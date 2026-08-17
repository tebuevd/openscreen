// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserShims } from "./browserShim";
import { nativeBridgeClient } from "./client";
import { MAX_ACTIVE_REWIND_COMPOSER_CLAIMS } from "./contracts";

function installPersistedRestoration(prompt = "restore me", revision = 7) {
	localStorage.setItem(
		"browser-shim-chat-v1",
		JSON.stringify({
			project: {
				session: {
					id: "session",
					projectId: "project",
					title: "Conversation",
					createdAt: "2026-08-17T00:00:00.000Z",
					messages: [],
					revision,
					pendingComposerRestoration: { prompt, revision },
				},
			},
		}),
	);
	// biome-ignore lint/suspicious/noExplicitAny: test-only browser bridge reload
	delete (window as any).electronAPI;
	installBrowserShims();
}

function installPersistedRestorations(count: number) {
	const sessions = Object.fromEntries(
		Array.from({ length: count }, (_, index) => [
			`session-${index}`,
			{
				id: `session-${index}`,
				projectId: "project",
				title: `Conversation ${index}`,
				createdAt: "2026-08-17T00:00:00.000Z",
				messages: [],
				revision: 1,
				pendingComposerRestoration: { prompt: `prompt ${index}`, revision: 1 },
			},
		]),
	);
	localStorage.setItem("browser-shim-chat-v1", JSON.stringify({ project: sessions }));
	// biome-ignore lint/suspicious/noExplicitAny: test-only browser bridge reload
	delete (window as any).electronAPI;
	installBrowserShims();
}

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

	it("leases, releases, and idempotently confirms a persisted restoration", async () => {
		installPersistedRestoration();
		const selected = await nativeBridgeClient.aiEdition.chatSelectSession("project", "session");
		expect(selected?.pendingComposerRestoration).toEqual({ revision: 7 });
		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer("project", "session", 6),
		).toEqual({ claimed: false });
		const firstClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(firstClaim).toMatchObject({ claimed: true, prompt: "restore me" });
		if (!firstClaim.claimed) return;
		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer("project", "session", 7),
		).toEqual(firstClaim);
		expect(
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", "session"))
				?.pendingComposerRestoration,
		).toEqual({ revision: 7 });
		expect(
			await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(firstClaim.claimId),
		).toEqual({ released: true });
		const replacementClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(replacementClaim).toMatchObject({ claimed: true, prompt: "restore me" });
		if (!replacementClaim.claimed) return;
		expect(replacementClaim.claimId).not.toBe(firstClaim.claimId);
		expect(
			await nativeBridgeClient.aiEdition.chatConfirmRewindComposerClaim(replacementClaim.claimId),
		).toEqual({ confirmed: true, alreadyConfirmed: false });
		expect(
			await nativeBridgeClient.aiEdition.chatConfirmRewindComposerClaim(replacementClaim.claimId),
		).toEqual({ confirmed: true, alreadyConfirmed: true });
		expect(
			(await nativeBridgeClient.aiEdition.chatSelectSession("project", "session"))
				?.pendingComposerRestoration,
		).toBeUndefined();
	});

	it("releases browser claims on pagehide", async () => {
		installPersistedRestoration("pagehide prompt");
		const firstClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(firstClaim.claimed).toBe(true);
		if (!firstClaim.claimed) return;

		window.dispatchEvent(new Event("pagehide"));
		// biome-ignore lint/suspicious/noExplicitAny: simulate the replacement page owner
		delete (window as any).electronAPI;
		installBrowserShims();

		const replacementClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(replacementClaim).toMatchObject({ claimed: true, prompt: "pagehide prompt" });
		if (!replacementClaim.claimed) return;
		expect(replacementClaim.claimId).not.toBe(firstClaim.claimId);
		await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(replacementClaim.claimId);
	});

	it("releases browser claims when their lease expires", async () => {
		vi.useFakeTimers();
		installPersistedRestoration("expiry prompt");
		const firstClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(firstClaim.claimed).toBe(true);
		if (!firstClaim.claimed) return;

		vi.advanceTimersByTime(firstClaim.leaseExpiresAt - Date.now());

		const replacementClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(replacementClaim).toMatchObject({ claimed: true, prompt: "expiry prompt" });
		if (!replacementClaim.claimed) return;
		expect(replacementClaim.claimId).not.toBe(firstClaim.claimId);
		await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(replacementClaim.claimId);
	});

	it("emits browser availability events when a claim releases or expires", async () => {
		vi.useFakeTimers();
		installPersistedRestoration("available prompt");
		const updates: Array<{ kind: string; pendingComposerRestoration?: { revision: number } }> = [];
		const unsubscribe = window.electronAPI.onAiEditionChatSessionUpdated((event) =>
			updates.push(event),
		);
		const firstClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(firstClaim.claimed).toBe(true);
		if (!firstClaim.claimed) return;

		await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(firstClaim.claimId);

		expect(updates).toEqual([
			expect.objectContaining({
				kind: "rewind-composer-available",
				pendingComposerRestoration: { revision: 7 },
			}),
		]);
		const secondClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			"session",
			7,
		);
		expect(secondClaim.claimed).toBe(true);
		if (!secondClaim.claimed) return;

		vi.advanceTimersByTime(secondClaim.leaseExpiresAt - Date.now());

		expect(updates).toHaveLength(2);
		expect(updates[1]).toMatchObject({
			kind: "rewind-composer-available",
			pendingComposerRestoration: { revision: 7 },
		});
		unsubscribe();
	});

	it("caps active browser composer leases without evicting existing claims", async () => {
		vi.useFakeTimers();
		installPersistedRestorations(MAX_ACTIVE_REWIND_COMPOSER_CLAIMS + 3);
		const claims: Array<{
			claimed: true;
			prompt: string;
			claimId: string;
			leaseExpiresAt: number;
		}> = [];
		for (let index = 0; index < MAX_ACTIVE_REWIND_COMPOSER_CLAIMS; index++) {
			const claim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
				"project",
				`session-${index}`,
				1,
			);
			expect(claim.claimed).toBe(true);
			if (!claim.claimed) throw new Error("Expected browser composer lease");
			claims.push(claim);
		}
		const timersAtCapacity = vi.getTimerCount();

		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
				"project",
				`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS}`,
				1,
			),
		).toEqual({ claimed: false, leaseExpiresAt: claims[0].leaseExpiresAt });
		expect(vi.getTimerCount()).toBe(timersAtCapacity);
		expect(
			(
				await nativeBridgeClient.aiEdition.chatSelectSession(
					"project",
					`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS}`,
				)
			)?.pendingComposerRestoration,
		).toEqual({ revision: 1 });
		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer("project", "session-0", 1),
		).toEqual(claims[0]);
		expect(vi.getTimerCount()).toBe(timersAtCapacity);

		expect(
			await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(claims[0].claimId),
		).toEqual({ released: true });
		const releasedSlotClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS}`,
			1,
		);
		expect(releasedSlotClaim).toMatchObject({
			claimed: true,
			prompt: `prompt ${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS}`,
		});
		expect(vi.getTimerCount()).toBe(timersAtCapacity);

		expect(
			await nativeBridgeClient.aiEdition.chatConfirmRewindComposerClaim(claims[1].claimId),
		).toMatchObject({ confirmed: true });
		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
				"project",
				`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS + 1}`,
				1,
			),
		).toMatchObject({ claimed: true });

		const timersBeforeExpiryRejection = vi.getTimerCount();
		expect(
			await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
				"project",
				`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS + 2}`,
				1,
			),
		).toEqual({ claimed: false, leaseExpiresAt: claims[2].leaseExpiresAt });
		expect(vi.getTimerCount()).toBe(timersBeforeExpiryRejection);
		vi.advanceTimersByTime(claims[2].leaseExpiresAt - Date.now());
		const expirySlotClaim = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
			"project",
			`session-${MAX_ACTIVE_REWIND_COMPOSER_CLAIMS + 2}`,
			1,
		);
		expect(expirySlotClaim).toMatchObject({ claimed: true });
		if (!expirySlotClaim.claimed) return;
		await nativeBridgeClient.aiEdition.chatReleaseRewindComposerClaim(expirySlotClaim.claimId);
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
				"failed",
			),
		).toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatResolvePersistence(
				"project",
				session.id,
				"failed-persistence-run",
				"failed",
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

	it("keeps unresolved persistence fenced beyond 30 minutes without timer growth", async () => {
		vi.useFakeTimers();
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("project");
		const baselineTimerCount = vi.getTimerCount();
		await nativeBridgeClient.aiEdition.chatRun(
			"project",
			session.id,
			"hung",
			undefined,
			"hung-run",
		);
		expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
		await nativeBridgeClient.aiEdition.chatBeginPersistence("project", session.id, "hung-run");
		expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimerCount);
		await vi.advanceTimersByTimeAsync(31 * 60_000);

		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				"project",
				session.id,
				"replacement",
				undefined,
				"replacement-run",
			),
		).resolves.toMatchObject({ success: false });
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus("project", session.id, "hung-run"),
		).toMatchObject({ state: "persisting" });
		expect(
			await nativeBridgeClient.aiEdition.chatRenameSession("project", session.id, "Blocked"),
		).toBeNull();
		expect(await nativeBridgeClient.aiEdition.chatDeleteSession("project", session.id)).toEqual({
			success: false,
		});
		expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimerCount);

		expect(
			await nativeBridgeClient.aiEdition.chatResolvePersistence(
				"project",
				session.id,
				"hung-run",
				"failed",
			),
		).toEqual({ success: true });
		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				"project",
				session.id,
				"after settlement",
				undefined,
				"replacement-after-settlement",
			),
		).resolves.toMatchObject({ success: true });
		await nativeBridgeClient.aiEdition.chatAbortRun(
			"project",
			session.id,
			"replacement-after-settlement",
		);
	});

	it("rejects new browser work at active capacity without evicting existing operations", async () => {
		const active: Array<{ projectId: string; sessionId: string; operationId: string }> = [];
		for (let index = 0; index < 128; index++) {
			const projectId = `browser-capacity-project-${index}`;
			const session = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
			const operationId = `browser-capacity-${index}`;
			await expect(
				nativeBridgeClient.aiEdition.chatRun(
					projectId,
					session.id,
					`message ${index}`,
					undefined,
					operationId,
				),
			).resolves.toMatchObject({ success: true });
			active.push({ projectId, sessionId: session.id, operationId });
		}

		const overflowProjectId = "browser-capacity-overflow-project";
		const overflowSession = await nativeBridgeClient.aiEdition.chatCreateSession(overflowProjectId);
		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				overflowProjectId,
				overflowSession.id,
				"overflow",
				undefined,
				"browser-capacity-overflow",
			),
		).resolves.toEqual({ success: false, error: "Too many chat operations are active." });
		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				active[0].projectId,
				active[0].sessionId,
				active[0].operationId,
			),
		).toMatchObject({ state: "prepared" });

		await nativeBridgeClient.aiEdition.chatAbortRun(
			active[0].projectId,
			active[0].sessionId,
			active[0].operationId,
		);
		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				overflowProjectId,
				overflowSession.id,
				"accepted after settlement",
				undefined,
				"browser-capacity-after-settlement",
			),
		).resolves.toMatchObject({ success: true });
		await nativeBridgeClient.aiEdition.chatAbortRun(
			overflowProjectId,
			overflowSession.id,
			"browser-capacity-after-settlement",
		);
		for (const operation of active.slice(1)) {
			await nativeBridgeClient.aiEdition.chatAbortRun(
				operation.projectId,
				operation.sessionId,
				operation.operationId,
			);
		}
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

	it("clears an active write fence when the browser backend restarts", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("restart-fence-project");
		await nativeBridgeClient.aiEdition.chatRun(
			"restart-fence-project",
			session.id,
			"pending write",
			undefined,
			"restart-fence-run",
		);
		await nativeBridgeClient.aiEdition.chatBeginPersistence(
			"restart-fence-project",
			session.id,
			"restart-fence-run",
		);

		// The browser shim is its own backend. Reinstalling it models a main-process restart:
		// process-local fences disappear, and no browser write can survive that teardown.
		// biome-ignore lint/suspicious/noExplicitAny: test-only browser backend restart
		delete (window as any).electronAPI;
		installBrowserShims();

		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"restart-fence-project",
				session.id,
				"restart-fence-run",
			),
		).toEqual({ state: "unknown", operationId: "restart-fence-run" });
		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				"restart-fence-project",
				session.id,
				"replacement",
				undefined,
				"replacement-after-restart",
			),
		).resolves.toMatchObject({ success: true });
		await nativeBridgeClient.aiEdition.chatAbortRun(
			"restart-fence-project",
			session.id,
			"replacement-after-restart",
		);
	});

	it("releases the browser document owner's operations on page teardown", async () => {
		const session = await nativeBridgeClient.aiEdition.chatCreateSession("pagehide-project");
		await nativeBridgeClient.aiEdition.chatRun(
			"pagehide-project",
			session.id,
			"pending",
			undefined,
			"pagehide-run",
		);
		await nativeBridgeClient.aiEdition.chatBeginPersistence(
			"pagehide-project",
			session.id,
			"pagehide-run",
		);

		window.dispatchEvent(new Event("pagehide"));

		expect(
			await nativeBridgeClient.aiEdition.chatOperationStatus(
				"pagehide-project",
				session.id,
				"pagehide-run",
			),
		).toMatchObject({ state: "aborted" });
		await expect(
			nativeBridgeClient.aiEdition.chatRun(
				"pagehide-project",
				session.id,
				"replacement",
				undefined,
				"pagehide-replacement",
			),
		).resolves.toMatchObject({ success: true });
		await nativeBridgeClient.aiEdition.chatAbortRun(
			"pagehide-project",
			session.id,
			"pagehide-replacement",
		);
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
