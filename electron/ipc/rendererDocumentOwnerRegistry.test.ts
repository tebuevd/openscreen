import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExportDestinationTransactionManager } from "../native-bridge/services/exportDestinationTransaction";
import { RendererDocumentOwnerRegistry } from "./rendererDocumentOwnerRegistry";

class FakeFrame {
	readonly frameToken: string;
	readonly processId: number;
	readonly routingId: number;
	readonly parent: FakeFrame | null;
	destroyed = false;

	constructor(
		processId: number,
		routingId: number,
		frameToken: string,
		parent: FakeFrame | null = null,
	) {
		this.processId = processId;
		this.routingId = routingId;
		this.frameToken = frameToken;
		this.parent = parent;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}
}

class FakeSender extends EventEmitter {
	readonly id: number;
	destroyed = false;
	loadingMainFrame = false;
	mainFrame: FakeFrame;

	constructor(id: number, mainFrame = new FakeFrame(100 + id, 1, `document-${id}-1`)) {
		super();
		this.id = id;
		this.mainFrame = mainFrame;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	isLoadingMainFrame(): boolean {
		return this.loadingMainFrame;
	}
}

function request(sender: FakeSender, frame = sender.mainFrame) {
	return {
		frameId: frame.routingId,
		processId: frame.processId,
		sender,
		senderFrame: frame,
	};
}

function startMainNavigation(sender: FakeSender, url = "https://next.test") {
	sender.loadingMainFrame = true;
	sender.emit("did-start-navigation", {
		url,
		isSameDocument: false,
		isMainFrame: true,
		frame: sender.mainFrame,
	});
}

function commitMainNavigation(sender: FakeSender, frame: FakeFrame, url = "https://next.test") {
	sender.mainFrame = frame;
	sender.loadingMainFrame = true;
	sender.emit("did-frame-navigate", {}, url, 200, "OK", true, frame.processId, frame.routingId);
}

describe("RendererDocumentOwnerRegistry", () => {
	it("rejects outgoing IPC after navigation start and accepts only the committed new document", async () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const sender = new FakeSender(7);
		const outgoingFrame = sender.mainFrame;
		const outgoingOwner = registry.ownerFor(request(sender) as never);

		startMainNavigation(sender);

		expect(() => registry.ownerFor(request(sender, outgoingFrame) as never)).toThrow(
			/navigation is pending/,
		);
		sender.emit(
			"did-frame-finish-load",
			{},
			true,
			outgoingFrame.processId,
			outgoingFrame.routingId,
		);
		expect(() => registry.ownerFor(request(sender, outgoingFrame) as never)).toThrow(
			/navigation is pending/,
		);
		expect(releaseOwner).toHaveBeenCalledWith(outgoingOwner);

		const committedFrame = new FakeFrame(207, 9, "document-7-2");
		commitMainNavigation(sender, committedFrame);
		const committedOwner = registry.ownerFor(request(sender) as never);

		expect(committedOwner).not.toBe(outgoingOwner);
		expect(() => registry.ownerFor(request(sender, outgoingFrame) as never)).toThrow(
			/committed main document/,
		);
	});

	it("recovers a failed main-frame navigation with a fresh owner for the surviving document", () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const sender = new FakeSender(8);
		const survivingFrame = sender.mainFrame;
		const outgoingOwner = registry.ownerFor(request(sender) as never);

		startMainNavigation(sender, "https://failed.test");
		sender.loadingMainFrame = false;
		sender.emit(
			"did-fail-provisional-load",
			{},
			-3,
			"ERR_ABORTED",
			"https://failed.test",
			true,
			survivingFrame.processId,
			survivingFrame.routingId,
		);

		const recoveredOwner = registry.ownerFor(request(sender) as never);
		expect(recoveredOwner).not.toBe(outgoingOwner);
		expect(releaseOwner).toHaveBeenCalledTimes(1);
	});

	it("does not recover a cancelled navigation while a second main navigation is pending", () => {
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner: async () => undefined });
		const sender = new FakeSender(9);
		registry.ownerFor(request(sender) as never);
		startMainNavigation(sender, "https://first.test");
		startMainNavigation(sender, "https://second.test");

		sender.emit(
			"did-fail-provisional-load",
			{},
			-3,
			"ERR_ABORTED",
			"https://first.test",
			true,
			sender.mainFrame.processId,
			sender.mainFrame.routingId,
		);

		expect(() => registry.ownerFor(request(sender) as never)).toThrow(/navigation is pending/);
		const committedFrame = new FakeFrame(209, 3, "document-9-2");
		commitMainNavigation(sender, committedFrame, "https://second.test");
		expect(() => registry.ownerFor(request(sender) as never)).not.toThrow();
	});

	it("keeps ownership for in-page and subframe navigation and rejects subframe IPC", () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const sender = new FakeSender(10);
		const owner = registry.ownerFor(request(sender) as never);

		sender.emit("did-start-navigation", {
			url: "https://example.test/#next",
			isSameDocument: true,
			isMainFrame: true,
			frame: sender.mainFrame,
		});
		sender.emit("did-start-navigation", {
			url: "https://frame.test",
			isSameDocument: false,
			isMainFrame: false,
			frame: new FakeFrame(500, 2, "subframe", sender.mainFrame),
		});

		expect(registry.ownerFor(request(sender) as never)).toBe(owner);
		expect(releaseOwner).not.toHaveBeenCalled();
		const subframe = new FakeFrame(500, 2, "subframe", sender.mainFrame);
		expect(() => registry.ownerFor(request(sender, subframe) as never)).toThrow(
			/committed main document/,
		);
	});

	it("waits for a committed frame when observation begins during loading", () => {
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner: async () => undefined });
		const sender = new FakeSender(11);
		sender.loadingMainFrame = true;
		registry.observe(sender as never);

		expect(() => registry.ownerFor(request(sender) as never)).toThrow(/navigation is pending/);
		sender.loadingMainFrame = false;
		sender.emit("did-stop-loading");
		expect(() => registry.ownerFor(request(sender) as never)).not.toThrow();
	});

	it("keeps renderer-process replacement pending until its new main frame commits", () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const sender = new FakeSender(12);
		const owner = registry.ownerFor(request(sender) as never);

		sender.emit("render-process-gone");
		expect(() => registry.ownerFor(request(sender) as never)).toThrow(/navigation is pending/);
		expect(releaseOwner).toHaveBeenCalledWith(owner);

		const replacement = new FakeFrame(312, 1, "document-12-2");
		commitMainNavigation(sender, replacement);
		expect(registry.ownerFor(request(sender) as never)).not.toBe(owner);
	});

	it("releases ownership and rejects future IPC when the sender is destroyed", () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const sender = new FakeSender(13);
		const owner = registry.ownerFor(request(sender) as never);
		sender.destroyed = true;

		sender.emit("destroyed");

		expect(releaseOwner).toHaveBeenCalledWith(owner);
		expect(() => registry.ownerFor(request(sender) as never)).toThrow(/destroyed/);
	});

	it("releases only the destroyed WebContents document owner", () => {
		const releaseOwner = vi.fn(async () => undefined);
		const registry = new RendererDocumentOwnerRegistry({ releaseOwner });
		const firstSender = new FakeSender(20);
		const secondSender = new FakeSender(21);
		const firstOwner = registry.ownerFor(request(firstSender) as never);
		const secondOwner = registry.ownerFor(request(secondSender) as never);

		firstSender.destroyed = true;
		firstSender.emit("destroyed");

		expect(releaseOwner).toHaveBeenCalledTimes(1);
		expect(releaseOwner).toHaveBeenCalledWith(firstOwner);
		expect(registry.ownerFor(request(secondSender) as never)).toBe(secondOwner);
	});

	it("sender destruction releases and cleans its real staged transaction", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-owner-registry-"));
		try {
			const manager = new ExportDestinationTransactionManager();
			const registry = new RendererDocumentOwnerRegistry({
				releaseOwner: (owner) => manager.abortOwner(owner),
			});
			const sender = new FakeSender(14);
			const owner = registry.ownerFor(request(sender) as never);
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
