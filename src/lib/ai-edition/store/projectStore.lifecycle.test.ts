// @vitest-environment jsdom
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DocumentNotFoundError,
	DocumentService,
} from "../../../../electron/ai-edition/document-service";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { useProjectStore } from "./projectStore";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	delete: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: bridgeMocks,
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function loadDocument(document: AxcutDocument) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: "ready",
		error: null,
		dirty: false,
		lastSavedAt: new Date(),
	});
}

function connectDocumentService(service: DocumentService) {
	bridgeMocks.get.mockImplementation(async (projectId: string) => {
		try {
			return { success: true, document: await service.getProject(projectId) };
		} catch (error) {
			return {
				success: false,
				error: errorMessage(error),
				notFound: error instanceof DocumentNotFoundError,
			};
		}
	});
	bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => {
		try {
			return { success: true, document: await service.saveProject(document) };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});
	bridgeMocks.delete.mockImplementation(async (projectId: string) => {
		try {
			await service.deleteProject(projectId);
			return { success: true };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});
	bridgeMocks.addAsset.mockImplementation(
		async (projectId: string, assetPath: string, label?: string) => {
			const document = await service.addAsset(projectId, { path: assetPath, label });
			return { assetId: document.assets.at(-1)?.id ?? "", document };
		},
	);
	bridgeMocks.removeAsset.mockImplementation(async (projectId: string, assetId: string) => ({
		assetId,
		document: await service.removeAsset(projectId, assetId),
	}));
}

describe("project lifecycle failure reconciliation", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		Object.assign(window, {
			electronAPI: {
				findRecordingCamera: vi.fn().mockResolvedValue({ success: false }),
			},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only cleanup of the contextBridge stub
		delete (window as any).electronAPI;
	});

	it.each([
		"add",
		"remove",
		"backfill",
	] as const)("reconciles a committed %s after queued deletion cleanup fails", async (mutationKind) => {
		const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-lifecycle-"));
		const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-lifecycle-media-"));
		const service = new DocumentService(projectsRoot, mediaRoot);
		const committed = deferred<void>();
		const releaseResponse = deferred<void>();

		try {
			const created = await service.createProject(`Failed delete after ${mutationKind}`);
			const initial =
				mutationKind === "add"
					? created
					: await service.addAsset(created.project.id, { path: "/tmp/existing.mp4" });
			connectDocumentService(service);
			loadDocument(initial);

			let mutation: Promise<unknown>;
			if (mutationKind === "add") {
				bridgeMocks.addAsset.mockImplementationOnce(
					async (projectId: string, assetPath: string, label?: string) => {
						const document = await service.addAsset(projectId, { path: assetPath, label });
						committed.resolve(undefined);
						await releaseResponse.promise;
						return { assetId: document.assets.at(-1)?.id ?? "", document };
					},
				);
				mutation = useProjectStore.getState().addAsset("/tmp/added.mp4");
			} else if (mutationKind === "remove") {
				const assetId = initial.assets[0].id;
				bridgeMocks.removeAsset.mockImplementationOnce(async (projectId: string, id: string) => {
					const document = await service.removeAsset(projectId, id);
					committed.resolve(undefined);
					await releaseResponse.promise;
					return { assetId: id, document };
				});
				mutation = useProjectStore.getState().removeAsset(assetId);
			} else {
				bridgeMocks.save.mockImplementationOnce(async (document: AxcutDocument) => {
					const persisted = await service.saveProject(document);
					committed.resolve(undefined);
					await releaseResponse.promise;
					return { success: true, document: persisted };
				});
				const generation = useProjectStore.getState().documentGeneration;
				mutation = useProjectStore.getState().saveDocumentUpdate(generation, (document) => ({
					...document,
					assets: document.assets.map((asset) => ({
						...asset,
						video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
					})),
				}));
			}

			await committed.promise;
			const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failed"));
			try {
				await expect(useProjectStore.getState().deleteProject(created.project.id)).rejects.toThrow(
					"cleanup failed",
				);
			} finally {
				rm.mockRestore();
				releaseResponse.resolve(undefined);
				await mutation;
			}

			const onDisk = await service.getProject(created.project.id);
			expect(useProjectStore.getState()).toMatchObject({
				projectId: created.project.id,
				document: onDisk,
				status: "ready",
				dirty: false,
			});
		} finally {
			await fs.rm(projectsRoot, { recursive: true, force: true });
			await fs.rm(mediaRoot, { recursive: true, force: true });
		}
	});

	it("reconciles an earlier committed add after a same-id import fails", async () => {
		const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-import-"));
		const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-import-media-"));
		const service = new DocumentService(projectsRoot, mediaRoot);
		const committed = deferred<void>();
		const releaseResponse = deferred<void>();

		try {
			const created = await service.createProject("Before import");
			connectDocumentService(service);
			loadDocument(created);
			bridgeMocks.addAsset.mockImplementationOnce(
				async (projectId: string, assetPath: string, label?: string) => {
					const document = await service.addAsset(projectId, { path: assetPath, label });
					committed.resolve(undefined);
					await releaseResponse.promise;
					return { assetId: document.assets.at(-1)?.id ?? "", document };
				},
			);
			const adding = useProjectStore.getState().addAsset("/tmp/committed.mp4");
			await committed.promise;

			const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("disk full"));
			try {
				await expect(
					useProjectStore.getState().importProject({
						...created,
						project: { ...created.project, title: "Imported replacement" },
					}),
				).rejects.toThrow("disk full");
			} finally {
				open.mockRestore();
				releaseResponse.resolve(undefined);
				await adding;
			}

			const onDisk = await service.getProject(created.project.id);
			expect(onDisk.assets).toHaveLength(1);
			expect(useProjectStore.getState()).toMatchObject({
				document: onDisk,
				status: "ready",
				dirty: false,
			});
		} finally {
			await fs.rm(projectsRoot, { recursive: true, force: true });
			await fs.rm(mediaRoot, { recursive: true, force: true });
		}
	});

	it("clears the active project when failed deletion reporting follows the commit point", async () => {
		const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-deleted-"));
		const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-deleted-media-"));
		const service = new DocumentService(projectsRoot, mediaRoot);

		try {
			const created = await service.createProject("Actually deleted");
			connectDocumentService(service);
			loadDocument(created);
			bridgeMocks.delete.mockImplementationOnce(async (projectId: string) => {
				await service.deleteProject(projectId);
				return { success: false, error: "delete acknowledgement lost" };
			});

			await expect(useProjectStore.getState().deleteProject(created.project.id)).rejects.toThrow(
				"delete acknowledgement lost",
			);

			expect(useProjectStore.getState()).toMatchObject({
				projectId: null,
				document: null,
				status: "idle",
				dirty: false,
			});
			await expect(service.getProject(created.project.id)).rejects.toBeInstanceOf(
				DocumentNotFoundError,
			);
		} finally {
			await fs.rm(projectsRoot, { recursive: true, force: true });
			await fs.rm(mediaRoot, { recursive: true, force: true });
		}
	});

	it("marks recoverable local data dirty and errored when reconciliation cannot load", async () => {
		const local = createEmptyDocument({ projectId: "proj_local", title: "Local recovery" });
		loadDocument(local);
		bridgeMocks.delete.mockResolvedValue({ success: false, error: "delete failed" });
		bridgeMocks.get.mockResolvedValue({ success: false, error: "read failed" });

		await expect(useProjectStore.getState().deleteProject(local.project.id)).rejects.toThrow(
			"delete failed",
		);

		expect(useProjectStore.getState()).toMatchObject({
			projectId: local.project.id,
			document: local,
			status: "error",
			dirty: true,
		});
		expect(useProjectStore.getState().error).toContain("delete failed");
		expect(useProjectStore.getState().error).toContain("read failed");
	});

	it("ignores stale recovery after another project opens", async () => {
		const projectA = createEmptyDocument({ projectId: "proj_a", title: "Project A" });
		const projectB = createEmptyDocument({ projectId: "proj_b", title: "Project B" });
		const recovery = deferred<{ success: true; document: AxcutDocument }>();
		loadDocument(projectA);
		bridgeMocks.delete.mockResolvedValue({ success: false, error: "delete failed" });
		bridgeMocks.get
			.mockReturnValueOnce(recovery.promise)
			.mockResolvedValueOnce({ success: true, document: projectB });

		const deleting = useProjectStore.getState().deleteProject(projectA.project.id);
		await vi.waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(1));
		await useProjectStore.getState().loadProject(projectB.project.id);
		recovery.resolve({ success: true, document: projectA });
		await expect(deleting).rejects.toThrow("delete failed");

		expect(useProjectStore.getState()).toMatchObject({
			projectId: projectB.project.id,
			document: projectB,
			status: "ready",
			dirty: false,
		});
	});

	it("can retry deletion after a reconciled cleanup failure", async () => {
		const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-retry-"));
		const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-retry-media-"));
		const service = new DocumentService(projectsRoot, mediaRoot);

		try {
			const created = await service.createProject("Retry delete");
			connectDocumentService(service);
			loadDocument(created);
			const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failed"));
			await expect(useProjectStore.getState().deleteProject(created.project.id)).rejects.toThrow(
				"cleanup failed",
			);
			rm.mockRestore();
			expect(useProjectStore.getState()).toMatchObject({ status: "ready", dirty: false });

			await expect(
				useProjectStore.getState().deleteProject(created.project.id),
			).resolves.toBeUndefined();
			expect(useProjectStore.getState()).toMatchObject({
				projectId: null,
				document: null,
				status: "idle",
			});
		} finally {
			await fs.rm(projectsRoot, { recursive: true, force: true });
			await fs.rm(mediaRoot, { recursive: true, force: true });
		}
	});
});
