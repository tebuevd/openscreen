import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExportDestinationTransactionManager } from "../native-bridge/services/exportDestinationTransaction";
import { ExportTransactionOwnerRegistry } from "./exportTransactionOwnerRegistry";

class FakeSender extends EventEmitter {
	readonly id: number;
	destroyed = false;

	constructor(id: number) {
		super();
		this.id = id;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}
}

describe("ExportTransactionOwnerRegistry", () => {
	it("keeps one opaque owner per sender document and rotates it on main-frame navigation", async () => {
		const abortOwner = vi.fn(async () => undefined);
		const registry = new ExportTransactionOwnerRegistry({ abortOwner });
		const sender = new FakeSender(7);
		const first = registry.ownerFor(sender as never);

		expect(registry.ownerFor(sender as never)).toBe(first);
		sender.emit("did-start-navigation", {}, "https://example.test", false, true);
		await Promise.resolve();

		expect(abortOwner).toHaveBeenCalledWith(first);
		expect(registry.ownerFor(sender as never)).not.toBe(first);
	});

	it("does not rotate ownership for in-place or subframe navigation", async () => {
		const abortOwner = vi.fn(async () => undefined);
		const registry = new ExportTransactionOwnerRegistry({ abortOwner });
		const sender = new FakeSender(8);
		const owner = registry.ownerFor(sender as never);

		sender.emit("did-start-navigation", {}, "https://example.test/#hash", true, true);
		sender.emit("did-start-navigation", {}, "https://frame.test", false, false);
		await Promise.resolve();

		expect(abortOwner).not.toHaveBeenCalled();
		expect(registry.ownerFor(sender as never)).toBe(owner);
	});

	it("aborts and rotates ownership when the renderer process exits", async () => {
		const abortOwner = vi.fn(async () => undefined);
		const registry = new ExportTransactionOwnerRegistry({ abortOwner });
		const sender = new FakeSender(9);
		const owner = registry.ownerFor(sender as never);

		sender.emit("render-process-gone");
		await Promise.resolve();

		expect(abortOwner).toHaveBeenCalledWith(owner);
		expect(registry.ownerFor(sender as never)).not.toBe(owner);
	});

	it("aborts all ownership when the sender is destroyed", async () => {
		const abortOwner = vi.fn(async () => undefined);
		const registry = new ExportTransactionOwnerRegistry({ abortOwner });
		const sender = new FakeSender(10);
		const owner = registry.ownerFor(sender as never);
		sender.destroyed = true;

		sender.emit("destroyed");
		await Promise.resolve();

		expect(abortOwner).toHaveBeenCalledWith(owner);
		expect(() => registry.ownerFor(sender as never)).toThrow(/destroyed/);
	});

	it("sender destruction aborts and cleans its real staged transaction", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-owner-registry-"));
		try {
			const manager = new ExportDestinationTransactionManager();
			const registry = new ExportTransactionOwnerRegistry({
				abortOwner: (owner) => manager.abortOwner(owner),
			});
			const sender = new FakeSender(11);
			const owner = registry.ownerFor(sender as never);
			const transaction = await manager.begin({
				owner,
				requestedPath: path.join(directory, "output.mp4"),
				extension: ".mp4",
				sourcePaths: [],
				requiresPostprocess: true,
			});
			await manager.render(owner, transaction.id, async (stagePath) => {
				await fs.writeFile(stagePath, "native output");
			});
			sender.destroyed = true;

			sender.emit("destroyed");

			await vi.waitFor(async () => {
				expect(
					(await fs.readdir(directory)).filter((name) => name.startsWith(".openscreen-export")),
				).toEqual([]);
			});
			await expect(manager.readRenderedOutput(owner, transaction.id)).rejects.toThrow(/not active/);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
