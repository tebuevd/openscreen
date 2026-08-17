// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	delete: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

const menuCallbacks = vi.hoisted(() => ({
	newProject: null as (() => void) | null,
	loadProject: null as (() => void) | null,
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: bridgeMocks },
}));

vi.mock("@/native", () => ({
	nativeBridgeClient: { aiEdition: bridgeMocks },
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/contexts/ShortcutsContext", () => ({
	useShortcuts: () => ({ shortcuts: {}, isMac: false, openConfig: vi.fn() }),
}));

vi.mock("@/lib/shortcuts", () => ({ matchesShortcut: () => false }));
vi.mock("@/lib/ai-edition/store/undo", () => ({
	useUndoRedoShortcuts: vi.fn(),
	clearHistory: vi.fn(),
	pushHistory: vi.fn(),
}));
vi.mock("@/lib/ai-edition/store/useSequentialTimelineOps", () => ({
	useSequentialTimelineOps: () => ({ apply: vi.fn() }),
}));
vi.mock("@/lib/ai-edition/store/transcriptionStore", () => ({
	useAutoTranscription: vi.fn(),
	useAssetTranscriptions: () => ({}),
	useTimelineTranscriptGate: () => ({ state: "ready" }),
	useTranscriptionStore: (
		selector: (state: { requestTimelineTranscripts: () => void }) => unknown,
	) => selector({ requestTimelineTranscripts: vi.fn() }),
}));
vi.mock("@/lib/ai-edition/store/useTimeline", () => ({
	useTimeline: () => ({
		selection: null,
		multiSelection: [],
		clipSelection: null,
		zoomRegions: [],
		speedRegions: [],
		cameraFullscreenRegions: [],
		trimRanges: [],
		annotationRegions: [],
		clips: [],
		selectRegion: vi.fn(),
		removeRegion: vi.fn(),
		removeRegions: vi.fn(),
		duplicateClip: vi.fn(),
		addZoom: vi.fn(),
		addTrim: vi.fn(),
		addAnnotation: vi.fn(),
		addSpeed: vi.fn(),
		addCameraFullscreen: vi.fn(),
		updateZoomFocusLive: vi.fn(),
		commitZoomFocus: vi.fn(),
		updateAnnotationLive: vi.fn(),
		commitAnnotationChange: vi.fn(),
		updateClipSourceRange: vi.fn(),
		updateClipCrop: vi.fn(),
	}),
}));
vi.mock("@/native/useNativePlaybackSync", () => ({ useNativePlaybackSync: vi.fn() }));
vi.mock("./recordingImport", () => ({ importPendingRecording: async () => "none" }));

vi.mock("./v4/EditorTopBar", () => ({
	EditorTopBar: ({ actions }: { actions: { openProject: () => void; newProject: () => void } }) => (
		<div>
			<button type="button" onClick={actions.openProject}>
				Topbar Open
			</button>
			<button type="button" onClick={actions.newProject}>
				Topbar New
			</button>
		</div>
	),
}));

vi.mock("./Modals", () => ({
	OpenProjectModal: ({
		open,
		onClose,
		onSelect,
		onDelete,
		onBrowse,
	}: {
		open: boolean;
		onClose: () => void;
		onSelect: (id: string) => void;
		onDelete: (id: string) => void;
		onBrowse: () => void;
	}) =>
		open ? (
			<div aria-label="Open project modal">
				<button
					type="button"
					onClick={() => {
						onSelect("proj_b");
						onClose();
					}}
				>
					Select Existing
				</button>
				<button
					type="button"
					onClick={() => {
						onBrowse();
						onClose();
					}}
				>
					Browse Import
				</button>
				<button
					type="button"
					onClick={() => {
						onDelete("proj_a");
						onClose();
					}}
				>
					Delete Active
				</button>
			</div>
		) : null,
	NewProjectModal: ({
		open,
		onClose,
		onCreate,
	}: {
		open: boolean;
		onClose: () => void;
		onCreate: (title: string, startingPoint: "import") => void;
	}) =>
		open ? (
			<div aria-label="New project modal">
				<button
					type="button"
					onClick={() => {
						onCreate("Created Project", "import");
						onClose();
					}}
				>
					Create Project
				</button>
			</div>
		) : null,
	UnsavedChangesModal: ({
		open,
		onChoose,
	}: {
		open: boolean;
		onChoose: (choice: "save" | "discard" | "cancel") => void;
	}) =>
		open ? (
			<div aria-label="Unsaved prompt">
				<button type="button" onClick={() => onChoose("save")}>
					Save Choice
				</button>
				<button type="button" onClick={() => onChoose("discard")}>
					Discard Choice
				</button>
				<button type="button" onClick={() => onChoose("cancel")}>
					Cancel Choice
				</button>
			</div>
		) : null,
	EditClipModal: () => null,
}));

vi.mock("./Preview", () => ({ Preview: () => null }));
vi.mock("./LeftPanel", () => ({ LeftPanel: () => null }));
vi.mock("./ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./v4/FloatingInspector", () => ({ FloatingInspector: () => null }));
vi.mock("./v4/MediaStage", () => ({ MediaStage: () => null }));
vi.mock("./v4/RecStage", () => ({ RecStage: () => null }));
vi.mock("./v4/V4Timeline", () => ({ V4Timeline: () => null }));

type Route =
	| "topbar-open"
	| "topbar-new"
	| "native-menu"
	| "native-new"
	| "browse-import"
	| "shortcut";
type Choice = "save" | "discard" | "cancel";

const projectA = createEmptyDocument({ projectId: "proj_a", title: "Project A" });
const projectB = createEmptyDocument({ projectId: "proj_b", title: "Project B" });
const createdProject = createEmptyDocument({ projectId: "proj_created", title: "Created Project" });
const importedProject = createEmptyDocument({ projectId: "proj_imported", title: "Imported" });

function loadDirtyProject() {
	useProjectStore.setState({
		projectId: projectA.project.id,
		document: projectA,
		revision: 1,
		status: "ready",
		error: null,
		dirty: true,
		lastSavedAt: null,
	});
}

async function triggerRoute(route: Route) {
	if (route === "topbar-open" || route === "browse-import") {
		fireEvent.click(screen.getByRole("button", { name: "Topbar Open" }));
	} else if (route === "topbar-new") {
		fireEvent.click(screen.getByRole("button", { name: "Topbar New" }));
	} else if (route === "native-menu") {
		act(() => menuCallbacks.loadProject?.());
	} else if (route === "native-new") {
		act(() => menuCallbacks.newProject?.());
	} else {
		fireEvent.keyDown(window, { key: "o", ctrlKey: true });
	}

	if (route === "topbar-new" || route === "native-new") {
		fireEvent.click(await screen.findByRole("button", { name: "Create Project" }));
	} else if (route === "browse-import") {
		fireEvent.click(await screen.findByRole("button", { name: "Browse Import" }));
	} else {
		fireEvent.click(await screen.findByRole("button", { name: "Select Existing" }));
	}
}

describe("NewEditorShell project replacement routes", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.listProjects.mockResolvedValue([]);
		bridgeMocks.get.mockResolvedValue({ success: true, document: projectB });
		bridgeMocks.create.mockResolvedValue({ success: true, document: createdProject });
		bridgeMocks.delete.mockResolvedValue({ success: true });
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		menuCallbacks.newProject = null;
		menuCallbacks.loadProject = null;
		loadDirtyProject();

		Object.assign(window, {
			electronAPI: {
				setHasUnsavedChanges: vi.fn(),
				onRequestCloseConfirm: vi.fn(() => vi.fn()),
				onRequestSaveBeforeClose: vi.fn(() => vi.fn()),
				onMenuNewProject: vi.fn((callback: () => void) => {
					menuCallbacks.newProject = callback;
					return vi.fn();
				}),
				onMenuLoadProject: vi.fn((callback: () => void) => {
					menuCallbacks.loadProject = callback;
					return vi.fn();
				}),
				onMenuSaveProject: vi.fn(() => vi.fn()),
				onMenuSaveProjectAs: vi.fn(() => vi.fn()),
				loadProjectFile: vi.fn(async () => ({ success: true, project: importedProject })),
			},
		});
	});

	afterEach(() => {
		cleanup();
		// biome-ignore lint/suspicious/noExplicitAny: test-only cleanup of contextBridge
		delete (window as any).electronAPI;
	});

	it.each([
		["topbar-open", "save"],
		["topbar-open", "discard"],
		["topbar-open", "cancel"],
		["topbar-new", "save"],
		["topbar-new", "discard"],
		["topbar-new", "cancel"],
		["native-menu", "save"],
		["native-menu", "discard"],
		["native-menu", "cancel"],
		["native-new", "save"],
		["native-new", "discard"],
		["native-new", "cancel"],
		["browse-import", "save"],
		["browse-import", "discard"],
		["browse-import", "cancel"],
	] as Array<[Route, Choice]>)("gates dirty %s replacement with %s", async (route, choice) => {
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());

		await triggerRoute(route);
		expect(screen.getAllByLabelText("Unsaved prompt")).toHaveLength(1);
		fireEvent.click(
			screen.getByRole("button", { name: `${choice[0].toUpperCase()}${choice.slice(1)} Choice` }),
		);

		const expected =
			route === "topbar-new" || route === "native-new"
				? createdProject
				: route === "browse-import"
					? importedProject
					: projectB;
		if (choice === "cancel") {
			await waitFor(() =>
				expect(screen.queryByLabelText("Unsaved prompt")).not.toBeInTheDocument(),
			);
			expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });
		} else {
			await waitFor(() =>
				expect(useProjectStore.getState()).toMatchObject({
					projectId: expected.project.id,
					document: expected,
					status: "ready",
					dirty: false,
				}),
			);
		}
		const explicitSaves = bridgeMocks.save.mock.calls.filter(
			([document]) => document.project.id === projectA.project.id,
		);
		expect(explicitSaves).toHaveLength(choice === "save" ? 1 : 0);
	});

	it("opens a renderer shortcut without prompting twice", async () => {
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());

		fireEvent.keyDown(window, { key: "o", ctrlKey: true });
		act(() => menuCallbacks.loadProject?.());
		expect(screen.getByLabelText("Open project modal")).toBeInTheDocument();
		expect(screen.queryByLabelText("Unsaved prompt")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Select Existing" }));
		expect(screen.getAllByLabelText("Unsaved prompt")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Discard Choice" }));

		await waitFor(() => expect(useProjectStore.getState().projectId).toBe(projectB.project.id));
		expect(bridgeMocks.get).toHaveBeenCalledTimes(1);
	});

	it.each([
		"save",
		"discard",
		"cancel",
	] as const)("gates active-project deletion with %s", async (choice) => {
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Topbar Open" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete Active" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: `${choice[0].toUpperCase()}${choice.slice(1)} Choice`,
			}),
		);

		if (choice === "cancel") {
			expect(bridgeMocks.delete).not.toHaveBeenCalled();
			expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });
		} else {
			await waitFor(() => expect(useProjectStore.getState().document).toBeNull());
			expect(bridgeMocks.delete).toHaveBeenCalledWith(projectA.project.id);
		}
	});

	it("does not replace from the top bar when the accepted save is rejected", async () => {
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());
		await triggerRoute("topbar-open");

		fireEvent.click(screen.getByRole("button", { name: "Save Choice" }));

		await waitFor(() => expect(screen.queryByLabelText("Unsaved prompt")).not.toBeInTheDocument());
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });
	});

	it("keeps discarded changes recoverable when an existing-project load fails", async () => {
		bridgeMocks.get.mockResolvedValue({ success: false, error: "Project B unavailable" });
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());
		await triggerRoute("topbar-open");

		fireEvent.click(screen.getByRole("button", { name: "Discard Choice" }));

		await waitFor(() => expect(useProjectStore.getState().status).toBe("error"));
		expect(useProjectStore.getState()).toMatchObject({
			projectId: projectA.project.id,
			document: projectA,
			dirty: true,
			error: "Project B unavailable",
		});
	});

	it("keeps discarded changes when the browse picker is cancelled", async () => {
		vi.mocked(window.electronAPI.loadProjectFile).mockResolvedValue({ success: false });
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());
		await triggerRoute("browse-import");

		fireEvent.click(screen.getByRole("button", { name: "Discard Choice" }));

		await waitFor(() => expect(window.electronAPI.loadProjectFile).toHaveBeenCalledTimes(1));
		expect(useProjectStore.getState()).toMatchObject({ document: projectA, dirty: true });
	});

	it("replaces a clean project without opening the prompt", async () => {
		useProjectStore.setState({ dirty: false });
		render(<NewEditorShell />);
		await waitFor(() => expect(bridgeMocks.listProjects).toHaveBeenCalled());

		await triggerRoute("topbar-open");

		await waitFor(() => expect(useProjectStore.getState().projectId).toBe(projectB.project.id));
		expect(screen.queryByLabelText("Unsaved prompt")).not.toBeInTheDocument();
	});
});
