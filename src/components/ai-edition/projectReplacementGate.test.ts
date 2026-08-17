import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	deleteProjectThroughLifecycleGate,
	registerProjectReplacementPrompt,
	replaceCurrentProject,
	tryBeginProjectLifecycleOperation,
} from "./projectReplacementGate";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	delete: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: bridgeMocks },
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function loadDocument(
	document: AxcutDocument,
	options: { status?: "ready" | "loading" | "error"; dirty?: boolean } = {},
) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: options.status ?? "ready",
		error: options.status === "error" ? "Recovery required" : null,
		dirty: options.dirty ?? true,
		lastSavedAt: null,
	});
}

describe("project replacement gate", () => {
	let unregisterPrompt: (() => void) | null = null;
	const projectA = createEmptyDocument({ projectId: "proj_a", title: "Project A" });

	beforeEach(() => {
		unregisterPrompt?.();
		unregisterPrompt = null;
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		toastMocks.error.mockReset();
	});

	afterEach(() => {
		unregisterPrompt?.();
	});

	it.each([
		"save",
		"discard",
		"cancel",
	] as const)("applies dirty %s before an open replacement", async (choice) => {
		loadDocument(projectA);
		bridgeMocks.save.mockResolvedValue({ success: true, document: projectA });
		const prompt = vi.fn(async () => choice);
		unregisterPrompt = registerProjectReplacementPrompt(prompt);
		const replacement = vi.fn(async () => {
			expect(useProjectStore.getState().dirty).toBe(choice === "discard");
			return "replaced";
		});

		const outcome = await replaceCurrentProject("open", replacement);

		expect(prompt).toHaveBeenCalledWith("open");
		if (choice === "cancel") {
			expect(outcome).toEqual({ status: "cancelled" });
			expect(replacement).not.toHaveBeenCalled();
		} else {
			expect(outcome).toEqual({ status: "completed", value: "replaced" });
			expect(replacement).toHaveBeenCalledTimes(1);
		}
		expect(bridgeMocks.save).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
	});

	it.each([
		{ status: "ready", error: "disk full" },
		{ status: "loading", error: null },
		{ status: "error", error: "recovery write failed" },
	] as const)("blocks replacement when a $status save is refused", async ({ status, error }) => {
		loadDocument(projectA, { status });
		if (error) bridgeMocks.save.mockResolvedValue({ success: false, error });
		unregisterPrompt = registerProjectReplacementPrompt(async () => "save");
		const replacement = vi.fn(async () => undefined);

		await expect(replaceCurrentProject("new", replacement)).resolves.toEqual({
			status: "save-failed",
		});

		expect(replacement).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: projectA.project.id,
			document: projectA,
			status,
			dirty: true,
		});
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
	});

	it("uses the recovery save before replacing an errored dirty project", async () => {
		loadDocument(projectA, { status: "error" });
		bridgeMocks.save.mockResolvedValue({ success: true, document: projectA });
		unregisterPrompt = registerProjectReplacementPrompt(async () => "save");
		const replacement = vi.fn(async () => "replacement");

		await expect(replaceCurrentProject("open", replacement)).resolves.toEqual({
			status: "completed",
			value: "replacement",
		});
		expect(bridgeMocks.save).toHaveBeenCalledWith(projectA);
		expect(replacement).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState()).toMatchObject({ status: "ready", dirty: false });
	});

	it("blocks replacement when an edit detaches the accepted save", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		loadDocument(projectA);
		bridgeMocks.save.mockReturnValue(saving.promise);
		unregisterPrompt = registerProjectReplacementPrompt(async () => "save");
		const replacement = vi.fn(async () => undefined);

		const replacing = replaceCurrentProject("open", replacement);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(projectA));
		const edited = {
			...projectA,
			project: { ...projectA.project, title: "Concurrent edit" },
		};
		useProjectStore.getState().setDocument(edited);
		saving.resolve({ success: true, document: projectA });

		await expect(replacing).resolves.toEqual({ status: "save-failed" });
		expect(replacement).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({ document: edited, dirty: true });
	});

	it("keeps a discarded dirty project recoverable when replacement fails or cancels", async () => {
		loadDocument(projectA);
		unregisterPrompt = registerProjectReplacementPrompt(async () => "discard");

		await expect(
			replaceCurrentProject("open", async () => {
				throw new Error("picker load failed");
			}),
		).rejects.toThrow("picker load failed");
		expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });

		await expect(replaceCurrentProject("open", async () => null)).resolves.toEqual({
			status: "completed",
			value: null,
		});
		expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("bypasses the prompt for a clean project", async () => {
		loadDocument(projectA, { dirty: false });
		const prompt = vi.fn(async () => "cancel" as const);
		unregisterPrompt = registerProjectReplacementPrompt(prompt);
		const replacement = vi.fn(async () => "clean replacement");

		await expect(replaceCurrentProject("open", replacement)).resolves.toEqual({
			status: "completed",
			value: "clean replacement",
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(replacement).toHaveBeenCalledTimes(1);
	});

	it("bypasses the prompt when no document is loaded", async () => {
		const prompt = vi.fn(async () => "cancel" as const);
		unregisterPrompt = registerProjectReplacementPrompt(prompt);
		const replacement = vi.fn(async () => "empty replacement");

		await expect(replaceCurrentProject("new", replacement)).resolves.toEqual({
			status: "completed",
			value: "empty replacement",
		});
		expect(prompt).not.toHaveBeenCalled();
	});

	it("allows only one overlapping prompt and replacement", async () => {
		loadDocument(projectA);
		const choice = deferred<"discard">();
		const replacementDone = deferred<void>();
		const prompt = vi.fn(() => choice.promise);
		unregisterPrompt = registerProjectReplacementPrompt(prompt);
		const firstReplacement = vi.fn(() => replacementDone.promise);
		const ignoredReplacement = vi.fn(async () => undefined);

		const first = replaceCurrentProject("open", firstReplacement);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await expect(replaceCurrentProject("new", ignoredReplacement)).resolves.toEqual({
			status: "busy",
		});
		choice.resolve("discard");
		await vi.waitFor(() => expect(firstReplacement).toHaveBeenCalledTimes(1));
		await expect(replaceCurrentProject("new", ignoredReplacement)).resolves.toEqual({
			status: "busy",
		});
		replacementDone.resolve(undefined);
		await expect(first).resolves.toEqual({ status: "completed", value: undefined });

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(ignoredReplacement).not.toHaveBeenCalled();
	});

	it("serializes non-active deletion behind an in-flight project load without prompting", async () => {
		loadDocument(projectA, { dirty: false });
		const loading = deferred<void>();
		const replacement = replaceCurrentProject("open", () => loading.promise);
		const deletion = vi.fn(async () => undefined);

		await expect(deleteProjectThroughLifecycleGate("proj_b", deletion)).resolves.toEqual({
			status: "busy",
		});
		expect(deletion).not.toHaveBeenCalled();

		loading.resolve(undefined);
		await replacement;
	});

	it("prompts only when deleting the active project", async () => {
		loadDocument(projectA);
		const prompt = vi.fn(async () => "discard" as const);
		unregisterPrompt = registerProjectReplacementPrompt(prompt);
		const deletion = vi.fn(async () => "deleted");

		await expect(deleteProjectThroughLifecycleGate("proj_b", deletion)).resolves.toEqual({
			status: "completed",
			value: "deleted",
		});
		expect(prompt).not.toHaveBeenCalled();
		await expect(deleteProjectThroughLifecycleGate(projectA.project.id, deletion)).resolves.toEqual(
			{
				status: "completed",
				value: "deleted",
			},
		);
		expect(prompt).toHaveBeenCalledOnce();
	});

	it("shares the lifecycle lock with a close operation", async () => {
		const closeLease = tryBeginProjectLifecycleOperation();
		expect(closeLease).not.toBeNull();
		const replacement = vi.fn(async () => undefined);

		await expect(replaceCurrentProject("new", replacement)).resolves.toEqual({ status: "busy" });
		expect(replacement).not.toHaveBeenCalled();
		closeLease?.release();
	});

	it("clears dirty only when the replacement document becomes authoritative", async () => {
		const projectB = createEmptyDocument({ projectId: "proj_b", title: "Project B" });
		loadDocument(projectA);
		bridgeMocks.save.mockResolvedValue({ success: true, document: projectB });
		unregisterPrompt = registerProjectReplacementPrompt(async () => "discard");

		const outcome = await replaceCurrentProject("open", () =>
			useProjectStore.getState().importProject(projectB),
		);

		expect(outcome).toEqual({ status: "completed", value: true });
		expect(useProjectStore.getState()).toMatchObject({
			projectId: projectB.project.id,
			document: projectB,
			status: "ready",
			dirty: false,
		});
	});
});
