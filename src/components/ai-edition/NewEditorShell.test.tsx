// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { saveCurrentProjectBeforeClose } from "./NewEditorShell";

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
	success: vi.fn(),
	info: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: bridgeMocks },
}));

vi.mock("@/native", () => ({
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
	options: { status?: "ready" | "error" | "loading"; dirty?: boolean } = {},
) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: options.status ?? "ready",
		error: options.status === "error" ? "Lifecycle reconciliation failed" : null,
		dirty: options.dirty ?? true,
		lastSavedAt: null,
	});
}

describe("NewEditorShell save before close", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		for (const mock of Object.values(toastMocks)) mock.mockReset();
	});

	it("saves a dirty recovery document and permits one close", async () => {
		const recovery = createEmptyDocument({ projectId: "proj_recovery_close", title: "Recovery" });
		const persisted = {
			...recovery,
			project: { ...recovery.project, updatedAt: "2026-08-17T12:30:00.000Z" },
		};
		loadDocument(recovery, { status: "error", dirty: true });
		bridgeMocks.save.mockResolvedValue({ success: true, document: persisted });
		const close = vi.fn();

		if (await saveCurrentProjectBeforeClose()) close();

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).toHaveBeenCalledWith(recovery);
		expect(useProjectStore.getState()).toMatchObject({
			document: persisted,
			status: "ready",
			error: null,
			dirty: false,
		});
		expect(close).toHaveBeenCalledTimes(1);
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "rejection",
			response: { success: false, error: "disk full" },
		},
		{
			name: "ambiguous response",
			response: { success: true },
		},
		{
			name: "different response",
			response: {
				success: true,
				document: createEmptyDocument({
					projectId: "proj_recovery_refused",
					title: "Different document",
				}),
			},
		},
	])("keeps the recovery document open after save $name", async ({ response }) => {
		const recovery = createEmptyDocument({
			projectId: "proj_recovery_refused",
			title: "Only recovery copy",
		});
		loadDocument(recovery, { status: "error", dirty: true });
		bridgeMocks.save.mockResolvedValue(response);
		const close = vi.fn();

		if (await saveCurrentProjectBeforeClose()) close();

		expect(close).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: recovery,
			status: "error",
			error: "Lifecycle reconciliation failed",
			dirty: true,
		});
		expect(toastMocks.error).toHaveBeenCalledWith("Failed to save before closing");
	});

	it("does not close without a savable current document", async () => {
		const document = createEmptyDocument({ projectId: "proj_refused_close", title: "Refused" });
		const close = vi.fn();

		if (await saveCurrentProjectBeforeClose()) close();
		loadDocument(document, { status: "loading", dirty: true });
		if (await saveCurrentProjectBeforeClose()) close();
		loadDocument(document, { status: "error", dirty: false });
		if (await saveCurrentProjectBeforeClose()) close();

		expect(close).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(toastMocks.error).toHaveBeenCalledTimes(3);
	});

	it("does not close when an edit supersedes a pending ready-state save", async () => {
		const document = createEmptyDocument({ projectId: "proj_edit_close", title: "Before edit" });
		const pending = deferred<{ success: true; document: AxcutDocument }>();
		loadDocument(document);
		bridgeMocks.save.mockReturnValue(pending.promise);
		const close = vi.fn();

		const closing = saveCurrentProjectBeforeClose();
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(document));
		const edited = {
			...document,
			project: { ...document.project, title: "Concurrent edit" },
		};
		useProjectStore.getState().setDocument(edited);
		pending.resolve({ success: true, document });
		if (await closing) close();

		expect(close).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: edited,
			status: "ready",
			dirty: true,
		});
		expect(toastMocks.error).toHaveBeenCalledWith("Failed to save before closing");
	});

	it("does not close a same-id import that replaces a pending recovery save", async () => {
		const recovery = createEmptyDocument({ projectId: "proj_import_close", title: "Recovery" });
		const imported = {
			...recovery,
			project: { ...recovery.project, title: "Imported replacement" },
		};
		const recoveryResponse = deferred<{ success: true; document: AxcutDocument }>();
		loadDocument(recovery, { status: "error", dirty: true });
		bridgeMocks.save
			.mockReturnValueOnce(recoveryResponse.promise)
			.mockResolvedValueOnce({ success: true, document: imported });
		const close = vi.fn();

		const closing = saveCurrentProjectBeforeClose();
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(recovery));
		await expect(useProjectStore.getState().importProject(imported)).resolves.toBe(true);
		recoveryResponse.resolve({ success: true, document: recovery });
		if (await closing) close();

		expect(close).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: imported,
			status: "ready",
			error: null,
			dirty: false,
		});
		expect(toastMocks.error).toHaveBeenCalledWith("Failed to save before closing");
	});

	it("keeps normal ready-state save and close behavior", async () => {
		const document = createEmptyDocument({ projectId: "proj_ready_close", title: "Ready" });
		loadDocument(document);
		bridgeMocks.save.mockResolvedValue({ success: true, document });
		const close = vi.fn();

		if (await saveCurrentProjectBeforeClose()) close();

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState()).toMatchObject({ status: "ready", dirty: false });
		expect(close).toHaveBeenCalledTimes(1);
	});
});
