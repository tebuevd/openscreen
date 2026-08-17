import { describe, expect, it, vi } from "vitest";
import type { AiEditionChatSession } from "../../../src/native/contracts";
import type { DocumentService } from "../../ai-edition/document-service";
import type { LlmConfigStore } from "../../ai-edition/llm-config-store";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function serviceOptions(overrides: Partial<AiEditionServiceOptions> = {}): AiEditionServiceOptions {
	return {
		documents: {} as DocumentService,
		llmConfig: () => ({}) as LlmConfigStore,
		runChat: vi.fn(async () => ({ success: true })),
		commitChatRun: vi.fn(() => ({ success: false as const, error: "unused" })),
		abortChatRun: vi.fn(() => ({ success: true as const })),
		beginChatOperationPersistence: vi.fn(() => ({ success: true as const })),
		resolveChatOperationPersistence: vi.fn(() => ({ success: true as const })),
		getChatOperationStatus: vi.fn((_projectId, _sessionId, operationId) => ({
			state: "persisting" as const,
			kind: "chat" as const,
			operationId,
		})),
		prepareRewindToMessage: vi.fn(() => ({ success: false as const, error: "unused" })),
		commitRewindToMessage: vi.fn(() => ({ success: false as const, error: "unused" })),
		abortRewindToMessage: vi.fn(() => ({ success: true as const })),
		handleChatOwnerTeardown: vi.fn(async () => undefined),
		reconcileChatProject: vi.fn(async () => undefined),
		reconcileChatOperation: vi.fn(async () => undefined),
		compactNow: vi.fn(async () => null),
		getContextUsage: vi.fn(() => null),
		undoLastToolBatch: vi.fn(() => ({ success: false, error: "unused" })),
		listSessions: vi.fn(() => []),
		createSession: vi.fn(() => ({
			id: "session",
			projectId: "project",
			title: "Conversation",
			createdAt: "2026-08-17T00:00:00.000Z",
			messageCount: 0,
		})),
		selectSession: vi.fn(() => null),
		claimRewindComposer: vi.fn(() => ({
			claimed: true as const,
			prompt: "restored",
			claimId: "claim",
			leaseExpiresAt: 100,
		})),
		confirmRewindComposerClaim: vi.fn(() => ({
			confirmed: true as const,
			alreadyConfirmed: false,
		})),
		releaseRewindComposerClaim: vi.fn(() => ({ released: true })),
		renameSession: vi.fn(() => null),
		deleteSession: vi.fn(() => false),
		...overrides,
	};
}

describe("AiEditionService chat document ownership", () => {
	it("forwards the opaque owner through document-bound chat operations", async () => {
		const options = serviceOptions();
		const service = new AiEditionService(options);
		const owner = {};

		await service.chatRun("project", "session", "edit", {}, "run", owner, {});
		service.chatCommitRun("project", "session", "run", owner);
		service.chatAbortRun("project", "session", "run", owner);
		service.chatBeginPersistence("project", "session", "run", owner);
		service.chatResolvePersistence("project", "session", "run", "failed", owner);
		service.chatPrepareRewind("project", "session", "message", owner);
		service.chatCommitRewind("project", "session", "rewind", 3, owner);
		service.chatAbortRewind("project", "session", "rewind", owner);

		expect(options.runChat).toHaveBeenCalledWith(
			"project",
			"session",
			"edit",
			{},
			"run",
			owner,
			{},
		);
		expect(options.commitChatRun).toHaveBeenCalledWith("project", "session", "run", owner);
		expect(options.abortChatRun).toHaveBeenCalledWith("project", "session", "run", owner);
		expect(options.beginChatOperationPersistence).toHaveBeenCalledWith(
			"project",
			"session",
			"run",
			owner,
		);
		expect(options.resolveChatOperationPersistence).toHaveBeenCalledWith(
			"project",
			"session",
			"run",
			"failed",
			owner,
		);
		expect(options.prepareRewindToMessage).toHaveBeenCalledWith(
			"project",
			"session",
			"message",
			owner,
		);
		expect(options.commitRewindToMessage).toHaveBeenCalledWith(
			"project",
			"session",
			"rewind",
			3,
			owner,
		);
		expect(options.abortRewindToMessage).toHaveBeenCalledWith(
			"project",
			"session",
			"rewind",
			owner,
		);
	});

	it("forwards owner-bound composer claim leases", () => {
		const options = serviceOptions();
		const service = new AiEditionService(options);
		const owner = {};

		expect(service.chatClaimRewindComposer("project", "session", 4, owner)).toEqual({
			claimed: true,
			prompt: "restored",
			claimId: "claim",
			leaseExpiresAt: 100,
		});
		expect(service.chatConfirmRewindComposerClaim("claim", owner)).toEqual({
			confirmed: true,
			alreadyConfirmed: false,
		});
		expect(service.chatReleaseRewindComposerClaim("claim", owner)).toEqual({ released: true });
		expect(options.claimRewindComposer).toHaveBeenCalledWith("project", "session", 4, owner);
		expect(options.confirmRewindComposerClaim).toHaveBeenCalledWith("claim", owner);
		expect(options.releaseRewindComposerClaim).toHaveBeenCalledWith("claim", owner);
	});

	it("triggers reconciliation without blocking replacement status and session reads", async () => {
		const projectReconciliation = deferred<void>();
		const session: AiEditionChatSession = {
			id: "session",
			projectId: "project",
			title: "Conversation",
			createdAt: "2026-08-17T00:00:00.000Z",
			messages: [],
			revision: 1,
		};
		const options = serviceOptions({
			reconcileChatProject: vi.fn(() => projectReconciliation.promise),
			listSessions: vi.fn(() => [
				{
					id: session.id,
					projectId: session.projectId,
					title: session.title,
					createdAt: session.createdAt,
					messageCount: session.messages.length,
				},
			]),
			selectSession: vi.fn(() => session),
		});
		const service = new AiEditionService(options);

		const listing = service.chatListSessions("project");
		const selecting = service.chatSelectSession("project", "session");
		await expect(listing).resolves.toHaveLength(1);
		await expect(selecting).resolves.toEqual(session);
		expect(options.reconcileChatProject).toHaveBeenCalledTimes(2);
		await service.chatOperationStatus("project", "session", "operation");
		expect(options.reconcileChatOperation).toHaveBeenCalledWith(
			"project",
			"session",
			"operation",
			options.documents,
		);
		projectReconciliation.resolve(undefined);
	});

	it("routes document-owner teardown to reconciliation with the shared document service", async () => {
		const options = serviceOptions();
		const service = new AiEditionService(options);
		const owner = {};

		await service.chatOwnerDestroyed(owner);

		expect(options.handleChatOwnerTeardown).toHaveBeenCalledWith(owner, options.documents);
	});
});
