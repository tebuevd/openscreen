import { describe, expect, it, vi } from "vitest";
import {
	EditorCloseCoordinator,
	type EditorWindowTarget,
	routeEditorMenuAction,
} from "./editor-window-lifecycle";

let nextWindowId = 0;

function windowTarget(url: string, options: { loading?: boolean; minimized?: boolean } = {}) {
	let destroyed = false;
	let minimized = options.minimized ?? false;
	let finishLoad: (() => void) | null = null;
	const target: EditorWindowTarget = {
		isDestroyed: () => destroyed,
		isMinimized: () => minimized,
		restore: vi.fn(() => {
			minimized = false;
		}),
		show: vi.fn(),
		focus: vi.fn(),
		close: vi.fn(() => {
			destroyed = true;
		}),
		webContents: {
			id: ++nextWindowId,
			getURL: () => url,
			isLoading: () => options.loading ?? false,
			once: vi.fn((_event, listener) => {
				finishLoad = listener;
			}),
			send: vi.fn(),
		},
	};
	return { target, finishLoad: () => finishLoad?.() };
}

describe("routeEditorMenuAction", () => {
	it("routes to and focuses the existing editor when an auxiliary window is focused", () => {
		const notes = windowTarget("file:///index.html?windowType=notes").target;
		const editor = windowTarget("file:///index.html?windowType=editor", { minimized: true }).target;
		const createEditor = vi.fn();

		expect(routeEditorMenuAction("menu-new-project", [notes, editor], createEditor)).toBe(editor);

		expect(createEditor).not.toHaveBeenCalled();
		expect(editor.restore).toHaveBeenCalledOnce();
		expect(editor.show).toHaveBeenCalledOnce();
		expect(editor.focus).toHaveBeenCalledOnce();
		expect(editor.webContents.send).toHaveBeenCalledWith("menu-new-project");
		expect(notes.webContents.send).not.toHaveBeenCalled();
	});

	it("creates an editor only when none exists and waits for its renderer", () => {
		const hud = windowTarget("file:///index.html?windowType=hud-overlay").target;
		const created = windowTarget("file:///index.html?windowType=editor");
		const createEditor = vi.fn(() => created.target);

		routeEditorMenuAction("menu-load-project", [hud], createEditor);

		expect(createEditor).toHaveBeenCalledOnce();
		expect(created.target.webContents.send).not.toHaveBeenCalled();
		created.finishLoad();
		expect(created.target.webContents.send).toHaveBeenCalledWith("menu-load-project");
	});

	it("uses a known editor before its navigation URL is observable", () => {
		const loadingEditor = windowTarget("", { loading: true });
		const createEditor = vi.fn();

		routeEditorMenuAction(
			"menu-new-project",
			[loadingEditor.target],
			createEditor,
			loadingEditor.target,
		);

		expect(createEditor).not.toHaveBeenCalled();
		loadingEditor.finishLoad();
		expect(loadingEditor.target.webContents.send).toHaveBeenCalledWith("menu-new-project");
	});
});

describe("EditorCloseCoordinator", () => {
	it("identifies requests and ignores stale or foreign responses", () => {
		const scheduled: Array<() => void> = [];
		const coordinator = new EditorCloseCoordinator((close) => scheduled.push(close));
		const editor = windowTarget("file:///index.html?windowType=editor").target;
		const event = { preventDefault: vi.fn() };

		coordinator.requestClose(editor, event, true);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(editor.webContents.send).toHaveBeenCalledWith("request-close-confirm", 1);
		expect(coordinator.respondToConfirm(editor.webContents.id + 1, 1, "discard")).toBe(false);
		expect(coordinator.respondToConfirm(editor.webContents.id, 2, "discard")).toBe(false);
		expect(scheduled).toHaveLength(0);

		expect(coordinator.respondToConfirm(editor.webContents.id, 1, "discard")).toBe(true);
		expect(scheduled).toHaveLength(1);
		scheduled[0]();
		expect(editor.close).toHaveBeenCalledOnce();
	});

	it("settles busy requests and correlates save completion", () => {
		const scheduled: Array<() => void> = [];
		const coordinator = new EditorCloseCoordinator((close) => scheduled.push(close));
		const editor = windowTarget("file:///index.html?windowType=editor").target;

		coordinator.requestClose(editor, { preventDefault: vi.fn() }, true);
		expect(coordinator.respondToConfirm(editor.webContents.id, 1, "busy")).toBe(true);
		coordinator.requestClose(editor, { preventDefault: vi.fn() }, true);
		expect(editor.webContents.send).toHaveBeenLastCalledWith("request-close-confirm", 2);
		expect(coordinator.respondToConfirm(editor.webContents.id, 2, "save")).toBe(true);
		expect(editor.webContents.send).toHaveBeenLastCalledWith("request-save-before-close", 2);
		expect(coordinator.respondToSave(editor.webContents.id, 1, true)).toBe(false);
		expect(coordinator.respondToSave(editor.webContents.id, 2, true)).toBe(true);
		expect(scheduled).toHaveLength(1);
	});
});
