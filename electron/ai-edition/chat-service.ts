// In-memory chat service. ponytail: chat sessions live in a nested Map; the
// agentic loop itself lives in `deep-agent/service.ts` and is a port of
// axcut's AxcutDeepAgentService (LangGraph stateful thread via
// `createDeepAgent`). The IPC bridge streams `text` deltas + `toolStart` /
// `toolEnd` lifecycle + `error` events into the renderer through the
// ChatEventSink.

import { randomUUID } from "node:crypto";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { documentsHaveEquivalentSaveContent } from "../../src/lib/ai-edition/document/equivalence";
import {
	type AxcutTimelineOperation,
	applyTimelineOperation,
} from "../../src/lib/ai-edition/document/operations";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import {
	type AiEditionChatCommitResult,
	type AiEditionChatCompactResult,
	type AiEditionChatComposerRestoration,
	type AiEditionChatMessage,
	type AiEditionChatOperationStatus,
	type AiEditionChatPersistenceResolution,
	type AiEditionChatResult,
	type AiEditionChatRewindCommitResult,
	type AiEditionChatRewindComposerClaimResult,
	type AiEditionChatRewindComposerConfirmResult,
	type AiEditionChatRewindComposerReleaseResult,
	type AiEditionChatRewindPrepareResult,
	type AiEditionChatSession,
	type AiEditionChatSessionUpdatedEvent,
	type AiEditionToolCallSummary,
	MAX_ACTIVE_REWIND_COMPOSER_CLAIMS,
} from "../../src/native/contracts";
import {
	applyCompaction,
	budgetSnapshot,
	buildCompactionPrompt,
	COMPACTION_SYSTEM_PROMPT,
	compactionReducesHistory,
	compactionSplitIndex,
	DEFAULT_BUDGET_TOKENS,
} from "./chat-compaction";
import type { CursorTelemetryReader } from "./deep-agent/service";
import type { DocumentService } from "./document-service";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const sessionsByProject = new Map<string, Map<string, ChatSession>>();

// ponytail: per-message checkpoints, stored as an ordered list per session
// (insertion order == the session's message order). Each entry captures the
// document *right before* the agent runs that user message — same restore
// semantics as axcut's per-user-message checkpoint. The renderer surfaces a
// ↩ button on every user message that has a checkpoint.
interface MessageCheckpoint {
	userMessageId: string;
	document: AxcutDocument;
	createdAt: string;
}
const messageCheckpointsBySession = new Map<string, MessageCheckpoint[]>();

const RUNNING_OPERATION_TTL_MS = 15 * 60_000;
const PREPARED_OPERATION_TTL_MS = 5 * 60_000;
const TERMINAL_OPERATION_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_OPERATIONS = 128;
const MAX_TERMINAL_OPERATIONS = 256;
const REWIND_COMPOSER_CLAIM_LEASE_MS = 15_000;
const CONFIRMED_REWIND_COMPOSER_CLAIM_TTL_MS = 10 * 60_000;
const MAX_CONFIRMED_REWIND_COMPOSER_CLAIMS = 256;

interface LeasedChatOperation {
	operationId: string;
	kind: "chat" | "rewind";
	projectId: string;
	sessionId: string;
	createdAt: number;
	expiresAt: number;
}

export type ChatOperationOwner = object;

interface RewindComposerClaim {
	claimId: string;
	projectId: string;
	sessionId: string;
	revision: number;
	owner: ChatOperationOwner;
	leaseExpiresAt: number;
}

interface ConfirmedRewindComposerClaim {
	owner: ChatOperationOwner;
	expiresAt: number;
}

export interface ChatDocumentAuthority {
	getProject(projectId: string): Promise<AxcutDocument>;
}

interface OwnedChatOperation {
	owner: ChatOperationOwner | null;
	ownerDetached: boolean;
}

interface PendingChatRun extends LeasedChatOperation, OwnedChatOperation {
	kind: "chat";
	state: "running" | "prepared" | "persisting";
	expectedSessionRevision: number;
	userMessage: AiEditionChatMessage;
	assistantMessage: AiEditionChatMessage | null;
	checkpoint: AxcutDocument | null;
	intendedDocument: AxcutDocument | null;
	requiresPersistence: boolean;
	retainCommitResult: boolean;
}

interface PendingRewind extends LeasedChatOperation, OwnedChatOperation {
	kind: "rewind";
	state: "prepared" | "persisting";
	targetMessageId: string;
	expectedSessionRevision: number;
	prompt: string;
	document: AxcutDocument;
	messages: AiEditionChatMessage[];
}

type PendingOperation = PendingChatRun | PendingRewind;

type CompletedChatOperation = Omit<LeasedChatOperation, "expiresAt"> &
	(
		| {
				state: "committed";
				kind: "chat";
				result: Extract<AiEditionChatCommitResult, { success: true }>;
		  }
		| {
				state: "committed";
				kind: "rewind";
				sessionRevision: number;
				result: Extract<AiEditionChatRewindCommitResult, { success: true }>;
		  }
	) & { expiresAt: number };

type AbortedChatOperation = Omit<LeasedChatOperation, "expiresAt"> & {
	state: "aborted";
	expiresAt: number;
};

type TerminalChatOperation = CompletedChatOperation | AbortedChatOperation;

const pendingChatRuns = new Map<string, PendingChatRun>();
const pendingRewinds = new Map<string, PendingRewind>();
const terminalChatOperations = new Map<string, TerminalChatOperation>();
const operationExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const operationReconciliations = new Map<string, Promise<void>>();
const sessionUpdateListeners = new Set<(event: AiEditionChatSessionUpdatedEvent) => void>();
// The prompt remains on the session until confirmation; these maps only serialize delivery.
const rewindComposerClaims = new Map<string, RewindComposerClaim>();
const rewindComposerClaimBySession = new Map<string, string>();
const rewindComposerClaimExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const confirmedRewindComposerClaims = new Map<string, ConfirmedRewindComposerClaim>();

function sessionKey(projectId: string, sessionId: string): string {
	return `${projectId}::${sessionId}`;
}

function operationBelongsToSession(
	operation: { projectId: string; sessionId: string },
	projectId: string,
	sessionId: string,
): boolean {
	return operation.projectId === projectId && operation.sessionId === sessionId;
}

function cancelOperationExpiry(operationId: string): void {
	const timeout = operationExpiryTimers.get(operationId);
	if (timeout) clearTimeout(timeout);
	operationExpiryTimers.delete(operationId);
}

function deleteOperationRecord(operationId: string): void {
	pendingChatRuns.delete(operationId);
	pendingRewinds.delete(operationId);
	terminalChatOperations.delete(operationId);
	cancelOperationExpiry(operationId);
}

function scheduleOperationDeadline(
	operation: LeasedChatOperation,
	expiresAt: number,
	onExpire: () => void,
): void {
	cancelOperationExpiry(operation.operationId);
	operation.expiresAt = expiresAt;
	const expire = () => {
		const remaining = operation.expiresAt - Date.now();
		if (remaining > 0) {
			const timeout = setTimeout(expire, remaining);
			timeout.unref?.();
			operationExpiryTimers.set(operation.operationId, timeout);
			return;
		}
		operationExpiryTimers.delete(operation.operationId);
		onExpire();
	};
	const timeout = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
	timeout.unref?.();
	operationExpiryTimers.set(operation.operationId, timeout);
}

function rememberTerminalOperation(operation: TerminalChatOperation): void {
	deleteOperationRecord(operation.operationId);
	terminalChatOperations.set(operation.operationId, operation);
	scheduleOperationDeadline(operation, Date.now() + TERMINAL_OPERATION_TTL_MS, () => {
		if (terminalChatOperations.get(operation.operationId) === operation) {
			deleteOperationRecord(operation.operationId);
		}
	});
	while (terminalChatOperations.size > MAX_TERMINAL_OPERATIONS) {
		const oldestOperationId = terminalChatOperations.keys().next().value;
		if (typeof oldestOperationId !== "string") break;
		deleteOperationRecord(oldestOperationId);
	}
}

function rememberAbortedOperation(operation: PendingOperation): void {
	rememberTerminalOperation({
		operationId: operation.operationId,
		kind: operation.kind,
		projectId: operation.projectId,
		sessionId: operation.sessionId,
		createdAt: operation.createdAt,
		state: "aborted",
		expiresAt: 0,
	});
}

function activeOperationForId(operationId: string): PendingOperation | null {
	return pendingChatRuns.get(operationId) ?? pendingRewinds.get(operationId) ?? null;
}

function operationIsActive(operation: PendingOperation): boolean {
	return activeOperationForId(operation.operationId) === operation;
}

function operationIsOwnedBy(
	operation: PendingOperation,
	owner: ChatOperationOwner | null,
): boolean {
	return operation.owner === owner;
}

function expireActiveOperation(operation: PendingOperation): void {
	if (!operationIsActive(operation)) return;
	if (operation.state === "persisting") return;
	pendingChatRuns.delete(operation.operationId);
	pendingRewinds.delete(operation.operationId);
	rememberAbortedOperation(operation);
}

function scheduleActivePhase(operation: PendingOperation, ttlMs: number): void {
	scheduleOperationDeadline(operation, Date.now() + ttlMs, () => expireActiveOperation(operation));
}

function pruneExpiredOperations(): void {
	const now = Date.now();
	for (const operation of [...pendingChatRuns.values(), ...pendingRewinds.values()]) {
		if (operation.state !== "persisting" && operation.expiresAt <= now) {
			expireActiveOperation(operation);
		}
	}
	for (const operation of terminalChatOperations.values()) {
		if (operation.expiresAt <= now) deleteOperationRecord(operation.operationId);
	}
}

function operationIdIsInUse(operationId: string): boolean {
	pruneExpiredOperations();
	return activeOperationForId(operationId) !== null || terminalChatOperations.has(operationId);
}

function sessionHasPendingOperation(projectId: string, sessionId: string): boolean {
	pruneExpiredOperations();
	return (
		[...pendingChatRuns.values()].some((operation) =>
			operationBelongsToSession(operation, projectId, sessionId),
		) ||
		[...pendingRewinds.values()].some((operation) =>
			operationBelongsToSession(operation, projectId, sessionId),
		)
	);
}

function cloneMessage(message: AiEditionChatMessage): AiEditionChatMessage {
	return {
		...message,
		toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
	};
}

function cloneChatCommitResult(
	result: Extract<AiEditionChatCommitResult, { success: true }>,
): Extract<AiEditionChatCommitResult, { success: true }> {
	return {
		success: true as const,
		messages: result.messages.map(cloneMessage),
		sessionRevision: result.sessionRevision,
	};
}

function cloneRewindCommitResult(
	result: Extract<AiEditionChatRewindCommitResult, { success: true }>,
): Extract<AiEditionChatRewindCommitResult, { success: true }> {
	return {
		success: true,
		messages: result.messages.map(cloneMessage),
		sessionRevision: result.sessionRevision,
		pendingComposerRestoration: { ...result.pendingComposerRestoration },
	};
}

export function subscribeChatSessionUpdates(
	listener: (event: AiEditionChatSessionUpdatedEvent) => void,
): () => void {
	sessionUpdateListeners.add(listener);
	return () => sessionUpdateListeners.delete(listener);
}

function emitChatSessionUpdate(event: AiEditionChatSessionUpdatedEvent): void {
	for (const listener of sessionUpdateListeners) {
		try {
			listener(event);
		} catch {
			// A dead renderer listener must not turn an already-committed operation into a failed RPC.
		}
	}
}

function ownedOperation(
	projectId: string,
	sessionId: string,
	operationId: string,
): PendingOperation | null {
	const operation = activeOperationForId(operationId);
	return operation && operationBelongsToSession(operation, projectId, sessionId) ? operation : null;
}

export function beginChatOperationPersistence(
	projectId: string,
	sessionId: string,
	operationId: string,
	owner: ChatOperationOwner | null = null,
): { success: true } | { success: false; error: string } {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal && operationBelongsToSession(terminal, projectId, sessionId)) {
		return {
			success: false,
			error:
				terminal.state === "committed"
					? "Chat operation is already committed."
					: "Chat operation is already aborted.",
		};
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	if (!operation) {
		return { success: false, error: "Chat operation not found, expired, or owned elsewhere." };
	}
	if (!operationIsOwnedBy(operation, owner)) {
		return { success: false, error: "Chat operation belongs to another document owner." };
	}
	if (operation.state === "persisting") return { success: true };
	if (operation.state !== "prepared") {
		return { success: false, error: "Chat operation is not prepared for persistence." };
	}
	operation.state = "persisting";
	// Persistence is a write fence, not a lease. Once acknowledged it remains until the
	// renderer reports settlement or owner teardown reconciles the authoritative project queue.
	// Releasing it on a watchdog would let an uncancelled write land after a replacement operation.
	cancelOperationExpiry(operation.operationId);
	operation.expiresAt = Number.POSITIVE_INFINITY;
	return { success: true };
}

export function resolveChatOperationPersistence(
	projectId: string,
	sessionId: string,
	operationId: string,
	_outcome: AiEditionChatPersistenceResolution,
	owner: ChatOperationOwner | null = null,
): { success: true } | { success: false; error: string } {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal && operationBelongsToSession(terminal, projectId, sessionId)) {
		return terminal.state === "aborted"
			? { success: true }
			: { success: false, error: "Committed persistence cannot be aborted." };
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	if (!operation || operation.state !== "persisting") {
		return { success: false, error: "Persisting chat operation not found or owned elsewhere." };
	}
	if (!operationIsOwnedBy(operation, owner)) {
		return {
			success: false,
			error: "Persisting chat operation belongs to another document owner.",
		};
	}
	rememberAbortedOperation(operation);
	return { success: true };
}

export function getChatOperationStatus(
	projectId: string,
	sessionId: string,
	operationId: string,
): AiEditionChatOperationStatus {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal && operationBelongsToSession(terminal, projectId, sessionId)) {
		if (terminal.state === "aborted") {
			return { state: "aborted", kind: terminal.kind, operationId };
		}
		return terminal.kind === "chat"
			? {
					state: "committed",
					kind: "chat",
					operationId,
					result: cloneChatCommitResult(terminal.result),
				}
			: {
					state: "committed",
					kind: "rewind",
					operationId,
					result: cloneRewindCommitResult(terminal.result),
				};
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	if (!operation) return { state: "unknown", operationId };
	if (operation.state === "running") {
		return { state: "running", kind: operation.kind, operationId };
	}
	if (operation.state === "persisting") {
		return {
			state: operation.ownerDetached ? "reconciling" : "persisting",
			kind: operation.kind,
			operationId,
		};
	}
	return { state: operation.state, kind: operation.kind, operationId };
}

function intendedDocumentFor(operation: PendingOperation): AxcutDocument | null {
	return operation.kind === "chat" ? operation.intendedDocument : operation.document;
}

async function reconcileDetachedPersistence(
	operation: PendingOperation,
	documents: ChatDocumentAuthority,
): Promise<void> {
	if (
		!operationIsActive(operation) ||
		!operation.ownerDetached ||
		operation.state !== "persisting"
	) {
		return;
	}
	const intended = intendedDocumentFor(operation);
	if (!intended) {
		abortPendingOperation(operation);
		return;
	}

	let authoritative: AxcutDocument;
	try {
		authoritative = await documents.getProject(operation.projectId);
	} catch (error) {
		console.warn(
			`[ai-edition] chat persistence reconciliation remains pending for ${operation.projectId}:`,
			error,
		);
		return;
	}
	if (
		!operationIsActive(operation) ||
		!operation.ownerDetached ||
		operation.state !== "persisting"
	) {
		return;
	}

	if (!documentsHaveEquivalentSaveContent(authoritative, intended)) {
		abortPendingOperation(operation);
		return;
	}
	const committed =
		operation.kind === "chat"
			? commitChatRun(
					operation.projectId,
					operation.sessionId,
					operation.operationId,
					operation.owner,
				)
			: commitRewindToMessage(
					operation.projectId,
					operation.sessionId,
					operation.operationId,
					operation.expectedSessionRevision,
					operation.owner,
				);
	if (!committed.success && operationIsActive(operation)) abortPendingOperation(operation);
}

function requestPersistenceReconciliation(
	operation: PendingOperation,
	documents: ChatDocumentAuthority,
): Promise<void> {
	const existing = operationReconciliations.get(operation.operationId);
	if (existing) return existing;
	const run = reconcileDetachedPersistence(operation, documents).catch((error) => {
		console.warn(
			`[ai-edition] unexpected chat persistence reconciliation failure for ${operation.projectId}:`,
			error,
		);
	});
	operationReconciliations.set(operation.operationId, run);
	void run.then(() => {
		if (operationReconciliations.get(operation.operationId) === run) {
			operationReconciliations.delete(operation.operationId);
		}
	});
	return run;
}

export async function handleChatOperationOwnerTeardown(
	owner: ChatOperationOwner,
	documents: ChatDocumentAuthority,
): Promise<void> {
	releaseRewindComposerClaimsForOwner(owner);
	const reconciliations: Promise<void>[] = [];
	for (const operation of [...pendingChatRuns.values(), ...pendingRewinds.values()]) {
		if (operation.owner !== owner) continue;
		if (operation.state !== "persisting") {
			abortPendingOperation(operation);
			continue;
		}
		operation.ownerDetached = true;
		reconciliations.push(requestPersistenceReconciliation(operation, documents));
	}
	await Promise.all(reconciliations);
}

export async function reconcileDetachedChatOperationsForProject(
	projectId: string,
	documents: ChatDocumentAuthority,
): Promise<void> {
	const reconciliations = [...pendingChatRuns.values(), ...pendingRewinds.values()]
		.filter((operation) => operation.projectId === projectId && operation.ownerDetached)
		.map((operation) => requestPersistenceReconciliation(operation, documents));
	await Promise.all(reconciliations);
}

export async function reconcileDetachedChatOperation(
	projectId: string,
	sessionId: string,
	operationId: string,
	documents: ChatDocumentAuthority,
): Promise<void> {
	const operation = ownedOperation(projectId, sessionId, operationId);
	if (operation?.ownerDetached) await requestPersistenceReconciliation(operation, documents);
}

function addActiveOperation(operation: PendingOperation): boolean {
	pruneExpiredOperations();
	if (pendingChatRuns.size + pendingRewinds.size >= MAX_ACTIVE_OPERATIONS) return false;
	if (operation.kind === "chat") pendingChatRuns.set(operation.operationId, operation);
	else pendingRewinds.set(operation.operationId, operation);
	scheduleActivePhase(
		operation,
		operation.state === "running" ? RUNNING_OPERATION_TTL_MS : PREPARED_OPERATION_TTL_MS,
	);
	return true;
}

function rememberCompletedOperation(operation: CompletedChatOperation): void {
	rememberTerminalOperation(operation);
}

function abortPendingOperation(operation: PendingOperation): { success: true } {
	rememberAbortedOperation(operation);
	return { success: true };
}

function checkpointsForSession(projectId: string, sessionId: string): MessageCheckpoint[] {
	return messageCheckpointsBySession.get(sessionKey(projectId, sessionId)) ?? [];
}

function recordMessageCheckpoint(
	projectId: string,
	sessionId: string,
	userMessageId: string,
	document: AxcutDocument,
): void {
	const key = sessionKey(projectId, sessionId);
	const list = messageCheckpointsBySession.get(key) ?? [];
	list.push({
		userMessageId,
		document,
		createdAt: new Date().toISOString(),
	});
	messageCheckpointsBySession.set(key, list);
}

function findCheckpointForMessage(
	projectId: string,
	sessionId: string,
	userMessageId: string,
): MessageCheckpoint | null {
	return (
		checkpointsForSession(projectId, sessionId).find((c) => c.userMessageId === userMessageId) ??
		null
	);
}

// ponytail: drop every checkpoint at or after the given user message id.
// Called after a rewind truncates the message list, so future checkpoints
// stay aligned with the surviving messages. We compare against the
// session's current message order; if the target message is gone we drop
// all checkpoints created after the surviving tail.
function dropCheckpointsFrom(
	projectId: string,
	sessionId: string,
	fromUserMessageId: string,
): void {
	const key = sessionKey(projectId, sessionId);
	const list = messageCheckpointsBySession.get(key);
	if (!list) return;
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	const surviving = session?.messages.find((m) => m.id === fromUserMessageId);
	const cutIndex = surviving ? list.findIndex((c) => c.userMessageId === fromUserMessageId) : -1;
	if (cutIndex === -1) {
		// ponytail: target message vanished (e.g. already rewound past it).
		// Drop the entire session's checkpoints — they all reference a
		// lineage that's no longer valid.
		messageCheckpointsBySession.delete(key);
		return;
	}
	messageCheckpointsBySession.set(
		key,
		list.filter((_c, i) => i < cutIndex),
	);
}

// ponytail: what compaction leaves behind. `coveredCount` counts the leading
// transcript messages the summary stands in for — the transcript itself is
// never rewritten, so the user keeps every message they wrote while the model
// gets the shortened list. Sessions are in-memory only; deleting the messages
// the renderer shows would be unrecoverable, and nothing in the UI would say
// it happened.
interface SessionCompaction {
	summary: AiEditionChatMessage;
	coveredCount: number;
}

export interface ChatSession {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messages: AiEditionChatMessage[];
	/** Monotonic identity for destructive message/checkpoint mutations. */
	revision: number;
	pendingComposerRestoration?: AiEditionChatComposerRestoration & { prompt: string };
	/** Main-process bookkeeping: the compaction boundary, not part of the
	 *  transcript. See `modelMessages`. */
	compaction?: SessionCompaction;
}

function emitRewindComposerAvailability(claim: RewindComposerClaim): void {
	const session = sessionsByProject.get(claim.projectId)?.get(claim.sessionId);
	if (
		!session?.pendingComposerRestoration ||
		session.pendingComposerRestoration.revision !== claim.revision
	) {
		return;
	}
	emitChatSessionUpdate({
		projectId: claim.projectId,
		sessionId: claim.sessionId,
		revision: session.revision,
		operationId: `${claim.claimId}:available`,
		kind: "rewind-composer-available",
		messages: session.messages.map(cloneMessage),
		pendingComposerRestoration: { revision: claim.revision },
	});
}

function removeRewindComposerClaim(claim: RewindComposerClaim, notifyAvailability = false): void {
	let removed = false;
	if (rewindComposerClaims.get(claim.claimId) === claim) {
		rewindComposerClaims.delete(claim.claimId);
		removed = true;
	}
	const key = sessionKey(claim.projectId, claim.sessionId);
	if (rewindComposerClaimBySession.get(key) === claim.claimId) {
		rewindComposerClaimBySession.delete(key);
		removed = true;
	}
	const timeout = rewindComposerClaimExpiryTimers.get(claim.claimId);
	if (timeout) clearTimeout(timeout);
	rewindComposerClaimExpiryTimers.delete(claim.claimId);
	if (removed && notifyAvailability) emitRewindComposerAvailability(claim);
}

function activeRewindComposerClaim(
	projectId: string,
	sessionId: string,
	notifyExpired = true,
): RewindComposerClaim | null {
	const key = sessionKey(projectId, sessionId);
	const claimId = rewindComposerClaimBySession.get(key);
	if (!claimId) return null;
	const claim = rewindComposerClaims.get(claimId);
	if (!claim || claim.projectId !== projectId || claim.sessionId !== sessionId) {
		rewindComposerClaimBySession.delete(key);
		return null;
	}
	if (claim.leaseExpiresAt <= Date.now()) {
		removeRewindComposerClaim(claim, notifyExpired);
		return null;
	}
	return claim;
}

function pruneExpiredRewindComposerClaims(): void {
	const now = Date.now();
	for (const claim of [...rewindComposerClaims.values()]) {
		if (claim.leaseExpiresAt <= now) removeRewindComposerClaim(claim, true);
	}
}

function nextRewindComposerClaimExpiry(): number | undefined {
	let earliest = Number.POSITIVE_INFINITY;
	for (const claim of rewindComposerClaims.values()) {
		earliest = Math.min(earliest, claim.leaseExpiresAt);
	}
	return Number.isFinite(earliest) ? earliest : undefined;
}

function scheduleRewindComposerClaimExpiry(claim: RewindComposerClaim): void {
	const expire = () => {
		if (rewindComposerClaims.get(claim.claimId) !== claim) return;
		const remaining = claim.leaseExpiresAt - Date.now();
		if (remaining > 0) {
			const timeout = setTimeout(expire, remaining);
			timeout.unref?.();
			rewindComposerClaimExpiryTimers.set(claim.claimId, timeout);
			return;
		}
		removeRewindComposerClaim(claim, true);
	};
	const timeout = setTimeout(expire, Math.max(0, claim.leaseExpiresAt - Date.now()));
	timeout.unref?.();
	rewindComposerClaimExpiryTimers.set(claim.claimId, timeout);
}

function clearPendingComposerRestoration(session: ChatSession): void {
	const claim = activeRewindComposerClaim(session.projectId, session.id, false);
	if (claim) removeRewindComposerClaim(claim);
	delete session.pendingComposerRestoration;
}

function pruneConfirmedRewindComposerClaims(): void {
	const now = Date.now();
	for (const [claimId, claim] of confirmedRewindComposerClaims) {
		if (claim.expiresAt <= now) confirmedRewindComposerClaims.delete(claimId);
	}
}

function rememberConfirmedRewindComposerClaim(claim: RewindComposerClaim): void {
	pruneConfirmedRewindComposerClaims();
	confirmedRewindComposerClaims.set(claim.claimId, {
		owner: claim.owner,
		expiresAt: Date.now() + CONFIRMED_REWIND_COMPOSER_CLAIM_TTL_MS,
	});
	while (confirmedRewindComposerClaims.size > MAX_CONFIRMED_REWIND_COMPOSER_CLAIMS) {
		const oldestClaimId = confirmedRewindComposerClaims.keys().next().value;
		if (typeof oldestClaimId !== "string") break;
		confirmedRewindComposerClaims.delete(oldestClaimId);
	}
}

function releaseRewindComposerClaimsForOwner(owner: ChatOperationOwner): void {
	for (const claim of [...rewindComposerClaims.values()]) {
		if (claim.owner === owner) removeRewindComposerClaim(claim, true);
	}
}

/** The message list compaction hands the model: summary first, then everything
 *  after the boundary. Identical to the transcript until a compaction lands. */
function modelMessages(session: ChatSession): AiEditionChatMessage[] {
	const state = session.compaction;
	if (!state) return session.messages;
	return [state.summary, ...session.messages.slice(state.coveredCount)];
}

// The model sees a sliding window of recent turns, not the whole session.
const MODEL_HISTORY_WINDOW = 20;

/**
 * Window `modelMessages` down to what we send. The summary is pinned to the
 * front rather than left to the window: the tail after a compaction is roughly
 * half the session, so at the token counts that trip compaction in the first
 * place a plain `slice(-N)` drops the very summary we just paid to produce.
 */
function modelHistory(
	session: ChatSession,
	pendingUserMessage?: AiEditionChatMessage,
): AiEditionChatMessage[] {
	const messages = pendingUserMessage
		? [...modelMessages(session), pendingUserMessage]
		: modelMessages(session);
	if (messages.length <= MODEL_HISTORY_WINDOW) return messages;
	const summary = session.compaction?.summary;
	if (!summary) return messages.slice(-MODEL_HISTORY_WINDOW);
	return [summary, ...messages.slice(1).slice(-(MODEL_HISTORY_WINDOW - 1))];
}

export interface ChatSessionSummary {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messageCount: number;
}

function toSummary(s: ChatSession): ChatSessionSummary {
	return {
		id: s.id,
		projectId: s.projectId,
		title: s.title,
		createdAt: s.createdAt,
		messageCount: s.messages.length,
	};
}

function getProjectSessions(projectId: string): Map<string, ChatSession> {
	let m = sessionsByProject.get(projectId);
	if (!m) {
		m = new Map();
		sessionsByProject.set(projectId, m);
	}
	return m;
}

function defaultSessionTitle(index: number): string {
	return `Conversation ${index}`;
}

export function listSessions(projectId: string): ChatSessionSummary[] {
	const m = sessionsByProject.get(projectId);
	if (!m) return [];
	return Array.from(m.values())
		.map(toSummary)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSession(projectId: string, title?: string): ChatSessionSummary {
	const m = getProjectSessions(projectId);
	const id = `sess_${randomUUID()}`;
	const now = new Date().toISOString();
	const session: ChatSession = {
		id,
		projectId,
		title: title?.trim() || defaultSessionTitle(m.size + 1),
		createdAt: now,
		messages: [],
		revision: 0,
	};
	m.set(id, session);
	return toSummary(session);
}

export function selectSession(projectId: string, sessionId: string): AiEditionChatSession | null {
	const m = sessionsByProject.get(projectId);
	const s = m?.get(sessionId);
	if (!s) return null;
	// ponytail: shallow-copy messages so the caller can't mutate the live array.
	// The compaction boundary stays behind: it is main-process bookkeeping, and
	// every caller of this wants the transcript as the user sees it.
	return {
		id: s.id,
		projectId: s.projectId,
		title: s.title,
		createdAt: s.createdAt,
		messages: [...s.messages],
		revision: s.revision,
		...(s.pendingComposerRestoration
			? { pendingComposerRestoration: { revision: s.pendingComposerRestoration.revision } }
			: {}),
	};
}

export function claimRewindComposer(
	projectId: string,
	sessionId: string,
	revision: number,
	owner: ChatOperationOwner,
): AiEditionChatRewindComposerClaimResult {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return { claimed: false };
	const pending = session.pendingComposerRestoration;
	if (!pending || pending.revision !== revision) return { claimed: false };
	pruneExpiredRewindComposerClaims();
	const existing = activeRewindComposerClaim(projectId, sessionId);
	if (existing) {
		if (existing.revision !== revision || existing.owner !== owner) {
			return { claimed: false, leaseExpiresAt: existing.leaseExpiresAt };
		}
		return {
			claimed: true,
			prompt: pending.prompt,
			claimId: existing.claimId,
			leaseExpiresAt: existing.leaseExpiresAt,
		};
	}
	if (rewindComposerClaims.size >= MAX_ACTIVE_REWIND_COMPOSER_CLAIMS) {
		return { claimed: false, leaseExpiresAt: nextRewindComposerClaimExpiry() };
	}

	let claimId = `chat_rewind_composer_${randomUUID()}`;
	while (rewindComposerClaims.has(claimId) || confirmedRewindComposerClaims.has(claimId)) {
		claimId = `chat_rewind_composer_${randomUUID()}`;
	}
	const claim: RewindComposerClaim = {
		claimId,
		projectId,
		sessionId,
		revision,
		owner,
		leaseExpiresAt: Date.now() + REWIND_COMPOSER_CLAIM_LEASE_MS,
	};
	rewindComposerClaims.set(claimId, claim);
	rewindComposerClaimBySession.set(sessionKey(projectId, sessionId), claimId);
	scheduleRewindComposerClaimExpiry(claim);
	return {
		claimed: true,
		prompt: pending.prompt,
		claimId,
		leaseExpiresAt: claim.leaseExpiresAt,
	};
}

export function confirmRewindComposerClaim(
	claimId: string,
	owner: ChatOperationOwner,
): AiEditionChatRewindComposerConfirmResult {
	pruneConfirmedRewindComposerClaims();
	const confirmed = confirmedRewindComposerClaims.get(claimId);
	if (confirmed) {
		return confirmed.owner === owner
			? { confirmed: true, alreadyConfirmed: true }
			: { confirmed: false };
	}

	const claim = rewindComposerClaims.get(claimId);
	if (!claim || claim.owner !== owner) return { confirmed: false };
	if (claim.leaseExpiresAt <= Date.now()) {
		removeRewindComposerClaim(claim, true);
		return { confirmed: false };
	}
	const session = sessionsByProject.get(claim.projectId)?.get(claim.sessionId);
	if (
		!session?.pendingComposerRestoration ||
		session.pendingComposerRestoration.revision !== claim.revision ||
		rewindComposerClaimBySession.get(sessionKey(claim.projectId, claim.sessionId)) !== claimId
	) {
		return { confirmed: false };
	}

	delete session.pendingComposerRestoration;
	removeRewindComposerClaim(claim);
	rememberConfirmedRewindComposerClaim(claim);
	return { confirmed: true, alreadyConfirmed: false };
}

export function releaseRewindComposerClaim(
	claimId: string,
	owner: ChatOperationOwner,
): AiEditionChatRewindComposerReleaseResult {
	const claim = rewindComposerClaims.get(claimId);
	if (!claim || claim.owner !== owner) return { released: false };
	if (claim.leaseExpiresAt <= Date.now()) {
		removeRewindComposerClaim(claim, true);
		return { released: false };
	}
	const session = sessionsByProject.get(claim.projectId)?.get(claim.sessionId);
	if (
		!session?.pendingComposerRestoration ||
		session.pendingComposerRestoration.revision !== claim.revision ||
		rewindComposerClaimBySession.get(sessionKey(claim.projectId, claim.sessionId)) !== claimId
	) {
		return { released: false };
	}
	removeRewindComposerClaim(claim, true);
	return { released: true };
}

export function renameSession(
	projectId: string,
	sessionId: string,
	title: string,
): ChatSessionSummary | null {
	const m = sessionsByProject.get(projectId);
	const s = m?.get(sessionId);
	if (!s) return null;
	if (sessionHasPendingOperation(projectId, sessionId)) return null;
	const trimmed = title.trim();
	if (trimmed && trimmed !== s.title) {
		s.title = trimmed;
		clearPendingComposerRestoration(s);
		s.revision++;
	}
	return toSummary(s);
}

export function deleteSession(projectId: string, sessionId: string): boolean {
	const m = sessionsByProject.get(projectId);
	if (!m?.has(sessionId)) return false;
	if (sessionHasPendingOperation(projectId, sessionId)) return false;
	const session = m.get(sessionId);
	if (session) clearPendingComposerRestoration(session);
	m.delete(sessionId);
	messageCheckpointsBySession.delete(sessionKey(projectId, sessionId));
	return true;
}

export interface ChatEventSink {
	/** Streamed text delta from the model. */
	text?: (delta: string) => void;
	/** Streamed delta from the model's reasoning block (Anthropic/MiniMax
	 * thinking). Provider-agnostic — never called for providers that don't
	 * expose thinking. The chat panel streams these into a live "Thinking…"
	 * block so the reasoning phase doesn't feel like dead air. */
	thinking?: (delta: string) => void;
	/** A tool call is about to execute. */
	toolStart?: (name: string, args: unknown) => void;
	/** A tool call has finished. `ok=false` carries the model's error message. */
	toolEnd?: (name: string, ok: boolean, summary?: string) => void;
	/** The agent loop hit a fatal error (provider 4xx, network, parse). */
	error?: (message: string) => void;
}

export interface ChatRunEnv {
	/** Reads recorded cursor telemetry for an asset. Built in `electron/ipc/
	 *  handlers.ts`, where the path allow-list lives. */
	cursor?: CursorTelemetryReader;
}

// ponytail: zero-config noop for sink callbacks that the caller did not provide.
const noop = () => undefined;

/** ponytail: zero-config sink that swallows every event. */
const NOOP_SINK: Required<ChatEventSink> = {
	text: noop,
	thinking: noop,
	toolStart: noop,
	toolEnd: noop,
	error: noop,
};

export async function runChat(
	projectId: string,
	sessionId: string,
	message: string,
	llmConfig: LlmConfigStore,
	documentInput?: unknown,
	sink: ChatEventSink = {},
	/** Runtime capabilities the pure chat path cannot build for itself. Optional
	 *  and last so the three existing call sites are unchanged — but note that a
	 *  production caller which forgets to pass `cursor` gets an agent that answers
	 *  "I could not look" every time, which is honest and unhelpful. */
	env: ChatRunEnv = {},
	/** Renderer correlation id. When supplied, history remains staged until commitChatRun. */
	operationId?: string,
	owner: ChatOperationOwner | null = null,
): Promise<AiEditionChatResult> {
	const emit: Required<ChatEventSink> = { ...NOOP_SINK, ...sink };
	const config = llmConfig.getConfig();
	if (!config) {
		return {
			success: false,
			error: "No LLM provider configured. Open Settings → AI to configure.",
		};
	}

	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	if (!def) {
		return { success: false, error: `Unknown provider: ${config.provider}` };
	}

	const credential = llmConfig.getCredential(def.id, def.envKeys);
	const apiKey = credential?.value ?? null;
	if (!apiKey && def.authKind === "api-key") {
		return {
			success: false,
			error: `No API key for ${def.label}. Add one in Settings → AI.`,
		};
	}

	const sessions = getProjectSessions(projectId);
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, error: "Chat session unavailable." };
	}
	if (sessionHasPendingOperation(projectId, session.id)) {
		return { success: false, error: "Another chat operation is already pending." };
	}

	// Tools only run against a valid document snapshot; a missing or invalid
	// snapshot degrades to text-only chat instead of failing the turn.
	let workingDocument: AxcutDocument | null = null;
	if (documentInput !== undefined && documentInput !== null) {
		const parsed = documentSchema.safeParse(documentInput);
		if (parsed.success) workingDocument = parsed.data;
	}

	const userMessage: AiEditionChatMessage = {
		id: randomUUID(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};

	// ponytail: snapshot the document *right before* this user message
	// triggers a turn — same restore semantics as axcut's per-message
	// checkpoint. We hold a stable `workingDocument` ref so this snapshot
	// reflects what the user saw when they hit Send.
	const documentForCheckpoint: AxcutDocument | null = workingDocument
		? structuredClone(workingDocument)
		: null;
	userMessage.checkpointId = documentForCheckpoint ? userMessage.id : null;
	const runOperationId = operationId?.trim() || `chat_run_${randomUUID()}`;
	if (operationIdIsInUse(runOperationId)) {
		return { success: false, error: "Chat operation id is already in use." };
	}
	const pendingRun: PendingChatRun = {
		operationId: runOperationId,
		kind: "chat",
		projectId,
		sessionId: session.id,
		createdAt: Date.now(),
		state: "running",
		expectedSessionRevision: session.revision,
		userMessage,
		assistantMessage: null,
		checkpoint: documentForCheckpoint,
		intendedDocument: null,
		requiresPersistence: false,
		retainCommitResult: operationId !== undefined,
		expiresAt: 0,
		owner,
		ownerDetached: false,
	};
	if (!addActiveOperation(pendingRun)) {
		return { success: false, error: "Too many chat operations are active." };
	}

	const editsAllowed = config.allowAgentEdits !== false;

	// ponytail: NO automatic compaction here. A turn used to first check the
	// history against a guessed 80k-token budget and, past 70% of it, block on
	// a whole extra summarizer call before the user's request was even sent.
	// The app cannot ask a provider how big its context window is, so that
	// budget was a number someone picked — wrong by an order of magnitude for a
	// 1M-token Gemini, and silently discarding context the model could have
	// held. Compaction is now only ever what the user asked for by pressing the
	// button. See chat-compaction.ts.

	const history = modelHistory(session, userMessage).map((m) => ({
		role: m.role as "user" | "assistant" | "system",
		content: m.content,
	}));

	const appliedToolCalls: AiEditionToolCallSummary[] = [];

	const agentSink = {
		text: (delta: string) => emit.text(delta),
		thinking: (delta: string) => emit.thinking(delta),
		toolStart: (name: string, args: unknown) => {
			emit.toolStart(name, args);
		},
		toolEnd: (name: string, ok: boolean, summary?: string) => {
			emit.toolEnd(name, ok, summary);
			if (ok && summary) {
				appliedToolCalls.push({ name, summary });
			}
		},
		error: (message: string) => emit.error(message),
	};

	const { invokeOpenScreenAgent } = await import("./deep-agent/service");

	let result: Awaited<ReturnType<typeof invokeOpenScreenAgent>>;
	try {
		result = await invokeOpenScreenAgent({
			document: workingDocument ?? emptyDocumentForTextOnly(projectId),
			model: {
				provider: config.provider,
				model: config.model,
				apiKey: apiKey ?? undefined,
				baseUrl: config.baseUrl,
				reasoningEffort: config.reasoningEffort,
			},
			history,
			userMessage: message,
			sink: agentSink,
			editsAllowed,
			cursor: env.cursor,
		});
	} catch (error) {
		if (pendingChatRuns.get(runOperationId) === pendingRun) {
			if (pendingRun.retainCommitResult) abortPendingOperation(pendingRun);
			else deleteOperationRecord(runOperationId);
		}
		throw error;
	}
	if (pendingChatRuns.get(runOperationId) !== pendingRun) {
		return { success: false, error: "Chat run was abandoned." };
	}

	if (!result.text) {
		if (pendingChatRuns.get(runOperationId) === pendingRun) {
			if (pendingRun.retainCommitResult) abortPendingOperation(pendingRun);
			else deleteOperationRecord(runOperationId);
		}
		// ponytail: surface the deep-agent's diagnostic so the user can see
		// *why* the model produced no text (e.g. MiniMax streaming only
		// thinking blocks, or a non-text content shape that our extractor
		// missed). Falls back to the generic message when the agent didn't
		// provide a reason.
		return {
			success: false,
			error: result.reason ?? "Empty response from model.",
		};
	}

	const assistantMessage: AiEditionChatMessage = {
		id: randomUUID(),
		role: "assistant",
		content: result.text,
		createdAt: new Date().toISOString(),
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
	};
	pendingRun.assistantMessage = assistantMessage;
	pendingRun.requiresPersistence = result.mutated && editsAllowed;
	pendingRun.intendedDocument = pendingRun.requiresPersistence
		? structuredClone(result.document)
		: null;
	pendingRun.state = "prepared";
	scheduleActivePhase(pendingRun, PREPARED_OPERATION_TTL_MS);

	// Direct main-process consumers use immediate commit. The renderer supplies an operation id
	// and commits only after its launch document has been accepted and persisted.
	if (!operationId) {
		const committed = commitChatRun(projectId, session.id, runOperationId, owner);
		if (!committed.success) return committed;
	}

	return {
		success: true,
		assistantMessage,
		// ponytail: belt and braces on `editsAllowed`. This returned document is
		// the ONLY path to disk (LeftPanel → applyDocumentResult),
		// so it is where a write that somehow escaped the executor's guard would
		// still land. Cheap, and it makes the setting's guarantee structural
		// rather than dependent on one predicate holding everywhere.
		document: result.mutated && editsAllowed ? result.document : undefined,
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
		userMessageCheckpointId: userMessage.checkpointId ?? undefined,
	};
}

export function commitChatRun(
	projectId: string,
	sessionId: string,
	operationId: string,
	owner: ChatOperationOwner | null = null,
): AiEditionChatCommitResult {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal) {
		if (
			terminal.state === "committed" &&
			terminal.kind === "chat" &&
			operationBelongsToSession(terminal, projectId, sessionId)
		) {
			return cloneChatCommitResult(terminal.result);
		}
		return {
			success: false,
			error: "Chat operation belongs to another session or operation kind.",
		};
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	const pending = operation?.kind === "chat" ? operation : null;
	if (!pending || !operationBelongsToSession(pending, projectId, sessionId)) {
		return { success: false, error: "Chat operation not found or expired." };
	}
	if (!operationIsOwnedBy(pending, owner)) {
		return { success: false, error: "Chat operation belongs to another document owner." };
	}
	if (pending.state === "running" || !pending.assistantMessage) {
		return { success: false, error: "Chat operation is still running." };
	}
	if (pending.requiresPersistence && pending.retainCommitResult && pending.state !== "persisting") {
		return { success: false, error: "Chat operation has not begun document persistence." };
	}
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session || session.revision !== pending.expectedSessionRevision) {
		abortPendingOperation(pending);
		return { success: false, error: "Conversation changed before the chat result committed." };
	}

	if (pending.checkpoint) {
		recordMessageCheckpoint(projectId, sessionId, pending.userMessage.id, pending.checkpoint);
	}
	session.messages.push(cloneMessage(pending.userMessage), cloneMessage(pending.assistantMessage));
	clearPendingComposerRestoration(session);
	session.revision++;
	const result: Extract<AiEditionChatCommitResult, { success: true }> = {
		success: true,
		messages: session.messages.map(cloneMessage),
		sessionRevision: session.revision,
	};
	if (pending.retainCommitResult) {
		rememberCompletedOperation({
			operationId,
			createdAt: pending.createdAt,
			projectId,
			sessionId,
			state: "committed",
			kind: "chat",
			result,
			expiresAt: 0,
		});
	} else {
		deleteOperationRecord(operationId);
	}
	emitChatSessionUpdate({
		projectId,
		sessionId,
		revision: session.revision,
		operationId,
		kind: "chat",
		messages: result.messages.map(cloneMessage),
	});
	return cloneChatCommitResult(result);
}

export function abortChatRun(
	projectId: string,
	sessionId: string,
	operationId: string,
	owner: ChatOperationOwner | null = null,
): { success: true } | { success: false; error: string } {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal) {
		if (operationBelongsToSession(terminal, projectId, sessionId)) {
			return {
				success: false,
				error:
					terminal.state === "committed"
						? "Chat operation is already committed."
						: "Chat operation is already aborted.",
			};
		}
		return { success: false, error: "Chat operation belongs to another session." };
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	const pending = operation?.kind === "chat" ? operation : null;
	if (!pending || !operationBelongsToSession(pending, projectId, sessionId)) {
		return { success: false, error: "Chat operation not found or expired." };
	}
	if (!operationIsOwnedBy(pending, owner)) {
		return { success: false, error: "Chat operation belongs to another document owner." };
	}
	if (pending.state === "persisting") {
		return { success: false, error: "Persisting chat operation requires reconciliation." };
	}
	return abortPendingOperation(pending);
}

// Preparation is non-destructive. It locks this session revision until the renderer has
// accepted and persisted the document; only commitRewindToMessage truncates history.
export function prepareRewindToMessage(
	projectId: string,
	sessionId: string,
	messageId: string,
	owner: ChatOperationOwner | null = null,
): AiEditionChatRewindPrepareResult {
	pruneExpiredOperations();
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return { success: false, error: "Chat session not found." };
	if (sessionHasPendingOperation(projectId, sessionId)) {
		return { success: false, error: "Another chat operation is already pending." };
	}
	const messageIndex = session.messages.findIndex((m) => m.id === messageId);
	if (messageIndex === -1) {
		return { success: false, error: "Message not found in this session." };
	}
	const target = session.messages[messageIndex];
	if (target.role !== "user") {
		return { success: false, error: "Rewind must target a user message." };
	}
	if (!target.checkpointId) {
		return { success: false, error: "No checkpoint stored for this message." };
	}
	const cp = findCheckpointForMessage(projectId, sessionId, target.checkpointId);
	if (!cp) {
		return {
			success: false,
			error: "Checkpoint expired — start a fresh chat to recover state.",
		};
	}

	let operationId = `chat_rewind_${randomUUID()}`;
	while (operationIdIsInUse(operationId)) operationId = `chat_rewind_${randomUUID()}`;
	const prepared: PendingRewind = {
		operationId,
		kind: "rewind",
		projectId,
		sessionId,
		createdAt: Date.now(),
		state: "prepared",
		targetMessageId: messageId,
		expectedSessionRevision: session.revision,
		prompt: target.content,
		document: structuredClone(cp.document),
		messages: session.messages.slice(0, messageIndex + 1).map(cloneMessage),
		expiresAt: 0,
		owner,
		ownerDetached: false,
	};
	if (!addActiveOperation(prepared)) {
		return { success: false, error: "Too many chat operations are active." };
	}

	return {
		success: true,
		operationId,
		sessionRevision: session.revision,
		document: structuredClone(prepared.document),
		messages: prepared.messages.map(cloneMessage),
	};
}

export function commitRewindToMessage(
	projectId: string,
	sessionId: string,
	operationId: string,
	sessionRevision: number,
	owner: ChatOperationOwner | null = null,
): AiEditionChatRewindCommitResult {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal) {
		if (
			terminal.state === "committed" &&
			terminal.kind === "rewind" &&
			terminal.sessionRevision === sessionRevision &&
			operationBelongsToSession(terminal, projectId, sessionId)
		) {
			return cloneRewindCommitResult(terminal.result);
		}
		return { success: false, error: "Rewind operation identity does not match its commit." };
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	const prepared = operation?.kind === "rewind" ? operation : null;
	if (!prepared || !operationBelongsToSession(prepared, projectId, sessionId)) {
		return { success: false, error: "Rewind operation not found or expired." };
	}
	if (!operationIsOwnedBy(prepared, owner)) {
		return { success: false, error: "Rewind operation belongs to another document owner." };
	}
	if (prepared.state !== "persisting") {
		return { success: false, error: "Rewind operation has not begun document persistence." };
	}
	if (sessionRevision !== prepared.expectedSessionRevision) {
		return { success: false, error: "Rewind session revision does not match its preparation." };
	}
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session || session.revision !== prepared.expectedSessionRevision) {
		abortPendingOperation(prepared);
		return { success: false, error: "Conversation changed before rewind commit." };
	}
	const target = session.messages.find((message) => message.id === prepared.targetMessageId);
	if (
		!target?.checkpointId ||
		!findCheckpointForMessage(projectId, sessionId, target.checkpointId)
	) {
		abortPendingOperation(prepared);
		return { success: false, error: "Rewind checkpoint is no longer available." };
	}

	session.messages = prepared.messages.map(cloneMessage);
	if (session.compaction && session.compaction.coveredCount > session.messages.length) {
		session.compaction = undefined;
	}
	dropCheckpointsFrom(projectId, sessionId, target.checkpointId);
	clearPendingComposerRestoration(session);
	session.revision++;
	session.pendingComposerRestoration = {
		prompt: prepared.prompt,
		revision: session.revision,
	};
	const result: Extract<AiEditionChatRewindCommitResult, { success: true }> = {
		success: true,
		messages: session.messages.map(cloneMessage),
		sessionRevision: session.revision,
		pendingComposerRestoration: { revision: session.revision },
	};
	rememberCompletedOperation({
		operationId,
		createdAt: prepared.createdAt,
		projectId,
		sessionId,
		state: "committed",
		kind: "rewind",
		sessionRevision,
		result: cloneRewindCommitResult(result),
		expiresAt: 0,
	});
	emitChatSessionUpdate({
		projectId,
		sessionId,
		revision: session.revision,
		operationId,
		kind: "rewind",
		messages: result.messages.map(cloneMessage),
		pendingComposerRestoration: { ...result.pendingComposerRestoration },
	});
	return cloneRewindCommitResult(result);
}

export function abortRewindToMessage(
	projectId: string,
	sessionId: string,
	operationId: string,
	owner: ChatOperationOwner | null = null,
): { success: true } | { success: false; error: string } {
	pruneExpiredOperations();
	const terminal = terminalChatOperations.get(operationId);
	if (terminal) {
		if (operationBelongsToSession(terminal, projectId, sessionId)) {
			return {
				success: false,
				error:
					terminal.state === "committed"
						? "Rewind operation is already committed."
						: "Rewind operation is already aborted.",
			};
		}
		return { success: false, error: "Rewind operation belongs to another session." };
	}
	const operation = ownedOperation(projectId, sessionId, operationId);
	const prepared = operation?.kind === "rewind" ? operation : null;
	if (!prepared || !operationBelongsToSession(prepared, projectId, sessionId)) {
		return { success: false, error: "Rewind operation not found or expired." };
	}
	if (!operationIsOwnedBy(prepared, owner)) {
		return { success: false, error: "Rewind operation belongs to another document owner." };
	}
	if (prepared.state === "persisting") {
		return { success: false, error: "Persisting rewind requires reconciliation." };
	}
	return abortPendingOperation(prepared);
}

// ponytail: renderer-initiated timeline operation. Reads the doc from disk,
// applies `op`, saves the result, and records a chat assistant message that
// summarises the change so the conversation history reflects the manual
// edit (axcut's `applyOperation` does the same).
//
// The renderer applies an optimistic copy to its local store before calling
// this; if the call fails we roll back to the previous document by re-reading
// the saved state, so the cache and disk stay aligned.
export interface TimelineOperationResult {
	document: AxcutDocument;
	summary: string;
}

export async function runTimelineOperation(
	projectId: string,
	sessionId: string,
	op: AxcutTimelineOperation,
	conversationMessage: string,
	documents: DocumentService,
): Promise<{ success: true; result: TimelineOperationResult } | { success: false; error: string }> {
	let session = sessionsByProject.get(projectId)?.get(sessionId);
	const created = !session;
	if (created) {
		const summary = createSession(projectId);
		session = sessionsByProject.get(projectId)?.get(summary.id);
		if (!session) return { success: false, error: "Could not create session." };
	}
	if (sessionHasPendingOperation(projectId, sessionId)) {
		return { success: false, error: "Another chat operation is already pending." };
	}

	let current: AxcutDocument;
	try {
		current = await documents.getProject(projectId);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const applied = applyTimelineOperation(current, op);

	let saved: AxcutDocument;
	try {
		saved = await documents.saveProject(applied.document);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (conversationMessage.trim() && session) {
		const assistantMessage: AiEditionChatMessage = {
			id: `msg_${randomUUID()}`,
			role: "assistant",
			content: conversationMessage.trim(),
			createdAt: new Date().toISOString(),
		};
		session.messages.push(assistantMessage);
		clearPendingComposerRestoration(session);
		session.revision++;
	}

	return {
		success: true,
		result: {
			document: saved,
			summary: applied.summary,
		},
	};
}

// ponytail: port of axcut's compactSession — manual compaction from a button
// press. Returns the latest session snapshot + the inserted summary message
// id, so the renderer can highlight it.
export async function compactSessionNow(
	projectId: string,
	sessionId: string,
	llmConfig: LlmConfigStore,
): Promise<AiEditionChatCompactResult | null> {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	if (sessionHasPendingOperation(projectId, sessionId)) return null;
	const config = llmConfig.getConfig();
	if (!config) return null;
	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	if (!def) return null;
	const credential = llmConfig.getCredential(def.id, def.envKeys);
	const apiKey = credential?.value ?? "";

	// Pressing the button IS the decision — nothing here second-guesses it
	// against a budget. It only declines when there is genuinely nothing to
	// fold (fewer than 4 messages), which is the one refusal left.
	const plan = planCompaction(session);
	if (!plan) return null;

	const ok = await tryCompactSession({
		session,
		plan,
		apiKey,
		provider: config.provider,
		model: config.model,
		baseUrl: config.baseUrl,
		reasoningEffort: config.reasoningEffort,
	});
	if (!ok) return null;
	return {
		summaryMessageId: ok.summaryMessageId,
		summary: ok.summary,
		session: selectSession(projectId, sessionId)!,
	};
}

// ponytail: port of axcut's getContextUsage. Returns the current session's
// token estimate + window budget so the renderer can fill the "% context"
// pill with real numbers (no probe — char-based heuristic matching the
// in-call compaction one).
export function getSessionContextUsage(
	projectId: string,
	sessionId: string,
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): { usedTokens: number; budgetTokens: number; ratio: number; fillPercent: number } | null {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	if (sessionHasPendingOperation(projectId, sessionId)) return null;
	// Measured on what the model is given, not on the transcript — after a
	// compaction those differ, and the number that matters is the one that
	// fills the context window.
	const snap = budgetSnapshot(modelMessages(session), budgetTokens);
	const fillPercent = Math.min(100, Math.round(snap.ratio * 100));
	return {
		usedTokens: snap.usedTokens,
		budgetTokens: snap.budgetTokens,
		ratio: snap.ratio,
		fillPercent,
	};
}

// ponytail: when no document snapshot exists the agent has no edit surface.
// We still hand it an empty (schema-valid) document so the LangGraph thread
// can run, and the model simply won't call write tools against it.
function emptyDocumentForTextOnly(projectId: string): AxcutDocument {
	return createEmptyDocument({ title: "Untitled project", projectId });
}

// --- Compaction (P3.7) ---------------------------------------------------

export interface SessionBudgetSnapshot {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
	fillPercent: number;
}

export function getSessionBudget(
	projectId: string,
	sessionId: string,
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): SessionBudgetSnapshot | null {
	const s = sessionsByProject.get(projectId)?.get(sessionId);
	if (!s) return null;
	const snap = budgetSnapshot(modelMessages(s), budgetTokens);
	return {
		usedTokens: snap.usedTokens,
		budgetTokens: snap.budgetTokens,
		ratio: snap.ratio,
		fillPercent: Math.min(100, Math.round(snap.ratio * 100)),
	};
}

/**
 * Force a compaction on the given session. Returns the inserted "Earlier
 * context" message id, or `null` if there isn't enough history yet.
 */
export async function compactSession(
	projectId: string,
	sessionId: string,
	llmConfig: LlmConfigStore,
): Promise<{ summaryMessageId: string | null; summary: string } | null> {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	const config = llmConfig.getConfig();
	if (!config) return null;
	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	const credential = def ? llmConfig.getCredential(def.id, def.envKeys) : null;
	const apiKey = credential?.value ?? "";

	const plan = planCompaction(session);
	if (!plan) return { summaryMessageId: null, summary: "" };

	const ok = await tryCompactSession({
		session,
		plan,
		apiKey,
		provider: config.provider,
		model: config.model,
		baseUrl: config.baseUrl,
		reasoningEffort: config.reasoningEffort,
	});
	return ok;
}

interface CompactionPlan {
	/** What the model currently gets — the input compaction shortens. */
	payload: AiEditionChatMessage[];
	/** Boundary inside `payload`. */
	splitIndex: number;
	/** The same boundary expressed as a count of transcript messages. */
	coveredCount: number;
}

/**
 * Where a compaction would cut, measured against the payload rather than the
 * transcript — compaction never rewrites the transcript, so the split index
 * has to be an index into the list it will actually be applied to.
 *
 * A second compaction folds the previous summary into the new one: it sits at
 * `payload[0]`, so it is part of the prefix being summarized.
 */
function planCompaction(session: ChatSession): CompactionPlan | null {
	const payload = modelMessages(session);
	const splitIndex = compactionSplitIndex(payload);
	if (splitIndex === null || splitIndex <= 0) return null;
	// Payload index → transcript index. With a summary in front, payload[i]
	// is transcript message `coveredCount + i - 1`.
	const offset = session.compaction ? session.compaction.coveredCount - 1 : 0;
	return { payload, splitIndex, coveredCount: splitIndex + offset };
}

/**
 * Summarize the older half of the model payload and record the boundary on the
 * session. The transcript is left alone — `session.messages` is what the
 * renderer shows, and compaction is a fact about the model's input.
 */
async function tryCompactSession(opts: {
	session: ChatSession;
	plan: CompactionPlan;
	apiKey: string;
	provider: string;
	model: string;
	baseUrl?: string;
	reasoningEffort?: string;
}): Promise<{ summaryMessageId: string | null; summary: string } | null> {
	const { session, plan, apiKey, provider, model, baseUrl, reasoningEffort } = opts;
	const expectedRevision = session.revision;
	const oldMessages = plan.payload.slice(0, plan.splitIndex);
	if (oldMessages.length === 0) return null;

	const prompt = buildCompactionPrompt(oldMessages);
	let summary = "";
	try {
		const { createOpenScreenChatModel, messageContentToText } = await import(
			"./deep-agent/chat-model"
		);
		const chatModel = await createOpenScreenChatModel({
			provider,
			model,
			apiKey,
			baseUrl,
			reasoningEffort,
		});
		const result = await chatModel.invoke([
			new SystemMessage(COMPACTION_SYSTEM_PROMPT),
			new HumanMessage(prompt),
		]);
		summary = messageContentToText(result.content);
		if (!summary) {
			return null;
		}
	} catch {
		// ponytail: a failed summarize must not break the chat turn — leave
		// the session as-is and let the next turn try again.
		return null;
	}

	const compacted = applyCompaction(
		plan.payload,
		plan.splitIndex,
		summary,
		new Date().toISOString(),
	);
	const summaryMessage = compacted[0];
	if (!summaryMessage) return null;
	if (!compactionReducesHistory(plan.payload, compacted)) {
		// The model handed back a summary at least as long as the messages it
		// replaced: adopting it would grow the payload. Refuse it and leave the
		// session alone. (There is no "stop trying" flag any more — nothing
		// retries on its own, so the only next attempt is another button press,
		// which is the user asking again knowingly.)
		return null;
	}
	if (
		session.revision !== expectedRevision ||
		sessionHasPendingOperation(session.projectId, session.id)
	) {
		return null;
	}
	session.compaction = { summary: summaryMessage, coveredCount: plan.coveredCount };
	clearPendingComposerRestoration(session);
	session.revision++;
	return {
		summaryMessageId: summaryMessage.id,
		summary,
	};
}
