import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import type { ExportTransactionOwner } from "../native-bridge/services/exportDestinationTransaction";

type Sender = Pick<
	WebContents,
	"id" | "isDestroyed" | "isLoadingMainFrame" | "mainFrame" | "on" | "removeListener"
>;
type SenderFrame = Pick<
	WebFrameMain,
	"frameToken" | "isDestroyed" | "parent" | "processId" | "routingId"
>;
type OwnerRequest = Pick<IpcMainInvokeEvent, "frameId" | "processId" | "sender" | "senderFrame">;

interface FrameIdentity {
	frameToken: string;
	processId: number;
	routingId: number;
}

interface SenderSession {
	owner: ExportTransactionOwner | null;
	committedFrame: FrameIdentity | null;
	pendingUrls: Map<string, number> | null;
	onDestroyed: () => void;
	onRenderProcessGone: () => void;
	onDidStartNavigation: (...args: unknown[]) => void;
	onDidFrameNavigate: (...args: unknown[]) => void;
	onDidFailLoad: (...args: unknown[]) => void;
	onDidFailProvisionalLoad: (...args: unknown[]) => void;
	onDidStopLoading: () => void;
}

export interface ExportTransactionOwnerRegistryOptions {
	abortOwner: (owner: ExportTransactionOwner) => Promise<void>;
	onAbortError?: (senderId: number, error: unknown) => void;
}

function eventDetails(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function sameFrame(left: FrameIdentity, right: FrameIdentity): boolean {
	return (
		left.processId === right.processId &&
		left.routingId === right.routingId &&
		left.frameToken === right.frameToken
	);
}

/** Binds opaque transaction ownership to one committed main-frame document lifetime. */
export class ExportTransactionOwnerRegistry {
	private readonly sessions = new WeakMap<Sender, SenderSession>();
	private readonly abortOwner: (owner: ExportTransactionOwner) => Promise<void>;
	private readonly onAbortError: (senderId: number, error: unknown) => void;

	constructor(options: ExportTransactionOwnerRegistryOptions) {
		this.abortOwner = options.abortOwner;
		this.onAbortError =
			options.onAbortError ??
			((senderId, error) => {
				console.error(
					`[export-destination] failed to abort exports for sender ${senderId}:`,
					error,
				);
			});
	}

	/** Install navigation listeners before a sender first requests a transaction. */
	observe(sender: Sender): void {
		if (!sender.isDestroyed()) this.ensureSession(sender);
	}

	ownerFor(event: OwnerRequest): ExportTransactionOwner {
		const sender = event.sender;
		if (sender.isDestroyed()) throw new Error("Export sender is destroyed.");
		const session = this.ensureSession(sender);
		if (session.pendingUrls) {
			throw new Error("Export transactions are unavailable while navigation is pending.");
		}

		const requestFrame = this.frameFromRequest(event);
		if (
			!requestFrame ||
			!session.committedFrame ||
			!sameFrame(requestFrame, session.committedFrame)
		) {
			throw new Error("Export transaction IPC did not come from the committed main document.");
		}
		const currentFrame = this.currentMainFrame(sender);
		if (!currentFrame || !sameFrame(currentFrame, session.committedFrame)) {
			throw new Error("Export transaction document identity is no longer current.");
		}

		session.owner ??= {};
		return session.owner;
	}

	private ensureSession(sender: Sender): SenderSession {
		const existing = this.sessions.get(sender);
		if (existing) return existing;

		const isLoadingMainFrame = sender.isLoadingMainFrame();
		const session = {} as SenderSession;
		session.owner = null;
		session.committedFrame = isLoadingMainFrame ? null : this.currentMainFrame(sender);
		session.pendingUrls = isLoadingMainFrame ? new Map([["<unobserved-navigation>", 1]]) : null;
		session.onDestroyed = () => this.destroy(sender);
		session.onRenderProcessGone = () => this.enterPending(sender, "<renderer-gone>");
		session.onDidStartNavigation = (...args) => {
			const details = eventDetails(args[0]);
			const isSameDocument = details.isSameDocument === true || args[2] === true;
			const isMainFrame = details.isMainFrame ?? args[3] !== false;
			if (isMainFrame === true && !isSameDocument) {
				const url = typeof details.url === "string" ? details.url : String(args[1] ?? "");
				this.enterPending(sender, url);
			}
		};
		session.onDidFrameNavigate = (...args) => {
			const details = eventDetails(args[0]);
			const isMainFrame = details.isMainFrame ?? args[4] === true;
			if (isMainFrame !== true) return;
			this.commitFrame(
				sender,
				Number(details.frameProcessId ?? args[5]),
				Number(details.frameRoutingId ?? args[6]),
			);
		};
		const onNavigationFailed = (...args: unknown[]) => {
			const details = eventDetails(args[0]);
			const isMainFrame = details.isMainFrame ?? args[4] === true;
			if (isMainFrame !== true || !session.pendingUrls) return;
			const url =
				typeof details.validatedURL === "string" ? details.validatedURL : String(args[3] ?? "");
			this.failPendingNavigation(sender, url);
		};
		session.onDidFailLoad = onNavigationFailed;
		session.onDidFailProvisionalLoad = onNavigationFailed;
		session.onDidStopLoading = () => {
			if (session.pendingUrls) this.recoverCurrentFrame(sender);
		};

		this.sessions.set(sender, session);
		sender.on("destroyed", session.onDestroyed);
		sender.on("render-process-gone", session.onRenderProcessGone);
		sender.on("did-start-navigation", session.onDidStartNavigation);
		sender.on("did-frame-navigate", session.onDidFrameNavigate);
		sender.on("did-fail-load", session.onDidFailLoad);
		sender.on("did-fail-provisional-load", session.onDidFailProvisionalLoad);
		sender.on("did-stop-loading", session.onDidStopLoading);
		return session;
	}

	private enterPending(sender: Sender, url: string): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		if (!session.pendingUrls) {
			session.pendingUrls = new Map();
			this.revokeOwner(session, sender.id);
		}
		session.pendingUrls.set(url, (session.pendingUrls.get(url) ?? 0) + 1);
	}

	private failPendingNavigation(sender: Sender, url: string): void {
		const session = this.sessions.get(sender);
		const pending = session?.pendingUrls;
		if (!session || !pending) return;
		const count = pending.get(url) ?? 0;
		if (count <= 1) pending.delete(url);
		else pending.set(url, count - 1);
		if (pending.size === 0) this.recoverCurrentFrame(sender);
	}

	private recoverCurrentFrame(sender: Sender): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		const identity = this.currentMainFrame(sender);
		if (!identity) return;
		this.revokeOwner(session, sender.id);
		session.committedFrame = identity;
		session.pendingUrls = null;
	}

	private commitFrame(sender: Sender, processId: number, routingId: number): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		const identity = this.currentMainFrame(sender);
		if (
			!identity ||
			!Number.isFinite(processId) ||
			!Number.isFinite(routingId) ||
			identity.processId !== processId ||
			identity.routingId !== routingId
		) {
			return;
		}
		this.revokeOwner(session, sender.id);
		session.committedFrame = identity;
		session.pendingUrls = null;
	}

	private frameFromRequest(event: OwnerRequest): FrameIdentity | null {
		const frame = event.senderFrame as SenderFrame | null;
		try {
			if (
				!frame ||
				frame.isDestroyed() ||
				frame.parent !== null ||
				frame.processId !== event.processId ||
				frame.routingId !== event.frameId
			) {
				return null;
			}
			return {
				frameToken: frame.frameToken,
				processId: frame.processId,
				routingId: frame.routingId,
			};
		} catch {
			return null;
		}
	}

	private currentMainFrame(sender: Sender): FrameIdentity | null {
		try {
			const frame = sender.mainFrame as SenderFrame;
			if (frame.isDestroyed() || frame.parent !== null) return null;
			return {
				frameToken: frame.frameToken,
				processId: frame.processId,
				routingId: frame.routingId,
			};
		} catch {
			return null;
		}
	}

	private revokeOwner(session: SenderSession, senderId: number): void {
		const owner = session.owner;
		session.owner = null;
		if (owner) this.abort(owner, senderId);
	}

	private destroy(sender: Sender): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		this.sessions.delete(sender);
		sender.removeListener("render-process-gone", session.onRenderProcessGone);
		sender.removeListener("did-start-navigation", session.onDidStartNavigation);
		sender.removeListener("did-frame-navigate", session.onDidFrameNavigate);
		sender.removeListener("did-fail-load", session.onDidFailLoad);
		sender.removeListener("did-fail-provisional-load", session.onDidFailProvisionalLoad);
		sender.removeListener("did-stop-loading", session.onDidStopLoading);
		this.revokeOwner(session, sender.id);
	}

	private abort(owner: ExportTransactionOwner, senderId: number): void {
		void this.abortOwner(owner).catch((error) => this.onAbortError(senderId, error));
	}
}
