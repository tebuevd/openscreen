// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { useTimeline } from "./useTimeline";

/**
 * `useTimeline` reads the locale — `addAnnotation` seeds a new region with the
 * translated default text — so it needs the provider. One helper rather than a
 * wrapper argument on every call site.
 */
const renderTimeline = () => renderHook(() => useTimeline(), { wrapper: I18nProvider });
const StrictTimelineWrapper = ({ children }: PropsWithChildren) =>
	createElement(StrictMode, null, createElement(I18nProvider, null, children));
const renderStrictTimeline = () =>
	renderHook(() => useTimeline(), { wrapper: StrictTimelineWrapper });

const probeVideoDurationMock = vi.hoisted(() => vi.fn());
const probeVideoDimensionsMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
);

vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return {
		...actual,
		probeVideoDuration: probeVideoDurationMock,
		probeVideoDimensions: probeVideoDimensionsMock,
	};
});

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
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

const sampleDoc: AxcutDocument = {
	// ponytail: the bridge contract after the migration hoist is the CURRENT version —
	// every load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure current-version
	// validator. Test fixtures model the post-hoist contract, so they read the version
	// off `axcutSchemaVersion` instead of restating it.
	// Annotated `AxcutDocument` rather than left to inference: the document type
	// pins `schemaVersion` to the LITERAL 7 and `kind` to `"video"`, both of which
	// an unannotated object literal widens — and the annotation makes every
	// required field (`cameraTrack`) a compile error when it is missing instead of
	// a fixture that silently drifts from the schema.
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
			// No webcam was recorded alongside this screen capture.
			cameraTrack: null,
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "clip_a",
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("useTimeline.insertClipAt background duration probe", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "long.webm",
						originalPath: "/tmp/long.webm",
						durationSec: undefined,
						video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
						cameraTrack: null,
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("only resizes the probed clip and leaves earlier clips' positions untouched", async () => {
		// clip_a already sits at 0..10 (a "short clip"). Insert a second clip
		// for asset_2 after it — insertClipAt has no cached duration for
		// asset_2, so it lands at the 60s placeholder, then the background
		// probe (mocked here to resolve to a much shorter real duration)
		// corrects it. Regression test for the bug where the probe used to
		// shift EVERY sibling clip (including ones before it) by the delta
		// between the real and placeholder duration, corrupting their
		// positions and producing visual overlap.
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(2);
		const clipA = clips?.find((c) => c.id === "clip_a");
		const inserted = clips?.find((c) => c.assetId === "asset_2");
		expect(clipA).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(inserted).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline.moveClip / duplicateClip (delegates to document/timeline.ts)", () => {
	const twoClipDoc: AxcutDocument = {
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				sampleDoc.timeline.clips[0],
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: twoClipDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("moveClip reorders clips and persists the resequenced timeline", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_a");
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(3);
		expect(clips?.[0].id).toBe("clip_a");
		expect(clips?.[2].id).toBe("clip_b");
		const copyId = clips?.[1].id;
		expect(copyId).toBeTruthy();
		expect(copyId).not.toBe("clip_a");
		expect(result.current.clipSelection).toBe(copyId);
	});

	it("duplicateClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_missing");
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline backfills missing source dimensions on load", () => {
	const documentWithoutDimensions: AxcutDocument = {
		...sampleDoc,
		assets: [{ ...sampleDoc.assets[0], video: undefined }],
	};

	function loadDocument(document: AxcutDocument, newGeneration = false) {
		const state = useProjectStore.getState();
		useProjectStore.setState({
			projectId: document.project.id,
			document,
			documentGeneration: state.documentGeneration + (newGeneration ? 1 : 0),
			revision: 1,
			status: "ready",
			error: null,
			dirty: false,
		});
	}

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("probes a used asset with no dimensions and persists them", async () => {
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save.mock.calls[0]?.[0]).toMatchObject({
			assets: [{ id: "asset_1", video: { width: 1920, height: 1080 } }],
		});
		expect(useProjectStore.getState().document?.assets[0].video).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});

	it("waits for a pending unrelated save and merges into its committed snapshot", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		const pendingSave = deferred<{ success: true; document: AxcutDocument }>();
		let firstSnapshot: AxcutDocument | null = null;
		probeVideoDimensionsMock.mockReturnValue(probe.promise);
		bridgeMocks.save.mockImplementationOnce((document: AxcutDocument) => {
			firstSnapshot = document;
			return pendingSave.promise;
		});
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		let unrelatedSave!: Promise<void>;
		act(() => {
			const current = useProjectStore.getState().document!;
			unrelatedSave = useProjectStore.getState().saveDocument({
				...current,
				project: { ...current.project, title: "Pending unrelated edit" },
			});
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		await act(async () => {
			probe.resolve({ width: 2880, height: 1864 });
			await probe.promise;
			await Promise.resolve();
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);

		await act(async () => {
			pendingSave.resolve({ success: true, document: firstSnapshot! });
			await unrelatedSave;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));

		const backfillSnapshot = bridgeMocks.save.mock.calls[1]?.[0] as AxcutDocument;
		expect(backfillSnapshot.project.title).toBe("Pending unrelated edit");
		expect(backfillSnapshot.assets[0].video).toMatchObject({ width: 2880, height: 1864 });
		expect(useProjectStore.getState().document).toMatchObject({
			project: { title: "Pending unrelated edit" },
			assets: [{ video: { width: 2880, height: 1864 } }],
		});
	});

	it("rebases an in-flight backfill over a later same-project save", async () => {
		const firstSave = deferred<{ success: true; document: AxcutDocument }>();
		let firstSnapshot: AxcutDocument | null = null;
		bridgeMocks.save.mockImplementationOnce((document: AxcutDocument) => {
			firstSnapshot = document;
			return firstSave.promise;
		});
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		let laterSave!: Promise<void>;
		act(() => {
			const current = useProjectStore.getState().document!;
			laterSave = useProjectStore.getState().saveDocument({
				...current,
				project: { ...current.project, title: "Later same-project edit" },
			});
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Later same-project edit" } },
			dirty: true,
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);

		await act(async () => {
			firstSave.resolve({ success: true, document: firstSnapshot! });
			await firstSave.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(3));
		await act(async () => laterSave);

		for (const index of [1, 2]) {
			const snapshot = bridgeMocks.save.mock.calls[index]?.[0] as AxcutDocument;
			expect(snapshot.project.title).toBe("Later same-project edit");
			expect(snapshot.assets[0].video).toMatchObject({ width: 1920, height: 1080 });
		}
		expect(useProjectStore.getState()).toMatchObject({
			document: {
				project: { title: "Later same-project edit" },
				assets: [{ video: { width: 1920, height: 1080 } }],
			},
			dirty: false,
		});
	});

	it("does not spin after persistence rejection and retries on the next document change", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.assets[0].video).toBeUndefined();

		act(() => {
			const current = useProjectStore.getState().document!;
			useProjectStore.getState().setDocument({
				...current,
				project: { ...current.project, title: "Retry trigger" },
			});
		});
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));

		const retrySnapshot = bridgeMocks.save.mock.calls[1]?.[0] as AxcutDocument;
		expect(retrySnapshot).toMatchObject({
			project: { title: "Retry trigger" },
			assets: [{ video: { width: 1920, height: 1080 } }],
		});
	});

	it("remembers a genuine probe failure without spinning", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null);
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

		act(() => {
			useProjectStore.setState({
				document: {
					...documentWithoutDimensions,
					project: { ...documentWithoutDimensions.project, title: "Still unreadable" },
				},
			});
		});
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		probeVideoDimensionsMock.mockResolvedValue({ width: 1280, height: 720 });
		act(() => {
			const current = useProjectStore.getState().document!;
			useProjectStore.getState().setDocument({
				...current,
				assets: current.assets.map((asset) => ({
					...asset,
					originalPath: "/tmp/replaced-after-failure.webm",
				})),
			});
		});
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect((bridgeMocks.save.mock.calls[0]?.[0] as AxcutDocument).assets[0]).toMatchObject({
			originalPath: "/tmp/replaced-after-failure.webm",
			video: { width: 1280, height: 720 },
		});
	});

	it("rejects a stale result when the same asset id gets a new path", async () => {
		const oldProbe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock
			.mockReturnValueOnce(oldProbe.promise)
			.mockResolvedValueOnce({ width: 1280, height: 720 });
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		act(() => {
			const current = useProjectStore.getState().document!;
			useProjectStore.getState().setDocument({
				...current,
				assets: current.assets.map((asset) => ({
					...asset,
					originalPath: "/tmp/replaced.webm",
					video: undefined,
				})),
			});
		});
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		await act(async () => {
			oldProbe.resolve({ width: 2880, height: 1864 });
			await oldProbe.promise;
			await Promise.resolve();
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		const snapshot = bridgeMocks.save.mock.calls[0]?.[0] as AxcutDocument;
		expect(snapshot.assets[0]).toMatchObject({
			originalPath: "/tmp/replaced.webm",
			video: { width: 1280, height: 720 },
		});
	});

	it("prunes removed assets so re-adding the identity can be probed", async () => {
		const removedProbe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock
			.mockReturnValueOnce(removedProbe.promise)
			.mockResolvedValueOnce({ width: 1024, height: 768 });
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		act(() => {
			useProjectStore.getState().setDocument({
				...documentWithoutDimensions,
				assets: [],
				timeline: { ...documentWithoutDimensions.timeline, clips: [] },
			});
		});
		await act(async () => Promise.resolve());
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		// Re-add before the old probe resolves. The same id and path still get a new
		// attempt identity, so the old completion cannot impersonate this asset.
		act(() => useProjectStore.getState().setDocument(documentWithoutDimensions));
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		await act(async () => {
			removedProbe.resolve({ width: 4000, height: 3000 });
			await removedProbe.promise;
			await Promise.resolve();
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect((bridgeMocks.save.mock.calls[0]?.[0] as AxcutDocument).assets[0].video).toMatchObject({
			width: 1024,
			height: 768,
		});
	});

	it("re-probes and heals dimensions that disappear after a successful save", async () => {
		probeVideoDimensionsMock
			.mockResolvedValueOnce({ width: 1920, height: 1080 })
			.mockResolvedValueOnce({ width: 2880, height: 1864 });
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		act(() => {
			const persisted = useProjectStore.getState().document!;
			useProjectStore.getState().setDocument({
				...persisted,
				assets: persisted.assets.map((asset) => ({ ...asset, video: undefined })),
			});
		});
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));

		expect((bridgeMocks.save.mock.calls[1]?.[0] as AxcutDocument).assets[0].video).toMatchObject({
			width: 2880,
			height: 1864,
		});
		expect(useProjectStore.getState().document?.assets[0].video).toMatchObject({
			width: 2880,
			height: 1864,
		});
	});

	it("starts no duplicate probe while the same asset path is in flight", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock.mockReturnValue(probe.promise);
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		act(() => {
			useProjectStore.setState({
				document: {
					...documentWithoutDimensions,
					project: { ...documentWithoutDimensions.project, title: "Updated in flight" },
				},
			});
		});
		await act(async () => Promise.resolve());
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			probe.resolve({ width: 1920, height: 1080 });
			await probe.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect((bridgeMocks.save.mock.calls[0]?.[0] as AxcutDocument).project.title).toBe(
			"Updated in flight",
		);
	});

	it("invalidates old work across an A-to-B-to-A project generation change", async () => {
		const oldProbe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock
			.mockReturnValueOnce(oldProbe.promise)
			.mockResolvedValueOnce({ width: 1366, height: 768 });
		loadDocument(documentWithoutDimensions);
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		act(() => loadDocument(projectB, true));
		const reopenedA: AxcutDocument = {
			...documentWithoutDimensions,
			project: { ...documentWithoutDimensions.project, title: "Reopened A" },
		};
		act(() => loadDocument(reopenedA, true));
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		await act(async () => {
			oldProbe.resolve({ width: 2880, height: 1864 });
			await oldProbe.promise;
			await Promise.resolve();
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document).toMatchObject({
			project: { id: "proj_test", title: "Reopened A" },
			assets: [{ video: { width: 1366, height: 768 } }],
		});
	});

	it("does not apply an old save after unmount and remount", async () => {
		const oldSave = deferred<{ success: true; document: AxcutDocument }>();
		const newSave = deferred<{ success: true; document: AxcutDocument }>();
		const snapshots: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshots.push(document);
			return snapshots.length === 1 ? oldSave.promise : newSave.promise;
		});
		loadDocument(documentWithoutDimensions);
		const first = renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		first.unmount();

		act(() => {
			const current = useProjectStore.getState().document!;
			useProjectStore.getState().setDocument({
				...current,
				project: { ...current.project, title: "New mount edit" },
			});
		});
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2));

		await act(async () => {
			oldSave.resolve({ success: true, document: snapshots[0] });
			await oldSave.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "New mount edit" }, assets: [{ video: undefined }] },
			dirty: true,
		});

		await act(async () => {
			newSave.resolve({ success: true, document: snapshots[1] });
			await newSave.promise;
		});
		await waitFor(() =>
			expect(useProjectStore.getState().document?.assets[0].video).toMatchObject({
				width: 1920,
				height: 1080,
			}),
		);
		expect(snapshots[1]).toMatchObject({
			project: { title: "New mount edit" },
			assets: [{ video: { width: 1920, height: 1080 } }],
		});
	});

	it("does not duplicate an in-flight probe during StrictMode effect replay", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock.mockReturnValue(probe.promise);
		loadDocument(documentWithoutDimensions);
		renderStrictTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));
		await act(async () => Promise.resolve());
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			probe.resolve({ width: 1920, height: 1080 });
			await probe.promise;
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
	});

	it("leaves an asset that already has dimensions untouched", async () => {
		loadDocument(sampleDoc);
		renderTimeline();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline.updateClipSourceRange (Edit-clip modal)", () => {
	const anchoredZoom = (id: string, s: number, e: number) => ({
		id,
		startMs: s * 1000,
		endMs: e * 1000,
		clipId: "clip_a",
		sourceStartSec: s,
		sourceEndSec: e,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_keep", 2, 3), anchoredZoom("z_drop", 6, 8)],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shrinks the clip's timeline width to match the narrowed source window", async () => {
		const { result } = renderTimeline();
		// Trim the 10s clip down to its first 4s of source.
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 4);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4 });
		// The width followed the edit instead of keeping its stale 10s extent.
		expect(clip?.timelineStartSec).toBe(0);
		expect(clip?.timelineEndSec).toBe(4);
	});

	it("drops a pill sitting over the truncated tail and keeps the one that survives", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 4);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		// z_keep (source 2-3) stays; z_drop (source 6-8) is entirely past the new 4s end.
		expect(zooms.map((z) => z.id)).toEqual(["z_keep"]);
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 3,
			startMs: 2000,
			endMs: 3000,
		});
	});

	it("shortens a pill that straddles the new clip end to the surviving overlap", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_edge", 3, 7)],
			},
		});
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 5);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(zooms).toHaveLength(1);
		// 3-7 clamped to the [0,5] window → 3-5.
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 3,
			sourceEndSec: 5,
			startMs: 3000,
			endMs: 5000,
		});
	});
});

describe("useTimeline.addAnnotation", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("creates a text annotation carrying the localised default text", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addAnnotation();
		});
		const annotations = useProjectStore.getState().document?.annotations ?? [];
		expect(annotations).toHaveLength(1);
		// Real text, not an empty field. An empty annotation renders nothing at
		// all, so adding one used to change nothing on the canvas; the
		// inspector's placeholder is CSS ghost text that never reaches `content`
		// and therefore never reached the compositor. DEFAULT_LOCALE is `en`.
		expect(annotations[0]).toMatchObject({ type: "text", content: "Hello" });
		// Still auto-selected, so its inspector opens ready to be typed over.
		expect(result.current.selection).toEqual({
			kind: "annotation",
			id: (annotations[0] as { id: string }).id,
		});
	});
});

describe("useTimeline zoom modifiers (rotation + focus mode)", () => {
	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				// v5 clip anchor: clip_a draws source 0..10 at timeline 0..10, so the
				// 1000..3000ms ruler span is source 1..3 of that clip. `startMs`/`endMs`
				// stay as the derived cache. (The fixture used to carry a
				// `clipStartOffsetMs` that exists in no schema and no reader.)
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: docWithZoom,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sets a 3D rotation preset on the region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			id: "zoom_a",
			rotationPreset: "iso",
		});
	});

	it("clears the preset back to a flat frame", async () => {
		// "None" in the UI is the ABSENCE of a preset, not a fourth one: the schema field is
		// optional and the native side treats anything unrecognised as zero rotation.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", undefined);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].rotationPreset).toBeUndefined();
	});

	it("switches focus mode without disturbing the rotation preset", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomFocusMode("zoom_a", "auto");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			rotationPreset: "left",
			focusMode: "auto",
		});
	});
});

// Regression guard for the playhead-stutter fix. `currentTimeSec` is rewritten on
// every animation frame during playback, and `useTimeline()` is called by the editor
// shell — so subscribing to the playhead here re-rendered the entire editor (timeline,
// clips, waveforms, inspector) 60×/s, which is exactly what made the playhead itself
// stutter. The hook must read the playhead imperatively: zero re-renders per tick, but
// still the LIVE value at the moment an action fires.
describe("useTimeline is not re-rendered by playhead ticks", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
			currentTimeSec: 0,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not re-render across a second of 60 Hz playhead writes", () => {
		let renders = 0;
		renderHook(
			() => {
				renders++;
				return useTimeline();
			},
			{ wrapper: I18nProvider },
		);
		const baseline = renders;

		// One act() per write: a single batched act() would collapse all 60 into one
		// React pass and hide the very thing this asserts.
		for (let i = 1; i <= 60; i++) {
			act(() => {
				useProjectStore.getState().setCurrentTime(i / 60);
			});
		}

		expect(renders - baseline).toBe(0);
		expect(useProjectStore.getState().currentTimeSec).toBeCloseTo(1);
	});

	it("still anchors a new region at the live playhead", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom();
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 6200,
		});
	});

	// Pasting a copied trim is exactly this call: a trim carries no properties, so
	// all a copy holds is its length, and paste recreates one that long at the
	// playhead. Same primitive the toolbar's cut button uses.
	it("creates a trim of the requested length", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(3);
		});
		await act(async () => {
			await result.current.addTrim(1.25);
		});
		const trim = useProjectStore.getState().document?.timeline.trimRanges.at(-1);
		expect((trim?.endSec ?? 0) - (trim?.startSec ?? 0)).toBeCloseTo(1.25, 6);
	});

	// The timeline's toolbar passes a duration worth a fixed number of pixels at
	// the current zoom; every other entry point keeps the 2 s above.
	it("honours a caller-supplied duration", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom(0.4);
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 4600,
		});
	});
});

describe("useTimeline selection", () => {
	// A pill and a clip are one selection, not two. While both could be set at
	// once, copy/paste keyed off "is a clip selected?" and so acted on the clip
	// whatever the user had actually clicked.
	it("lets a clip and a pill cancel each other", () => {
		const { result } = renderTimeline();

		act(() => result.current.selectClip("clip_1"));
		expect(result.current.clipSelection).toBe("clip_1");

		act(() => result.current.selectRegion("zoom", "z1"));
		expect(result.current.selection).toMatchObject({ kind: "zoom", id: "z1" });
		expect(result.current.clipSelection).toBeNull();

		act(() => result.current.selectClip("clip_2"));
		expect(result.current.clipSelection).toBe("clip_2");
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);

		act(() => result.current.clearSelection());
		expect(result.current.selection).toBeNull();
		expect(result.current.clipSelection).toBeNull();
	});
});
