import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ExportContainerExtension = ".mp4" | ".gif";
export type ExportTransactionOwner = object;

type RenameFile = (oldPath: string, newPath: string) => Promise<void>;
type RemoveFile = (filePath: string) => Promise<void>;
type RemoveDirectory = (directoryPath: string) => Promise<void>;
type ChmodStage = (handle: FileHandle, mode: number) => Promise<void>;
type SyncStage = (handle: FileHandle) => Promise<void>;

export interface ExportCleanupIssue {
	path: string;
	reason: string;
	error?: unknown;
}

export interface ExportErrorWithCleanup extends Error {
	cleanupIssues?: ExportCleanupIssue[];
}

export class ExportCleanupAggregateError extends Error {
	readonly errors: unknown[];

	constructor(errors: unknown[], message: string) {
		super(message);
		this.name = "ExportCleanupAggregateError";
		this.errors = errors;
	}
}

export interface ExportDestinationTransactionOptions {
	platform?: NodeJS.Platform;
	expiryMs?: number;
	rename?: RenameFile;
	unlink?: RemoveFile;
	rmdir?: RemoveDirectory;
	chmodStage?: ChmodStage;
	syncStage?: SyncStage;
	randomId?: () => string;
	onCleanupIssue?: (issue: ExportCleanupIssue) => void;
	processLocks?: Set<string>;
}

export interface BeginExportTransactionOptions {
	owner: ExportTransactionOwner;
	requestedPath: string;
	extension: ExportContainerExtension;
	sourcePaths: string[];
	requiresPostprocess: boolean;
}

export interface ExportDestinationTransactionHandle {
	id: string;
}

type TransactionState = "created" | "rendered" | "awaiting-postprocess" | "ready" | "closed";

interface NodeIdentity {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

interface OwnedDirectory {
	path: string;
	identity: NodeIdentity;
}

interface ExportDestinationTransaction {
	id: string;
	owner: ExportTransactionOwner;
	requestedPath: string;
	destinationPath: string;
	destinationKeys: string[];
	sourcePaths: string[];
	requiresPostprocess: boolean;
	workspace: OwnedDirectory;
	stagePath: string;
	stageIdentity: NodeIdentity;
	stageHandle: FileHandle | null;
	locks: OwnedDirectory[];
	state: TransactionState;
	busy: boolean;
	abortRequested: boolean;
	idlePromise: Promise<void> | null;
	resolveIdle: (() => void) | null;
	expiryTimer: NodeJS.Timeout | null;
}

interface PathIdentity {
	canonicalKey: string;
	stat: BigIntStats | null;
}

const PROCESS_DESTINATION_LOCKS = new Set<string>();
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const DEFAULT_EXPIRY_MS = 5 * 60_000;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function identityOf(stat: BigIntStats): NodeIdentity {
	return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function sameIdentity(stat: BigIntStats, identity: NodeIdentity): boolean {
	if (stat.dev !== identity.dev) return false;
	if (identity.ino !== 0n) return stat.ino === identity.ino;
	return stat.ino === 0n && stat.birthtimeNs === identity.birthtimeNs;
}

async function lstatIfExists(filePath: string): Promise<BigIntStats | null> {
	try {
		return await fs.lstat(filePath, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

async function statIfExists(filePath: string): Promise<BigIntStats | null> {
	try {
		return await fs.stat(filePath, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

/** Convert every local source to the exact filesystem spelling passed to native. */
export function normalizeLocalFilePath(input: string, label: string): string {
	if (typeof input !== "string" || !input.trim()) {
		throw new TypeError(`${label} must be a non-empty local file path.`);
	}
	if (WINDOWS_DRIVE_PATH.test(input) || !URI_SCHEME.test(input)) {
		return path.resolve(input);
	}

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new TypeError(`${label} contains a malformed URL.`);
	}
	if (parsed.protocol !== "file:") {
		throw new TypeError(`${label} uses unsupported protocol ${parsed.protocol}`);
	}
	try {
		return path.resolve(fileURLToPath(parsed));
	} catch {
		throw new TypeError(`${label} must be a valid local file URL.`);
	}
}

async function resolveExistingAncestors(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		const parent = path.dirname(filePath);
		if (parent === filePath) return filePath;
		return path.join(await resolveExistingAncestors(parent), path.basename(filePath));
	}
}

function normalizeCase(filePath: string, platform: NodeJS.Platform): string {
	return platform === "win32" || platform === "darwin" ? filePath.toLowerCase() : filePath;
}

async function identifyPath(filePath: string, platform: NodeJS.Platform): Promise<PathIdentity> {
	const physicalPath = await resolveExistingAncestors(filePath);
	return {
		canonicalKey: normalizeCase(path.normalize(physicalPath), platform),
		stat: await statIfExists(filePath),
	};
}

async function assertReplaceableDestination(
	filePath: string,
	identity: PathIdentity,
): Promise<void> {
	const entry = await lstatIfExists(filePath);
	if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
		throw new Error("Export destination must be a regular file path.");
	}
	if (identity.stat && !identity.stat.isFile()) {
		throw new Error("Export destination must resolve to a regular file.");
	}
}

function sameInode(left: BigIntStats | null, right: BigIntStats | null): boolean {
	return Boolean(
		left && right && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino,
	);
}

function lockName(key: string): string {
	return `.openscreen-export-lock-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function attachCleanupIssues(error: unknown, issues: ExportCleanupIssue[]): Error {
	const primary = toError(error) as ExportErrorWithCleanup;
	if (issues.length > 0) {
		try {
			Object.defineProperty(primary, "cleanupIssues", {
				value: issues,
				configurable: true,
			});
		} catch {
			// Reporting still happens through onCleanupIssue; never replace the primary error.
		}
	}
	return primary;
}

/**
 * Owns one private workspace and deterministic lock set per export. Crash leftovers are never
 * reclaimed automatically: without a live owner token, deleting a lock could admit two writers.
 */
export class ExportDestinationTransactionManager {
	private readonly platform: NodeJS.Platform;
	private readonly expiryMs: number;
	private readonly rename: RenameFile;
	private readonly unlink: RemoveFile;
	private readonly rmdir: RemoveDirectory;
	private readonly chmodStage: ChmodStage;
	private readonly syncStage: SyncStage;
	private readonly randomId: () => string;
	private readonly onCleanupIssue: (issue: ExportCleanupIssue) => void;
	private readonly processLocks: Set<string>;
	private readonly transactions = new Map<string, ExportDestinationTransaction>();
	private readonly transactionsByOwner = new Map<ExportTransactionOwner, Set<string>>();
	private readonly revokedOwners = new WeakSet<ExportTransactionOwner>();

	constructor(options: ExportDestinationTransactionOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
		this.rename = options.rename ?? fs.rename;
		this.unlink = options.unlink ?? fs.unlink;
		this.rmdir = options.rmdir ?? fs.rmdir;
		this.chmodStage = options.chmodStage ?? ((handle, mode) => handle.chmod(mode));
		this.syncStage = options.syncStage ?? ((handle) => handle.sync());
		this.randomId = options.randomId ?? randomUUID;
		this.onCleanupIssue =
			options.onCleanupIssue ??
			((issue) => {
				console.error(
					`[export-destination] ${issue.reason}: ${path.basename(issue.path)}`,
					issue.error,
				);
			});
		this.processLocks = options.processLocks ?? PROCESS_DESTINATION_LOCKS;
	}

	async begin(options: BeginExportTransactionOptions): Promise<ExportDestinationTransactionHandle> {
		if (typeof options.owner !== "object" || options.owner === null) {
			throw new TypeError("Export transaction owner is required.");
		}
		if (this.revokedOwners.has(options.owner)) {
			throw new Error("Export transaction owner is no longer active.");
		}
		const destinationPath = normalizeLocalFilePath(options.requestedPath, "Export destination");
		if (!destinationPath.toLowerCase().endsWith(options.extension)) {
			throw new TypeError(`Export destination must end in ${options.extension}.`);
		}
		const sourcePaths = options.sourcePaths.map((sourcePath, index) =>
			normalizeLocalFilePath(sourcePath, `Export source ${index + 1}`),
		);
		const destinationIdentity = await identifyPath(destinationPath, this.platform);
		await assertReplaceableDestination(destinationPath, destinationIdentity);
		await this.assertDestinationIsNotSource(destinationIdentity, sourcePaths);

		const destinationKeys = [`path:${destinationIdentity.canonicalKey}`];
		if (destinationIdentity.stat?.ino) {
			destinationKeys.push(`inode:${destinationIdentity.stat.dev}:${destinationIdentity.stat.ino}`);
		}
		const directory = path.dirname(destinationPath);
		const locks = await this.acquireLocks(directory, destinationKeys);

		let workspace: OwnedDirectory | null = null;
		let stageHandle: FileHandle | null = null;
		let stageIdentity: NodeIdentity | null = null;
		let stagePath = "";
		try {
			const workspacePath = await fs.mkdtemp(path.join(directory, ".openscreen-export-"));
			const initialWorkspaceStat = await fs.lstat(workspacePath, { bigint: true });
			workspace = { path: workspacePath, identity: identityOf(initialWorkspaceStat) };
			await fs.chmod(workspacePath, 0o700);
			const workspaceStat = await fs.lstat(workspacePath, { bigint: true });
			if (
				!workspaceStat.isDirectory() ||
				workspaceStat.isSymbolicLink() ||
				!sameIdentity(workspaceStat, workspace.identity)
			) {
				throw new Error("Export workspace is not a private directory.");
			}
			if (this.platform !== "win32" && (workspaceStat.mode & 0o077n) !== 0n) {
				throw new Error("Export workspace permissions are not private.");
			}
			stagePath = path.join(workspacePath, `output${options.extension}`);
			stageHandle = await fs.open(stagePath, "wx+", 0o600);
			stageIdentity = identityOf(await stageHandle.stat({ bigint: true }));
			await stageHandle.chmod(0o600);
			const [handleStat, pathStat] = await Promise.all([
				stageHandle.stat({ bigint: true }),
				fs.lstat(stagePath, { bigint: true }),
			]);
			if (
				!handleStat.isFile() ||
				!pathStat.isFile() ||
				!sameIdentity(pathStat, stageIdentity) ||
				handleStat.nlink !== 1n
			) {
				throw new Error("Export stage file identity could not be reserved safely.");
			}

			const id = this.randomId();
			if (this.transactions.has(id)) throw new Error("Export transaction ID collision.");
			if (this.revokedOwners.has(options.owner)) {
				throw new Error("Export transaction owner is no longer active.");
			}
			const transaction: ExportDestinationTransaction = {
				id,
				owner: options.owner,
				requestedPath: options.requestedPath,
				destinationPath,
				destinationKeys,
				sourcePaths,
				requiresPostprocess: options.requiresPostprocess,
				workspace,
				stagePath,
				stageIdentity,
				stageHandle,
				locks,
				state: "created",
				busy: false,
				abortRequested: false,
				idlePromise: null,
				resolveIdle: null,
				expiryTimer: null,
			};
			this.transactions.set(id, transaction);
			const ownerTransactions = this.transactionsByOwner.get(options.owner) ?? new Set<string>();
			ownerTransactions.add(id);
			this.transactionsByOwner.set(options.owner, ownerTransactions);
			return { id };
		} catch (error) {
			const issues: ExportCleanupIssue[] = [];
			if (stageHandle) {
				await stageHandle.close().catch((closeError) =>
					issues.push({
						path: stagePath,
						reason: "failed to close stage file",
						error: closeError,
					}),
				);
			}
			if (stagePath) await this.removeExpectedFile(stagePath, stageIdentity, issues);
			if (workspace) await this.removeExpectedDirectory(workspace, issues);
			await this.releaseLocks(destinationKeys, locks, issues);
			this.reportCleanupIssues(issues);
			throw attachCleanupIssues(error, issues);
		}
	}

	async render<T>(
		owner: ExportTransactionOwner,
		id: string,
		writer: (internalPath: string) => Promise<T>,
	): Promise<T> {
		const transaction = this.requireOwned(id, owner);
		this.enter(transaction, ["created"], "render");
		try {
			await this.verifyStage(transaction, false);
			const result = await writer(transaction.stagePath);
			await this.verifyStage(transaction, true);
			if (transaction.abortRequested) throw new Error("Export transaction was aborted.");
			transaction.state = "rendered";
			return result;
		} catch (error) {
			const issues = await this.closeTransaction(transaction);
			throw attachCleanupIssues(error, issues);
		} finally {
			this.leave(transaction);
		}
	}

	async readRenderedOutput(owner: ExportTransactionOwner, id: string): Promise<Buffer> {
		const transaction = this.requireOwned(id, owner);
		if (!transaction.requiresPostprocess) {
			throw new Error("Export transaction does not allow post-processing.");
		}
		this.enter(transaction, ["rendered"], "read rendered output");
		try {
			const stat = await this.verifyStage(transaction, true);
			if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new Error("Staged export is too large to read for post-processing.");
			}
			const data = Buffer.alloc(Number(stat.size));
			let offset = 0;
			while (offset < data.length) {
				const read = await transaction.stageHandle!.read(
					data,
					offset,
					data.length - offset,
					offset,
				);
				if (read.bytesRead === 0) throw new Error("Staged export ended while being read.");
				offset += read.bytesRead;
			}
			if (transaction.abortRequested) throw new Error("Export transaction was aborted.");
			transaction.state = "awaiting-postprocess";
			return data;
		} catch (error) {
			const issues = await this.closeTransaction(transaction);
			throw attachCleanupIssues(error, issues);
		} finally {
			this.leave(transaction);
		}
	}

	async replaceWithPostprocessedOutput(
		owner: ExportTransactionOwner,
		id: string,
		data: Uint8Array,
	): Promise<void> {
		const transaction = this.requireOwned(id, owner);
		this.enter(transaction, ["awaiting-postprocess"], "write post-processed output");
		try {
			if (data.byteLength === 0) throw new Error("Post-processing produced an empty output file.");
			await this.verifyStage(transaction, true);
			const handle = transaction.stageHandle!;
			await handle.truncate(0);
			let offset = 0;
			while (offset < data.byteLength) {
				const written = await handle.write(data, offset, data.byteLength - offset, offset);
				if (written.bytesWritten === 0) throw new Error("Post-processed output write stalled.");
				offset += written.bytesWritten;
			}
			await handle.truncate(data.byteLength);
			await this.verifyStage(transaction, true);
			if (transaction.abortRequested) throw new Error("Export transaction was aborted.");
			transaction.state = "ready";
		} catch (error) {
			const issues = await this.closeTransaction(transaction);
			throw attachCleanupIssues(error, issues);
		} finally {
			this.leave(transaction);
		}
	}

	async commit(owner: ExportTransactionOwner, id: string): Promise<string> {
		const transaction = this.requireOwned(id, owner);
		const expectedState: TransactionState = transaction.requiresPostprocess ? "ready" : "rendered";
		this.enter(transaction, [expectedState], "commit");
		try {
			await this.verifyStage(transaction, true);
			if (transaction.abortRequested) throw new Error("Export transaction was aborted.");
			const destinationIdentity = await identifyPath(transaction.destinationPath, this.platform);
			await assertReplaceableDestination(transaction.destinationPath, destinationIdentity);
			await this.assertDestinationIsNotSource(destinationIdentity, transaction.sourcePaths);

			const handle = transaction.stageHandle!;
			if (this.platform !== "win32" && destinationIdentity.stat?.isFile()) {
				await this.chmodStage(handle, Number(destinationIdentity.stat.mode & 0o777n));
			}
			await this.syncStage(handle);
			await this.verifyStage(transaction, true);
			await handle.close();
			transaction.stageHandle = null;
			await this.verifyClosedStagePath(transaction);
			if (transaction.abortRequested) throw new Error("Export transaction was aborted.");

			// One replacement primitive only. If this filesystem cannot overwrite atomically, fail
			// without ever moving or unlinking the old destination.
			await this.rename(transaction.stagePath, transaction.destinationPath);
			transaction.state = "closed";
			await this.closeTransaction(transaction);
			return transaction.requestedPath;
		} catch (error) {
			const issues = await this.closeTransaction(transaction);
			throw attachCleanupIssues(error, issues);
		} finally {
			this.leave(transaction);
		}
	}

	async run<T>(
		owner: ExportTransactionOwner,
		requestedPath: string,
		extension: ExportContainerExtension,
		sourcePaths: string[],
		writer: (internalPath: string) => Promise<T>,
	): Promise<T> {
		const transaction = await this.begin({
			owner,
			requestedPath,
			extension,
			sourcePaths,
			requiresPostprocess: false,
		});
		const result = await this.render(owner, transaction.id, writer);
		await this.commit(owner, transaction.id);
		return result;
	}

	async abort(owner: ExportTransactionOwner, id: string): Promise<void> {
		let transaction = this.requireOwned(id, owner);
		if (transaction.busy) {
			transaction.abortRequested = true;
			await transaction.idlePromise;
			const remaining = this.transactions.get(id);
			if (!remaining) return;
			transaction = this.requireOwned(id, owner);
		}
		this.enter(transaction, ["created", "rendered", "awaiting-postprocess", "ready"], "abort");
		try {
			const issues = await this.closeTransaction(transaction);
			if (issues.length > 0) {
				throw new ExportCleanupAggregateError(
					issues.map((issue) => issue.error ?? new Error(issue.reason)),
					"Export transaction cleanup was incomplete.",
				);
			}
		} finally {
			this.leave(transaction);
		}
	}

	async abortOwner(owner: ExportTransactionOwner): Promise<void> {
		this.revokedOwners.add(owner);
		const ids = [...(this.transactionsByOwner.get(owner) ?? [])];
		const results = await Promise.allSettled(ids.map((id) => this.abort(owner, id)));
		const errors = results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		if (errors.length > 0) {
			throw new ExportCleanupAggregateError(errors, "Failed to abort all owned exports.");
		}
	}

	private requireOwned(id: string, owner: ExportTransactionOwner): ExportDestinationTransaction {
		const transaction = this.transactions.get(id);
		if (!transaction) throw new Error("Export transaction is not active.");
		if (transaction.owner !== owner)
			throw new Error("Export transaction belongs to another sender.");
		return transaction;
	}

	private enter(
		transaction: ExportDestinationTransaction,
		allowedStates: TransactionState[],
		operation: string,
	): void {
		if (transaction.busy)
			throw new Error("Export transaction already has an operation in progress.");
		if (!allowedStates.includes(transaction.state)) {
			throw new Error(`Cannot ${operation} an export transaction in state ${transaction.state}.`);
		}
		if (transaction.expiryTimer) clearTimeout(transaction.expiryTimer);
		transaction.expiryTimer = null;
		transaction.busy = true;
		transaction.idlePromise = new Promise<void>((resolve) => {
			transaction.resolveIdle = resolve;
		});
	}

	private leave(transaction: ExportDestinationTransaction): void {
		if (!transaction.busy) return;
		transaction.busy = false;
		transaction.resolveIdle?.();
		transaction.resolveIdle = null;
		transaction.idlePromise = null;
		if (this.transactions.has(transaction.id)) this.scheduleExpiry(transaction);
	}

	private scheduleExpiry(transaction: ExportDestinationTransaction): void {
		if (!transaction.requiresPostprocess || this.expiryMs <= 0) return;
		transaction.expiryTimer = setTimeout(() => {
			void this.abort(transaction.owner, transaction.id).catch((error) => {
				this.reportCleanupIssues([
					{
						path: transaction.workspace.path,
						reason: "expired export cleanup failed",
						error,
					},
				]);
			});
		}, this.expiryMs);
		transaction.expiryTimer.unref?.();
	}

	private async verifyWorkspace(transaction: ExportDestinationTransaction): Promise<void> {
		const stat = await fs.lstat(transaction.workspace.path, { bigint: true });
		if (!stat.isDirectory() || !sameIdentity(stat, transaction.workspace.identity)) {
			throw new Error("Export workspace identity changed during the transaction.");
		}
		for (const lock of transaction.locks) {
			const lockStat = await fs.lstat(lock.path, { bigint: true });
			if (!lockStat.isDirectory() || !sameIdentity(lockStat, lock.identity)) {
				throw new Error("Export destination lock identity changed during the transaction.");
			}
		}
	}

	private async verifyStage(
		transaction: ExportDestinationTransaction,
		requireNonEmpty: boolean,
	): Promise<BigIntStats> {
		await this.verifyWorkspace(transaction);
		const handle = transaction.stageHandle;
		if (!handle) throw new Error("Export stage file is closed.");
		const [handleStat, pathStat] = await Promise.all([
			handle.stat({ bigint: true }),
			fs.lstat(transaction.stagePath, { bigint: true }),
		]);
		if (
			!handleStat.isFile() ||
			!pathStat.isFile() ||
			!sameIdentity(handleStat, transaction.stageIdentity) ||
			!sameIdentity(pathStat, transaction.stageIdentity) ||
			handleStat.nlink !== 1n ||
			pathStat.nlink !== 1n
		) {
			throw new Error("Export stage file identity changed during the transaction.");
		}
		if (requireNonEmpty && handleStat.size <= 0n) {
			throw new Error("Export produced an empty output file.");
		}
		return handleStat;
	}

	private async verifyClosedStagePath(transaction: ExportDestinationTransaction): Promise<void> {
		await this.verifyWorkspace(transaction);
		const pathStat = await fs.lstat(transaction.stagePath, { bigint: true });
		if (
			!pathStat.isFile() ||
			!sameIdentity(pathStat, transaction.stageIdentity) ||
			pathStat.nlink !== 1n ||
			pathStat.size <= 0n
		) {
			throw new Error("Export stage file identity changed before installation.");
		}
	}

	private async assertDestinationIsNotSource(
		destinationIdentity: PathIdentity,
		sourcePaths: string[],
	): Promise<void> {
		for (const sourcePath of sourcePaths) {
			const sourceIdentity = await identifyPath(sourcePath, this.platform);
			if (
				destinationIdentity.canonicalKey === sourceIdentity.canonicalKey ||
				sameInode(destinationIdentity.stat, sourceIdentity.stat)
			) {
				throw new Error("Export destination must not be the same file as an export source.");
			}
		}
	}

	private async acquireLocks(directory: string, keys: string[]): Promise<OwnedDirectory[]> {
		if (keys.some((key) => this.processLocks.has(key))) {
			throw new Error("An export to this destination is already in progress.");
		}
		for (const key of keys) this.processLocks.add(key);

		const locks: OwnedDirectory[] = [];
		try {
			for (const key of [...keys].sort()) {
				const lockPath = path.join(directory, lockName(key));
				try {
					await fs.mkdir(lockPath, { mode: 0o700 });
				} catch (error) {
					if (errorCode(error) === "EEXIST") {
						throw new Error(
							"Export destination is locked by another process; stale locks are never removed automatically.",
						);
					}
					throw error;
				}
				const stat = await fs.lstat(lockPath, { bigint: true });
				if (!stat.isDirectory() || stat.isSymbolicLink()) {
					throw new Error("Export destination lock is not a directory.");
				}
				locks.push({ path: lockPath, identity: identityOf(stat) });
			}
			return locks;
		} catch (error) {
			const issues: ExportCleanupIssue[] = [];
			await this.releaseLocks(keys, locks, issues);
			this.reportCleanupIssues(issues);
			throw attachCleanupIssues(error, issues);
		}
	}

	private async releaseLocks(
		keys: string[],
		locks: OwnedDirectory[],
		issues: ExportCleanupIssue[],
	): Promise<void> {
		for (const lock of [...locks].reverse()) {
			await this.removeExpectedDirectory(lock, issues);
		}
		for (const key of keys) this.processLocks.delete(key);
	}

	private async closeTransaction(
		transaction: ExportDestinationTransaction,
	): Promise<ExportCleanupIssue[]> {
		if (transaction.state === "closed" && !this.transactions.has(transaction.id)) return [];
		transaction.state = "closed";
		if (transaction.expiryTimer) clearTimeout(transaction.expiryTimer);
		transaction.expiryTimer = null;
		this.transactions.delete(transaction.id);
		const ownerTransactions = this.transactionsByOwner.get(transaction.owner);
		ownerTransactions?.delete(transaction.id);
		if (ownerTransactions?.size === 0) this.transactionsByOwner.delete(transaction.owner);

		const issues: ExportCleanupIssue[] = [];
		if (transaction.stageHandle) {
			await transaction.stageHandle.close().catch((error) => {
				issues.push({ path: transaction.stagePath, reason: "failed to close stage file", error });
			});
			transaction.stageHandle = null;
		}
		await this.removeExpectedFile(transaction.stagePath, transaction.stageIdentity, issues);
		await this.removeExpectedDirectory(transaction.workspace, issues);
		await this.releaseLocks(transaction.destinationKeys, transaction.locks, issues);
		this.reportCleanupIssues(issues);
		return issues;
	}

	private async removeExpectedFile(
		filePath: string,
		expected: NodeIdentity | null,
		issues: ExportCleanupIssue[],
	): Promise<void> {
		let stat: BigIntStats | null;
		try {
			stat = await lstatIfExists(filePath);
		} catch (error) {
			issues.push({ path: filePath, reason: "failed to inspect stage file", error });
			return;
		}
		if (!stat) return;
		if (!expected || !stat.isFile() || !sameIdentity(stat, expected)) {
			issues.push({ path: filePath, reason: "refused to remove an unowned stage path" });
			return;
		}
		try {
			await this.unlink(filePath);
		} catch (error) {
			issues.push({ path: filePath, reason: "failed to remove owned stage file", error });
		}
	}

	private async removeExpectedDirectory(
		directory: OwnedDirectory,
		issues: ExportCleanupIssue[],
	): Promise<void> {
		let stat: BigIntStats | null;
		try {
			stat = await lstatIfExists(directory.path);
		} catch (error) {
			issues.push({ path: directory.path, reason: "failed to inspect owned directory", error });
			return;
		}
		if (!stat) return;
		if (!stat.isDirectory() || !sameIdentity(stat, directory.identity)) {
			issues.push({ path: directory.path, reason: "refused to remove an unowned directory" });
			return;
		}
		try {
			await this.rmdir(directory.path);
		} catch (error) {
			issues.push({
				path: directory.path,
				reason: "failed to remove owned empty directory",
				error,
			});
		}
	}

	private reportCleanupIssues(issues: ExportCleanupIssue[]): void {
		for (const issue of issues) {
			try {
				this.onCleanupIssue(issue);
			} catch {
				// Diagnostics must never replace an export or cleanup result.
			}
		}
	}
}

export const sharedExportDestinationTransactions = new ExportDestinationTransactionManager();
