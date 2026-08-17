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
		await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "run-commit");
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "run-commit"),
		).toEqual({ success: true });
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
			await nativeBridgeClient.aiEdition.chatCommitRun("foreign", session.id, "owned-run"),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatAbortRun("project", "foreign", "owned-run"),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "owned-run"),
		).toEqual({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatAbortRun("foreign", session.id, "owned-run"),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "owned-run"),
		).toEqual({ success: true });
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
		).toEqual({ success: true });
		expect(
			await nativeBridgeClient.aiEdition.chatRenameSession("project", session.id, "Renamed"),
		).toMatchObject({ title: "Renamed" });
	});

	it("renews active runs and expires abandoned runs and completed tombstones", async () => {
		vi.useFakeTimers();
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"renewed",
			undefined,
			"renewed-run",
		);
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatRenewOperation("project", session.id, "renewed-run"),
		).toEqual({ success: true });
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "renewed-run"),
		).toEqual({ success: true });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "renewed-run"),
		).toMatchObject({ success: false });

		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"abandoned",
			undefined,
			"abandoned-run",
		);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(
			await nativeBridgeClient.aiEdition.chatCommitRun("project", session.id, "abandoned-run"),
		).toMatchObject({ success: false });
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
		).toEqual({ success: true });
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
