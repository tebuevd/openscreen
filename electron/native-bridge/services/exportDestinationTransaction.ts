import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ExportContainerExtension = ".mp4" | ".gif";
type RenameFile = (oldPath: string, newPath: string) => Promise<void>;

export interface ExportDestinationTransactionOptions {
	platform?: NodeJS.Platform;
	rename?: RenameFile;
	randomId?: () => string;
}

export interface ExportDestinationTransactionHandle {
	id: string;
	temporaryPath: string;
	requestedPath: string;
}

interface ExportDestinationTransaction extends ExportDestinationTransactionHandle {
	destinationPath: string;
	destinationKeys: string[];
	backupPath: string;
	sourcePaths: string[];
	backupContainsDestination: boolean;
}

interface PathIdentity {
	canonicalKey: string;
	stat: Awaited<ReturnType<typeof statIfExists>>;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function statIfExists(filePath: string) {
	try {
		return await fs.stat(filePath, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

async function resolveExistingAncestors(filePath: string): Promise<string> {
	const absolutePath = path.resolve(filePath);
	try {
		return await fs.realpath(absolutePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		const parent = path.dirname(absolutePath);
		if (parent === absolutePath) return absolutePath;
		return path.join(await resolveExistingAncestors(parent), path.basename(absolutePath));
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
	let entry: Awaited<ReturnType<typeof fs.lstat>> | null = null;
	try {
		entry = await fs.lstat(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
		throw new Error("Export destination must be a regular file path.");
	}
	if (identity.stat && !identity.stat.isFile()) {
		throw new Error("Export destination must resolve to a regular file.");
	}
}

function sameInode(left: PathIdentity["stat"], right: PathIdentity["stat"]): boolean {
	return Boolean(
		left && right && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino,
	);
}

async function removePathWithoutMasking(filePath: string): Promise<void> {
	try {
		await fs.rm(filePath, { recursive: true, force: true });
	} catch (error) {
		console.warn(`[export-destination] failed to clean ${path.basename(filePath)}:`, error);
	}
}

async function preserveDestinationMode(
	temporaryPath: string,
	destinationIdentity: PathIdentity,
): Promise<void> {
	if (process.platform === "win32" || !destinationIdentity.stat?.isFile()) return;
	try {
		await fs.chmod(temporaryPath, Number(destinationIdentity.stat.mode & 0o777n));
	} catch (error) {
		// Mode copying is best-effort; replacement itself remains safe if this filesystem rejects it.
		console.warn("[export-destination] failed to preserve destination permissions:", error);
	}
}

/**
 * Owns the filesystem lifetime of user-visible exports. Native and post-processing writers only
 * receive a unique sibling path; the selected destination is touched by commit alone.
 */
export class ExportDestinationTransactionManager {
	private readonly platform: NodeJS.Platform;
	private readonly rename: RenameFile;
	private readonly randomId: () => string;
	private readonly activeDestinations = new Set<string>();
	private readonly transactions = new Map<string, ExportDestinationTransaction>();

	constructor(options: ExportDestinationTransactionOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.rename = options.rename ?? fs.rename;
		this.randomId = options.randomId ?? randomUUID;
	}

	async begin(
		requestedPath: string,
		extension: ExportContainerExtension,
		sourcePaths: string[],
	): Promise<ExportDestinationTransactionHandle> {
		if (typeof requestedPath !== "string" || requestedPath.length === 0) {
			throw new TypeError("Export destination must be a non-empty path.");
		}
		if (!requestedPath.toLowerCase().endsWith(extension)) {
			throw new TypeError(`Export destination must end in ${extension}.`);
		}
		if (sourcePaths.some((sourcePath) => typeof sourcePath !== "string" || !sourcePath.trim())) {
			throw new TypeError("Export source paths must be non-empty strings.");
		}

		const destinationPath = path.resolve(requestedPath);
		const destinationIdentity = await identifyPath(destinationPath, this.platform);
		await assertReplaceableDestination(destinationPath, destinationIdentity);
		await this.assertDestinationIsNotSource(destinationIdentity, sourcePaths);

		const destinationKeys = [`path:${destinationIdentity.canonicalKey}`];
		if (destinationIdentity.stat?.ino) {
			destinationKeys.push(`inode:${destinationIdentity.stat.dev}:${destinationIdentity.stat.ino}`);
		}
		if (destinationKeys.some((key) => this.activeDestinations.has(key))) {
			throw new Error("An export to this destination is already in progress.");
		}
		for (const key of destinationKeys) this.activeDestinations.add(key);

		try {
			const directory = path.dirname(destinationPath);
			let id = "";
			let temporaryPath = "";
			let backupPath = "";
			for (let attempt = 0; attempt < 8; attempt += 1) {
				id = this.randomId();
				temporaryPath = path.join(directory, `.openscreen-export-${process.pid}-${id}${extension}`);
				backupPath = path.join(
					directory,
					`.openscreen-export-backup-${process.pid}-${id}${extension}`,
				);
				if (!(await pathExists(temporaryPath)) && !(await pathExists(backupPath))) break;
				id = "";
			}
			if (!id) {
				throw new Error("Could not reserve a unique temporary export path.");
			}

			const transaction: ExportDestinationTransaction = {
				id,
				temporaryPath,
				requestedPath,
				destinationPath,
				destinationKeys,
				backupPath,
				sourcePaths: [...sourcePaths],
				backupContainsDestination: false,
			};
			this.transactions.set(id, transaction);
			return { id, temporaryPath, requestedPath };
		} catch (error) {
			for (const key of destinationKeys) this.activeDestinations.delete(key);
			throw error;
		}
	}

	async validate(id: string): Promise<void> {
		const transaction = this.requireTransaction(id);
		let outputStat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			outputStat = await fs.lstat(transaction.temporaryPath);
		} catch {
			throw new Error("Export completed without producing an output file.");
		}
		if (!outputStat.isFile() || outputStat.size <= 0) {
			throw new Error("Export produced an empty or invalid output file.");
		}
	}

	async replaceTemporaryOutput(id: string, data: Uint8Array): Promise<void> {
		const transaction = this.requireTransaction(id);
		if (data.byteLength === 0) {
			throw new Error("Export post-processing produced an empty output file.");
		}
		await fs.writeFile(transaction.temporaryPath, data);
		await this.validate(id);
	}

	async commit(id: string): Promise<string> {
		const transaction = this.requireTransaction(id);
		try {
			await this.validate(id);
			const destinationIdentity = await identifyPath(transaction.destinationPath, this.platform);
			await assertReplaceableDestination(transaction.destinationPath, destinationIdentity);
			await this.assertDestinationIsNotSource(destinationIdentity, transaction.sourcePaths);
			await preserveDestinationMode(transaction.temporaryPath, destinationIdentity);
			await this.replaceDestination(transaction);
			return transaction.requestedPath;
		} catch (error) {
			await this.cleanup(transaction);
			throw error;
		} finally {
			this.release(transaction);
		}
	}

	async abort(id: string): Promise<void> {
		const transaction = this.transactions.get(id);
		if (!transaction) return;
		try {
			await this.cleanup(transaction);
		} finally {
			this.release(transaction);
		}
	}

	async run<T>(
		requestedPath: string,
		extension: ExportContainerExtension,
		sourcePaths: string[],
		writer: (temporaryPath: string) => Promise<T>,
	): Promise<T> {
		const transaction = await this.begin(requestedPath, extension, sourcePaths);
		try {
			const result = await writer(transaction.temporaryPath);
			await this.validate(transaction.id);
			await this.commit(transaction.id);
			return result;
		} catch (error) {
			await this.abort(transaction.id);
			throw error;
		}
	}

	private requireTransaction(id: string): ExportDestinationTransaction {
		const transaction = this.transactions.get(id);
		if (!transaction) throw new Error("Export transaction is not active.");
		return transaction;
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

	private async replaceDestination(transaction: ExportDestinationTransaction): Promise<void> {
		try {
			await this.rename(transaction.temporaryPath, transaction.destinationPath);
			return;
		} catch (directError) {
			if (!(await pathExists(transaction.destinationPath))) throw directError;
			const destinationIdentity = await identifyPath(transaction.destinationPath, this.platform);
			await assertReplaceableDestination(transaction.destinationPath, destinationIdentity);

			try {
				await this.rename(transaction.destinationPath, transaction.backupPath);
				transaction.backupContainsDestination = true;
			} catch {
				throw directError;
			}

			try {
				await this.rename(transaction.temporaryPath, transaction.destinationPath);
			} catch (commitError) {
				try {
					await this.rename(transaction.backupPath, transaction.destinationPath);
					transaction.backupContainsDestination = false;
				} catch (rollbackError) {
					console.error(
						`[export-destination] rollback failed; original output remains in ${path.basename(transaction.backupPath)}:`,
						rollbackError,
					);
				}
				throw commitError;
			}

			transaction.backupContainsDestination = false;
			await removePathWithoutMasking(transaction.backupPath);
		}
	}

	private async cleanup(transaction: ExportDestinationTransaction): Promise<void> {
		await removePathWithoutMasking(transaction.temporaryPath);
		if (!transaction.backupContainsDestination) {
			await removePathWithoutMasking(transaction.backupPath);
		}
	}

	private release(transaction: ExportDestinationTransaction): void {
		this.transactions.delete(transaction.id);
		for (const key of transaction.destinationKeys) this.activeDestinations.delete(key);
	}
}

export const sharedExportDestinationTransactions = new ExportDestinationTransactionManager();
