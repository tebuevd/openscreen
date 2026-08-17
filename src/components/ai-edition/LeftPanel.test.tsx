// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { LeftPanel } from "./LeftPanel";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	save: vi.fn(),
	llmGetSnapshot: vi.fn(),
	chatListSessions: vi.fn(),
	chatSelectSession: vi.fn(),
	chatCreateSession: vi.fn(),
	chatRun: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
	success: vi.fn(),
	info: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: bridgeMocks,
	},
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

vi.mock("./ProviderSettings", () => ({
	ProviderSettings: () => null,
}));

vi.mock("./Modals", () => ({
	ChatHistoryModal: () => null,
	SourceTranscriptModal: () => null,
}));

const sampleDoc: AxcutDocument = {
	schemaVersion: 7,
	project: {
		id: "proj_a",
		title: "Project A",
		createdAt: "2026-08-16T10:00:00.000Z",
		updatedAt: "2026-08-16T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
};

function withTitle(document: AxcutDocument, title: string): AxcutDocument {
	return { ...document, project: { ...document.project, title } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function loadDocument(document: AxcutDocument = sampleDoc) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: "ready",
		error: null,
		dirty: false,
		lastSavedAt: new Date(),
	});
}

function chatResult(document: AxcutDocument) {
	return {
		success: true,
		assistantMessage: {
			id: "assistant_1",
			role: "assistant" as const,
			content: "The edit is ready.",
			createdAt: "2026-08-16T10:00:01.000Z",
		},
		document,
	};
}

function renderPanel() {
	return render(
		<I18nProvider>
			<LeftPanel active="chat" />
		</I18nProvider>,
	);
}

async function startPendingChat<T>(pending: Promise<T>) {
	bridgeMocks.chatRun.mockReturnValue(pending);
	renderPanel();
	await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
	fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
		target: { value: "Improve this edit" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(bridgeMocks.chatRun).toHaveBeenCalledTimes(1));
	expect(screen.getByText("Thinking…")).toBeInTheDocument();
}

describe("LeftPanel async document results", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		useChatPromptBus.setState({ pending: null });
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		for (const mock of Object.values(toastMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		bridgeMocks.llmGetSnapshot.mockResolvedValue({
			config: { provider: "openai", model: "gpt-test" },
			connectedProviders: ["openai"],
			availableProviders: [],
			credentialSummary: [],
		});
		bridgeMocks.chatListSessions.mockResolvedValue([
			{
				id: "session_1",
				title: "Conversation",
				messageCount: 0,
				createdAt: "2026-08-16T10:00:00.000Z",
			},
		]);
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [],
		});
		Object.assign(window, {
			electronAPI: {
				onAiEditionChatEvent: vi.fn(() => () => undefined),
				setLocale: vi.fn(),
			},
		});
		Object.defineProperty(HTMLElement.prototype, "scrollTo", {
			configurable: true,
			value: vi.fn(),
		});
		loadDocument();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only cleanup of the contextBridge stub
		delete (window as any).electronAPI;
	});

	it("keeps a same-id imported document authoritative while chat is pending", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const imported = withTitle(sampleDoc, "Imported replacement");

		await act(async () => {
			await useProjectStore.getState().importProject(imported);
		});
		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Stale agent result")));
			await run.promise;
		});

		await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_a",
			document: { project: { title: "Imported replacement" } },
			dirty: false,
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).toHaveBeenCalledWith(imported);
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Could not apply the agent's edits",
			expect.objectContaining({ description: expect.stringContaining("project changed") }),
		);
	});

	it("ignores a stale result across an A-to-B-to-A generation transition", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		const reopenedA = withTitle(sampleDoc, "Reopened Project A");
		bridgeMocks.get
			.mockResolvedValueOnce({ success: true, document: projectB })
			.mockResolvedValueOnce({ success: true, document: reopenedA });

		await act(async () => {
			await useProjectStore.getState().loadProject("proj_b");
			await useProjectStore.getState().loadProject("proj_a");
		});
		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Stale agent result")));
			await run.promise;
		});

		await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_a",
			document: { project: { title: "Reopened Project A" } },
			dirty: false,
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Could not apply the agent's edits",
			expect.any(Object),
		);
	});

	it("refuses a stale result after a same-generation user edit", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const userEdit = withTitle(sampleDoc, "User edit while chat runs");
		act(() => useProjectStore.getState().setDocument(userEdit));

		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Stale agent result")));
			await run.promise;
		});

		await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "User edit while chat runs" } },
			dirty: true,
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Could not apply the agent's edits",
			expect.any(Object),
		);
	});

	it("applies and persists an unchanged chat result exactly once", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const agentResult = withTitle(sampleDoc, "Accepted agent result");

		await act(async () => {
			run.resolve(chatResult(agentResult));
			await run.promise;
		});

		await waitFor(() =>
			expect(useProjectStore.getState()).toMatchObject({
				document: { project: { title: "Accepted agent result" } },
				dirty: false,
			}),
		);
		expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).toHaveBeenCalledWith(agentResult);
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it("clears loading without changing or saving the document when chat rejects", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);

		await act(async () => {
			run.reject(new Error("model unavailable"));
			await run.promise.catch(() => undefined);
		});

		await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
		expect(useProjectStore.getState()).toMatchObject({
			document: sampleDoc,
			dirty: false,
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Chat failed",
			expect.objectContaining({ description: "model unavailable" }),
		);
	});
});
