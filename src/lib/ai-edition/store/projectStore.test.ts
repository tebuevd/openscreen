// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAsset as removeAssetFromDocument } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: toastMocks.error },
}));

const sampleDoc = {
	// ponytail: the bridge contract after the migration hoist is v6 — every
	// load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure v6
	// validator. Test fixtures model the post-hoist contract.
	// `as const` and not a bare 7: the document type pins this field to the
	// LITERAL 7, and an unannotated object literal widens it to `number` — so
	// every `document: sampleDoc` below fails to type-check for a fixture that
	// is, in fact, exactly right.
	schemaVersion: 7 as const,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
};

const assetDoc: AxcutDocument = {
	...sampleDoc,
	project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			cameraTrack: null,
		},
	],
	timeline: {
		...sampleDoc.timeline,
		clips: [
			{
				id: "clip_1",
				assetId: "asset_1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
	},
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function loadDocument(document: AxcutDocument = sampleDoc) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: "ready",
		error: null,
		dirty: false,
	});
}

describe("useProjectStore", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
		toastMocks.error.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI = {
			findRecordingCamera: vi.fn().mockResolvedValue({
				success: false,
				error: "No camera attached to this recording",
			}),
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		delete (window as any).electronAPI;
	});

	it("createProject stores the returned document and bumps revision", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const doc = await useProjectStore.getState().createProject("Test");

		expect(doc.project.id).toBe("proj_test");
		const state = useProjectStore.getState();
		expect(state.projectId).toBe("proj_test");
		expect(state.document?.project.title).toBe("Test");
		expect(state.revision).toBe(1);
		expect(state.status).toBe("ready");
	});

	it("loadProject handles a failed bridge response by setting error status", async () => {
		bridgeMocks.get.mockResolvedValue({ success: false, error: "not found" });

		await useProjectStore.getState().loadProject("proj_x");

		const state = useProjectStore.getState();
		expect(state.status).toBe("error");
		expect(state.error).toBe("not found");
	});

	it("serializes saves and persists the latest authoritative document", async () => {
		const firstSave = deferred<{ success: true; document: AxcutDocument }>();
		const secondSave = deferred<{ success: true; document: AxcutDocument }>();
		const snapshots: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshots.push(document);
			return snapshots.length === 1 ? firstSave.promise : secondSave.promise;
		});
		loadDocument();

		const firstPromise = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "First edit" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const afterFirst = useProjectStore.getState().document!;
		const secondPromise = useProjectStore.getState().saveDocument({
			...afterFirst,
			project: { ...afterFirst.project, title: "Second edit" },
		});

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Second edit" } },
			dirty: true,
		});

		firstSave.resolve({ success: true, document: snapshots[0] });
		await firstPromise;
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		expect(snapshots[1].project.title).toBe("Second edit");
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Second edit" } },
			dirty: true,
		});

		secondSave.resolve({ success: true, document: snapshots[1] });
		await secondPromise;
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Second edit" } },
			dirty: false,
		});
	});

	it("does not let an old same-project response replace a newer dirty mutation", async () => {
		const pending = deferred<{ success: true; document: AxcutDocument }>();
		let snapshot: AxcutDocument | null = null;
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshot = document;
			return pending.promise;
		});
		loadDocument();

		const savePromise = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Pending save" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const current = useProjectStore.getState().document!;
		useProjectStore.getState().setDocument({
			...current,
			project: { ...current.project, title: "Newer unsaved edit" },
		});

		pending.resolve({ success: true, document: snapshot! });
		await savePromise;
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer unsaved edit" } },
			dirty: true,
		});
	});

	it("does not apply an old save response after an A-to-B-to-A reload", async () => {
		const pending = deferred<{ success: true; document: AxcutDocument }>();
		let snapshot: AxcutDocument | null = null;
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshot = document;
			return pending.promise;
		});
		loadDocument();
		const firstGeneration = useProjectStore.getState().documentGeneration;
		const savePromise = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Old A save" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		const reopenedA: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Reopened A" },
		};
		bridgeMocks.get.mockResolvedValueOnce({ success: true, document: projectB });
		bridgeMocks.get.mockResolvedValueOnce({ success: true, document: reopenedA });
		await useProjectStore.getState().loadProject("proj_b");
		await useProjectStore.getState().loadProject("proj_test");
		useProjectStore.getState().setDocument({
			...reopenedA,
			project: { ...reopenedA.project, title: "Reopened A dirty" },
		});

		pending.resolve({ success: true, document: snapshot! });
		await savePromise;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: { project: { title: "Reopened A dirty" } },
			dirty: true,
		});
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(firstGeneration);
	});

	it("merges a delayed add response without clearing a newer dirty edit", async () => {
		const pending = deferred<{ assetId: string; document: AxcutDocument }>();
		bridgeMocks.addAsset.mockReturnValue(pending.promise);
		loadDocument();

		const adding = useProjectStore.getState().addAsset("/tmp/screen.webm");
		await waitFor(() => expect(bridgeMocks.addAsset).toHaveBeenCalledTimes(1));
		useProjectStore.getState().setDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Newer dirty title" },
		});
		pending.resolve({ assetId: "asset_1", document: assetDoc });
		await adding;

		expect(useProjectStore.getState()).toMatchObject({
			document: {
				project: { title: "Newer dirty title" },
				assets: [{ id: "asset_1" }],
			},
			dirty: true,
		});
	});

	it("does not let a later ordinary save drop an asset added while it was queued", async () => {
		const pendingAdd = deferred<{ assetId: string; document: AxcutDocument }>();
		bridgeMocks.addAsset.mockReturnValue(pendingAdd.promise);
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		loadDocument();

		const adding = useProjectStore.getState().addAsset("/tmp/screen.webm");
		await waitFor(() => expect(bridgeMocks.addAsset).toHaveBeenCalledTimes(1));
		const stale = useProjectStore.getState().document!;
		const saving = useProjectStore.getState().saveDocument({
			...stale,
			project: { ...stale.project, title: "Save queued after add" },
		});
		pendingAdd.resolve({ assetId: "asset_1", document: assetDoc });
		await adding;
		await saving;

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save.mock.calls[0]?.[0]).toMatchObject({
			project: { title: "Save queued after add" },
			assets: [{ id: "asset_1" }],
		});
		expect(useProjectStore.getState().document).toMatchObject({
			project: { title: "Save queued after add" },
			assets: [{ id: "asset_1" }],
		});
	});

	it("orders remove before a later ordinary save and preserves its newer edit", async () => {
		const pendingRemove = deferred<{ assetId: string; document: AxcutDocument }>();
		const pendingSave = deferred<{ success: true; document: AxcutDocument }>();
		let saveSnapshot: AxcutDocument | null = null;
		bridgeMocks.removeAsset.mockReturnValue(pendingRemove.promise);
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			saveSnapshot = document;
			return pendingSave.promise;
		});
		loadDocument(assetDoc);

		const removing = useProjectStore.getState().removeAsset("asset_1");
		await waitFor(() => expect(bridgeMocks.removeAsset).toHaveBeenCalledTimes(1));
		const current = useProjectStore.getState().document!;
		const saving = useProjectStore.getState().saveDocument({
			...current,
			project: { ...current.project, title: "Edit queued after remove" },
		});
		pendingRemove.resolve({
			assetId: "asset_1",
			document: removeAssetFromDocument(assetDoc, "asset_1"),
		});
		await removing;
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		expect(saveSnapshot).toMatchObject({
			project: { title: "Edit queued after remove" },
			assets: [],
			timeline: { clips: [] },
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Edit queued after remove" }, assets: [] },
			dirty: true,
		});

		pendingSave.resolve({ success: true, document: saveSnapshot! });
		await saving;
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Edit queued after remove" }, assets: [] },
			dirty: false,
		});
	});

	it("orders an atomic updater after add and includes the new asset", async () => {
		const pendingAdd = deferred<{ assetId: string; document: AxcutDocument }>();
		bridgeMocks.addAsset.mockReturnValue(pendingAdd.promise);
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		loadDocument();

		const adding = useProjectStore.getState().addAsset("/tmp/screen.webm");
		await waitFor(() => expect(bridgeMocks.addAsset).toHaveBeenCalledTimes(1));
		const generation = useProjectStore.getState().documentGeneration;
		const updating = useProjectStore.getState().saveDocumentUpdate(generation, (document) => ({
			...document,
			project: { ...document.project, title: "Updater after add" },
		}));
		pendingAdd.resolve({ assetId: "asset_1", document: assetDoc });
		await adding;
		await updating;

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save.mock.calls[0]?.[0]).toMatchObject({
			project: { title: "Updater after add" },
			assets: [{ id: "asset_1" }],
		});
		expect(useProjectStore.getState().document).toMatchObject({
			project: { title: "Updater after add" },
			assets: [{ id: "asset_1" }],
		});
	});

	it("ignores an A-to-B-to-A stale asset-operation response", async () => {
		const pendingRemove = deferred<{ assetId: string; document: AxcutDocument }>();
		bridgeMocks.removeAsset.mockReturnValue(pendingRemove.promise);
		loadDocument(assetDoc);
		const firstGeneration = useProjectStore.getState().documentGeneration;
		const removing = useProjectStore.getState().removeAsset("asset_1");
		await waitFor(() => expect(bridgeMocks.removeAsset).toHaveBeenCalledTimes(1));

		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		const reopenedA: AxcutDocument = {
			...assetDoc,
			project: { ...assetDoc.project, title: "Reopened A" },
		};
		bridgeMocks.get.mockResolvedValueOnce({ success: true, document: projectB });
		bridgeMocks.get.mockResolvedValueOnce({ success: true, document: reopenedA });
		await useProjectStore.getState().loadProject("proj_b");
		await useProjectStore.getState().loadProject("proj_test");
		pendingRemove.resolve({
			assetId: "asset_1",
			document: removeAssetFromDocument(assetDoc, "asset_1"),
		});
		await removing;

		expect(useProjectStore.getState().document).toMatchObject({
			project: { id: "proj_test", title: "Reopened A" },
			assets: [{ id: "asset_1" }],
		});
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(firstGeneration);
	});

	it("recovers the renderer queue after an asset operation rejects", async () => {
		bridgeMocks.removeAsset.mockRejectedValueOnce(new Error("remove failed"));
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		loadDocument(assetDoc);

		await expect(useProjectStore.getState().removeAsset("asset_1")).rejects.toThrow(
			"remove failed",
		);
		const current = useProjectStore.getState().document!;
		await useProjectStore.getState().saveDocument({
			...current,
			project: { ...current.project, title: "Save after rejection" },
		});

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.project.title).toBe("Save after rejection");
	});

	it("merges a delayed camera link into the newest document", async () => {
		const camera = deferred<{
			success: true;
			webcamVideoPath: string;
			offsetMs: number;
		}>();
		bridgeMocks.addAsset.mockResolvedValue({ assetId: "asset_1", document: assetDoc });
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockReturnValue(camera.promise);
		loadDocument();

		const adding = useProjectStore.getState().addAsset("/tmp/screen.webm");
		await waitFor(() => expect(useProjectStore.getState().document?.assets).toHaveLength(1));
		const current = useProjectStore.getState().document!;
		useProjectStore.getState().setDocument({
			...current,
			project: { ...current.project, title: "Edit during camera lookup" },
		});
		camera.resolve({
			success: true,
			webcamVideoPath: "/tmp/screen-webcam.webm",
			offsetMs: 12.4,
		});
		await adding;

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save.mock.calls[0]?.[0]).toMatchObject({
			project: { title: "Edit during camera lookup" },
			assets: [
				{
					id: "asset_1",
					cameraTrack: { sourcePath: "/tmp/screen-webcam.webm", offsetMs: 12 },
				},
			],
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: {
				project: { title: "Edit during camera lookup" },
				assets: [{ cameraTrack: { sourcePath: "/tmp/screen-webcam.webm" } }],
			},
			dirty: false,
		});
	});

	it("addAsset replaces the document and bumps revision", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const updatedDoc = {
			...sampleDoc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "screen.webm",
					originalPath: "/tmp/screen.webm",
				},
			],
			project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
		};
		bridgeMocks.addAsset.mockResolvedValue({ assetId: "asset_1", document: updatedDoc });

		const asset = await useProjectStore.getState().addAsset("/tmp/screen.webm");

		expect(asset?.id).toBe("asset_1");
		expect(useProjectStore.getState().revision).toBe(2);
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
	});

	it("addAsset resolves an independent camera for every asset added, not just the first", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockImplementation(async (path: string) => {
			if (path === "/tmp/screen1.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen1-webcam.webm", offsetMs: 0 };
			}
			if (path === "/tmp/screen2.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen2-webcam.webm", offsetMs: 0 };
			}
			return { success: false, error: "No camera attached to this recording" };
		});

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "screen1.webm",
						originalPath: "/tmp/screen1.webm",
					},
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});
		await useProjectStore.getState().addAsset("/tmp/screen1.webm");

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_2",
			document: {
				...useProjectStore.getState().document,
				assets: [
					...useProjectStore.getState().document!.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "screen2.webm",
						originalPath: "/tmp/screen2.webm",
					},
				],
			},
		});
		await useProjectStore.getState().addAsset("/tmp/screen2.webm");

		const assets = useProjectStore.getState().document?.assets ?? [];
		expect(assets).toHaveLength(2);
		expect(assets.find((a) => a.id === "asset_1")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen1-webcam.webm",
		);
		expect(assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen2-webcam.webm",
		);
	});

	it("addAsset links the camera when the recorder measured a sub-millisecond offset", async () => {
		// The native capture paths derive this from `performance.now()` (100 µs
		// resolution), so the offset is almost never a whole number — while
		// `cameraTrackSchema.offsetMs` is an int. Unrounded, the document failed
		// validation, the catch below treated it as a lookup failure, and a
		// recording that HAD a camera silently lost it.
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: true,
			webcamVideoPath: "/tmp/screen-webcam.webm",
			offsetMs: -192.80000000447035,
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "screen.mp4", originalPath: "/tmp/screen.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/screen.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		const camera = useProjectStore.getState().document?.assets[0]?.cameraTrack;
		expect(camera?.sourcePath).toBe("/tmp/screen-webcam.webm");
		expect(camera?.offsetMs).toBe(-193);
	});

	it("addAsset stays silent (no toast) when a plain imported video has no camera", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: false,
			error: "No camera attached to this recording",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.assets[0]?.cameraTrack).toBeNull();
	});

	it("addAsset toasts when the camera lookup itself throws", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockRejectedValue(new Error("bridge exploded"));
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).toHaveBeenCalledTimes(1);
		expect(toastMocks.error.mock.calls[0][0]).toContain("video.mp4");
	});

	it("removeAsset requires a loaded project", async () => {
		await expect(useProjectStore.getState().removeAsset("asset_x")).rejects.toThrow(
			"No project loaded",
		);
	});

	it("clear resets the store", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 5,
			status: "ready",
			error: null,
		});
		useProjectStore.getState().clear();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
		});
	});
});
