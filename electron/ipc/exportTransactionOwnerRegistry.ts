import type { WebContents } from "electron";
import type { ExportTransactionOwner } from "../native-bridge/services/exportDestinationTransaction";

type Sender = Pick<WebContents, "id" | "isDestroyed" | "on" | "removeListener">;

interface SenderSession {
	owner: ExportTransactionOwner;
	onDestroyed: () => void;
	onRenderProcessGone: () => void;
	onDidStartNavigation: (...args: unknown[]) => void;
}

export interface ExportTransactionOwnerRegistryOptions {
	abortOwner: (owner: ExportTransactionOwner) => Promise<void>;
	onAbortError?: (senderId: number, error: unknown) => void;
}

/** Binds opaque transaction ownership to one WebContents document lifetime. */
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

	ownerFor(sender: Sender): ExportTransactionOwner {
		if (sender.isDestroyed()) throw new Error("Export sender is destroyed.");
		const existing = this.sessions.get(sender);
		if (existing) return existing.owner;

		const session: SenderSession = {
			owner: {},
			onDestroyed: () => this.destroy(sender),
			onRenderProcessGone: () => this.rotate(sender),
			onDidStartNavigation: (...args) => {
				const isInPlace = args[2] === true;
				const isMainFrame = args[3] !== false;
				if (isMainFrame && !isInPlace) this.rotate(sender);
			},
		};
		this.sessions.set(sender, session);
		sender.on("destroyed", session.onDestroyed);
		sender.on("render-process-gone", session.onRenderProcessGone);
		sender.on("did-start-navigation", session.onDidStartNavigation);
		return session.owner;
	}

	private rotate(sender: Sender): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		const previousOwner = session.owner;
		session.owner = {};
		this.abort(previousOwner, sender.id);
	}

	private destroy(sender: Sender): void {
		const session = this.sessions.get(sender);
		if (!session) return;
		this.sessions.delete(sender);
		sender.removeListener("render-process-gone", session.onRenderProcessGone);
		sender.removeListener("did-start-navigation", session.onDidStartNavigation);
		this.abort(session.owner, sender.id);
	}

	private abort(owner: ExportTransactionOwner, senderId: number): void {
		void this.abortOwner(owner).catch((error) => this.onAbortError(senderId, error));
	}
}
