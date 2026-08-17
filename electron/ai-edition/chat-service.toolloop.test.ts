// Tool-loop behavior of runChat (P1.2–P1.5, P1.8, P2.5) with a mocked deep
// agent. The deep-agent port routes the loop through LangGraph
// (`createDeepAgent`); rather than mocking the LangChain chat model the
// tests mock `invokeOpenScreenAgent` directly — that's the seam chat-service
// crosses to drive the agentic turn.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";

vi.mock("./deep-agent/service", () => ({
	invokeOpenScreenAgent: vi.fn(),
}));

import {
	abortChatRun,
	abortRewindToMessage,
	beginChatOperationPersistence,
	commitChatRun,
	commitRewindToMessage,
	createSession,
	deleteSession,
	getChatOperationStatus,
	prepareRewindToMessage,
	renameSession,
	resolveChatOperationPersistence,
	runChat,
	subscribeChatSessionUpdates,
} from "./chat-service";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import type { LlmConfigStore } from "./llm-config-store";

const invokeMock = vi.mocked(invokeOpenScreenAgent);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_loop" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

function stubConfig(overrides: Record<string, unknown> = {}): LlmConfigStore {
	return {
		getConfig: () => ({ provider: "openai", model: "gpt-4o", ...overrides }),
		getApiKey: () => "sk-test",
		getCredential: (_id: string, _envKeys: string[]) => ({
			value: "sk-test",
			entry: { kind: "api-key", apiKey: "sk-test" },
		}),
	} as unknown as LlmConfigStore;
}

// ponytail: a tiny stub that simulates the deep agent. It captures the args
// chat-service hands it, emits the sink events a real agent would emit (text
// deltas, tool lifecycle, errors), and returns the simulated result.
//
// Tests compose each scenario by giving `simulate` callbacks that drive the
// sink — that's the public contract the orchestrator cares about, so the
// tests no longer reach inside the LangGraph state machine.
interface CapturedInvoke {
	args: {
		document: AxcutDocument;
		model: { provider: string; model: string };
		history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
		userMessage: string;
		editsAllowed?: boolean;
	};
}

interface ToolLoopFixture {
	events: { kind: string; payload: unknown }[];
	captured: CapturedInvoke[];
}

function resetFixture(): ToolLoopFixture {
	return { events: [], captured: [] };
}

let fixture: ToolLoopFixture = resetFixture();

beforeEach(() => {
	fixture = resetFixture();
	invokeMock.mockReset();
	// ponytail: default mock — tests override per-scenario.
	invokeMock.mockImplementation(async (args) => {
		fixture.captured.push({ args });
		return { text: "ok", document: args.document, mutated: false };
	});
});

afterEach(() => {
	vi.useRealTimers();
});

// ponytail: tool chain driven by a generator — each `next()` call resolves to
// the next sink event (text delta / toolStart / toolEnd / error). The
// generator yields `null` to end the loop.
async function streamAgent(
	args: Parameters<typeof invokeOpenScreenAgent>[0],
	events: ReadonlyArray<{ kind: string; payload: unknown }>,
): Promise<{ text: string; document: AxcutDocument; mutated: boolean }> {
	const sink = args.sink;
	for (const event of events) {
		switch (event.kind) {
			case "text":
				sink.text(event.payload as string);
				break;
			case "toolStart":
				sink.toolStart(
					(event.payload as { name: string }).name,
					(event.payload as { args: unknown }).args,
				);
				break;
			case "toolEnd":
				sink.toolEnd(
					(event.payload as { name: string }).name,
					(event.payload as { ok: boolean }).ok,
					(event.payload as { summary?: string }).summary,
				);
				break;
			case "error":
				sink.error(event.payload as string);
				break;
		}
	}
	return {
		text: "Done.",
		document: args.document,
		mutated: false,
	};
}

describe("runChat tool loop", () => {
	it("stages renderer chat history until explicit commit and can abort without contamination", async () => {
		const { selectSession } = await import("./chat-service");
		const session = createSession("proj_staged_chat");
		const result = await runChat(
			"proj_staged_chat",
			session.id,
			"pending turn",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_abort",
		);
		expect(result.success).toBe(true);
		expect(selectSession("proj_staged_chat", session.id)?.messages).toEqual([]);
		expect(abortChatRun("proj_staged_chat", session.id, "run_abort")).toEqual({ success: true });
		expect(selectSession("proj_staged_chat", session.id)?.messages).toEqual([]);

		await runChat(
			"proj_staged_chat",
			session.id,
			"committed turn",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_commit",
		);
		expect(selectSession("proj_staged_chat", session.id)?.messages).toEqual([]);
		const committedRun = commitChatRun("proj_staged_chat", session.id, "run_commit");
		expect(committedRun).toMatchObject({
			success: true,
			sessionRevision: 1,
		});
		expect(selectSession("proj_staged_chat", session.id)?.messages).toHaveLength(2);
		expect(commitChatRun("proj_staged_chat", session.id, "run_commit")).toEqual(committedRun);
		expect(
			beginChatOperationPersistence("proj_staged_chat", session.id, "run_commit").success,
		).toBe(false);
		expect(getChatOperationStatus("proj_staged_chat", session.id, "run_commit")).toMatchObject({
			state: "committed",
			result: committedRun,
		});
	});

	it("executes tool calls, chains turns, and returns the mutated document", async () => {
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.toolStart("addTrim", { startSec: 5, endSec: 8, reason: "silence" });
			args.sink.toolEnd("addTrim", true, "added trim 0:05.0 – 0:08.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const session = createSession("proj_loop");
		const result = await runChat(
			"proj_loop",
			session.id,
			"cut the silence",
			stubConfig(),
			fixtureDocument(),
		);

		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("Done.");
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls?.[0].summary).toMatch(/added trim/);
	});

	it("rewinds to before the user message, restoring the document", async () => {
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.toolStart("addTrim", { startSec: 1, endSec: 2 });
			args.sink.toolEnd("addTrim", true, "added trim 0:01.0 – 0:02.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const session = createSession("proj_rewind");
		const result = await runChat(
			"proj_rewind",
			session.id,
			"cut the silence",
			stubConfig(),
			fixtureDocument(),
		);
		expect(result.success).toBe(true);
		const userMessage = result.assistantMessage; // ignored; we want the user message id
		void userMessage;

		const sessionMessages = (await import("./chat-service")).selectSession(
			"proj_rewind",
			session.id,
		);
		expect(sessionMessages?.messages).toHaveLength(2);
		const user = sessionMessages?.messages[0];
		expect(user?.role).toBe("user");
		expect(user?.checkpointId).toBe(user?.id);

		const prepared = prepareRewindToMessage("proj_rewind", session.id, user!.id);
		expect(prepared.success).toBe(true);
		if (!prepared.success) return;
		const restored = documentSchema.parse(prepared.document);
		expect(restored.timeline.trimRanges).toHaveLength(0);
		expect(prepared.prompt).toBe("cut the silence");
		expect(
			(await import("./chat-service")).selectSession("proj_rewind", session.id)?.messages,
		).toHaveLength(2);
		expect(beginChatOperationPersistence("proj_rewind", session.id, prepared.operationId)).toEqual({
			success: true,
		});

		const committed = commitRewindToMessage(
			"proj_rewind",
			session.id,
			prepared.operationId,
			prepared.sessionRevision,
		);
		expect(committed.success).toBe(true);
		expect(
			(await import("./chat-service")).selectSession("proj_rewind", session.id)?.messages,
		).toHaveLength(1);
		expect(
			commitRewindToMessage(
				"proj_rewind",
				"foreign_session",
				prepared.operationId,
				prepared.sessionRevision,
			).success,
		).toBe(false);
		expect(
			abortRewindToMessage("proj_rewind", "foreign_session", prepared.operationId).success,
		).toBe(false);
		expect(
			commitRewindToMessage(
				"proj_rewind",
				session.id,
				prepared.operationId,
				prepared.sessionRevision,
			),
		).toEqual(committed);
	});

	it("keeps persistence valid while renderer timers are suspended beyond five minutes", async () => {
		vi.useFakeTimers();
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "done",
			document: args.document,
			mutated: true,
		}));
		const projectId = "proj_suspended_persistence";
		const session = createSession(projectId);
		await runChat(
			projectId,
			session.id,
			"long save",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_suspended_persistence",
		);
		expect(
			getChatOperationStatus(projectId, session.id, "run_suspended_persistence"),
		).toMatchObject({
			state: "prepared",
		});
		expect(
			beginChatOperationPersistence(projectId, session.id, "run_suspended_persistence"),
		).toEqual({
			success: true,
		});

		await vi.advanceTimersByTimeAsync(6 * 60_000);
		expect(
			getChatOperationStatus(projectId, session.id, "run_suspended_persistence"),
		).toMatchObject({
			state: "persisting",
		});
		expect(commitChatRun(projectId, session.id, "run_suspended_persistence")).toMatchObject({
			success: true,
		});
	});

	it("retains bounded late-persistence evidence after the session lock deadline", async () => {
		vi.useFakeTimers();
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "done",
			document: args.document,
			mutated: true,
		}));
		const projectId = "proj_late_persistence";
		const session = createSession(projectId);
		await runChat(
			projectId,
			session.id,
			"late save",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_late_persistence",
		);
		beginChatOperationPersistence(projectId, session.id, "run_late_persistence");

		await vi.advanceTimersByTimeAsync(11 * 60_000);
		expect(getChatOperationStatus(projectId, session.id, "run_late_persistence")).toMatchObject({
			state: "late-persistence",
		});
		expect(commitChatRun(projectId, session.id, "run_late_persistence")).toMatchObject({
			success: true,
		});
	});

	it("resolves confirmed failed persistence and releases the session lock", async () => {
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "done",
			document: args.document,
			mutated: true,
		}));
		const projectId = "proj_failed_persistence";
		const session = createSession(projectId);
		await runChat(
			projectId,
			session.id,
			"failed save",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_failed_persistence",
		);
		expect(beginChatOperationPersistence(projectId, session.id, "run_failed_persistence")).toEqual({
			success: true,
		});
		expect(
			resolveChatOperationPersistence(projectId, "foreign_session", "run_failed_persistence")
				.success,
		).toBe(false);
		expect(
			resolveChatOperationPersistence(projectId, session.id, "run_failed_persistence"),
		).toEqual({
			success: true,
		});
		expect(getChatOperationStatus(projectId, session.id, "run_failed_persistence")).toMatchObject({
			state: "aborted",
		});
		await expect(
			runChat(
				projectId,
				session.id,
				"replacement",
				stubConfig(),
				fixtureDocument(),
				{},
				{},
				"replacement_after_failed_save",
			),
		).resolves.toMatchObject({ success: true });
		expect(abortChatRun(projectId, session.id, "replacement_after_failed_save")).toEqual({
			success: true,
		});
	});

	it("bounds a permanently pending save and eventually releases its lock and evidence", async () => {
		vi.useFakeTimers();
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "done",
			document: args.document,
			mutated: true,
		}));
		const projectId = "proj_hung_persistence";
		const session = createSession(projectId);
		await runChat(
			projectId,
			session.id,
			"hung save",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_hung_persistence",
		);
		beginChatOperationPersistence(projectId, session.id, "run_hung_persistence");

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await expect(
			runChat(
				projectId,
				session.id,
				"replacement",
				stubConfig(),
				fixtureDocument(),
				{},
				{},
				"replacement_after_hung_save",
			),
		).resolves.toMatchObject({ success: true });
		expect(abortChatRun(projectId, session.id, "replacement_after_hung_save")).toEqual({
			success: true,
		});
		expect(getChatOperationStatus(projectId, session.id, "run_hung_persistence")).toMatchObject({
			state: "late-persistence",
		});

		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(getChatOperationStatus(projectId, session.id, "run_hung_persistence")).toMatchObject({
			state: "aborted",
		});
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(getChatOperationStatus(projectId, session.id, "run_hung_persistence")).toEqual({
			state: "unknown",
			operationId: "run_hung_persistence",
		});
	});

	it("expires abandoned running and prepared operations without renderer renewal", async () => {
		vi.useFakeTimers();
		const agent = deferred<{ text: string; document: AxcutDocument; mutated: boolean }>();
		invokeMock.mockReturnValueOnce(agent.promise);
		const runningSession = createSession("proj_abandoned_running");
		const running = runChat(
			"proj_abandoned_running",
			runningSession.id,
			"abandoned",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_abandoned_running",
		);
		await vi.advanceTimersByTimeAsync(15 * 60_000);
		agent.resolve({ text: "late", document: fixtureDocument(), mutated: false });
		await expect(running).resolves.toMatchObject({ success: false });

		const preparedSession = createSession("proj_abandoned_prepared");
		await runChat(
			"proj_abandoned_prepared",
			preparedSession.id,
			"prepared",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_abandoned_prepared",
		);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(
			getChatOperationStatus(
				"proj_abandoned_prepared",
				preparedSession.id,
				"run_abandoned_prepared",
			),
		).toMatchObject({ state: "aborted" });
	});

	it("does not let a late failed run consume a newer reuse of its expired id", async () => {
		vi.useFakeTimers();
		const abandoned = deferred<{ text: string; document: AxcutDocument; mutated: boolean }>();
		const replacement = deferred<{ text: string; document: AxcutDocument; mutated: boolean }>();
		invokeMock.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(replacement.promise);
		const projectId = "proj_reused_operation_id";
		const session = createSession(projectId);
		const abandonedRun = runChat(
			projectId,
			session.id,
			"abandoned",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"reused_operation_id",
		);
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		expect(getChatOperationStatus(projectId, session.id, "reused_operation_id")).toEqual({
			state: "unknown",
			operationId: "reused_operation_id",
		});

		const replacementRun = runChat(
			projectId,
			session.id,
			"replacement",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"reused_operation_id",
		);
		abandoned.reject(new Error("late provider failure"));
		await expect(abandonedRun).rejects.toThrow("late provider failure");
		expect(getChatOperationStatus(projectId, session.id, "reused_operation_id")).toMatchObject({
			state: "running",
		});

		replacement.resolve({ text: "replacement done", document: fixtureDocument(), mutated: false });
		await expect(replacementRun).resolves.toMatchObject({ success: true });
		expect(commitChatRun(projectId, session.id, "reused_operation_id")).toMatchObject({
			success: true,
		});
	});

	it("does not let foreign commit or abort calls consume pending or completed operations", async () => {
		const session = createSession("proj_foreign_operation");
		await runChat(
			"proj_foreign_operation",
			session.id,
			"edit",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"run_foreign_operation",
		);

		expect(
			abortChatRun("proj_foreign_operation", "foreign_session", "run_foreign_operation").success,
		).toBe(false);
		expect(renameSession("proj_foreign_operation", session.id, "Blocked rename")).toBeNull();
		expect(deleteSession("proj_foreign_operation", session.id)).toBe(false);
		const committed = commitChatRun("proj_foreign_operation", session.id, "run_foreign_operation");
		expect(committed).toMatchObject({ success: true });
		expect(
			commitChatRun("proj_foreign_operation", "foreign_session", "run_foreign_operation").success,
		).toBe(false);
		expect(
			abortChatRun("proj_foreign_operation", "foreign_session", "run_foreign_operation").success,
		).toBe(false);
		expect(commitChatRun("proj_foreign_operation", session.id, "run_foreign_operation")).toEqual(
			committed,
		);
		expect(
			getChatOperationStatus("proj_foreign_operation", "foreign_session", "run_foreign_operation"),
		).toEqual({ state: "unknown", operationId: "run_foreign_operation" });
		expect(
			abortChatRun("proj_foreign_operation", session.id, "run_foreign_operation").success,
		).toBe(false);
	});

	it("bounds completed tombstones, expires status, and emits one canonical update", async () => {
		const updates: unknown[] = [];
		const unsubscribe = subscribeChatSessionUpdates((update) => updates.push(update));
		const projectId = "proj_tombstone_bound";
		const session = createSession(projectId);
		for (let index = 0; index <= 256; index++) {
			const operationId = `bounded_run_${index}`;
			await runChat(
				projectId,
				session.id,
				`edit ${index}`,
				stubConfig(),
				fixtureDocument(),
				{},
				{},
				operationId,
			);
			expect(commitChatRun(projectId, session.id, operationId).success).toBe(true);
		}
		expect(commitChatRun(projectId, session.id, "bounded_run_0").success).toBe(false);
		expect(commitChatRun(projectId, session.id, "bounded_run_256").success).toBe(true);
		expect(updates).toHaveLength(257);
		commitChatRun(projectId, session.id, "bounded_run_256");
		expect(updates).toHaveLength(257);
		unsubscribe();

		vi.useFakeTimers();
		const expiringSession = createSession("proj_tombstone_expiry");
		await runChat(
			"proj_tombstone_expiry",
			expiringSession.id,
			"edit",
			stubConfig(),
			fixtureDocument(),
			{},
			{},
			"expiring_tombstone",
		);
		expect(
			commitChatRun("proj_tombstone_expiry", expiringSession.id, "expiring_tombstone").success,
		).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(
			getChatOperationStatus("proj_tombstone_expiry", expiringSession.id, "expiring_tombstone"),
		).toEqual({ state: "unknown", operationId: "expiring_tombstone" });
	});

	it("prepareRewindToMessage refuses when the target has no checkpoint", async () => {
		const { createSession, selectSession, runChat } = await import("./chat-service");
		const session = createSession("proj_rewind_no_cp");
		await runChat(
			"proj_rewind_no_cp",
			session.id,
			"hi",
			stubConfig(),
			// text-only: no document → no checkpoint
		);
		const userId = selectSession("proj_rewind_no_cp", session.id)?.messages[0].id;
		const result = prepareRewindToMessage("proj_rewind_no_cp", session.id, userId!);
		expect(result.success).toBe(false);
	});

	it("prepareRewindToMessage rejects targeting an assistant message", async () => {
		const { createSession, listSessions, selectSession, runChat } = await import("./chat-service");
		const session = createSession("proj_rewind_aimessage");
		await runChat("proj_rewind_aimessage", session.id, "hi", stubConfig(), fixtureDocument());
		const assistant = selectSession("proj_rewind_aimessage", session.id)?.messages.find(
			(m) => m.role === "assistant",
		);
		const result = prepareRewindToMessage("proj_rewind_aimessage", session.id, assistant!.id);
		expect(result.success).toBe(false);
		void listSessions;
	});

	it("aborts a prepared rewind without changing messages or consuming its checkpoint", async () => {
		const { selectSession } = await import("./chat-service");
		const session = createSession("proj_rewind_abort");
		await runChat("proj_rewind_abort", session.id, "first turn", stubConfig(), fixtureDocument());
		const before = selectSession("proj_rewind_abort", session.id)!;
		const targetId = before.messages[0].id;
		const prepared = prepareRewindToMessage("proj_rewind_abort", session.id, targetId);
		expect(prepared.success).toBe(true);
		if (!prepared.success) return;

		expect(abortRewindToMessage("proj_rewind_abort", session.id, prepared.operationId)).toEqual({
			success: true,
		});
		expect(selectSession("proj_rewind_abort", session.id)?.messages).toEqual(before.messages);
		const retry = prepareRewindToMessage("proj_rewind_abort", session.id, targetId);
		expect(retry.success).toBe(true);
		if (retry.success) {
			abortRewindToMessage("proj_rewind_abort", session.id, retry.operationId);
		}
	});

	it("refuses a rewind commit with the wrong prepared revision without truncating", async () => {
		const { selectSession } = await import("./chat-service");
		const session = createSession("proj_rewind_revision");
		await runChat(
			"proj_rewind_revision",
			session.id,
			"first turn",
			stubConfig(),
			fixtureDocument(),
		);
		const before = selectSession("proj_rewind_revision", session.id)!;
		const prepared = prepareRewindToMessage(
			"proj_rewind_revision",
			session.id,
			before.messages[0].id,
		);
		expect(prepared.success).toBe(true);
		if (!prepared.success) return;
		expect(
			beginChatOperationPersistence("proj_rewind_revision", session.id, prepared.operationId),
		).toEqual({ success: true });

		const commit = commitRewindToMessage(
			"proj_rewind_revision",
			session.id,
			prepared.operationId,
			prepared.sessionRevision + 1,
		);
		expect(commit.success).toBe(false);
		expect(selectSession("proj_rewind_revision", session.id)?.messages).toEqual(before.messages);
		expect(
			resolveChatOperationPersistence("proj_rewind_revision", session.id, prepared.operationId),
		).toEqual({ success: true });
	});

	it("runs text-only when no document snapshot is provided", async () => {
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "Hi!",
			document: args.document,
			mutated: false,
		}));
		const s = createSession("proj_text_only");
		const result = await runChat("proj_text_only", s.id, "hello", stubConfig());
		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("Hi!");
		expect(result.document).toBeUndefined();
	});

	it("forwards text deltas, tool lifecycle, and errors through the ChatEventSink", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		invokeMock.mockImplementationOnce(async (args) => {
			events.push({ kind: "captured", payload: args.userMessage });
			args.sink.text("Hi ");
			args.sink.thinking("pondering. ");
			args.sink.text("there.");
			args.sink.thinking("concluding.");
			args.sink.toolStart("addTrim", { startSec: 1, endSec: 2 });
			args.sink.toolEnd("addTrim", true, "added trim 0:01.0 – 0:02.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const sink = {
			text: (delta: string) => fixture.events.push({ kind: "text", payload: delta }),
			thinking: (delta: string) => fixture.events.push({ kind: "thinking", payload: delta }),
			toolStart: (name: string, args: unknown) =>
				fixture.events.push({ kind: "toolStart", payload: { name, args } }),
			toolEnd: (name: string, ok: boolean, summary?: string) =>
				fixture.events.push({ kind: "toolEnd", payload: { name, ok, summary } }),
			error: (message: string) => fixture.events.push({ kind: "error", payload: message }),
		};

		const s = createSession("proj_sink");
		const result = await runChat("proj_sink", s.id, "cut", stubConfig(), fixtureDocument(), sink);
		expect(result.success).toBe(true);
		expect(fixture.events.map((e) => e.kind)).toEqual([
			"text",
			"thinking",
			"text",
			"thinking",
			"toolStart",
			"toolEnd",
		]);
		expect((fixture.events[0].payload as string) + (fixture.events[2].payload as string)).toBe(
			"Hi there.",
		);
		expect((fixture.events[1].payload as string) + (fixture.events[3].payload as string)).toBe(
			"pondering. concluding.",
		);
		expect(fixture.events[4].payload).toMatchObject({ name: "addTrim" });
		expect(fixture.events[5].payload).toMatchObject({
			name: "addTrim",
			ok: true,
			summary: expect.stringMatching(/added trim/),
		});

		// ponytail: empty-result path. When the deep agent returns no text,
		// runChat surfaces "Empty response from model." — this is the second
		// major behavior we want a regression test for.
		fixture.events.length = 0;
		invokeMock.mockReset();
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.error("Upstream 404 404 Page not found");
			return { text: "", document: args.document, mutated: false };
		});
		const sinkErr = {
			text: (delta: string) => fixture.events.push({ kind: "text", payload: delta }),
			thinking: (delta: string) => fixture.events.push({ kind: "thinking", payload: delta }),
			toolStart: (name: string, args: unknown) =>
				fixture.events.push({ kind: "toolStart", payload: { name, args } }),
			toolEnd: (name: string, ok: boolean, summary?: string) =>
				fixture.events.push({ kind: "toolEnd", payload: { name, ok, summary } }),
			error: (message: string) => fixture.events.push({ kind: "error", payload: message }),
		};
		const errResult = await runChat(
			"proj_sink_err",
			createSession("proj_sink_err").id,
			"x",
			stubConfig(),
			fixtureDocument(),
			sinkErr,
		);
		expect(errResult.success).toBe(false);
		expect(errResult.error).toMatch(/Empty response/);
		expect(fixture.events.map((e) => e.kind)).toEqual(["error"]);
		expect(fixture.events[0].payload).toMatch(/Upstream 404/);

		// ponytail: keep TS happy about `events` — the variable is used above.
		void events;
		void streamAgent;
	});
});

// ── D-CONSENT ───────────────────────────────────────────────────────────────
//
// `allowAgentEdits` is offered in Settings as "Project edits — when off, the
// agent must ask before changing the timeline". `runChat` computed
// `const editsAllowed = config.allowAgentEdits !== false;` and then, twenty
// lines later, `void editsAllowed;`. That was every use of it: it reached
// neither the tools nor the prompt, and `git log -S` shows it never had.
describe("allowAgentEdits reaches the agent", () => {
	it("passes the flag down when the setting is off", async () => {
		const session = createSession("proj_consent_off");
		await runChat(
			"proj_consent_off",
			session.id,
			"cut the silences",
			stubConfig({ allowAgentEdits: false }),
			fixtureDocument(),
		);
		expect(fixture.captured.at(-1)?.args.editsAllowed).toBe(false);
	});

	it("passes it as allowed when the setting is on, or absent", async () => {
		for (const config of [stubConfig(), stubConfig({ allowAgentEdits: true })]) {
			const session = createSession("proj_consent_on");
			await runChat("proj_consent_on", session.id, "cut it", config, fixtureDocument());
			expect(fixture.captured.at(-1)?.args.editsAllowed).toBe(true);
		}
	});

	it("withholds the document even if an agent somehow reports a mutation", async () => {
		// Belt and braces: this returned document is the only path to disk. If the
		// executor's guard were ever bypassed — a tool built outside the factory,
		// a future sub-agent — the setting would still hold here.
		invokeMock.mockReset();
		invokeMock.mockImplementation(async (args) => ({
			text: "I went ahead and cut them.",
			document: args.document,
			mutated: true,
		}));
		const session = createSession("proj_consent_belt");
		const result = await runChat(
			"proj_consent_belt",
			session.id,
			"cut the silences",
			stubConfig({ allowAgentEdits: false }),
			fixtureDocument(),
		);
		expect(result.success).toBe(true);
		expect(result.document).toBeUndefined();
	});

	it("returns the document normally when edits are allowed", async () => {
		invokeMock.mockReset();
		invokeMock.mockImplementation(async (args) => ({
			text: "Cut them.",
			document: args.document,
			mutated: true,
		}));
		const session = createSession("proj_consent_allowed");
		const result = await runChat(
			"proj_consent_allowed",
			session.id,
			"cut the silences",
			stubConfig(),
			fixtureDocument(),
		);
		expect(result.document).toBeDefined();
	});
});
