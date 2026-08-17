// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", session.id))?.messages,
		).toHaveLength(2);
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
