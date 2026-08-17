// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import type { AiEditionChatEvent } from "@/native/contracts";
import { LeftPanel } from "./LeftPanel";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	save: vi.fn(),
	llmGetSnapshot: vi.fn(),
	chatListSessions: vi.fn(),
	chatSelectSession: vi.fn(),
	chatCreateSession: vi.fn(),
	chatDeleteSession: vi.fn(),
	chatRun: vi.fn(),
	chatCommitRun: vi.fn(),
	chatAbortRun: vi.fn(),
	chatPrepareRewind: vi.fn(),
	chatCommitRewind: vi.fn(),
	chatAbortRewind: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
	success: vi.fn(),
	info: vi.fn(),
}));

let chatEventListener: ((event: AiEditionChatEvent) => void) | null = null;

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

const rewindMessages = [
	{
		id: "user_1",
		role: "user" as const,
		content: "Try this edit",
		createdAt: "2026-08-16T10:00:00.000Z",
		checkpointId: "user_1",
	},
	{
		id: "assistant_1",
		role: "assistant" as const,
		content: "Applied the old edit.",
		createdAt: "2026-08-16T10:00:01.000Z",
	},
];

function preparedRewind(operationId = "rewind_1") {
	return {
		success: true as const,
		operationId,
		sessionRevision: 4,
		document: withTitle(sampleDoc, "Rewound document"),
		messages: [rewindMessages[0]],
		prompt: "Try this edit",
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

async function startPendingRewind<T>(pending: Promise<T>) {
	bridgeMocks.chatSelectSession.mockResolvedValue({
		id: "session_1",
		projectId: "proj_a",
		title: "Conversation",
		createdAt: "2026-08-16T10:00:00.000Z",
		messages: rewindMessages,
	});
	bridgeMocks.chatPrepareRewind.mockReturnValue(pending);
	renderPanel();
	const trigger = await screen.findByRole("button", { name: "Rewind to this message" });
	fireEvent.click(trigger);
	fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
	await waitFor(() => expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledTimes(1));
}

describe("LeftPanel async document results", () => {
	beforeEach(() => {
		chatEventListener = null;
		useProjectStore.getState().clear();
		useChatPromptBus.setState({ pending: null });
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		for (const mock of Object.values(toastMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		bridgeMocks.chatCommitRun.mockResolvedValue({ success: true });
		bridgeMocks.chatAbortRun.mockResolvedValue({ success: true });
		bridgeMocks.chatAbortRewind.mockResolvedValue({ success: true });
		bridgeMocks.chatDeleteSession.mockResolvedValue({ success: true });
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
				onAiEditionChatEvent: vi.fn((listener: (event: AiEditionChatEvent) => void) => {
					chatEventListener = listener;
					return () => {
						if (chatEventListener === listener) chatEventListener = null;
					};
				}),
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
		expect(bridgeMocks.chatCommitRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
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

	it("discards a late session creation without updating the replacement project panel", async () => {
		const creating = deferred<{
			id: string;
			projectId: string;
			title: string;
			createdAt: string;
			messageCount: number;
		}>();
		bridgeMocks.chatListSessions.mockResolvedValue([]);
		bridgeMocks.chatCreateSession.mockReturnValue(creating.promise);
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatListSessions).toHaveBeenCalled());
		fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
			target: { value: "Improve this edit" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(bridgeMocks.chatCreateSession).toHaveBeenCalledTimes(1));

		const imported = withTitle(sampleDoc, "Imported while creating a session");
		await act(async () => {
			await useProjectStore.getState().importProject(imported);
		});
		expect(toastMocks.error).toHaveBeenCalledTimes(1);

		await act(async () => {
			creating.resolve({
				id: "late_session",
				projectId: "proj_a",
				title: "Conversation",
				createdAt: "2026-08-16T10:00:00.000Z",
				messageCount: 0,
			});
			await creating.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatDeleteSession).toHaveBeenCalledWith("proj_a", "late_session"),
		);
		expect(bridgeMocks.chatRun).not.toHaveBeenCalled();
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.project.title).toBe(
			"Imported while creating a session",
		);
	});

	it("refuses a stale result after a same-generation user edit", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const listCallsBeforeCompletion = bridgeMocks.chatListSessions.mock.calls.length;
		const selectCallsBeforeCompletion = bridgeMocks.chatSelectSession.mock.calls.length;
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
		expect(bridgeMocks.chatCommitRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.chatListSessions).toHaveBeenCalledTimes(listCallsBeforeCompletion);
		expect(bridgeMocks.chatSelectSession).toHaveBeenCalledTimes(selectCallsBeforeCompletion);
		expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
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
		expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
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

	it.each([
		"same-generation edit",
		"same-id import",
	] as const)("keeps a pending rewind retryable after a %s", async (mutation) => {
		const preparing = deferred<ReturnType<typeof preparedRewind>>();
		await startPendingRewind(preparing.promise);
		const winner = withTitle(
			sampleDoc,
			mutation === "same-generation edit" ? "Concurrent edit" : "Imported replacement",
		);
		if (mutation === "same-generation edit") {
			act(() => useProjectStore.getState().setDocument(winner));
		} else {
			await act(async () => {
				await useProjectStore.getState().importProject(winner);
			});
		}

		await act(async () => {
			preparing.resolve(preparedRewind());
			await preparing.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatAbortRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe(winner.project.title);
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Rewind to this message" })).toBeEnabled();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Could not apply the agent's edits",
			expect.any(Object),
		);
	});

	it("aborts rewind without changing renderer history when persistence is rejected", async () => {
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		bridgeMocks.get.mockResolvedValue({ success: true, document: sampleDoc });
		await startPendingRewind(Promise.resolve(preparedRewind()));

		await waitFor(() => expect(bridgeMocks.chatAbortRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({ document: sampleDoc, dirty: false });
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Rewind failed",
			expect.objectContaining({ description: "disk full" }),
		);
	});

	it("reconciles an authoritative rewind after a lost response without committing chat history", async () => {
		const prepared = preparedRewind();
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({ success: true, document: prepared.document });
		await startPendingRewind(Promise.resolve(prepared));

		await waitFor(() => expect(bridgeMocks.chatAbortRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Rewound document" } },
			dirty: false,
		});
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
	});

	it("applies, persists, and commits a prepared rewind exactly once", async () => {
		const prepared = preparedRewind();
		bridgeMocks.chatCommitRewind.mockResolvedValue({
			success: true,
			messages: prepared.messages,
			prompt: prepared.prompt,
		});
		await startPendingRewind(Promise.resolve(prepared));

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).toHaveBeenCalledWith(prepared.document);
		expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledWith(
			"proj_a",
			"session_1",
			prepared.operationId,
			prepared.sessionRevision,
		);
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Rewound document");
		expect(screen.queryByText("Applied the old edit.")).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("Try this edit");
	});

	it("blocks overlapping rewind and chat handlers while rewind preparation is pending", async () => {
		const preparing = deferred<
			ReturnType<typeof preparedRewind> | { success: false; error: string }
		>();
		await startPendingRewind(preparing.promise);

		const rewindTrigger = screen.getByRole("button", { name: "Rewind to this message" });
		expect(rewindTrigger).toBeDisabled();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toBeDisabled();
		const confirm = screen.getByRole("button", { name: "Rewind" });
		expect(confirm).toBeDisabled();
		fireEvent.click(confirm);
		expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.chatRun).not.toHaveBeenCalled();

		await act(async () => {
			preparing.resolve({ success: false, error: "cancelled" });
			await preparing.promise;
		});
		await waitFor(() => expect(rewindTrigger).toBeEnabled());
	});

	it("disables rewind controls while a chat run is pending", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: rewindMessages,
		});
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);

		for (const rewind of screen.getAllByRole("button", { name: "Rewind to this message" })) {
			expect(rewind).toBeDisabled();
		}
		await act(async () => {
			run.reject(new Error("cancelled"));
			await run.promise.catch(() => undefined);
		});
	});

	it("ignores streamed reasoning from an older operation in the same session", async () => {
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const operationId = bridgeMocks.chatRun.mock.calls[0][4] as string;

		act(() => {
			chatEventListener?.({
				kind: "thinking",
				sessionId: "session_1",
				operationId: "older-run",
				delta: "stale reasoning",
			});
		});
		expect(screen.queryByText("stale reasoning")).not.toBeInTheDocument();

		act(() => {
			chatEventListener?.({
				kind: "thinking",
				sessionId: "session_1",
				operationId,
				delta: "current reasoning",
			});
		});
		expect(screen.getByText("current reasoning")).toBeInTheDocument();

		await act(async () => {
			run.reject(new Error("cancelled"));
			await run.promise.catch(() => undefined);
		});
	});
});
