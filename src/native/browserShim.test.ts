// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserShims } from "./browserShim";
import { nativeBridgeClient } from "./client";

describe("browser chat operation shim", () => {
	beforeEach(() => {
		localStorage.clear();
		window.history.replaceState({}, "", "/?browser");
		// biome-ignore lint/suspicious/noExplicitAny: the shim installs its own browser bridge
		delete (window as any).electronAPI;
		installBrowserShims();
	});

	afterEach(() => {
		vi.useRealTimers();
		window.history.replaceState({}, "", "/");
		// biome-ignore lint/suspicious/noExplicitAny: test-only cleanup of the browser bridge
		delete (window as any).electronAPI;
	});

	it("keeps chat messages staged until commit and discards aborted runs", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");

		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"discard me",
			undefined,
			"run-abort",
		);
		expect(
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", session.id))?.messages,
		).toEqual([]);
		await nativeBridgeClient.aiEdition.chatAbortRun("project", session.id, "run-abort");
		expect(
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", session.id))?.messages,
		).toEqual([]);

		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"keep me",
			undefined,
			"run-commit",
		);
		expect(
			await nativeBridgeClient.aiEdition.chatRun(
				"project",
				session.id,
				"overlap",
				undefined,
				"run-overlap",
			),
		).toMatchObject({ success: false });
		const committed = await nativeBridgeClient.aiEdition.chatCommitRun(
			"project",
			session.id,
			"run-commit",
		);
		expect(committed).toMatchObject({ success: true, sessionRevision: 1 });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "run-commit"),
		).toEqual(committed);
		expect(
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", session.id))?.messages,
		).toHaveLength(2);
	});

	it("does not let foreign commit or abort calls consume another session's operation", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"keep me",
			undefined,
			"owned-run",
		);

		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("foreign", session.id, "owned-run"),
		).toEqual({ state: "unknown", operationId: "owned-run" });
		expect(
			await nativeBridgeClient.aiEdition.chatBeginPersistence(
				"project",
				"foreign-session",
				"owned-run",
			),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("foreign", session.id, "owned-run"),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatAbortRun("project", "foreign", "owned-run"),
		).toMatchObject({ success: false });
		const committed = await nativeBridgeClient.aiEdition.chatCommitRun(
			"project",
			session.id,
			"owned-run",
		);
		expect(committed).toMatchObject({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatAbortRun("foreign", session.id, "owned-run"),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "owned-run"),
		).toEqual(committed);
	});

	it("resolves confirmed failed persistence without consuming another owner", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"failed persistence",
			undefined,
			"failed-persistence-run",
		);
		await nativeBridgeClient.aiEdition.chatBeginPersistence(
			"project",
			session.id,
			"failed-persistence-run",
		);
		expect(
			await nativeBridgeClient.aiEdition.chatResolvePersistence(
				"foreign",
				session.id,
				"failed-persistence-run",
			),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatResolvePersistence(
				"project",
				session.id,
				"failed-persistence-run",
			),
		).toEqual({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"project",
				session.id,
				"failed-persistence-run",
			),
		).toMatchObject({ state: "aborted" });
	});

	it("rejects rename and delete while their session has a prepared run", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project", "Original");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"pending",
			undefined,
			"pending-mutation-run",
		);

		expect(
			await nativeBridgeClient.aiEdition.chatRenameSession("project", session.id, "Renamed"),
		).toBeNull();
		expect(await nativeBridgeClient.aiEdition.chatDeleteSession("project", session.id)).toEqual({
			success: false,
		});
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun(
				"project",
				session.id,
				"pending-mutation-run",
			),
		).toMatchObject({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatRenameSession("project", session.id, "Renamed"),
		).toMatchObject({ title: "Renamed" });
	});

	it("transitions persistence without heartbeats and emits one canonical update", async () => {
		vi.useFakeTimers();
		const updates: unknown[] = [];
		const unsubscribe = window.electronAPI.onAiEditionChatSessionUpdated((event) =>
			updates.push(event),
		);
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"renewed",
			undefined,
			"renewed-run",
		);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "renewed-run"),
		).toMatchObject({ state: "prepared" });
		expect(
			await nativeBridgeClient.aiEdition.chatBeginPersistence("project", session.id, "renewed-run"),
		).toEqual({ success: true });
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "renewed-run"),
		).toMatchObject({ state: "persisting" });
		const committed = await nativeBridgeClient.aiEdition.chatCommitRun(
			"project",
			session.id,
			"renewed-run",
		);
		expect(committed).toMatchObject({ success: true, sessionRevision: 1 });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "renewed-run"),
		).toEqual(committed);
		expect(updates).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "renewed-run"),
		).toEqual({ state: "unknown", operationId: "renewed-run" });
		unsubscribe();
	});

	it("releases a hung persistence lock while retaining bounded late evidence", async () => {
		vi.useFakeTimers();
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"hung",
			undefined,
			"hung-run",
		);
		await nativeBridgeClient.aiEdition.chatBeginPersistence("project", session.id, "hung-run");
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				"project",
				session.id,
				"replacement",
				undefined,
				"replacement-run",
			),
		).resolves.toMatchObject({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "hung-run"),
		).toMatchObject({ state: "late-persistence" });
		await nativeBridgeClient.aiEdition.chatAbortRun("project", session.id, "replacement-run");
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "hung-run"),
		).toMatchObject({ state: "aborted" });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "hung-run"),
		).toEqual({ state: "unknown", operationId: "hung-run" });
	});

	it("expires an abandoned prepared operation without renderer renewal", async () => {
		vi.useFakeTimers();
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"abandoned",
			undefined,
			"abandoned-run",
		);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"project",
				session.id,
				"abandoned-run",
			),
		).toMatchObject({ state: "aborted" });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"project",
				session.id,
				"abandoned-run",
			),
		).toEqual({ state: "unknown", operationId: "abandoned-run" });
	});

	it("recovers committed evidence when the browser renderer is reinstalled", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("restart-project");
		await nativeBridgeClient.aiEdition.chatRun(
			"restart-project",
			session.id,
			"survive renderer restart",
			undefined,
			"restart-run",
		);
		const committed = await nativeBridgeClient.aiEdition.chatCommitRun(
			"restart-project",
			session.id,
			"restart-run",
		);
		expect(committed).toMatchObject({ success: true });

		// Recreate the shim as a renderer reload would, while localStorage stands in for main ownership.
		// biome-ignore lint/suspicious/noExplicitAny: test-only browser bridge restart
		delete (window as any).electronAPI;
		installBrowserShims();

		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"restart-project",
				session.id,
				"restart-run",
			),
		).toMatchObject({ state: "committed", result: committed });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun(
				"restart-project",
				session.id,
				"restart-run",
			),
		).toEqual(committed);
	});

	it("bounds browser commit tombstones without evicting the newest replay result", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("bounded-project");
		for (let index = 0; index <= 256; index++) {
			const operationId = `browser-bounded-${index}`;
			await nativeBridgeClient.aiEdition.chatRun(
				"bounded-project",
				session.id,
				`message ${index}`,
				undefined,
				operationId,
			);
			await nativeBridgeClient.aiEdition.chatCommitRun("bounded-project", session.id, operationId);
		}

		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun(
				"bounded-project",
				session.id,
				"browser-bounded-0",
			),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun(
				"bounded-project",
				session.id,
				"browser-bounded-256",
			),
		).toMatchObject({ success: true });
	});

	it("exposes non-destructive rewind protocol failures when checkpoints are unavailable", async () => {
		const prepared = await nativeBridgeClient.aiEdition.chatPrepareRewind(
			"project",
			"session",
			"message",
		);
		expect(prepared).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRewind("project", "session", "rewind", 1),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatAbortRewind("project", "session", "rewind"),
		).toMatchObject({ success: false });
	});
});
