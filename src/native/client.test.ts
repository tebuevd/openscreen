// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridgeClient } from "./client";

const invoke = vi.fn();

describe("native chat operation client", () => {
	beforeEach(() => {
		invoke.mockReset();
		invoke.mockResolvedValue({ ok: true, data: { success: true }, meta: {} });
		Object.assign(window, { electronAPI: { invokeNativeBridge: invoke } });
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only cleanup of the contextBridge stub
		delete (window as any).electronAPI;
	});

	it("sends staged chat run and persistence operation identities", async () => {
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			"session",
			"edit",
			{ version: 1 },
			"run-1",
		);
		await nativeBridgeClient.aiEdition.chatCommitRun("project", "session", "run-1");
		await nativeBridgeClient.aiEdition.chatAbortRun("project", "session", "run-2");
		await nativeBridgeClient.aiEdition.chatBeginPersistence("project", "session", "run-3");
		await nativeBridgeClient.aiEdition.chatOperationStatus("project", "session", "run-4");
		await nativeBridgeClient.aiEdition.chatResolvePersistence(
			"project",
			"session",
			"run-5",
			"superseded",
		);

		expect(invoke.mock.calls.map(([request]) => request)).toEqual([
			expect.objectContaining({
				action: "chat.run",
				payload: {
					projectId: "project",
					sessionId: "session",
					message: "edit",
					document: { version: 1 },
					operationId: "run-1",
				},
			}),
			expect.objectContaining({
				action: "chat.run.commit",
				payload: { projectId: "project", sessionId: "session", operationId: "run-1" },
			}),
			expect.objectContaining({
				action: "chat.run.abort",
				payload: { projectId: "project", sessionId: "session", operationId: "run-2" },
			}),
			expect.objectContaining({
				action: "chat.operation.beginPersistence",
				payload: { projectId: "project", sessionId: "session", operationId: "run-3" },
			}),
			expect.objectContaining({
				action: "chat.operation.status",
				payload: { projectId: "project", sessionId: "session", operationId: "run-4" },
			}),
			expect.objectContaining({
				action: "chat.operation.resolvePersistence",
				payload: {
					projectId: "project",
					sessionId: "session",
					operationId: "run-5",
					outcome: "superseded",
				},
			}),
		]);
	});

	it("sends rewind prepare commit and abort identities", async () => {
		await nativeBridgeClient.aiEdition.chatClaimComposerRestoration("project", "session", 6);
		await nativeBridgeClient.aiEdition.chatPrepareRewind("project", "session", "message");
		await nativeBridgeClient.aiEdition.chatCommitRewind("project", "session", "rewind-1", 7);
		await nativeBridgeClient.aiEdition.chatAbortRewind("project", "session", "rewind-2");

		expect(invoke.mock.calls.map(([request]) => request)).toEqual([
			expect.objectContaining({
				action: "chat.composerRestoration.claim",
				payload: { projectId: "project", sessionId: "session", revision: 6 },
			}),
			expect.objectContaining({
				action: "chat.rewind.prepare",
				payload: { projectId: "project", sessionId: "session", messageId: "message" },
			}),
			expect.objectContaining({
				action: "chat.rewind.commit",
				payload: {
					projectId: "project",
					sessionId: "session",
					operationId: "rewind-1",
					sessionRevision: 7,
				},
			}),
			expect.objectContaining({
				action: "chat.rewind.abort",
				payload: { projectId: "project", sessionId: "session", operationId: "rewind-2" },
			}),
		]);
	});
});
