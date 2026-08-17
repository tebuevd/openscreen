// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import type { AiEditionChatEvent, AiEditionChatSessionUpdatedEvent } from "@/native/contracts";
import { LeftPanel } from "./LeftPanel";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	save: vi.fn(),
	llmGetSnapshot: vi.fn(),
	chatListSessions: vi.fn(),
	chatSelectSession: vi.fn(),
	chatClaimRewindComposer: vi.fn(),
	chatConfirmRewindComposerClaim: vi.fn(),
	chatReleaseRewindComposerClaim: vi.fn(),
	chatCreateSession: vi.fn(),
	chatDeleteSession: vi.fn(),
	chatRun: vi.fn(),
	chatCommitRun: vi.fn(),
	chatAbortRun: vi.fn(),
	chatBeginPersistence: vi.fn(),
	chatOperationStatus: vi.fn(),
	chatResolvePersistence: vi.fn(),
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
let chatSessionUpdateListener: ((event: AiEditionChatSessionUpdatedEvent) => void) | null = null;

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
	ChatHistoryModal: ({
		open,
		sessions,
		onSelect,
	}: {
		open: boolean;
		sessions: Array<{ id: string; title: string }>;
		onSelect: (id: string) => void;
	}) =>
		open ? (
			<div aria-label="Conversation picker">
				{sessions.map((session) => (
					<button key={session.id} type="button" onClick={() => onSelect(session.id)}>
						{session.title}
					</button>
				))}
			</div>
		) : null,
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

function chatResult(document: AxcutDocument, userMessageCheckpointId = "canonical_user_1") {
	return {
		success: true,
		assistantMessage: {
			id: "assistant_1",
			role: "assistant" as const,
			content: "The edit is ready.",
			createdAt: "2026-08-16T10:00:01.000Z",
		},
		document,
		userMessageCheckpointId,
	};
}

function canonicalChatCommit(sessionRevision = 1, userMessageCheckpointId = "canonical_user_1") {
	return {
		success: true as const,
		messages: [
			{
				id: userMessageCheckpointId,
				role: "user" as const,
				content: "Improve this edit",
				createdAt: "2026-08-16T10:00:00.000Z",
				checkpointId: userMessageCheckpointId,
			},
			{
				id: "assistant_1",
				role: "assistant" as const,
				content: "The edit is ready.",
				createdAt: "2026-08-16T10:00:01.000Z",
			},
		],
		sessionRevision,
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
	};
}

function rewindComposerClaim(prompt: string, claimId = "claim-default") {
	return {
		claimed: true as const,
		prompt,
		claimId,
		leaseExpiresAt: Date.now() + 15_000,
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
	const view = renderPanel();
	await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
	fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
		target: { value: "Improve this edit" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(bridgeMocks.chatRun).toHaveBeenCalledTimes(1));
	expect(screen.getByText("Thinking…")).toBeInTheDocument();
	return view;
}

async function startPendingRewind<T>(pending: Promise<T>) {
	bridgeMocks.chatSelectSession.mockResolvedValue({
		id: "session_1",
		projectId: "proj_a",
		title: "Conversation",
		createdAt: "2026-08-16T10:00:00.000Z",
		messages: rewindMessages,
		revision: 4,
	});
	bridgeMocks.chatPrepareRewind.mockReturnValue(pending);
	const view = renderPanel();
	const trigger = await screen.findByRole("button", { name: "Rewind to this message" });
	fireEvent.click(trigger);
	fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
	await waitFor(() => expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledTimes(1));
	return view;
}

describe("LeftPanel async document results", () => {
	beforeEach(() => {
		chatEventListener = null;
		chatSessionUpdateListener = null;
		useProjectStore.getState().clear();
		useChatPromptBus.setState({ pending: null });
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		for (const mock of Object.values(toastMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		bridgeMocks.chatCommitRun.mockResolvedValue(canonicalChatCommit());
		bridgeMocks.chatAbortRun.mockResolvedValue({ success: true });
		bridgeMocks.chatBeginPersistence.mockResolvedValue({ success: true });
		bridgeMocks.chatOperationStatus.mockImplementation(
			async (_projectId: string, _sessionId: string, operationId: string) => ({
				state: "persisting",
				kind: operationId.startsWith("rewind") ? "rewind" : "chat",
				operationId,
			}),
		);
		bridgeMocks.chatResolvePersistence.mockResolvedValue({ success: true });
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
			revision: 0,
		});
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(rewindComposerClaim("Try this edit"));
		bridgeMocks.chatConfirmRewindComposerClaim.mockResolvedValue({
			confirmed: true,
			alreadyConfirmed: false,
		});
		bridgeMocks.chatReleaseRewindComposerClaim.mockResolvedValue({ released: true });
		Object.assign(window, {
			electronAPI: {
				onAiEditionChatEvent: vi.fn((listener: (event: AiEditionChatEvent) => void) => {
					chatEventListener = listener;
					return () => {
						if (chatEventListener === listener) chatEventListener = null;
					};
				}),
				onAiEditionChatSessionUpdated: vi.fn(
					(listener: (event: AiEditionChatSessionUpdatedEvent) => void) => {
						chatSessionUpdateListener = listener;
						return () => {
							if (chatSessionUpdateListener === listener) chatSessionUpdateListener = null;
						};
					},
				),
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
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
			"proj_a",
			"session_1",
			bridgeMocks.chatRun.mock.calls[0][4],
			"not-persisted",
		);
		expect(bridgeMocks.chatListSessions).toHaveBeenCalledTimes(listCallsBeforeCompletion);
		expect(bridgeMocks.chatSelectSession).toHaveBeenCalledTimes(selectCallsBeforeCompletion);
		expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Could not apply the agent's edits",
			expect.any(Object),
		);
	});

	it("does not commit chat history when a newer edit supersedes an in-flight save", async () => {
		const agentSave = deferred<{ success: true; document: AxcutDocument }>();
		const savedDocuments: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			savedDocuments.push(document);
			return savedDocuments.length === 1
				? agentSave.promise
				: Promise.resolve({ success: true as const, document });
		});
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const agentResult = withTitle(sampleDoc, "Superseded agent result");
		bridgeMocks.get.mockResolvedValue({ success: true, document: agentResult });

		await act(async () => {
			run.resolve(chatResult(agentResult));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(agentResult));

		const winner = withTitle(sampleDoc, "Newer saved user edit");
		act(() => useProjectStore.getState().setDocument(winner));
		const savingWinner = useProjectStore.getState().saveDocument(winner);
		await act(async () => {
			agentSave.resolve({ success: true, document: agentResult });
			await agentSave.promise;
			await savingWinner;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				bridgeMocks.chatRun.mock.calls[0][4],
				"superseded",
			),
		);
		expect(savedDocuments).toEqual([agentResult, winner]);
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer saved user edit" } },
			dirty: false,
		});
		expect(bridgeMocks.chatCommitRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
	});

	it("keeps a same-id import authoritative when it supersedes an in-flight chat save", async () => {
		const agentSave = deferred<{ success: true; document: AxcutDocument }>();
		const importSave = deferred<{ success: true; document: AxcutDocument }>();
		const savedDocuments: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			savedDocuments.push(document);
			return savedDocuments.length === 1 ? agentSave.promise : importSave.promise;
		});
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const agentResult = withTitle(sampleDoc, "Superseded agent result");

		await act(async () => {
			run.resolve(chatResult(agentResult));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(agentResult));

		const imported = withTitle(sampleDoc, "Imported replacement after save started");
		bridgeMocks.get.mockResolvedValue({ success: true, document: imported });
		let importing!: Promise<boolean>;
		act(() => {
			importing = useProjectStore.getState().importProject(imported);
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(imported));
		await act(async () => {
			agentSave.resolve({ success: true, document: agentResult });
			await agentSave.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				bridgeMocks.chatRun.mock.calls[0][4],
				"superseded",
			),
		);
		await act(async () => {
			importSave.resolve({ success: true, document: imported });
			await importing;
		});

		expect(savedDocuments).toEqual([agentResult, imported]);
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Imported replacement after save started" } },
			dirty: false,
		});
		expect(bridgeMocks.chatCommitRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
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

	it("commits chat history when a lost save response reconciles to the intended document", async () => {
		const resultDocument = withTitle(sampleDoc, "Reconciled chat edit");
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({
			success: true,
			document: {
				...resultDocument,
				project: { ...resultDocument.project, updatedAt: "2026-08-16T10:05:00.000Z" },
			},
		});
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);

		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Reconciled chat edit" } },
			dirty: false,
		});
		expect(screen.getByText("The edit is ready.")).toBeInTheDocument();
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it.each([
		"successful",
		"ambiguous",
	] as const)("commits one canonical checkpoint after a same-project reopen and %s save response", async (saveResponse) => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const reloading = deferred<{ success: true; document: AxcutDocument }>();
		const readback = deferred<{ success: true; document: AxcutDocument }>();
		const resultDocument = withTitle(sampleDoc, "Persisted before same-project reopen");
		const reopened = {
			...resultDocument,
			project: {
				...resultDocument.project,
				updatedAt: "2026-08-16T10:05:00.000Z",
			},
		};
		const committed = canonicalChatCommit();
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockReturnValueOnce(reloading.promise).mockReturnValueOnce(readback.promise);
		bridgeMocks.chatCommitRun.mockResolvedValue({
			success: false,
			error: "Owner teardown already committed this operation.",
		});
		bridgeMocks.chatOperationStatus.mockImplementation(
			async (_projectId: string, _sessionId: string, operationId: string) =>
				bridgeMocks.chatCommitRun.mock.calls.length > 0
					? {
							state: "committed" as const,
							kind: "chat" as const,
							operationId,
							result: committed,
						}
					: { state: "persisting" as const, kind: "chat" as const, operationId },
		);
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument));

		let reopen!: Promise<void>;
		act(() => {
			reopen = useProjectStore.getState().loadProject("proj_a");
		});
		await act(async () => {
			if (saveResponse === "successful") {
				saving.resolve({ success: true, document: resultDocument });
			} else {
				saving.reject(new Error("save response lost"));
			}
			await saving.promise.catch(() => undefined);
		});
		await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(2));
		await act(async () => {
			reloading.resolve({ success: true, document: reopened });
			await reopen;
		});
		await act(async () => {
			readback.resolve({ success: true, document: resultDocument });
			await readback.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
		expect(toastMocks.error).not.toHaveBeenCalled();
		const operationId = bridgeMocks.chatRun.mock.calls[0][4] as string;
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: committed.sessionRevision,
				operationId,
				kind: "chat",
				messages: committed.messages,
			});
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: committed.sessionRevision,
				operationId,
				kind: "chat",
				messages: committed.messages,
			});
		});

		expect(await screen.findAllByText("The edit is ready.")).toHaveLength(1);
		bridgeMocks.chatPrepareRewind.mockResolvedValue({ success: false, error: "stop" });
		fireEvent.click(screen.getByRole("button", { name: "Rewind to this message" }));
		fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
		await waitFor(() =>
			expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				"canonical_user_1",
			),
		);
		expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1);
	});

	it("commits Project A chat history while Project B is still loading", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const resultDocument = withTitle(sampleDoc, "Persisted while Project B loads");
		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		const committed = canonicalChatCommit();
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: resultDocument }),
		);
		bridgeMocks.chatCommitRun.mockImplementation(
			async (_projectId: string, _sessionId: string, operationId: string) => {
				chatSessionUpdateListener?.({
					projectId: "proj_a",
					sessionId: "session_1",
					revision: committed.sessionRevision,
					operationId,
					kind: "chat",
					messages: committed.messages,
				});
				return committed;
			},
		);
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument));

		const selectCalls = bridgeMocks.chatSelectSession.mock.calls.length;
		let loading!: Promise<void>;
		await act(async () => {
			loading = useProjectStore.getState().loadProject("proj_b");
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession.mock.calls.length).toBeGreaterThan(selectCalls),
		);
		await act(async () => {
			saving.resolve({ success: true, document: resultDocument });
			await saving.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(screen.getAllByText("The edit is ready.")).toHaveLength(1);
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_a",
			document: sampleDoc,
			status: "loading",
		});

		await act(async () => {
			loadingProjectB.resolve({ success: true, document: projectB });
			await loading;
		});
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_b",
			document: projectB,
			status: "ready",
		});
	});

	it("keeps one canonical Project A checkpoint when owner teardown wins during a failed Project B load", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: false; error: string }>();
		const resultDocument = withTitle(sampleDoc, "Owner-reconciled edit");
		const committed = canonicalChatCommit();
		let ownerCommitted = false;
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: resultDocument }),
		);
		bridgeMocks.chatCommitRun.mockResolvedValue({
			success: false,
			error: "Owner teardown already committed this operation.",
		});
		bridgeMocks.chatOperationStatus.mockImplementation(
			async (_projectId: string, _sessionId: string, operationId: string) =>
				ownerCommitted
					? {
							state: "committed" as const,
							kind: "chat" as const,
							operationId,
							result: committed,
						}
					: { state: "persisting" as const, kind: "chat" as const, operationId },
		);
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument));

		const selectCalls = bridgeMocks.chatSelectSession.mock.calls.length;
		let loading!: Promise<void>;
		await act(async () => {
			loading = useProjectStore.getState().loadProject("proj_b");
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession.mock.calls.length).toBeGreaterThan(selectCalls),
		);
		const operationId = bridgeMocks.chatRun.mock.calls[0][4] as string;
		ownerCommitted = true;
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: committed.sessionRevision,
				operationId,
				kind: "chat",
				messages: committed.messages,
			});
		});
		await act(async () => {
			saving.resolve({ success: true, document: resultDocument });
			await saving.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(screen.getAllByText("The edit is ready.")).toHaveLength(1);
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();

		await act(async () => {
			loadingProjectB.resolve({ success: false, error: "Project B unavailable" });
			await loading;
		});
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_a",
			document: resultDocument,
			status: "error",
			error: "Project B unavailable",
			dirty: false,
		});
		expect(screen.getAllByText("The edit is ready.")).toHaveLength(1);

		act(() => useProjectStore.setState({ status: "ready", error: null }));
		bridgeMocks.chatPrepareRewind.mockResolvedValue({ success: false, error: "stop" });
		fireEvent.click(screen.getByRole("button", { name: "Rewind to this message" }));
		fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
		await waitFor(() =>
			expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				"canonical_user_1",
			),
		);
	});

	it("recovers two lost chat commit replies from canonical status without duplication", async () => {
		const committed = canonicalChatCommit();
		bridgeMocks.chatCommitRun
			.mockRejectedValueOnce(new Error("first commit reply lost"))
			.mockRejectedValueOnce(new Error("second commit reply lost"));
		bridgeMocks.chatOperationStatus
			.mockImplementationOnce(async (_projectId, _sessionId, operationId) => ({
				state: "persisting",
				kind: "chat",
				operationId,
			}))
			.mockResolvedValueOnce({ state: "unknown", operationId: "unknown" })
			.mockImplementation(async (_projectId, _sessionId, operationId) => ({
				state: "committed",
				kind: "chat",
				operationId,
				result: committed,
			}));
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);

		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Committed edit")));
			await run.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(2));
		expect(bridgeMocks.chatOperationStatus).toHaveBeenCalledTimes(3);
		expect(screen.getAllByText("The edit is ready.")).toHaveLength(1);
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it("refreshes a remounted panel when detached persistence commits canonically", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const resultDocument = withTitle(sampleDoc, "Detached persisted edit");
		const committed = canonicalChatCommit();
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.chatCommitRun.mockImplementation(
			async (_projectId: string, _sessionId: string, operationId: string) => {
				chatSessionUpdateListener?.({
					projectId: "proj_a",
					sessionId: "session_1",
					revision: committed.sessionRevision,
					operationId,
					kind: "chat",
					messages: committed.messages,
				});
				return committed;
			},
		);
		const run = deferred<ReturnType<typeof chatResult>>();
		const firstView = await startPendingChat(run.promise);

		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(bridgeMocks.chatBeginPersistence).toHaveBeenCalledTimes(1));
		firstView.unmount();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(chatSessionUpdateListener).toBeNull();

		const selectCalls = bridgeMocks.chatSelectSession.mock.calls.length;
		renderPanel();
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession.mock.calls.length).toBeGreaterThan(selectCalls),
		);
		await waitFor(() => expect(chatSessionUpdateListener).not.toBeNull());

		await act(async () => {
			saving.resolve({ success: true, document: resultDocument });
			await saving.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(screen.getAllByText("The edit is ready.")).toHaveLength(1);
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
	});

	it.each([
		"before",
		"after",
	] as const)("loads the canonical session when a replacement editor opens %s owner reconciliation", async (timing) => {
		const committed = canonicalChatCommit();
		const summaries = [
			{
				id: "session_1",
				projectId: "proj_a",
				title: "Conversation",
				createdAt: "2026-08-16T10:00:00.000Z",
				messageCount: committed.messages.length,
			},
		];
		bridgeMocks.chatListSessions.mockResolvedValue(summaries);
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: timing === "after" ? committed.messages : [],
			revision: timing === "after" ? committed.sessionRevision : 0,
		});

		renderPanel();
		if (timing === "before") {
			await waitFor(() =>
				expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "session_1"),
			);
			await waitFor(() => expect(chatSessionUpdateListener).not.toBeNull());
			expect(screen.queryByText("The edit is ready.")).not.toBeInTheDocument();
			act(() => {
				chatSessionUpdateListener?.({
					projectId: "proj_a",
					sessionId: "session_1",
					revision: committed.sessionRevision,
					operationId: "owner-reconciliation",
					kind: "chat",
					messages: committed.messages,
				});
			});
		}

		expect(await screen.findByText("The edit is ready.")).toBeInTheDocument();
		expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "session_1");
	});

	it("claims and applies a live rewind prompt exactly once", async () => {
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(
			rewindComposerClaim("Restore this prompt", "live-claim"),
		);
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
		const update: AiEditionChatSessionUpdatedEvent = {
			projectId: "proj_a",
			sessionId: "session_1",
			revision: 1,
			operationId: "live-rewind",
			kind: "rewind",
			messages: [rewindMessages[0]],
			pendingComposerRestoration: { revision: 1 },
		};

		act(() => chatSessionUpdateListener?.(update));

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Restore this prompt",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledWith("proj_a", "session_1", 1);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("live-claim");
		fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
			target: { value: "Keep my newer draft" },
		});
		act(() => chatSessionUpdateListener?.(update));
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1);
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
			"Keep my newer draft",
		);
	});

	it("leaves the composer unchanged when a stale restoration claim loses", async () => {
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue({ claimed: false });
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
		const input = screen.getByPlaceholderText("Describe the edit you want.");
		fireEvent.change(input, { target: { value: "Keep this draft" } });

		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 2,
				operationId: "stale-rewind",
				kind: "rewind",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 2 },
			});
		});

		await waitFor(() =>
			expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledWith("proj_a", "session_1", 2),
		);
		expect(input).toHaveValue("Keep this draft");
		expect(bridgeMocks.chatConfirmRewindComposerClaim).not.toHaveBeenCalled();
	});

	it("retries a lost claim when the first renderer releases its lease", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 8,
			pendingComposerRestoration: { revision: 8 },
		});
		bridgeMocks.chatClaimRewindComposer
			.mockResolvedValueOnce({ claimed: false, leaseExpiresAt: Date.now() + 15_000 })
			.mockResolvedValueOnce(rewindComposerClaim("Recovered after release", "released-claim"));
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));

		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 8,
				operationId: "first-owner-lease-released",
				kind: "rewind-composer-available",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 8 },
			});
		});

		const input = screen.getByPlaceholderText("Describe the edit you want.");
		await waitFor(() => expect(input).toHaveValue("Recovered after release"));
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
		fireEvent.change(input, { target: { value: "Keep one applied draft" } });
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 8,
				operationId: "duplicate-availability",
				kind: "rewind-composer-available",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 8 },
			});
		});
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
		expect(input).toHaveValue("Keep one applied draft");
	});

	it("retries a false claim after switching away and reselecting the conversation", async () => {
		bridgeMocks.chatListSessions.mockResolvedValue([
			{
				id: "session_1",
				title: "Conversation 1",
				messageCount: 1,
				createdAt: "2026-08-16T10:00:00.000Z",
			},
			{
				id: "session_2",
				title: "Conversation 2",
				messageCount: 0,
				createdAt: "2026-08-16T10:01:00.000Z",
			},
		]);
		bridgeMocks.chatSelectSession.mockImplementation(async (_projectId, sessionId) =>
			sessionId === "session_1"
				? {
						id: "session_1",
						projectId: "proj_a",
						title: "Conversation 1",
						createdAt: "2026-08-16T10:00:00.000Z",
						messages: [rewindMessages[0]],
						revision: 9,
						pendingComposerRestoration: { revision: 9 },
					}
				: {
						id: "session_2",
						projectId: "proj_a",
						title: "Conversation 2",
						createdAt: "2026-08-16T10:01:00.000Z",
						messages: [],
						revision: 0,
					},
		);
		bridgeMocks.chatClaimRewindComposer
			.mockResolvedValueOnce({ claimed: false })
			.mockResolvedValueOnce(rewindComposerClaim("Recovered on reselect", "reselected-claim"));
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));

		fireEvent.click(screen.getByRole("button", { name: "History" }));
		fireEvent.click(screen.getByRole("button", { name: "Conversation 2" }));
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "session_2"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Conversation 1" }));

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Recovered on reselect",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
	});

	it("retries once when another owner's composer lease expires", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 10,
			pendingComposerRestoration: { revision: 10 },
		});
		bridgeMocks.chatClaimRewindComposer
			.mockResolvedValueOnce({ claimed: false, leaseExpiresAt: Date.now() + 20 })
			.mockResolvedValueOnce(rewindComposerClaim("Recovered after expiry", "expiry-claim"));
		renderPanel();

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Recovered after expiry",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("expiry-claim");
	});

	it("cancels an older revision retry when a newer rewind supersedes it", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 11,
			pendingComposerRestoration: { revision: 11 },
		});
		bridgeMocks.chatClaimRewindComposer
			.mockResolvedValueOnce({ claimed: false, leaseExpiresAt: Date.now() + 40 })
			.mockResolvedValueOnce(rewindComposerClaim("Newest rewind prompt", "newest-claim"));
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));

		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 12,
				operationId: "newer-rewind",
				kind: "rewind",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 12 },
			});
		});
		const input = screen.getByPlaceholderText("Describe the edit you want.");
		await waitFor(() => expect(input).toHaveValue("Newest rewind prompt"));
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenLastCalledWith("proj_a", "session_1", 12);
		expect(input).toHaveValue("Newest rewind prompt");
	});

	it("clears a scheduled composer retry when the panel unmounts", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 13,
			pendingComposerRestoration: { revision: 13 },
		});
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue({
			claimed: false,
			leaseExpiresAt: Date.now() + 30,
		});
		const view = renderPanel();
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));

		view.unmount();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1);
	});

	it("replays a missed rewind prompt when its conversation is selected later", async () => {
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(
			rewindComposerClaim("Missed prompt", "missed-claim"),
		);
		bridgeMocks.chatSelectSession.mockImplementation(async (_projectId, sessionId) =>
			sessionId === "session_2"
				? {
						id: "session_2",
						projectId: "proj_a",
						title: "Conversation 2",
						createdAt: "2026-08-16T10:01:00.000Z",
						messages: [rewindMessages[0]],
						revision: 3,
						pendingComposerRestoration: { revision: 3 },
					}
				: {
						id: "session_1",
						projectId: "proj_a",
						title: "Conversation",
						createdAt: "2026-08-16T10:00:00.000Z",
						messages: [],
						revision: 0,
					},
		);
		bridgeMocks.chatCreateSession.mockResolvedValue({
			id: "session_2",
			projectId: "proj_a",
			title: "Conversation 2",
			createdAt: "2026-08-16T10:01:00.000Z",
			messageCount: 1,
		});
		renderPanel();
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "session_1"),
		);

		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_2",
				revision: 3,
				operationId: "missed-rewind",
				kind: "rewind",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 3 },
			});
		});
		expect(bridgeMocks.chatClaimRewindComposer).not.toHaveBeenCalled();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");

		fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "session_2"),
		);
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Missed prompt",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledWith("proj_a", "session_2", 3);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("missed-claim");
	});

	it("does not replay a composer restoration after it was confirmed", async () => {
		let pending = true;
		bridgeMocks.chatSelectSession.mockImplementation(async () => ({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 4,
			...(pending ? { pendingComposerRestoration: { revision: 4 } } : {}),
		}));
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(
			rewindComposerClaim("One-time prompt", "one-time-claim"),
		);
		bridgeMocks.chatConfirmRewindComposerClaim.mockImplementation(async () => {
			pending = false;
			return { confirmed: true, alreadyConfirmed: false };
		});
		const first = renderPanel();

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"One-time prompt",
			),
		);
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("one-time-claim"),
		);
		first.unmount();
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalledTimes(2));

		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1);
	});

	it("releases a claim when the panel unmounts before applying it, then replacement reclaims", async () => {
		const firstClaim = deferred<ReturnType<typeof rewindComposerClaim>>();
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 5,
			pendingComposerRestoration: { revision: 5 },
		});
		bridgeMocks.chatClaimRewindComposer.mockReturnValue(firstClaim.promise);
		const first = renderPanel();
		await waitFor(() =>
			expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledWith("proj_a", "session_1", 5),
		);
		first.unmount();

		await act(async () => {
			firstClaim.resolve(rewindComposerClaim("Recovered prompt", "outgoing-claim"));
			await firstClaim.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatReleaseRewindComposerClaim).toHaveBeenCalledWith("outgoing-claim"),
		);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).not.toHaveBeenCalled();
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(
			rewindComposerClaim("Recovered prompt", "replacement-claim"),
		);
		renderPanel();

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Recovered prompt",
			),
		);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("replacement-claim");
	});

	it("releases a claimed prompt when the session revision advances before apply", async () => {
		const claimResponse = deferred<ReturnType<typeof rewindComposerClaim>>();
		bridgeMocks.chatClaimRewindComposer.mockReturnValue(claimResponse.promise);
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 1,
				operationId: "rewind-before-newer-revision",
				kind: "rewind",
				messages: [rewindMessages[0]],
				pendingComposerRestoration: { revision: 1 },
			});
		});
		await waitFor(() => expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1));
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 2,
				operationId: "newer-session-revision",
				kind: "chat",
				messages: [],
			});
		});

		await act(async () => {
			claimResponse.resolve(rewindComposerClaim("Stale prompt", "stale-revision-claim"));
			await claimResponse.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatReleaseRewindComposerClaim).toHaveBeenCalledWith(
				"stale-revision-claim",
			),
		);
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		expect(bridgeMocks.chatConfirmRewindComposerClaim).not.toHaveBeenCalled();
	});

	it("retries a claim whose response was lost", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 6,
			pendingComposerRestoration: { revision: 6 },
		});
		bridgeMocks.chatClaimRewindComposer
			.mockRejectedValueOnce(new Error("claim response lost"))
			.mockResolvedValue(rewindComposerClaim("Recovered claim", "retried-claim"));
		renderPanel();

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Recovered claim",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(2);
		expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledWith("retried-claim");
	});

	it("retries a lost confirmation without applying the prompt twice", async () => {
		bridgeMocks.chatSelectSession.mockResolvedValue({
			id: "session_1",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messages: [rewindMessages[0]],
			revision: 7,
			pendingComposerRestoration: { revision: 7 },
		});
		bridgeMocks.chatClaimRewindComposer.mockResolvedValue(
			rewindComposerClaim("Confirm me", "confirm-retry"),
		);
		bridgeMocks.chatConfirmRewindComposerClaim
			.mockRejectedValueOnce(new Error("confirm response lost"))
			.mockResolvedValue({ confirmed: true, alreadyConfirmed: true });
		renderPanel();

		const input = await screen.findByPlaceholderText("Describe the edit you want.");
		await waitFor(() => expect(input).toHaveValue("Confirm me"));
		fireEvent.change(input, { target: { value: "Newer local draft" } });
		await waitFor(() =>
			expect(bridgeMocks.chatConfirmRewindComposerClaim).toHaveBeenCalledTimes(2),
		);
		expect(input).toHaveValue("Newer local draft");
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledTimes(1);
	});

	it("resolves a late failed save after the sending panel unmounts", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const resultDocument = withTitle(sampleDoc, "Late failed edit");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockRejectedValue(new Error("disk unavailable"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const run = deferred<ReturnType<typeof chatResult>>();
		const view = await startPendingChat(run.promise);

		await act(async () => {
			run.resolve(chatResult(resultDocument));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		view.unmount();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();

		await act(async () => {
			saving.reject(new Error("late write failure"));
			await saving.promise.catch(() => undefined);
		});

		await waitFor(() =>
			expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				bridgeMocks.chatRun.mock.calls[0][4],
				"failed",
			),
		);
		expect(bridgeMocks.chatCommitRun).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRun).not.toHaveBeenCalled();
	});

	it("maps the optimistic user message to its canonical checkpoint before session reload", async () => {
		bridgeMocks.chatCommitRun.mockResolvedValue(canonicalChatCommit(1, "canonical_checkpoint"));
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Canonical edit"), "canonical_checkpoint"));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		bridgeMocks.chatPrepareRewind.mockResolvedValue({
			success: false,
			error: "stop after identity",
		});

		fireEvent.click(screen.getByRole("button", { name: "Rewind to this message" }));
		fireEvent.click(screen.getByRole("button", { name: "Rewind" }));

		await waitFor(() =>
			expect(bridgeMocks.chatPrepareRewind).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				"canonical_checkpoint",
			),
		);
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

		if (mutation === "same-generation edit") {
			await waitFor(() => expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledTimes(1));
			expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		} else {
			await waitFor(() => expect(bridgeMocks.chatAbortRewind).toHaveBeenCalledTimes(1));
			expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		}
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

	it("resolves rewind without changing renderer history when persistence is rejected", async () => {
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		bridgeMocks.get.mockResolvedValue({ success: true, document: sampleDoc });
		await startPendingRewind(Promise.resolve(preparedRewind()));

		await waitFor(() =>
			expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				"rewind_1",
				"failed",
			),
		);
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({ document: sampleDoc, dirty: false });
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Rewind failed",
			expect.objectContaining({ description: "disk full" }),
		);
	});

	it("does not commit rewind history when a newer edit supersedes its in-flight save", async () => {
		const prepared = preparedRewind("rewind_superseded_save");
		const rewindSave = deferred<{ success: true; document: AxcutDocument }>();
		const savedDocuments: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			savedDocuments.push(document);
			return savedDocuments.length === 1
				? rewindSave.promise
				: Promise.resolve({ success: true as const, document });
		});
		bridgeMocks.get.mockResolvedValue({ success: true, document: prepared.document });
		await startPendingRewind(Promise.resolve(prepared));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(prepared.document));

		const winner = withTitle(sampleDoc, "Newer saved edit during rewind");
		act(() => useProjectStore.getState().setDocument(winner));
		const savingWinner = useProjectStore.getState().saveDocument(winner);
		await act(async () => {
			rewindSave.resolve({ success: true, document: prepared.document });
			await rewindSave.promise;
			await savingWinner;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				prepared.operationId,
				"superseded",
			),
		);
		expect(savedDocuments).toEqual([prepared.document, winner]);
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer saved edit during rewind" } },
			dirty: false,
		});
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
	});

	it("commits rewind history when a lost save response reconciles to the intended document", async () => {
		const prepared = preparedRewind();
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({ success: true, document: prepared.document });
		bridgeMocks.chatCommitRewind.mockResolvedValue({
			success: true,
			messages: prepared.messages,
			sessionRevision: prepared.sessionRevision + 1,
			pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
		});
		await startPendingRewind(Promise.resolve(prepared));

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Rewound document" } },
			dirty: false,
		});
		expect(screen.queryByText("Applied the old edit.")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Try this edit",
			),
		);
	});

	it("commits rewind history after a same-project reopen reads the persisted document", async () => {
		const prepared = preparedRewind("rewind_same_project_reopen");
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const reloading = deferred<{ success: true; document: AxcutDocument }>();
		const readback = deferred<{ success: true; document: AxcutDocument }>();
		const committed = {
			success: true as const,
			messages: prepared.messages,
			sessionRevision: prepared.sessionRevision + 1,
			pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
		};
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockReturnValueOnce(reloading.promise).mockReturnValueOnce(readback.promise);
		bridgeMocks.chatCommitRewind.mockResolvedValue(committed);
		await startPendingRewind(Promise.resolve(prepared));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(prepared.document));

		let reopen!: Promise<void>;
		act(() => {
			reopen = useProjectStore.getState().loadProject("proj_a");
		});
		saving.resolve({ success: true, document: prepared.document });
		await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(2));
		await act(async () => {
			reloading.resolve({ success: true, document: prepared.document });
			await reopen;
		});
		await act(async () => {
			readback.resolve({ success: true, document: prepared.document });
			await readback.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("");
		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: committed.sessionRevision,
				operationId: prepared.operationId,
				kind: "rewind",
				messages: committed.messages,
				pendingComposerRestoration: committed.pendingComposerRestoration,
			});
		});

		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Try this edit",
			),
		);
		expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1);
	});

	it("commits Project A rewind history while a failing Project B load retains it", async () => {
		const prepared = preparedRewind("rewind_while_project_b_loads");
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: false; error: string }>();
		const committed = {
			success: true as const,
			messages: prepared.messages,
			sessionRevision: prepared.sessionRevision + 1,
			pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
		};
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: prepared.document }),
		);
		bridgeMocks.chatCommitRewind.mockImplementation(async () => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: committed.sessionRevision,
				operationId: prepared.operationId,
				kind: "rewind",
				messages: committed.messages,
				pendingComposerRestoration: committed.pendingComposerRestoration,
			});
			return committed;
		});
		await startPendingRewind(Promise.resolve(prepared));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(prepared.document));

		const selectCalls = bridgeMocks.chatSelectSession.mock.calls.length;
		let loading!: Promise<void>;
		await act(async () => {
			loading = useProjectStore.getState().loadProject("proj_b");
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession.mock.calls.length).toBeGreaterThan(selectCalls),
		);
		await act(async () => {
			saving.resolve({ success: true, document: prepared.document });
			await saving.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Try this edit",
			),
		);
		expect(bridgeMocks.chatResolvePersistence).not.toHaveBeenCalled();
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(screen.queryByText("Applied the old edit.")).not.toBeInTheDocument();

		await act(async () => {
			loadingProjectB.resolve({ success: false, error: "Project B unavailable" });
			await loading;
		});
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_a",
			document: prepared.document,
			status: "error",
			error: "Project B unavailable",
			dirty: false,
		});
		expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1);
		expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue("Try this edit");
	});

	it("adopts a differing authoritative save and resolves rewind history", async () => {
		const authoritative = withTitle(sampleDoc, "Different authoritative document");
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({ success: true, document: authoritative });
		await startPendingRewind(Promise.resolve(preparedRewind()));

		await waitFor(() => expect(bridgeMocks.chatResolvePersistence).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Different authoritative document" } },
			dirty: false,
		});
		expect(screen.getByText("Applied the old edit.")).toBeInTheDocument();
		expect(toastMocks.error).toHaveBeenCalledWith(
			"Rewind failed",
			expect.objectContaining({ description: "response lost" }),
		);
	});

	it("applies, persists, and commits a prepared rewind exactly once", async () => {
		const prepared = preparedRewind();
		bridgeMocks.chatCommitRewind.mockResolvedValue({
			success: true,
			messages: prepared.messages,
			sessionRevision: prepared.sessionRevision + 1,
			pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
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
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Try this edit",
			),
		);
		expect(bridgeMocks.chatClaimRewindComposer).toHaveBeenCalledWith(
			"proj_a",
			"session_1",
			prepared.sessionRevision + 1,
		);
	});

	it("retries an ambiguous rewind history commit and applies its canonical result once", async () => {
		const prepared = preparedRewind();
		bridgeMocks.chatCommitRewind
			.mockRejectedValueOnce(new Error("commit reply lost"))
			.mockResolvedValue({
				success: true,
				messages: prepared.messages,
				sessionRevision: prepared.sessionRevision + 1,
				pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
			});
		await startPendingRewind(Promise.resolve(prepared));

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(2));
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(screen.queryByText("Applied the old edit.")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Describe the edit you want.")).toHaveValue(
				"Try this edit",
			),
		);
	});

	it("invalidates an unmounted rewind preparation and aborts it when the reply arrives", async () => {
		const preparing = deferred<ReturnType<typeof preparedRewind>>();
		const view = await startPendingRewind(preparing.promise);
		view.unmount();

		await act(async () => {
			preparing.resolve(preparedRewind("rewind_after_unmount"));
			await preparing.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatAbortRewind).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				"rewind_after_unmount",
			),
		);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(bridgeMocks.chatCommitRewind).not.toHaveBeenCalled();
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it("finishes rewind commit after unmount once document persistence has started", async () => {
		const prepared = preparedRewind("rewind_persisting_unmount");
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.chatCommitRewind.mockResolvedValue({
			success: true,
			messages: prepared.messages,
			sessionRevision: prepared.sessionRevision + 1,
			pendingComposerRestoration: { revision: prepared.sessionRevision + 1 },
		});
		const view = await startPendingRewind(Promise.resolve(prepared));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		view.unmount();
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();

		await act(async () => {
			saving.resolve({ success: true, document: prepared.document });
			await saving.promise;
		});

		await waitFor(() => expect(bridgeMocks.chatCommitRewind).toHaveBeenCalledTimes(1));
		expect(bridgeMocks.chatAbortRewind).not.toHaveBeenCalled();
		expect(toastMocks.success).not.toHaveBeenCalled();
	});

	it("cleans up a session created after the sending panel unmounts", async () => {
		const creating = deferred<{
			id: string;
			projectId: string;
			title: string;
			createdAt: string;
			messageCount: number;
		}>();
		bridgeMocks.chatListSessions.mockResolvedValue([]);
		bridgeMocks.chatCreateSession.mockReturnValue(creating.promise);
		const view = renderPanel();
		await waitFor(() => expect(bridgeMocks.chatListSessions).toHaveBeenCalled());
		fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
			target: { value: "Improve this edit" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(bridgeMocks.chatCreateSession).toHaveBeenCalledTimes(1));
		view.unmount();

		creating.resolve({
			id: "session_after_unmount",
			projectId: "proj_a",
			title: "Conversation",
			createdAt: "2026-08-16T10:00:00.000Z",
			messageCount: 0,
		});
		await creating.promise;

		await waitFor(() =>
			expect(bridgeMocks.chatDeleteSession).toHaveBeenCalledWith("proj_a", "session_after_unmount"),
		);
		expect(bridgeMocks.chatRun).not.toHaveBeenCalled();
		expect(toastMocks.error).not.toHaveBeenCalled();
	});

	it("reserves an async new-session action against overlapping chat send", async () => {
		const creating = deferred<{
			id: string;
			projectId: string;
			title: string;
			createdAt: string;
			messageCount: number;
		}>();
		bridgeMocks.chatCreateSession.mockReturnValue(creating.promise);
		renderPanel();
		await waitFor(() => expect(bridgeMocks.chatSelectSession).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
		await waitFor(() => expect(bridgeMocks.chatCreateSession).toHaveBeenCalledTimes(1));
		fireEvent.change(screen.getByPlaceholderText("Describe the edit you want."), {
			target: { value: "Must wait" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(bridgeMocks.chatRun).not.toHaveBeenCalled();

		creating.resolve({
			id: "new_session",
			projectId: "proj_a",
			title: "Conversation 2",
			createdAt: "2026-08-16T10:00:00.000Z",
			messageCount: 0,
		});
		await creating.promise;
		await waitFor(() =>
			expect(bridgeMocks.chatSelectSession).toHaveBeenCalledWith("proj_a", "new_session"),
		);
		expect(bridgeMocks.chatRun).not.toHaveBeenCalled();
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
			revision: 4,
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

	it("begins persistence without scheduling a renderer heartbeat", async () => {
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const run = deferred<ReturnType<typeof chatResult>>();
		await startPendingChat(run.promise);
		const operationId = bridgeMocks.chatRun.mock.calls[0][4] as string;

		await act(async () => {
			run.resolve(chatResult(withTitle(sampleDoc, "Persisted without heartbeat")));
			await run.promise;
		});

		await waitFor(() =>
			expect(bridgeMocks.chatBeginPersistence).toHaveBeenCalledWith(
				"proj_a",
				"session_1",
				operationId,
			),
		);
		expect(intervalSpy.mock.calls.some(([, timeout]) => timeout === 60_000)).toBe(false);
	});

	it("ignores stale reasoning and preserves the current trace on the canonical result", async () => {
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
			run.resolve(chatResult(withTitle(sampleDoc, "Reasoned edit")));
			await run.promise;
		});
		await waitFor(() => expect(bridgeMocks.chatCommitRun).toHaveBeenCalledTimes(1));
		expect(screen.getByText("current reasoning")).toBeInTheDocument();

		act(() => {
			chatSessionUpdateListener?.({
				projectId: "proj_a",
				sessionId: "session_1",
				revision: 1,
				operationId,
				kind: "chat",
				messages: canonicalChatCommit().messages,
			});
		});
		expect(screen.getByText("current reasoning")).toBeInTheDocument();
	});
});
