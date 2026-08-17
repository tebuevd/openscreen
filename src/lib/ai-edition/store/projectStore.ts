import { create } from "zustand";
import { nativeBridgeClient } from "@/native/client";
import { documentsHaveEquivalentSaveContent } from "../document/equivalence";
import {
	type Interval,
	removeAsset as removeAssetFromDocument,
	replaceTimeline as replaceTimelineOp,
	restoreFullTimeline as restoreFullTimelineOp,
} from "../document/timeline";
import { type AxcutAsset, type AxcutDocument, documentSchema } from "../schema";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

export type ProjectStatus = "idle" | "loading" | "ready" | "error";

export interface DocumentOperationToken {
	readonly projectId: string;
	readonly documentGeneration: number;
	readonly revision: number;
}

export type DocumentResultApplyOutcome =
	| {
			success: true;
			status: "applied" | "reconciled" | "authoritative-detached";
			appliedToCurrent: boolean;
	  }
	| { success: false; status: "stale" }
	| { success: false; status: "superseded" }
	| { success: false; status: "diverged"; error: string };

// Every resolved outcome represents a validated disk write. A detached write is
// not enough for destructive navigation because a newer generation/revision remains in memory.
export type DocumentSaveOutcome =
	| {
			status: "saved";
			appliedToCurrent: true;
			projectId: string;
			documentGeneration: number;
			revision: number;
	  }
	| {
			status: "persisted-detached";
			appliedToCurrent: false;
			projectId: string;
			documentGeneration: number;
			revision: number;
	  };

export class DocumentSaveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentSaveError";
	}
}

// Monotonic identity for one loaded document instance. A project can be opened,
// replaced, then opened again with the same id; project id alone cannot distinguish them.
let nextDocumentGeneration = 0;
const saveQueues = new Map<number, Promise<void>>();

function allocateDocumentGeneration(): number {
	return ++nextDocumentGeneration;
}

function enqueueSave<T>(generation: number, task: () => Promise<T>): Promise<T> {
	const tail = saveQueues.get(generation) ?? Promise.resolve();
	const run = tail.then(task, task);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	saveQueues.set(generation, settled);
	void settled.then(() => {
		if (saveQueues.get(generation) === settled) saveQueues.delete(generation);
	});
	return run;
}

async function persistDocument(document: AxcutDocument): Promise<AxcutDocument> {
	const result = await nativeBridgeClient.aiEdition.save(document);
	if (!result.success || !result.document) {
		throw new Error(result.error ?? "Failed to save project");
	}
	return parseDocument(result.document);
}

function assertMatchingSaveResponse(intended: AxcutDocument, persisted: AxcutDocument): void {
	if (persisted.project.id !== intended.project.id) {
		throw new DocumentSaveError(
			`Saved project response belongs to ${persisted.project.id}, expected ${intended.project.id}`,
		);
	}
	if (!documentsHaveEquivalentSaveContent(persisted, intended)) {
		throw new DocumentSaveError("Saved project response differs from the requested document");
	}
}

export interface ProjectState {
	projectId: string | null;
	document: AxcutDocument | null;
	/** Changes for every load/create/clear, including reopening the same project id. */
	documentGeneration: number;
	revision: number;
	status: ProjectStatus;
	error: string | null;
	sourceDurationSec: number;
	currentTimeSec: number;
	/** Single source of truth for "is the timeline transport playing?" — previously
	 *  duplicated as separate local state in NewEditorShell AND VirtualPreview, each
	 *  independently wired to the same raw <video> DOM events, which let one advance
	 *  a clip boundary while the other unconditionally stopped playback. */
	playing: boolean;
	/** True when the in-memory document has local changes that haven't been written to disk yet. */
	dirty: boolean;
	/** Timestamp of the most recent successful save (used by the titlebar indicator). */
	lastSavedAt: Date | null;

	loadProject: (projectId: string) => Promise<void>;
	createProject: (title: string) => Promise<AxcutDocument>;
	importProject: (document: AxcutDocument) => Promise<boolean>;
	deleteProject: (projectId: string) => Promise<void>;
	refresh: () => Promise<void>;
	addAsset: (path: string, label?: string) => Promise<AxcutAsset | null>;
	removeAsset: (assetId: string) => Promise<void>;
	saveDocument: (document: AxcutDocument) => Promise<DocumentSaveOutcome>;
	saveRecoveryDocument: () => Promise<Extract<DocumentSaveOutcome, { appliedToCurrent: true }>>;
	saveDocumentUpdate: (
		documentGeneration: number,
		update: (document: AxcutDocument) => AxcutDocument | null,
		isCurrent?: () => boolean,
	) => Promise<boolean>;
	applyDocumentResult: (
		expected: DocumentOperationToken,
		document: AxcutDocument,
	) => Promise<DocumentResultApplyOutcome>;
	setDocument: (document: AxcutDocument) => void;
	replaceTimeline: (intervals: Interval[], reason: string) => Promise<void>;
	restoreFullTimeline: () => Promise<void>;
	setSourceDuration: (sec: number) => void;
	setCurrentTime: (sec: number) => void;
	setPlaying: (playing: boolean) => void;
	markClean: () => void;
	clear: () => void;
}

function parseDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

function mergeAddedAsset(
	document: AxcutDocument,
	persisted: AxcutDocument,
	addedAsset: AxcutAsset,
): AxcutDocument {
	const existing = document.assets.find((asset) => asset.id === addedAsset.id);
	return {
		...document,
		assets: existing
			? document.assets.map((asset) =>
					asset.id === addedAsset.id ? { ...addedAsset, ...asset } : asset,
				)
			: [...document.assets, addedAsset],
		project: {
			...document.project,
			primaryAssetId: document.project.primaryAssetId ?? persisted.project.primaryAssetId,
			updatedAt: persisted.project.updatedAt,
		},
	};
}

interface LifecycleRecoveryOptions {
	documentGeneration: number;
	activeProjectId: string | null;
	targetProjectId: string;
	fallbackDocument: AxcutDocument | null;
	operationError: unknown;
	clearIfMissing: boolean;
}

async function reconcileLifecycleFailure(
	get: () => ProjectState,
	set: (partial: Partial<ProjectState>) => void,
	options: LifecycleRecoveryOptions,
): Promise<void> {
	const isCurrentOperation = () => {
		const current = get();
		return (
			current.documentGeneration === options.documentGeneration &&
			current.projectId === options.activeProjectId
		);
	};

	if (!isCurrentOperation()) return;
	try {
		const result = await nativeBridgeClient.aiEdition.get(options.targetProjectId);
		if (!isCurrentOperation()) return;
		if (!result.success || !result.document) {
			if (options.clearIfMissing && result.notFound) {
				get().clear();
				return;
			}
			throw new Error(result.error ?? "Failed to reload project after lifecycle failure");
		}

		const document = parseDocument(result.document);
		if (document.project.id !== options.targetProjectId) {
			throw new Error(
				`Reloaded project ${document.project.id}, expected ${options.targetProjectId}`,
			);
		}
		if (!isCurrentOperation()) return;
		set({
			projectId: document.project.id,
			document,
			revision: get().revision + 1,
			status: "ready",
			error: null,
			dirty: false,
			lastSavedAt: new Date(),
		});
		void import("./undo").then(({ clearHistory }) => clearHistory());
	} catch (reconciliationError) {
		if (!isCurrentOperation()) return;
		const operationMessage =
			options.operationError instanceof Error
				? options.operationError.message
				: String(options.operationError);
		const reconciliationMessage =
			reconciliationError instanceof Error
				? reconciliationError.message
				: String(reconciliationError);
		set({
			projectId: options.fallbackDocument?.project.id ?? options.activeProjectId,
			document: options.fallbackDocument,
			revision: get().revision + 1,
			status: "error",
			error: `${operationMessage} Recovery failed: ${reconciliationMessage}`,
			dirty: options.fallbackDocument !== null,
		});
	}
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projectId: null,
	document: null,
	documentGeneration: 0,
	revision: 0,
	status: "idle",
	error: null,
	sourceDurationSec: 0,
	currentTimeSec: 0,
	playing: false,
	dirty: false,
	lastSavedAt: null,

	async loadProject(projectId) {
		const documentGeneration = allocateDocumentGeneration();
		set({ documentGeneration, status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.get(projectId);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to load project");
			}
			const document = parseDocument(result.document);
			if (get().documentGeneration !== documentGeneration) return;
			set({
				projectId,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			void import("./undo").then(({ clearHistory }) => clearHistory());
		} catch (error) {
			if (get().documentGeneration !== documentGeneration) return;
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async createProject(title) {
		const documentGeneration = allocateDocumentGeneration();
		set({ documentGeneration, status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.create(title);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to create project");
			}
			const document = parseDocument(result.document);
			if (get().documentGeneration !== documentGeneration) return document;
			set({
				projectId: document.project.id,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			void import("./undo").then(({ clearHistory }) => clearHistory());
			return document;
		} catch (error) {
			if (get().documentGeneration === documentGeneration) {
				set({
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	},

	async importProject(document) {
		const imported = parseDocument(document);
		const before = get();
		const documentGeneration = allocateDocumentGeneration();
		set({ documentGeneration, status: "loading", error: null });
		try {
			const persisted = await persistDocument(imported);
			if (get().documentGeneration !== documentGeneration) return false;
			set({
				projectId: persisted.project.id,
				document: persisted,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			void import("./undo").then(({ clearHistory }) => clearHistory());
			return true;
		} catch (error) {
			await reconcileLifecycleFailure(get, set, {
				documentGeneration,
				activeProjectId: before.projectId,
				targetProjectId: imported.project.id,
				fallbackDocument: before.document ?? imported,
				operationError: error,
				clearIfMissing: false,
			});
			throw error;
		}
	},

	async deleteProject(projectId) {
		const before = get();
		const deletingActiveProject = before.projectId === projectId;
		const documentGeneration = deletingActiveProject ? allocateDocumentGeneration() : null;
		if (documentGeneration !== null) {
			// Invalidate first so saves waiting in the old generation never dispatch
			// after the main process has queued this deletion.
			set({ documentGeneration, status: "loading", error: null });
		}

		try {
			const result = await nativeBridgeClient.aiEdition.delete(projectId);
			if (!result.success) throw new Error(result.error ?? "Failed to delete project");
		} catch (error) {
			if (documentGeneration !== null) {
				await reconcileLifecycleFailure(get, set, {
					documentGeneration,
					activeProjectId: before.projectId,
					targetProjectId: projectId,
					fallbackDocument: before.document,
					operationError: error,
					clearIfMissing: true,
				});
			}
			throw error;
		}

		if (
			documentGeneration !== null &&
			get().documentGeneration === documentGeneration &&
			get().projectId === projectId
		) {
			get().clear();
		}
	},

	async refresh() {
		const { projectId } = get();
		if (!projectId) return;
		await get().loadProject(projectId);
	},

	async addAsset(path, label) {
		const { projectId, documentGeneration, status } = get();
		if (!projectId) throw new Error("No project loaded");
		if (status !== "ready") return null;
		const addedAsset = await enqueueSave(documentGeneration, async () => {
			const before = get();
			if (
				before.documentGeneration !== documentGeneration ||
				before.status !== "ready" ||
				before.projectId !== projectId ||
				!before.document
			) {
				return null;
			}
			const revision = before.revision;
			const result = await nativeBridgeClient.aiEdition.addAsset(projectId, path, label);
			const persisted = parseDocument(result.document);
			const added =
				persisted.assets.find((asset) => asset.id === result.assetId) ??
				persisted.assets.find(
					(asset) => asset.originalPath === path && (label ? asset.label === label : true),
				) ??
				persisted.assets.at(-1) ??
				null;
			const current = get();
			if (
				!added ||
				current.documentGeneration !== documentGeneration ||
				current.projectId !== projectId ||
				!current.document
			) {
				return null;
			}
			const mustMerge = before.dirty || current.revision !== revision;
			set({
				document: mustMerge ? mergeAddedAsset(current.document, persisted, added) : persisted,
				revision: current.revision + 1,
				dirty: mustMerge ? current.dirty || before.dirty : false,
				lastSavedAt: new Date(),
			});
			return added;
		});
		if (!addedAsset) return null;

		// P4 — auto-link the camera track from the recording-links registry (or
		// its legacy sidecar) for EVERY asset added, not just the first one in
		// the project: a project can hold multiple recordings, each with its
		// own camera (or none). The link is stored on the asset itself, not a
		// document-global field, so it follows the right clip in the timeline.
		// The camera DSL is read-only — cuts/zoom/speed live on the main
		// timeline and apply to the camera via the shared source-time
		// progression.
		if (addedAsset && window.electronAPI?.findRecordingCamera) {
			try {
				const camera = await window.electronAPI.findRecordingCamera(addedAsset.originalPath);
				if (get().documentGeneration !== documentGeneration || get().projectId !== projectId) {
					return null;
				}
				if (camera.success && camera.webcamVideoPath) {
					const linked = {
						sourcePath: camera.webcamVideoPath,
						startMs: 0,
						// ROUNDED, because `cameraTrackSchema` requires an integer and
						// the native capture paths measure this offset with
						// `performance.now()`, whose resolution is 100 µs — so roughly
						// nine recordings in ten produced something like -192.8 here.
						// `parseDocument` below then threw, the catch treated it as a
						// lookup failure, and the camera was dropped from a recording
						// that had one: the editor showed the screen video in the
						// camera's place. Sub-millisecond precision is meaningless for
						// a frame offset (a 60 fps frame is 16.7 ms), so rounding costs
						// nothing. Recordings already on disk carry the fractional
						// value in their session manifest, which is why this rounds on
						// the way IN rather than only at the recorder.
						offsetMs: Math.round(camera.offsetMs ?? 0),
						visible: true,
					};
					await get().saveDocumentUpdate(
						documentGeneration,
						(document) => {
							const asset = document.assets.find((candidate) => candidate.id === addedAsset.id);
							if (!asset || asset.originalPath !== addedAsset.originalPath) return null;
							return {
								...document,
								assets: document.assets.map((candidate) =>
									candidate.id === addedAsset.id
										? { ...candidate, cameraTrack: linked }
										: candidate,
								),
							};
						},
						() => {
							const current = get();
							const asset = current.document?.assets.find(
								(candidate) => candidate.id === addedAsset.id,
							);
							return (
								current.documentGeneration === documentGeneration &&
								current.projectId === projectId &&
								asset?.originalPath === addedAsset.originalPath
							);
						},
					);
				}
				// success:false just means no camera was found for this asset —
				// the normal case for a plain imported video. Nothing to surface.
			} catch (err) {
				// An actual lookup failure (not "no camera found") — worth surfacing.
				// Logged as well as toasted: a toast is gone in five seconds, and the
				// symptom this produces (a recording that silently loses its camera)
				// is reported from the editor, long after.
				if (get().documentGeneration !== documentGeneration || get().projectId !== projectId) {
					return null;
				}
				console.warn("[project] camera auto-link failed:", err);
				const name = addedAsset.originalPath.split(/[\\/]/).pop() ?? addedAsset.originalPath;
				void import("sonner").then(({ toast }) =>
					toast.error(`Could not check for a camera recording near ${name}`, {
						description: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		}
		if (get().documentGeneration !== documentGeneration || get().projectId !== projectId) {
			return null;
		}
		return get().document?.assets.find((asset) => asset.id === addedAsset.id) ?? addedAsset;
	},

	async removeAsset(assetId) {
		const { projectId, documentGeneration, status } = get();
		if (!projectId) throw new Error("No project loaded");
		if (status !== "ready") return;
		await enqueueSave(documentGeneration, async () => {
			const before = get();
			if (
				before.documentGeneration !== documentGeneration ||
				before.status !== "ready" ||
				before.projectId !== projectId ||
				!before.document
			) {
				return;
			}
			const revision = before.revision;
			const result = await nativeBridgeClient.aiEdition.removeAsset(projectId, assetId);
			const persisted = parseDocument(result.document);
			const current = get();
			if (
				current.documentGeneration !== documentGeneration ||
				current.projectId !== projectId ||
				!current.document
			) {
				return;
			}
			const mustMerge = before.dirty || current.revision !== revision;
			const merged = removeAssetFromDocument(current.document, assetId);
			set({
				document: mustMerge
					? {
							...merged,
							project: { ...merged.project, updatedAt: persisted.project.updatedAt },
						}
					: persisted,
				revision: current.revision + 1,
				dirty: mustMerge ? current.dirty || before.dirty : false,
				lastSavedAt: new Date(),
			});
		});
	},

	async saveDocument(document) {
		const state = get();
		const documentGeneration = state.documentGeneration;
		if (!state.projectId || !state.document) {
			throw new DocumentSaveError("No project document is loaded");
		}
		if (state.status !== "ready") {
			throw new DocumentSaveError(`Cannot save a project while its status is ${state.status}`);
		}
		if (
			state.projectId !== document.project.id ||
			state.document.project.id !== document.project.id
		) {
			throw new DocumentSaveError("Cannot save a document that is not the active project");
		}

		// Publish direct snapshot mutations before waiting. Callers that already used
		// setDocument pass the same object and do not create a second revision.
		if (state.document !== document) {
			set({ document, revision: state.revision + 1, dirty: true });
		}

		return enqueueSave(documentGeneration, async () => {
			const before = get();
			if (
				before.documentGeneration !== documentGeneration ||
				before.status !== "ready" ||
				before.projectId !== document.project.id ||
				!before.document
			) {
				throw new DocumentSaveError("The project changed before its save could start");
			}
			const revision = before.revision;
			const intended = parseDocument(structuredClone(before.document));
			const parsed = await persistDocument(intended);
			assertMatchingSaveResponse(intended, parsed);
			const current = get();
			if (
				current.documentGeneration !== documentGeneration ||
				current.projectId !== document.project.id ||
				current.revision !== revision ||
				current.status !== "ready" ||
				!current.document ||
				!documentsHaveEquivalentSaveContent(current.document, intended)
			) {
				return {
					status: "persisted-detached",
					appliedToCurrent: false,
					projectId: intended.project.id,
					documentGeneration,
					revision,
				};
			}
			const savedRevision = revision + 1;
			set({
				document: parsed,
				revision: savedRevision,
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return {
				status: "saved",
				appliedToCurrent: true,
				projectId: intended.project.id,
				documentGeneration,
				revision: savedRevision,
			};
		});
	},

	async saveRecoveryDocument() {
		const state = get();
		if (!state.projectId || !state.document) {
			throw new DocumentSaveError("No recovery document is loaded");
		}
		if (state.status !== "error" || !state.dirty) {
			throw new DocumentSaveError("The active project is not a dirty recovery document");
		}
		if (state.document.project.id !== state.projectId) {
			throw new DocumentSaveError("The recovery document is not the active project");
		}

		const projectId = state.projectId;
		const documentGeneration = state.documentGeneration;
		const revision = state.revision;
		const intended = parseDocument(structuredClone(state.document));
		return enqueueSave(documentGeneration, async () => {
			const before = get();
			if (
				before.documentGeneration !== documentGeneration ||
				before.revision !== revision ||
				before.projectId !== projectId ||
				before.status !== "error" ||
				!before.dirty ||
				!before.document ||
				!documentsHaveEquivalentSaveContent(before.document, intended)
			) {
				throw new DocumentSaveError("The recovery document changed before its save could start");
			}

			const parsed = await persistDocument(intended);
			assertMatchingSaveResponse(intended, parsed);
			const current = get();
			if (
				current.documentGeneration !== documentGeneration ||
				current.revision !== revision ||
				current.projectId !== projectId ||
				current.status !== "error" ||
				!current.dirty ||
				!current.document ||
				!documentsHaveEquivalentSaveContent(current.document, intended)
			) {
				throw new DocumentSaveError("The recovery document changed while it was being saved");
			}

			const savedRevision = revision + 1;
			set({
				document: parsed,
				revision: savedRevision,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return {
				status: "saved",
				appliedToCurrent: true,
				projectId,
				documentGeneration,
				revision: savedRevision,
			};
		});
	},

	async saveDocumentUpdate(documentGeneration, update, isCurrent = () => true) {
		return enqueueSave(documentGeneration, async () => {
			for (;;) {
				const before = get();
				if (
					!isCurrent() ||
					before.documentGeneration !== documentGeneration ||
					before.status !== "ready" ||
					!before.projectId ||
					!before.document ||
					before.document.project.id !== before.projectId
				) {
					return false;
				}

				const next = update(before.document);
				if (!next || next.project.id !== before.projectId) return false;
				const revision = before.revision;
				const parsed = await persistDocument(next);
				const current = get();
				if (
					!isCurrent() ||
					current.documentGeneration !== documentGeneration ||
					current.projectId !== before.projectId
				) {
					return false;
				}
				if (current.revision !== revision) continue;

				set({
					document: parsed,
					revision: revision + 1,
					dirty: false,
					lastSavedAt: new Date(),
				});
				return true;
			}
		});
	},

	async applyDocumentResult(expected, document) {
		return enqueueSave(expected.documentGeneration, async () => {
			const before = get();
			if (
				before.documentGeneration !== expected.documentGeneration ||
				before.projectId !== expected.projectId ||
				before.revision !== expected.revision ||
				before.status !== "ready" ||
				before.document?.project.id !== expected.projectId
			) {
				return { success: false, status: "stale" };
			}

			const parsed = parseDocument(document);
			if (parsed.project.id !== expected.projectId) {
				throw new Error(
					`Document result belongs to ${parsed.project.id}, expected ${expected.projectId}`,
				);
			}
			const operationIsCurrent = () => {
				const current = get();
				return (
					current.documentGeneration === expected.documentGeneration &&
					current.projectId === expected.projectId &&
					current.revision === expected.revision &&
					current.status === "ready" &&
					current.document?.project.id === expected.projectId
				);
			};
			const detachedOutcome = (authoritative: AxcutDocument): DocumentResultApplyOutcome => {
				const current = get();
				if (
					authoritative.project.id === expected.projectId &&
					documentsHaveEquivalentSaveContent(authoritative, parsed) &&
					current.projectId === expected.projectId &&
					current.status === "ready" &&
					current.document?.project.id === expected.projectId &&
					documentsHaveEquivalentSaveContent(current.document, parsed)
				) {
					return {
						success: true,
						status: "authoritative-detached",
						appliedToCurrent: false,
					};
				}
				return { success: false, status: "superseded" };
			};
			const readAuthoritative = async (): Promise<AxcutDocument> => {
				const result = await nativeBridgeClient.aiEdition.get(expected.projectId);
				if (!result.success || !result.document) {
					throw new Error(result.error ?? "Authoritative project document is unavailable");
				}
				const authoritative = parseDocument(result.document);
				if (authoritative.project.id !== expected.projectId) {
					throw new Error(
						`Authoritative project ${authoritative.project.id} does not match ${expected.projectId}`,
					);
				}
				return authoritative;
			};

			let persisted: AxcutDocument;
			try {
				persisted = await persistDocument(parsed);
			} catch (error) {
				// A failed response is ambiguous: the main process may have committed before the
				// acknowledgement was lost. Re-read disk and adopt it only while this operation's
				// exact launch version is still current; never restore over an intervening edit.
				try {
					const authoritative = await readAuthoritative();
					const beforeJson = JSON.stringify(before.document);
					const authoritativeJson = JSON.stringify(authoritative);
					const message = error instanceof Error ? error.message : String(error);
					if (documentsHaveEquivalentSaveContent(authoritative, parsed)) {
						if (!operationIsCurrent()) return detachedOutcome(authoritative);
						const { pushHistory } = await import("./undo");
						if (!operationIsCurrent()) return detachedOutcome(authoritative);
						pushHistory({
							projectId: expected.projectId,
							doc: structuredClone(before.document),
						});
						set({
							document: authoritative,
							revision: expected.revision + 1,
							dirty: false,
							lastSavedAt: new Date(),
						});
						return { success: true, status: "reconciled", appliedToCurrent: true };
					}

					if (!operationIsCurrent()) return { success: false, status: "superseded" };
					if (authoritativeJson !== beforeJson) {
						const { clearHistory } = await import("./undo");
						if (!operationIsCurrent()) return { success: false, status: "superseded" };
						clearHistory();
						set({
							document: authoritative,
							revision: expected.revision + 1,
							dirty: false,
							lastSavedAt: new Date(),
						});
					}
					return { success: false, status: "diverged", error: message };
				} catch (reconciliationError) {
					console.warn(
						"[project] could not reconcile an ambiguous document-result save:",
						reconciliationError,
					);
				}
				throw error;
			}

			const { pushHistory } = await import("./undo");
			if (!operationIsCurrent()) return detachedOutcome(await readAuthoritative());
			pushHistory({ projectId: expected.projectId, doc: structuredClone(before.document) });
			set({
				document: persisted,
				revision: expected.revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return { success: true, status: "applied", appliedToCurrent: true };
		});
	},

	setDocument(document) {
		const prev = get().document;
		if (prev && prev !== document) {
			// ponytail: push snapshot to undo history. Defer import to avoid
			// pulling the undo module into the store at module-load time.
			void import("./undo").then(({ pushHistory }) => {
				pushHistory({ projectId: prev.project.id, doc: structuredClone(prev) });
			});
		}
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	async replaceTimeline(intervals, reason) {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = replaceTimelineOp(doc, intervals, reason);
		await get().saveDocument(next);
	},

	async restoreFullTimeline() {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = restoreFullTimelineOp(doc);
		await get().saveDocument(next);
	},

	setSourceDuration(sec) {
		set({ sourceDurationSec: sec });
	},

	setCurrentTime(sec) {
		set({ currentTimeSec: sec });
	},

	setPlaying(playing) {
		set({ playing });
	},

	clear() {
		set({
			projectId: null,
			document: null,
			documentGeneration: allocateDocumentGeneration(),
			revision: 0,
			status: "idle",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			playing: false,
			dirty: false,
			lastSavedAt: null,
		});
	},

	markClean() {
		set({ dirty: false, lastSavedAt: new Date() });
	},
}));
