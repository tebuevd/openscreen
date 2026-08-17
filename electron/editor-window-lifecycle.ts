export type EditorMenuChannel =
	| "menu-load-project"
	| "menu-save-project"
	| "menu-save-project-as"
	| "menu-new-project";

interface EditorWebContentsTarget {
	id: number;
	getURL: () => string;
	isLoading: () => boolean;
	once: (event: "did-finish-load", listener: () => void) => unknown;
	send: (channel: string, ...args: unknown[]) => void;
}

export interface EditorWindowTarget {
	isDestroyed: () => boolean;
	isMinimized: () => boolean;
	restore: () => void;
	show: () => void;
	focus: () => void;
	close: () => void;
	webContents: EditorWebContentsTarget;
}

export function isEditorWindow(window: EditorWindowTarget): boolean {
	return !window.isDestroyed() && window.webContents.getURL().includes("windowType=editor");
}

export function routeEditorMenuAction(
	channel: EditorMenuChannel,
	windows: readonly EditorWindowTarget[],
	createEditor: () => EditorWindowTarget | null,
	knownEditor: EditorWindowTarget | null = null,
): EditorWindowTarget | null {
	const existing =
		knownEditor && !knownEditor.isDestroyed()
			? knownEditor
			: (windows.find(isEditorWindow) ?? null);
	const target = existing ?? createEditor();
	if (!target || target.isDestroyed()) return null;

	const send = () => {
		if (!target.isDestroyed()) target.webContents.send(channel);
	};

	if (existing) {
		if (target.isMinimized()) target.restore();
		target.show();
		target.focus();
	}

	// A newly-created renderer has not registered its menu listeners yet. An existing
	// editor can also still be navigating after a reload, so wait for that document too.
	if (!existing || target.webContents.isLoading()) {
		target.webContents.once("did-finish-load", send);
	} else {
		send();
	}

	return target;
}

export type EditorCloseChoice = "save" | "discard" | "cancel" | "busy";

interface PendingCloseOperation {
	id: number;
	window: EditorWindowTarget;
	phase: "confirm" | "save";
}

type ScheduleClose = (close: () => void) => void;

export class EditorCloseCoordinator {
	private nextOperationId = 0;
	private pending: PendingCloseOperation | null = null;
	private readonly forceClosing = new Set<number>();

	constructor(private readonly scheduleClose: ScheduleClose = (close) => setImmediate(close)) {}

	requestClose(
		window: EditorWindowTarget,
		event: { preventDefault: () => void },
		hasUnsavedChanges: boolean,
	): void {
		if (this.forceClosing.has(window.webContents.id) || !hasUnsavedChanges) return;

		event.preventDefault();
		if (this.pending) return;

		const operation: PendingCloseOperation = {
			id: ++this.nextOperationId,
			window,
			phase: "confirm",
		};
		this.pending = operation;
		window.webContents.send("request-close-confirm", operation.id);
	}

	respondToConfirm(senderId: number, operationId: number, choice: EditorCloseChoice): boolean {
		const operation = this.pending;
		if (
			!operation ||
			operation.phase !== "confirm" ||
			operation.id !== operationId ||
			operation.window.webContents.id !== senderId
		) {
			return false;
		}

		if (choice === "save") {
			operation.phase = "save";
			operation.window.webContents.send("request-save-before-close", operation.id);
			return true;
		}

		this.pending = null;
		if (choice === "discard") this.forceClose(operation.window);
		return true;
	}

	respondToSave(senderId: number, operationId: number, shouldClose: boolean): boolean {
		const operation = this.pending;
		if (
			!operation ||
			operation.phase !== "save" ||
			operation.id !== operationId ||
			operation.window.webContents.id !== senderId
		) {
			return false;
		}

		this.pending = null;
		if (shouldClose) this.forceClose(operation.window);
		return true;
	}

	closeImmediately(window: EditorWindowTarget): void {
		if (window.isDestroyed()) return;
		this.cancelWindow(window);
		this.forceClosing.add(window.webContents.id);
		try {
			window.close();
		} finally {
			this.forceClosing.delete(window.webContents.id);
		}
	}

	cancelWindow(window: EditorWindowTarget): void {
		if (this.pending?.window === window) this.pending = null;
	}

	private forceClose(window: EditorWindowTarget): void {
		if (window.isDestroyed()) return;
		const senderId = window.webContents.id;
		this.forceClosing.add(senderId);
		this.scheduleClose(() => {
			try {
				if (!window.isDestroyed()) window.close();
			} finally {
				this.forceClosing.delete(senderId);
			}
		});
	}
}
