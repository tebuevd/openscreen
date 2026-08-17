import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDestinationTransactionManager } from "./exportDestinationTransaction";

describe("ExportDestinationTransactionManager", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-export-transaction-"));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function transactionArtifacts(): Promise<string[]> {
		return (await fs.readdir(directory)).filter((name) => name.includes(".openscreen-export-"));
	}

	it("preserves an existing destination and removes a partial temp when rendering fails", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const originalError = new Error("native render failed");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(destination, ".mp4", [], async (temporaryPath) => {
				await fs.writeFile(temporaryPath, "partial render");
				throw originalError;
			}),
		).rejects.toBe(originalError);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await transactionArtifacts()).toEqual([]);
	});

	it("rejects an empty output while preserving the destination", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(destination, ".mp4", [], async (temporaryPath) => {
				await fs.writeFile(temporaryPath, "");
			}),
		).rejects.toThrow(/empty or invalid/);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await transactionArtifacts()).toEqual([]);
	});

	it("rejects a symlink output as non-regular without deleting its target", async () => {
		const destination = path.join(directory, "output.mp4");
		const source = path.join(directory, "source.mp4");
		await fs.writeFile(destination, "old export");
		await fs.writeFile(source, "source bytes");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(destination, ".mp4", [source], async (temporaryPath) => {
				await fs.symlink(source, temporaryPath);
			}),
		).rejects.toThrow(/empty or invalid/);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await fs.readFile(source, "utf8")).toBe("source bytes");
		expect(await transactionArtifacts()).toEqual([]);
	});

	it("rolls the old destination back when both replacement attempts fail", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		let temporaryPath = "";
		const commitError = Object.assign(new Error("commit failed"), { code: "EACCES" });
		const rename = vi.fn(async (from: string, to: string) => {
			if (from === temporaryPath && to === destination) throw commitError;
			await fs.rename(from, to);
		});
		const manager = new ExportDestinationTransactionManager({ rename });

		await expect(
			manager.run(destination, ".mp4", [], async (candidate) => {
				temporaryPath = candidate;
				await fs.writeFile(candidate, "new export");
			}),
		).rejects.toBe(commitError);

		expect(await fs.readFile(destination, "utf8")).toBe("old export");
		expect(await transactionArtifacts()).toEqual([]);
		expect(rename).toHaveBeenCalledTimes(4);
	});

	it("uses the backup fallback successfully and cleans both backup and temp", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(destination, "old export");
		let temporaryPath = "";
		let directAttempts = 0;
		const rename = vi.fn(async (from: string, to: string) => {
			if (from === temporaryPath && to === destination && directAttempts++ === 0) {
				throw Object.assign(new Error("replace unsupported"), { code: "EEXIST" });
			}
			await fs.rename(from, to);
		});
		const manager = new ExportDestinationTransactionManager({ rename });

		await manager.run(destination, ".mp4", [], async (candidate) => {
			temporaryPath = candidate;
			await fs.writeFile(candidate, "new export");
		});

		expect(await fs.readFile(destination, "utf8")).toBe("new export");
		expect(await transactionArtifacts()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves existing destination permission bits on replacement",
		async () => {
			const destination = path.join(directory, "output.mp4");
			await fs.writeFile(destination, "old export");
			await fs.chmod(destination, 0o640);
			const manager = new ExportDestinationTransactionManager();

			await manager.run(destination, ".mp4", [], async (temporaryPath) => {
				await fs.writeFile(temporaryPath, "new export");
			});

			expect((await fs.stat(destination)).mode & 0o777).toBe(0o640);
		},
	);

	it("leaves no destination or temp when a new export fails", async () => {
		const destination = path.join(directory, "new.mp4");
		const manager = new ExportDestinationTransactionManager();

		await expect(
			manager.run(destination, ".mp4", [], async (temporaryPath) => {
				await fs.writeFile(temporaryPath, "partial");
				throw new Error("render failed");
			}),
		).rejects.toThrow("render failed");

		await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await transactionArtifacts()).toEqual([]);
	});

	it("rejects an existing directory destination before the writer runs", async () => {
		const destination = path.join(directory, "output.mp4");
		await fs.mkdir(destination);
		await fs.writeFile(path.join(destination, "keep.txt"), "keep");
		const writer = vi.fn(async () => undefined);
		const manager = new ExportDestinationTransactionManager();

		await expect(manager.run(destination, ".mp4", [], writer)).rejects.toThrow(/regular file/);

		expect(writer).not.toHaveBeenCalled();
		expect(await fs.readFile(path.join(destination, "keep.txt"), "utf8")).toBe("keep");
	});

	it("fails a concurrent export to the same destination instead of interleaving writers", async () => {
		const destination = path.join(directory, "output.mp4");
		const manager = new ExportDestinationTransactionManager();
		let releaseFirst!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = manager.run(destination, ".mp4", [], async (temporaryPath) => {
			markStarted();
			await release;
			await fs.writeFile(temporaryPath, "first export");
		});
		await started;

		await expect(
			manager.run(destination, ".mp4", [], async (temporaryPath) => {
				await fs.writeFile(temporaryPath, "second export");
			}),
		).rejects.toThrow(/already in progress/);

		releaseFirst();
		await first;
		expect(await fs.readFile(destination, "utf8")).toBe("first export");
		expect(await transactionArtifacts()).toEqual([]);
	});

	it("normalizes destination case for locking on case-insensitive platforms", async () => {
		const manager = new ExportDestinationTransactionManager({ platform: "win32" });
		const first = await manager.begin(path.join(directory, "Output.mp4"), ".mp4", []);

		await expect(manager.begin(path.join(directory, "output.mp4"), ".mp4", [])).rejects.toThrow(
			/already in progress/,
		);

		await manager.abort(first.id);
	});

	it("rejects source aliases that differ only by case on case-insensitive platforms", async () => {
		const source = path.join(directory, "recording.mp4");
		await fs.writeFile(source, "source bytes");
		const manager = new ExportDestinationTransactionManager({ platform: "win32" });

		await expect(
			manager.begin(path.join(directory, "RECORDING.MP4"), ".mp4", [source]),
		).rejects.toThrow(/same file as an export source/);

		expect(await fs.readFile(source, "utf8")).toBe("source bytes");
	});

	it("locks concurrent destination hard links by inode", async () => {
		const firstPath = path.join(directory, "first.mp4");
		const secondPath = path.join(directory, "second.mp4");
		await fs.writeFile(firstPath, "old export");
		await fs.link(firstPath, secondPath);
		const manager = new ExportDestinationTransactionManager();
		const first = await manager.begin(firstPath, ".mp4", []);

		await expect(manager.begin(secondPath, ".mp4", [])).rejects.toThrow(/already in progress/);

		await manager.abort(first.id);
	});

	it("does not consume an identifiable stale temp left by an interrupted export", async () => {
		const destination = path.join(directory, "movie.mp4");
		const stalePath = path.join(directory, `.openscreen-export-${process.pid}-stale.mp4`);
		await fs.writeFile(stalePath, "crash residue");
		const ids = ["stale", "fresh"];
		const manager = new ExportDestinationTransactionManager({
			randomId: () => ids.shift() ?? "next",
		});

		await manager.run(destination, ".mp4", [], async (temporaryPath) => {
			expect(temporaryPath).not.toBe(stalePath);
			await fs.writeFile(temporaryPath, "new export");
		});

		expect(await fs.readFile(stalePath, "utf8")).toBe("crash residue");
		expect(await fs.readFile(destination, "utf8")).toBe("new export");
		expect(await transactionArtifacts()).toEqual([path.basename(stalePath)]);
	});
});
