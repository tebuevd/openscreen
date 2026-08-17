import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ExportCleanupAggregateError,
	ExportDestinationTransactionManager,
	type ExportErrorWithCleanup,
} from "./exportDestinationTransaction";

const OWNER_A = {};
const OWNER_B = {};

describe("ExportDestinationTransactionManager", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-export-transaction-"));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function artifacts(): Promise<string[]> {
		return (await fs.readdir(directory)).filter((name) => name.startsWith(".openscreen-export"));
	}

	async function beginPostprocess(
		manager: ExportDestinationTransactionManager,
		destination = path.join(directory, "output.mp4"),
	) {
		return manager.begin({
			owner: OWNER_A,
			requestedPath: destination,
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: true,
		});
	}

	it("creates a private workspace and exclusively reserved regular stage file", async () => {
		const destination = path.join(directory, "output.mp4");
		const manager = new ExportDestinationTransactionManager();
		let internalPath = "";

		const transaction = await manager.begin({
			owner: OWNER_A,
			requestedPath: destination,
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: false,
		});
		expect(transaction).toEqual({ id: expect.any(String) });
		await manager.render(OWNER_A, transaction.id, async (stagePath) => {
			internalPath = stagePath;
			const workspaceStat = await fs.stat(path.dirname(stagePath));
			const stageStat = await fs.lstat(stagePath);
			if (process.platform !== "win32") expect(workspaceStat.mode & 0o077).toBe(0);
			expect(stageStat.isFile()).toBe(true);
			expect(stageStat.nlink).toBe(1);
			expect(path.extname(stagePath)).toBe(".mp4");
			await fs.writeFile(stagePath, "rendered bytes");
		});
		await manager.commit(OWNER_A, transaction.id);

		expect(internalPath).not.toBe(destination);
		expect(await fs.readFile(destination, "utf8")).toBe("rendered bytes");
		expect(await artifacts()).toEqual([]);
	});

	it.each([
		"exact",
		"relative",
		"file-url",
		"symlink",
		"hard-link",
	])("rejects a %s source alias before invoking the writer", async (kind) => {
		const source = path.join(directory, "recording.mp4");
		await fs.writeFile(source, "source bytes");
		let destination = source;
		if (kind === "relative") destination = path.relative(process.cwd(), source);
		if (kind === "file-url") destination = pathToFileURL(source).toString();
		if (kind === "symlink") {
			destination = path.join(directory, "symlink.mp4");
			await fs.symlink(source, destination);
		}
		if (kind === "hard-link") {
			destination = path.join(directory, "hard-link.mp4");
			await fs.link(source, destination);
		}
		const writer = vi.fn(async () => undefined);
		const manager = new ExportDestinationTransactionManager();

		await expect(manager.run(OWNER_A, destination, ".mp4", [source], writer)).rejects.toThrow(
			/same file as an export source/,
		);
		expect(writer).not.toHaveBeenCalled();
		expect(await fs.readFile(source, "utf8")).toBe("source bytes");
	});

	it("normalizes case aliases on case-insensitive platforms", async () => {
		const source = path.join(directory, "recording.mp4");
		await fs.writeFile(source, "source bytes");
		const manager = new ExportDestinationTransactionManager({ platform: "win32" });

		await expect(
			manager.begin({
				owner: OWNER_A,
				requestedPath: path.join(directory, "RECORDING.MP4"),
				extension: ".mp4",
				sourcePaths: [source],
				requiresPostprocess: false,
			}),
		).rejects.toThrow(/same file as an export source/);
	});

	it("rejects malformed and unsupported local URL spellings", async () => {
		const manager = new ExportDestinationTransactionManager();
		for (const source of ["file:///%ZZ", "ftp://localhost/input.mp4", "blob:opaque-id"]) {
			await expect(
				manager.begin({
					owner: OWNER_A,
					requestedPath: path.join(directory, "output.mp4"),
					extension: ".mp4",
					sourcePaths: [source],
					requiresPostprocess: false,
				}),
			).rejects.toThrow(/local file URL|unsupported protocol/);
		}
	});

	it("preserves the destination and cleans owned resources when native rendering fails", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const original = new Error("native failed");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(OWNER_A, destination, ".mp4", [], async (stagePath) => {
				await fs.writeFile(stagePath, "partial");
				throw original;
			}),
		).rejects.toBe(original);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await artifacts()).toEqual([]);
	});

	it("rejects an empty render without touching the destination", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(OWNER_A, destination, ".mp4", [], async () => undefined),
		).rejects.toThrow(/empty output/);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await artifacts()).toEqual([]);
	});

	it("uses one install rename and leaves the old destination at its original path on failure", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const installError = Object.assign(new Error("atomic overwrite unavailable"), {
			code: "EPERM",
		});
		const rename = vi.fn(async () => {
			throw installError;
		});
		const manager = new ExportDestinationTransactionManager({ rename });

		await expect(
			manager.run(OWNER_A, destination, ".mp4", [], async (stagePath) => {
				await fs.writeFile(stagePath, "new export");
			}),
		).rejects.toBe(installError);

		expect(rename).toHaveBeenCalledOnce();
		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect((await fs.readdir(directory)).some((name) => name.includes("backup"))).toBe(false);
		expect(await artifacts()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves existing POSIX mode before installation",
		async () => {
			const destination = path.join(directory, "output.mp4");
			await fs.writeFile(destination, "old export");
			await fs.chmod(destination, 0o640);
			const manager = new ExportDestinationTransactionManager();

			await manager.run(OWNER_A, destination, ".mp4", [], async (stagePath) => {
				await fs.writeFile(stagePath, "new export");
			});

			expect((await fs.stat(destination)).mode & 0o777).toBe(0o640);
		},
	);

	it("treats mode preservation failure as commit failure", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const modeError = new Error("chmod denied");
		const rename = vi.fn(fs.rename);
		const manager = new ExportDestinationTransactionManager({
			platform: "linux",
			chmodStage: async () => {
				throw modeError;
			},
			rename,
		});

		await expect(
			manager.run(OWNER_A, destination, ".mp4", [], async (stagePath) => {
				await fs.writeFile(stagePath, "new export");
			}),
		).rejects.toBe(modeError);

		expect(rename).not.toHaveBeenCalled();
		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await artifacts()).toEqual([]);
	});

	it("does not write through a symlink substituted after render", async () => {
		const source = path.join(directory, "source.mp4");
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(source, "source bytes");
		await fs.writeFile(destination, "old export");
		const issues: string[] = [];
		const manager = new ExportDestinationTransactionManager({
			onCleanupIssue: (issue) => issues.push(issue.reason),
		});
		const transaction = await beginPostprocess(manager, destination);
		let stagePath = "";
		await manager.render(OWNER_A, transaction.id, async (internalPath) => {
			stagePath = internalPath;
			await fs.writeFile(internalPath, "native output");
		});
		await manager.readRenderedOutput(OWNER_A, transaction.id);
		await fs.unlink(stagePath);
		await fs.symlink(source, stagePath);

		await expect(
			manager.replaceWithPostprocessedOutput(OWNER_A, transaction.id, Buffer.from("mixed output")),
		).rejects.toThrow(/identity changed/);

		expect(await fs.readFile(source, "utf8")).toBe("source bytes");
		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await fs.lstat(stagePath)).toSatisfy((stat) => stat.isSymbolicLink());
		expect(issues).toContain("refused to remove an unowned stage path");
	});

	it("refuses recursive cleanup of an unrelated substituted directory and reports leftovers", async () => {
		const issues: string[] = [];
		const manager = new ExportDestinationTransactionManager({
			onCleanupIssue: (issue) => issues.push(issue.reason),
		});
		const transaction = await beginPostprocess(manager);
		let stagePath = "";
		await manager.render(OWNER_A, transaction.id, async (internalPath) => {
			stagePath = internalPath;
			await fs.writeFile(internalPath, "native output");
		});
		await fs.unlink(stagePath);
		await fs.mkdir(stagePath);
		await fs.writeFile(path.join(stagePath, "unrelated.txt"), "keep");

		await expect(manager.abort(OWNER_A, transaction.id)).rejects.toBeInstanceOf(
			ExportCleanupAggregateError,
		);

		expect(await fs.readFile(path.join(stagePath, "unrelated.txt"), "utf8")).toBe("keep");
		expect(issues).toContain("refused to remove an unowned stage path");
		expect(issues).toContain("failed to remove owned empty directory");
	});

	it("attaches cleanup failures without masking the primary writer error", async () => {
		const destination = path.join(directory, "output.mp4");
		const original = new Error("native failed") as ExportErrorWithCleanup;
		const onCleanupIssue = vi.fn(() => {
			throw new Error("diagnostic reporter failed");
		});
		const manager = new ExportDestinationTransactionManager({
			unlink: async () => {
				throw new Error("unlink denied");
			},
			onCleanupIssue,
		});

		await expect(
			manager.run(OWNER_A, destination, ".mp4", [], async (stagePath) => {
				await fs.writeFile(stagePath, "partial");
				throw original;
			}),
		).rejects.toBe(original);

		expect(original.cleanupIssues?.map((issue) => issue.reason)).toEqual(
			expect.arrayContaining([
				"failed to remove owned stage file",
				"failed to remove owned empty directory",
			]),
		);
		expect(onCleanupIssue).toHaveBeenCalledTimes(2);
	});

	it("enforces token ownership and valid postprocess transitions", async () => {
		const manager = new ExportDestinationTransactionManager();
		const transaction = await beginPostprocess(manager);
		await manager.render(OWNER_A, transaction.id, async (stagePath) => {
			await fs.writeFile(stagePath, "native output");
		});

		await expect(manager.readRenderedOutput(OWNER_B, transaction.id)).rejects.toThrow(
			/belongs to another sender/,
		);
		await expect(manager.commit(OWNER_A, transaction.id)).rejects.toThrow(/state rendered/);
		await manager.readRenderedOutput(OWNER_A, transaction.id);
		await expect(manager.commit(OWNER_A, transaction.id)).rejects.toThrow(/awaiting-postprocess/);
		await manager.abort(OWNER_A, transaction.id);
	});

	it("rejects concurrent methods on one transaction", async () => {
		const manager = new ExportDestinationTransactionManager();
		const transaction = await manager.begin({
			owner: OWNER_A,
			requestedPath: path.join(directory, "output.mp4"),
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: false,
		});
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		const render = manager.render(OWNER_A, transaction.id, async (stagePath) => {
			started();
			await gate;
			await fs.writeFile(stagePath, "native output");
		});
		await didStart;

		await expect(manager.commit(OWNER_A, transaction.id)).rejects.toThrow(/operation in progress/);
		release();
		await render;
		await manager.commit(OWNER_A, transaction.id);
	});

	it("expires abandoned staged transactions and releases resources", async () => {
		const manager = new ExportDestinationTransactionManager({ expiryMs: 20 });
		const transaction = await beginPostprocess(manager);
		await manager.render(OWNER_A, transaction.id, async (stagePath) => {
			await fs.writeFile(stagePath, "native output");
		});
		expect(await artifacts()).not.toEqual([]);

		await new Promise((resolve) => setTimeout(resolve, 60));

		await expect(manager.readRenderedOutput(OWNER_A, transaction.id)).rejects.toThrow(/not active/);
		expect(await artifacts()).toEqual([]);
	});

	it("rejects new transactions after their sender owner is revoked", async () => {
		const manager = new ExportDestinationTransactionManager();
		await manager.abortOwner(OWNER_A);

		await expect(beginPostprocess(manager)).rejects.toThrow(/owner is no longer active/);
		expect(await artifacts()).toEqual([]);
	});

	it("uses a cross-manager filesystem lock and releases only its owned lock", async () => {
		const destination = path.join(directory, "output.mp4");
		const first = new ExportDestinationTransactionManager({ processLocks: new Set() });
		const second = new ExportDestinationTransactionManager({ processLocks: new Set() });
		const firstTransaction = await first.begin({
			owner: OWNER_A,
			requestedPath: destination,
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: false,
		});

		await expect(
			second.begin({
				owner: OWNER_B,
				requestedPath: destination,
				extension: ".mp4",
				sourcePaths: [],
				requiresPostprocess: false,
			}),
		).rejects.toThrow(/locked by another process/);

		await first.abort(OWNER_A, firstTransaction.id);
		const next = await second.begin({
			owner: OWNER_B,
			requestedPath: destination,
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: false,
		});
		await second.abort(OWNER_B, next.id);
		expect(await artifacts()).toEqual([]);
	});

	it("never removes an unknown stale lock", async () => {
		const destination = path.join(directory, "output.mp4");
		const discover = new ExportDestinationTransactionManager({ processLocks: new Set() });
		const transaction = await discover.begin({
			owner: OWNER_A,
			requestedPath: destination,
			extension: ".mp4",
			sourcePaths: [],
			requiresPostprocess: false,
		});
		const lockNames = (await artifacts()).filter((name) => name.includes("lock"));
		await discover.abort(OWNER_A, transaction.id);
		const staleLock = path.join(directory, lockNames[0]!);
		await fs.mkdir(staleLock);
		const manager = new ExportDestinationTransactionManager({ processLocks: new Set() });

		await expect(
			manager.begin({
				owner: OWNER_B,
				requestedPath: destination,
				extension: ".mp4",
				sourcePaths: [],
				requiresPostprocess: false,
			}),
		).rejects.toThrow(/stale locks are never removed/);
		expect((await fs.lstat(staleLock)).isDirectory()).toBe(true);
	});
});
