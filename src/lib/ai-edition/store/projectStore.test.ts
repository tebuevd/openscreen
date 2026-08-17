// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAsset as removeAssetFromDocument } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { type DocumentOperationToken, useProjectStore } from "./projectStore";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	delete: vi.fn(),
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
			delete: bridgeMocks.delete,
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

function withUpdatedAt(document: AxcutDocument, updatedAt: string): AxcutDocument {
	return { ...document, project: { ...document.project, updatedAt } };
}

function withTitle(document: AxcutDocument, title: string): AxcutDocument {
	return { ...document, project: { ...document.project, title } };
}

function withProject(document: AxcutDocument, id: string, title: string): AxcutDocument {
	return { ...document, project: { ...document.project, id, title } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
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

function operationToken(): DocumentOperationToken {
	const state = useProjectStore.getState();
	if (!state.projectId) throw new Error("Expected a loaded project");
	return {
		projectId: state.projectId,
		documentGeneration: state.documentGeneration,
		revision: state.revision,
	};
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

	it("rejects ordinary saves instead of resolving when no write can start", async () => {
		await expect(useProjectStore.getState().saveDocument(sampleDoc)).rejects.toThrow(
			"No project document is loaded",
		);
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		loadDocument();
		useProjectStore.setState({ status: "loading" });
		await expect(useProjectStore.getState().saveDocument(sampleDoc)).rejects.toThrow(
			"status is loading",
		);
		useProjectStore.setState({ status: "error", error: "reconciliation failed", dirty: true });
		await expect(useProjectStore.getState().saveDocument(sampleDoc)).rejects.toThrow(
			"status is error",
		);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("makes a same-id import authoritative over saves queued by the old generation", async () => {
		const oldSave = deferred<{ success: true; document: AxcutDocument }>();
		const importSave = deferred<{ success: true; document: AxcutDocument }>();
		const snapshots: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshots.push(document);
			return snapshots.length === 1 ? oldSave.promise : importSave.promise;
		});
		loadDocument();

		const firstSaving = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Old in-flight save" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const oldGeneration = useProjectStore.getState().documentGeneration;
		const queuedSaving = useProjectStore.getState().saveDocument({
			...useProjectStore.getState().document!,
			project: { ...sampleDoc.project, title: "Old queued save" },
		});
		const queuedRefusal = expect(queuedSaving).rejects.toThrow(
			"changed before its save could start",
		);
		const imported: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Imported A" },
		};

		const importing = useProjectStore.getState().importProject(imported);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		expect(snapshots[1].project.title).toBe("Imported A");
		expect(useProjectStore.getState()).toMatchObject({ status: "loading" });
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(oldGeneration);

		oldSave.resolve({ success: true, document: snapshots[0] });
		await firstSaving;
		await queuedRefusal;
		expect(bridgeMocks.save).toHaveBeenCalledTimes(2);

		importSave.resolve({ success: true, document: imported });
		await expect(importing).resolves.toBe(true);
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: { project: { title: "Imported A" } },
			status: "ready",
			dirty: false,
		});
	});

	it("reloads the current project when an import fails", async () => {
		bridgeMocks.save.mockResolvedValue({ success: false, error: "invalid import" });
		bridgeMocks.get.mockResolvedValue({ success: true, document: sampleDoc });
		loadDocument();
		const oldGeneration = useProjectStore.getState().documentGeneration;

		await expect(useProjectStore.getState().importProject(sampleDoc)).rejects.toThrow(
			"invalid import",
		);

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			status: "ready",
			error: null,
		});
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(oldGeneration);
		expect(bridgeMocks.get).toHaveBeenCalledWith("proj_test");
	});

	it("does not apply an import response after another project is opened", async () => {
		const pendingImport = deferred<{ success: true; document: AxcutDocument }>();
		bridgeMocks.save.mockReturnValue(pendingImport.promise);
		loadDocument();
		const imported: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Imported A" },
		};
		const importing = useProjectStore.getState().importProject(imported);

		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		bridgeMocks.get.mockResolvedValue({ success: true, document: projectB });
		await useProjectStore.getState().loadProject("proj_b");
		pendingImport.resolve({ success: true, document: imported });

		await expect(importing).resolves.toBe(false);
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_b",
			document: { project: { title: "Project B" } },
			status: "ready",
		});
	});

	it("invalidates an active project before deletion can race its queued saves", async () => {
		const oldSave = deferred<{ success: true; document: AxcutDocument }>();
		const deleting = deferred<{ success: true }>();
		let snapshot: AxcutDocument | null = null;
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshot = document;
			return oldSave.promise;
		});
		bridgeMocks.delete.mockReturnValue(deleting.promise);
		loadDocument();

		const firstSaving = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Old in-flight save" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const oldGeneration = useProjectStore.getState().documentGeneration;
		const queuedSaving = useProjectStore.getState().saveDocument({
			...useProjectStore.getState().document!,
			project: { ...sampleDoc.project, title: "Must not recreate" },
		});
		const queuedRefusal = expect(queuedSaving).rejects.toThrow(
			"changed before its save could start",
		);

		const deletion = useProjectStore.getState().deleteProject("proj_test");
		expect(bridgeMocks.delete).toHaveBeenCalledWith("proj_test");
		expect(useProjectStore.getState()).toMatchObject({ status: "loading" });
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(oldGeneration);

		oldSave.resolve({ success: true, document: snapshot! });
		await firstSaving;
		await queuedRefusal;
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);

		deleting.resolve({ success: true });
		await deletion;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			status: "idle",
		});
	});

	it("reloads an active project when deletion fails", async () => {
		bridgeMocks.delete.mockResolvedValue({ success: false, error: "permission denied" });
		bridgeMocks.get.mockResolvedValue({ success: true, document: sampleDoc });
		loadDocument();
		const oldGeneration = useProjectStore.getState().documentGeneration;

		await expect(useProjectStore.getState().deleteProject("proj_test")).rejects.toThrow(
			"permission denied",
		);

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			status: "ready",
			error: null,
		});
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(oldGeneration);
		expect(bridgeMocks.get).toHaveBeenCalledWith("proj_test");
	});

	it("does not clear a project opened while deletion is pending", async () => {
		const pendingDelete = deferred<{ success: true }>();
		bridgeMocks.delete.mockReturnValue(pendingDelete.promise);
		loadDocument();
		const deleting = useProjectStore.getState().deleteProject("proj_test");

		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		bridgeMocks.get.mockResolvedValue({ success: true, document: projectB });
		await useProjectStore.getState().loadProject("proj_b");
		pendingDelete.resolve({ success: true });
		await deleting;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_b",
			document: { project: { title: "Project B" } },
			status: "ready",
		});
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
		await expect(firstPromise).resolves.toMatchObject({
			status: "persisted-detached",
			appliedToCurrent: false,
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		expect(snapshots[1].project.title).toBe("Second edit");
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Second edit" } },
			dirty: true,
		});

		secondSave.resolve({ success: true, document: snapshots[1] });
		await expect(secondPromise).resolves.toMatchObject({
			status: "saved",
			appliedToCurrent: true,
		});
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

	it("atomically applies and persists a current full-document result once", async () => {
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		loadDocument();
		const expected = operationToken();
		const resultDocument: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Agent result" },
		};

		await expect(
			useProjectStore.getState().applyDocumentResult(expected, resultDocument),
		).resolves.toEqual({ success: true, status: "applied", appliedToCurrent: true });

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument);
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: { project: { title: "Agent result" } },
			dirty: false,
		});
	});

	it("reports a successful save as superseded when the current document changes in flight", async () => {
		const { clearHistory, undo } = await import("./undo");
		clearHistory();
		const pending = deferred<{ success: true; document: AxcutDocument }>();
		bridgeMocks.save.mockReturnValue(pending.promise);
		loadDocument();
		const expected = operationToken();
		const resultDocument: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Persisted agent result" },
		};
		bridgeMocks.get.mockResolvedValue({ success: true, document: resultDocument });
		const applying = useProjectStore.getState().applyDocumentResult(expected, resultDocument);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument));
		useProjectStore.getState().setDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Newer local edit" },
		});
		await Promise.resolve();

		pending.resolve({ success: true, document: resultDocument });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer local edit" } },
			dirty: true,
		});
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(undo()).toBe(false);
	});

	it("refuses a full-document result after the expected revision changes", async () => {
		loadDocument();
		const expected = operationToken();
		const edited: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Newer user edit" },
		};
		useProjectStore.getState().setDocument(edited);

		await expect(
			useProjectStore.getState().applyDocumentResult(expected, {
				...sampleDoc,
				project: { ...sampleDoc.project, title: "Stale agent result" },
			}),
		).resolves.toEqual({ success: false, status: "stale" });

		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer user edit" } },
			dirty: true,
		});
	});

	it("refuses a full-document result from an older same-project generation", async () => {
		loadDocument();
		const expected = operationToken();
		const reopened: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Reopened project" },
		};
		useProjectStore.getState().clear();
		loadDocument(reopened);

		await expect(
			useProjectStore.getState().applyDocumentResult(expected, {
				...sampleDoc,
				project: { ...sampleDoc.project, title: "Old generation result" },
			}),
		).resolves.toEqual({ success: false, status: "stale" });

		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document).toBe(reopened);
	});

	it("refuses a queued result when the revision changes before its serialized save", async () => {
		const firstSave = deferred<{ success: true; document: AxcutDocument }>();
		const snapshots: AxcutDocument[] = [];
		bridgeMocks.save.mockImplementation((document: AxcutDocument) => {
			snapshots.push(document);
			return snapshots.length === 1
				? firstSave.promise
				: Promise.resolve({ success: true as const, document });
		});
		loadDocument();
		const firstSaving = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Earlier queued save" },
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Queued agent result" },
		});
		const current = useProjectStore.getState().document!;
		useProjectStore.getState().setDocument({
			...current,
			project: { ...current.project, title: "Edit while result waits" },
		});

		firstSave.resolve({ success: true, document: snapshots[0] });
		await firstSaving;
		await expect(applying).resolves.toEqual({ success: false, status: "stale" });

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Edit while result waits" } },
			dirty: true,
		});
	});

	it("leaves memory and undo unchanged when a result save is authoritatively rejected", async () => {
		const { clearHistory, undo } = await import("./undo");
		clearHistory();
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		bridgeMocks.get.mockResolvedValue({ success: true, document: sampleDoc });
		loadDocument();

		await expect(
			useProjectStore.getState().applyDocumentResult(operationToken(), {
				...sampleDoc,
				project: { ...sampleDoc.project, title: "Rejected result" },
			}),
		).resolves.toEqual({ success: false, status: "diverged", error: "disk full" });

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.get).toHaveBeenCalledWith("proj_test");
		expect(useProjectStore.getState()).toMatchObject({ document: sampleDoc, dirty: false });
		expect(undo()).toBe(false);
	});

	it("adopts an authoritative result after a lost save response without losing undo", async () => {
		const { clearHistory, undo } = await import("./undo");
		clearHistory();
		const resultDocument: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Committed despite lost response" },
		};
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({
			success: true,
			document: {
				...resultDocument,
				project: { ...resultDocument.project, updatedAt: "2026-08-16T10:05:00.000Z" },
			},
		});
		loadDocument();

		await expect(
			useProjectStore.getState().applyDocumentResult(operationToken(), resultDocument),
		).resolves.toEqual({ success: true, status: "reconciled", appliedToCurrent: true });

		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Committed despite lost response" } },
			dirty: false,
		});
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
	});

	it("reports ambiguous persistence as superseded by a newer current document", async () => {
		const pending = deferred<{ success: true; document: AxcutDocument }>();
		const resultDocument: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Reconciled detached result" },
		};
		bridgeMocks.save.mockReturnValue(pending.promise);
		bridgeMocks.get.mockResolvedValue({ success: true, document: resultDocument });
		loadDocument();
		const applying = useProjectStore
			.getState()
			.applyDocumentResult(operationToken(), resultDocument);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(resultDocument));
		useProjectStore.getState().setDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Newer local edit" },
		});

		pending.reject(new Error("response lost"));
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Newer local edit" } },
			dirty: true,
		});
	});

	it("recognizes a persisted result after the same project reloads it authoritatively", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const reloading = deferred<{ success: true; document: AxcutDocument }>();
		const readback = deferred<{ success: true; document: AxcutDocument }>();
		const intended = withUpdatedAt(
			{
				...sampleDoc,
				project: { ...sampleDoc.project, title: "Persisted before reopen" },
			},
			"2026-08-16T10:01:00.000Z",
		);
		const reopened = withUpdatedAt(intended, "2026-08-16T10:02:00.000Z");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockReturnValueOnce(reloading.promise).mockReturnValueOnce(readback.promise);
		loadDocument();
		const expected = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(expected, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));

		const reloadPromise = useProjectStore.getState().loadProject(sampleDoc.project.id);
		saving.resolve({ success: true, document: intended });
		await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(2));
		reloading.resolve({ success: true, document: reopened });
		await reloadPromise;
		readback.resolve({ success: true, document: intended });

		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Persisted before reopen" } },
			status: "ready",
			dirty: false,
		});
		expect(useProjectStore.getState().documentGeneration).toBeGreaterThan(
			expected.documentGeneration,
		);
	});

	it("reconciles a lost save response after the same project reloads the intended document", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const reloading = deferred<{ success: true; document: AxcutDocument }>();
		const readback = deferred<{ success: true; document: AxcutDocument }>();
		const intended = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Reconciled before reopen" },
		};
		const reopened = withUpdatedAt(intended, "2026-08-16T10:03:00.000Z");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockReturnValueOnce(reloading.promise).mockReturnValueOnce(readback.promise);
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));

		const reloadPromise = useProjectStore.getState().loadProject(sampleDoc.project.id);
		saving.reject(new Error("response lost"));
		await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(2));
		reloading.resolve({ success: true, document: reopened });
		await reloadPromise;
		readback.resolve({ success: true, document: intended });

		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "Reconciled before reopen" } },
			status: "ready",
			dirty: false,
		});
	});

	it("recognizes an authoritative result while another project load retains its launch document", async () => {
		const { clearHistory, undo } = await import("./undo");
		clearHistory();
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const intended = withUpdatedAt(
			{
				...sampleDoc,
				project: { ...sampleDoc.project, title: "Persisted while B loads" },
			},
			"2026-08-16T10:04:00.000Z",
		);
		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: intended }),
		);
		loadDocument();
		const expected = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(expected, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));

		const loading = useProjectStore.getState().loadProject("proj_b");
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			loadingTargetProjectId: "proj_b",
			loadingRetainedProjectId: "proj_test",
			status: "loading",
		});
		saving.resolve({ success: true, document: intended });

		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			status: "loading",
		});
		expect(undo()).toBe(false);

		loadingProjectB.resolve({ success: true, document: projectB });
		await loading;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_b",
			document: projectB,
			loadingTargetProjectId: null,
			loadingRetainedProjectId: null,
			status: "ready",
			dirty: false,
		});
	});

	it("restores an authoritative retained result when the target load fails", async () => {
		const { clearHistory, undo } = await import("./undo");
		clearHistory();
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Reconciled while B loads");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: intended }),
		);
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loading = useProjectStore.getState().loadProject("proj_b");

		loadingProjectB.resolve({ success: false, error: "Project B unavailable" });
		await Promise.resolve();
		expect(useProjectStore.getState()).toMatchObject({ document: sampleDoc, status: "loading" });
		saving.reject(new Error("save response lost"));
		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		expect(undo()).toBe(false);

		await loading;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: intended,
			loadingTargetProjectId: null,
			loadingRetainedProjectId: null,
			status: "error",
			error: "Project B unavailable",
			dirty: false,
		});
		expect(undo()).toBe(false);
	});

	it("does not restore a retained result over an edit made while the target loads", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Persisted agent result");
		const edited = withTitle(sampleDoc, "Newer retained edit");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: intended }),
		);
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loading = useProjectStore.getState().loadProject("proj_b");
		useProjectStore.getState().setDocument(edited);

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		loadingProjectB.resolve({ success: false, error: "Project B unavailable" });
		await loading;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: edited,
			status: "error",
			dirty: true,
		});
	});

	it("does not restore a retained result over a same-id import", async () => {
		const agentSave = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const intended = withTitle(sampleDoc, "Persisted agent result");
		const imported = withTitle(sampleDoc, "Imported replacement");
		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		bridgeMocks.save.mockImplementation((document: AxcutDocument) =>
			document.project.title === imported.project.title
				? Promise.resolve({ success: true as const, document: imported })
				: agentSave.promise,
		);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: imported }),
		);
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loading = useProjectStore.getState().loadProject("proj_b");
		await expect(useProjectStore.getState().importProject(imported)).resolves.toBe(true);

		agentSave.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		loadingProjectB.resolve({ success: true, document: projectB });
		await loading;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: imported,
			status: "ready",
			dirty: false,
		});
	});

	it("rejects a detached result when authoritative disk content diverges", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const intended = withTitle(sampleDoc, "Intended agent result");
		const authoritative = withTitle(sampleDoc, "Different disk document");
		const projectB: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_b", title: "Project B" },
		};
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) =>
			projectId === "proj_b"
				? loadingProjectB.promise
				: Promise.resolve({ success: true as const, document: authoritative }),
		);
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loading = useProjectStore.getState().loadProject("proj_b");

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		expect(useProjectStore.getState()).toMatchObject({ document: sampleDoc, status: "loading" });

		loadingProjectB.resolve({ success: true, document: projectB });
		await loading;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_b",
			document: projectB,
			status: "ready",
		});
	});

	it.each([
		"before",
		"after",
	] as const)("keeps one retained origin when older B succeeds %s latest C", async (olderTiming) => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectC = deferred<{ success: true; document: AxcutDocument }>();
		const intended = withTitle(sampleDoc, "Persisted while B and C load");
		const projectB = withProject(sampleDoc, "proj_b", "Project B");
		const projectC = withProject(sampleDoc, "proj_c", "Project C");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			if (projectId === "proj_d") {
				return Promise.resolve({ success: false as const, error: "Project D unavailable" });
			}
			return Promise.resolve({ success: true as const, document: intended });
		});
		loadDocument();
		const expected = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(expected, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));

		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const afterB = useProjectStore.getState();
		const loadingBGeneration = afterB.documentGeneration;
		const loadingBToken = afterB.loadingRequestToken;
		const loadingC = useProjectStore.getState().loadProject("proj_c");
		const afterC = useProjectStore.getState();
		expect(afterC).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			documentGeneration: loadingBGeneration,
			loadingTargetProjectId: "proj_c",
			loadingRetainedProjectId: sampleDoc.project.id,
			loadingRetainedDocumentGeneration: expected.documentGeneration,
			loadingRetainedRevision: expected.revision,
			status: "loading",
		});
		expect(afterC.loadingRequestToken).toBeGreaterThan(loadingBToken ?? 0);

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);

		if (olderTiming === "before") {
			loadingProjectB.resolve({ success: true, document: projectB });
			await loadingB;
			expect(useProjectStore.getState()).toMatchObject({
				projectId: sampleDoc.project.id,
				loadingTargetProjectId: "proj_c",
				status: "loading",
			});
		}

		loadingProjectC.resolve({ success: true, document: projectC });
		await loadingC;
		if (olderTiming === "after") {
			loadingProjectB.resolve({ success: true, document: projectB });
			await loadingB;
		}
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_c",
			document: projectC,
			loadingRequestToken: null,
			loadingTargetProjectId: null,
			loadingRetainedProjectId: null,
			loadingRetainedDocumentGeneration: null,
			loadingRetainedRevision: null,
			status: "ready",
			dirty: false,
		});

		await useProjectStore.getState().loadProject("proj_d");
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_c",
			document: projectC,
			status: "error",
			error: "Project D unavailable",
		});
	});

	it.each([
		{ olderResult: "success", olderTiming: "before" },
		{ olderResult: "failure", olderTiming: "before" },
		{ olderResult: "success", olderTiming: "after" },
		{ olderResult: "failure", olderTiming: "after" },
	] as const)("restores authoritative A when B $olderResult resolves $olderTiming failing C", async ({
		olderResult,
		olderTiming,
	}) => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<
			{ success: true; document: AxcutDocument } | { success: false; error: string }
		>();
		const loadingProjectC = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Authoritative retained A");
		const projectB = withProject(sampleDoc, "proj_b", "Ignored Project B");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			return Promise.resolve({ success: true as const, document: intended });
		});
		loadDocument();
		const expected = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(expected, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const loadingC = useProjectStore.getState().loadProject("proj_c");
		const cToken = useProjectStore.getState().loadingRequestToken;
		const resolveOlder = () =>
			loadingProjectB.resolve(
				olderResult === "success"
					? { success: true, document: projectB }
					: { success: false, error: "Project B unavailable" },
			);

		if (olderTiming === "before") {
			resolveOlder();
			await loadingB;
			expect(useProjectStore.getState()).toMatchObject({
				loadingRequestToken: cToken,
				loadingTargetProjectId: "proj_c",
				status: "loading",
			});
		}

		loadingProjectC.resolve({ success: false, error: "Project C unavailable" });
		await Promise.resolve();
		if (olderTiming === "after") {
			resolveOlder();
			await loadingB;
			expect(useProjectStore.getState()).toMatchObject({
				loadingRequestToken: cToken,
				status: "loading",
			});
		}

		saving.reject(new Error("save response lost"));
		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		await loadingC;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: intended,
			loadingRequestToken: null,
			loadingTargetProjectId: null,
			loadingRetainedProjectId: null,
			status: "error",
			error: "Project C unavailable",
			dirty: false,
		});
	});

	it("supersedes an older failed load already waiting on the retained save queue", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: false; error: string }>();
		const loadingProjectC = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Authority after two failed loads");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			return Promise.resolve({ success: true as const, document: intended });
		});
		loadDocument();
		const origin = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(origin, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const loadingGeneration = useProjectStore.getState().documentGeneration;

		loadingProjectB.resolve({ success: false, error: "Project B unavailable" });
		await Promise.resolve();
		expect(useProjectStore.getState()).toMatchObject({
			loadingTargetProjectId: "proj_b",
			status: "loading",
		});
		const loadingC = useProjectStore.getState().loadProject("proj_c");
		expect(useProjectStore.getState()).toMatchObject({
			documentGeneration: loadingGeneration,
			loadingTargetProjectId: "proj_c",
			loadingRetainedDocumentGeneration: origin.documentGeneration,
			status: "loading",
		});
		loadingProjectC.resolve({ success: false, error: "Project C unavailable" });

		saving.reject(new Error("save response lost"));
		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		await Promise.all([loadingB, loadingC]);
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: intended,
			loadingRequestToken: null,
			status: "error",
			error: "Project C unavailable",
			dirty: false,
		});
	});

	it.each([
		"success",
		"failure",
	] as const)("preserves the retained origin across superseding same-id loads ending in %s", async (latestResult) => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingOlderA = deferred<{ success: true; document: AxcutDocument }>();
		const loadingLatestA = deferred<
			{ success: true; document: AxcutDocument } | { success: false; error: string }
		>();
		const intended = withTitle(sampleDoc, "Persisted same-id authority");
		const latestA = withUpdatedAt(intended, "2026-08-17T10:00:00.000Z");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get
			.mockReturnValueOnce(loadingOlderA.promise)
			.mockReturnValueOnce(loadingLatestA.promise)
			.mockResolvedValue({ success: true, document: intended });
		loadDocument();
		const expected = operationToken();
		const applying = useProjectStore.getState().applyDocumentResult(expected, intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingOlder = useProjectStore.getState().loadProject(sampleDoc.project.id);
		const firstLoadingGeneration = useProjectStore.getState().documentGeneration;
		const loadingLatest = useProjectStore.getState().loadProject(sampleDoc.project.id);
		expect(useProjectStore.getState()).toMatchObject({
			documentGeneration: firstLoadingGeneration,
			loadingRetainedDocumentGeneration: expected.documentGeneration,
			loadingRetainedRevision: expected.revision,
		});

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({
			success: true,
			status: "authoritative-detached",
			appliedToCurrent: false,
		});
		loadingLatestA.resolve(
			latestResult === "success"
				? { success: true, document: latestA }
				: { success: false, error: "Latest same-id load failed" },
		);
		await loadingLatest;
		loadingOlderA.resolve({
			success: true,
			document: withTitle(sampleDoc, "Ignored older same-id load"),
		});
		await loadingOlder;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: latestResult === "success" ? latestA : intended,
			status: latestResult === "success" ? "ready" : "error",
			dirty: false,
		});
	});

	it("keeps one origin and loading generation across an arbitrary superseding chain", async () => {
		const targetIds = ["proj_b", "proj_c", "proj_d", "proj_e"];
		const pending = targetIds.map(() =>
			deferred<{ success: true; document: AxcutDocument } | { success: false; error: string }>(),
		);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			const index = targetIds.indexOf(projectId);
			if (index < 0) throw new Error(`Unexpected project ${projectId}`);
			return pending[index].promise;
		});
		loadDocument();
		const origin = operationToken();
		const loads: Promise<void>[] = [];
		const tokens: number[] = [];
		let loadingGeneration: number | null = null;
		for (const projectId of targetIds) {
			loads.push(useProjectStore.getState().loadProject(projectId));
			const state = useProjectStore.getState();
			loadingGeneration ??= state.documentGeneration;
			expect(state).toMatchObject({
				projectId: sampleDoc.project.id,
				document: sampleDoc,
				documentGeneration: loadingGeneration,
				loadingTargetProjectId: projectId,
				loadingRetainedProjectId: sampleDoc.project.id,
				loadingRetainedDocumentGeneration: origin.documentGeneration,
				loadingRetainedRevision: origin.revision,
				status: "loading",
			});
			tokens.push(state.loadingRequestToken ?? -1);
		}
		expect(new Set(tokens).size).toBe(targetIds.length);

		pending[0].resolve({ success: false, error: "Ignored B failure" });
		pending[1].resolve({ success: false, error: "Ignored C failure" });
		await Promise.all(loads.slice(0, 2));
		expect(useProjectStore.getState()).toMatchObject({
			loadingRequestToken: tokens.at(-1),
			loadingTargetProjectId: "proj_e",
			status: "loading",
		});

		pending[3].resolve({ success: false, error: "Latest E failure" });
		await loads[3];
		pending[2].resolve({
			success: true,
			document: withProject(sampleDoc, "proj_d", "Ignored Project D"),
		});
		await loads[2];
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			loadingRequestToken: null,
			status: "error",
			error: "Latest E failure",
		});
	});

	it("does not restore overlapping retained authority over a divergent A edit", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectC = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Persisted agent result");
		const edited = withTitle(sampleDoc, "Newer A edit during B and C");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			return Promise.resolve({ success: true as const, document: intended });
		});
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const loadingC = useProjectStore.getState().loadProject("proj_c");
		useProjectStore.getState().setDocument(edited);

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		loadingProjectC.resolve({ success: false, error: "Project C unavailable" });
		await loadingC;
		loadingProjectB.resolve({
			success: true,
			document: withProject(sampleDoc, "proj_b", "Ignored Project B"),
		});
		await loadingB;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: edited,
			loadingRequestToken: null,
			status: "error",
			dirty: true,
		});
	});

	it("lets a same-id A import invalidate an overlapping load handoff", async () => {
		const agentSave = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectC = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Persisted agent result");
		const imported = withTitle(sampleDoc, "Imported A replacement");
		bridgeMocks.save.mockImplementation((document: AxcutDocument) =>
			document.project.title === imported.project.title
				? Promise.resolve({ success: true as const, document: imported })
				: agentSave.promise,
		);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			return Promise.resolve({ success: true as const, document: imported });
		});
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const loadingC = useProjectStore.getState().loadProject("proj_c");
		await expect(useProjectStore.getState().importProject(imported)).resolves.toBe(true);

		loadingProjectC.resolve({ success: false, error: "Ignored C failure" });
		loadingProjectB.resolve({
			success: true,
			document: withProject(sampleDoc, "proj_b", "Ignored Project B"),
		});
		await Promise.all([loadingB, loadingC]);
		agentSave.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });

		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: imported,
			loadingRequestToken: null,
			status: "ready",
			dirty: false,
		});
	});

	it("does not restore overlapping A authority when disk content diverges", async () => {
		const saving = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectB = deferred<{ success: true; document: AxcutDocument }>();
		const loadingProjectC = deferred<{ success: false; error: string }>();
		const intended = withTitle(sampleDoc, "Intended agent result");
		const authoritative = withTitle(sampleDoc, "Different disk document");
		bridgeMocks.save.mockReturnValue(saving.promise);
		bridgeMocks.get.mockImplementation((projectId: string) => {
			if (projectId === "proj_b") return loadingProjectB.promise;
			if (projectId === "proj_c") return loadingProjectC.promise;
			return Promise.resolve({ success: true as const, document: authoritative });
		});
		loadDocument();
		const applying = useProjectStore.getState().applyDocumentResult(operationToken(), intended);
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledWith(intended));
		const loadingB = useProjectStore.getState().loadProject("proj_b");
		const loadingC = useProjectStore.getState().loadProject("proj_c");

		saving.resolve({ success: true, document: intended });
		await expect(applying).resolves.toEqual({ success: false, status: "superseded" });
		loadingProjectC.resolve({ success: false, error: "Project C unavailable" });
		await loadingC;
		loadingProjectB.resolve({
			success: true,
			document: withProject(sampleDoc, "proj_b", "Ignored Project B"),
		});
		await loadingB;

		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			loadingRequestToken: null,
			status: "error",
			error: "Project C unavailable",
		});
	});

	it("adopts a differing authoritative document and clears incompatible undo history", async () => {
		const { clearHistory, pushHistory, undo } = await import("./undo");
		clearHistory();
		const intended = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Intended result" },
		};
		const authoritative = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "External authoritative result" },
		};
		bridgeMocks.save.mockRejectedValue(new Error("response lost"));
		bridgeMocks.get.mockResolvedValue({ success: true, document: authoritative });
		loadDocument();
		pushHistory({ projectId: "proj_test", doc: structuredClone(sampleDoc) });

		await expect(
			useProjectStore.getState().applyDocumentResult(operationToken(), intended),
		).resolves.toEqual({ success: false, status: "diverged", error: "response lost" });

		expect(useProjectStore.getState()).toMatchObject({
			document: { project: { title: "External authoritative result" } },
			dirty: false,
		});
		expect(undo()).toBe(false);
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
