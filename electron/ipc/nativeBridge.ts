import { app, ipcMain, webContents } from "electron";
import type {
	AiEditionChatCommitResult,
	AiEditionChatEvent,
	AiEditionChatOperationStatus,
	AiEditionChatPersistenceResolution,
	AiEditionChatSessionUpdatedEvent,
} from "../../src/native/contracts";
import {
	NATIVE_BRIDGE_CHANNEL,
	NATIVE_BRIDGE_VERSION,
	type NativeBridgeErrorCode,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectFileResult,
	type ProjectPathResult,
} from "../../src/native/contracts";
import type { ChatEventSink, ChatOperationOwner } from "../ai-edition/chat-service";
import type { DocumentService } from "../ai-edition/document-service";
import {
	type CursorTelemetryLoadResult,
	TelemetryCursorAdapter,
} from "../native-bridge/cursor/telemetryCursorAdapter";
import { AiEditionService } from "../native-bridge/services/aiEditionService";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";
import { CursorService } from "../native-bridge/services/cursorService";
import { ProjectService } from "../native-bridge/services/projectService";
import { SystemService } from "../native-bridge/services/systemService";
import { createNativeBridgeState } from "../native-bridge/store";
import { RendererDocumentOwnerRegistry } from "./rendererDocumentOwnerRegistry";

export interface NativeBridgeContext {
	getPlatform: () => NodeJS.Platform;
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	loadProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	loadProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
	resolveAssetBasePath: () => string | null;
	resolveVideoPath: (videoPath?: string | null) => string | null;
	loadCursorRecordingData: (
		videoPath: string,
	) => Promise<import("../../src/native/contracts").CursorRecordingData>;
	loadCursorTelemetry: (videoPath: string) => Promise<CursorTelemetryLoadResult>;
	/**
	 * returns the native (HWND / NSView / xcb_window) handle buffer
	 * for the BrowserWindow that hosts the requesting renderer. Used by the
	 * compositor domain's `createView` to wire the embedded native window
	 * to its D3D11 parent. May return `null` if the sender has no live window
	 * (e.g. mid-teardown), in which case `createView` fails with UNAVAILABLE.
	 */
	getNativeWindowHandle?: (sender: import("electron").WebContents) => Buffer | null;
	getAiEditionDocuments: () => DocumentService;
	getAiEditionLlmConfig: () => import("../ai-edition/llm-config-store").LlmConfigStore;
	runAiEditionChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document: unknown | undefined,
		operationId: string,
		owner: ChatOperationOwner,
		sink: ChatEventSink,
	) => Promise<import("../../src/native/contracts").AiEditionChatResult>;
	commitAiEditionChatRun: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatCommitResult;
	abortAiEditionChatRun: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatOperationResult;
	beginAiEditionChatPersistence: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatOperationResult;
	resolveAiEditionChatPersistence: (
		projectId: string,
		sessionId: string,
		operationId: string,
		outcome: AiEditionChatPersistenceResolution,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatOperationResult;
	getAiEditionChatOperationStatus: (
		projectId: string,
		sessionId: string,
		operationId: string,
	) => AiEditionChatOperationStatus;
	subscribeAiEditionChatSessionUpdates: (
		listener: (event: AiEditionChatSessionUpdatedEvent) => void,
	) => () => void;
	undoAiEditionToolBatch: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatResult;
	prepareRewindToMessage: (
		projectId: string,
		sessionId: string,
		messageId: string,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatRewindPrepareResult;
	commitRewindToMessage: (
		projectId: string,
		sessionId: string,
		operationId: string,
		sessionRevision: number,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatRewindCommitResult;
	abortRewindToMessage: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => import("../../src/native/contracts").AiEditionChatOperationResult;
	handleAiEditionChatOwnerTeardown: (
		owner: ChatOperationOwner,
		documents: DocumentService,
	) => Promise<void>;
	reconcileAiEditionChatProject: (projectId: string, documents: DocumentService) => Promise<void>;
	reconcileAiEditionChatOperation: (
		projectId: string,
		sessionId: string,
		operationId: string,
		documents: DocumentService,
	) => Promise<void>;
	compactNow: (
		projectId: string,
		sessionId: string,
	) => Promise<import("../../src/native/contracts").AiEditionChatCompactResult | null>;
	getContextUsage: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatBudget | null;
	listAiEditionChatSessions: (
		projectId: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary[];
	createAiEditionChatSession: (
		projectId: string,
		title?: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary;
	selectAiEditionChatSession: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatSession | null;
	renameAiEditionChatSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary | null;
	deleteAiEditionChatSession: (projectId: string, sessionId: string) => boolean;
}

function normalizePlatform(platform: NodeJS.Platform): NativePlatform {
	if (platform === "darwin" || platform === "win32") {
		return platform;
	}

	return "linux";
}

function createMeta(requestId?: string) {
	return {
		version: NATIVE_BRIDGE_VERSION,
		requestId: requestId || `native-${Date.now()}`,
		timestampMs: Date.now(),
	} as const;
}

function createSuccessResponse<TData>(requestId: string | undefined, data: TData) {
	return {
		ok: true,
		data,
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse<TData>;
}

function createErrorResponse(
	requestId: string | undefined,
	code: NativeBridgeErrorCode,
	message: string,
	retryable = false,
) {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable,
		},
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse;
}

/**
 * Strips absolute filesystem paths out of an error message before it crosses to
 * the renderer. Main-process errors quote the path they failed on (`ENOENT: no
 * such file or directory, open 'C:\Users\alice\…'`), and that string is rendered
 * verbatim in toasts and the chat error rail. Keeps the basename, which is the
 * part a user can act on. The full message still goes to the main-process log.
 */
function redactPaths(message: string): string {
	return message
		.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]*)/g, "…\\$1")
		.replace(/\/(?:[^/\0\s'"]+\/)+([^/\0\s'"]*)/g, "…/$1");
}

function isBridgeRequest(value: unknown): value is NativeBridgeRequest {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<NativeBridgeRequest>;
	return typeof candidate.domain === "string" && typeof candidate.action === "string";
}

// build a ChatEventSink that broadcasts each event to the renderer
// that requested the chat run. The webContents may be gone by the time a late
// delta fires (tab closed, window destroyed) — webContents.send throws, so we
// swallow the error to keep the loop running. The renderer treats a missing
// "end of stream" as "the run was abandoned" and shows an inline error.
function buildChatEventSink(
	sender: Electron.WebContents,
	sessionId: string,
	operationId: string,
): ChatEventSink {
	const send = (payload: AiEditionChatEvent) => {
		try {
			sender.send("ai-edition.chat-event", payload);
		} catch {
			// webContents gone — keep the loop running silently.
		}
	};
	return {
		text: (delta) => send({ kind: "text", sessionId, operationId, delta }),
		thinking: (delta) => send({ kind: "thinking", sessionId, operationId, delta }),
		toolStart: (name, args) => send({ kind: "toolStart", sessionId, operationId, name, args }),
		toolEnd: (name, ok, summary) =>
			send({ kind: "toolEnd", sessionId, operationId, name, ok, summary }),
		error: (message) => send({ kind: "error", sessionId, operationId, message }),
	};
}

let unsubscribeChatSessionUpdates: (() => void) | null = null;

export function registerNativeBridgeHandlers(context: NativeBridgeContext) {
	ipcMain.removeHandler(NATIVE_BRIDGE_CHANNEL);

	const platform = normalizePlatform(context.getPlatform());
	const store = createNativeBridgeState(platform);
	const projectService = new ProjectService({
		store,
		getCurrentProjectPath: context.getCurrentProjectPath,
		getCurrentVideoPath: context.getCurrentVideoPath,
		saveProjectFile: context.saveProjectFile,
		loadProjectFile: context.loadProjectFile,
		loadCurrentProjectFile: context.loadCurrentProjectFile,
		loadProjectFileFromPath: context.loadProjectFileFromPath,
		setCurrentVideoPath: context.setCurrentVideoPath,
		getCurrentVideoPathResult: context.getCurrentVideoPathResult,
		clearCurrentVideoPath: context.clearCurrentVideoPath,
	});
	const cursorService = new CursorService({
		store,
		adapter: new TelemetryCursorAdapter({
			loadRecordingData: context.loadCursorRecordingData,
			resolveVideoPath: context.resolveVideoPath,
			loadTelemetry: context.loadCursorTelemetry,
		}),
	});
	const systemService = new SystemService({
		store,
		getPlatform: () => platform,
		getAssetBasePath: context.resolveAssetBasePath,
		getCursorCapabilities: () => cursorService.getCapabilities(),
	});
	const compositorViewService = new CompositorViewService();
	const aiEditionService = new AiEditionService({
		documents: context.getAiEditionDocuments(),
		// Passed uncalled on purpose — invoking it here would build the store (and
		// hit the macOS Keychain) while wiring the bridge at startup.
		llmConfig: context.getAiEditionLlmConfig,
		runChat: context.runAiEditionChat,
		commitChatRun: context.commitAiEditionChatRun,
		abortChatRun: context.abortAiEditionChatRun,
		beginChatOperationPersistence: context.beginAiEditionChatPersistence,
		resolveChatOperationPersistence: context.resolveAiEditionChatPersistence,
		getChatOperationStatus: context.getAiEditionChatOperationStatus,
		undoLastToolBatch: context.undoAiEditionToolBatch,
		prepareRewindToMessage: context.prepareRewindToMessage,
		commitRewindToMessage: context.commitRewindToMessage,
		abortRewindToMessage: context.abortRewindToMessage,
		handleChatOwnerTeardown: context.handleAiEditionChatOwnerTeardown,
		reconcileChatProject: context.reconcileAiEditionChatProject,
		reconcileChatOperation: context.reconcileAiEditionChatOperation,
		compactNow: context.compactNow,
		getContextUsage: context.getContextUsage,
		listSessions: context.listAiEditionChatSessions,
		createSession: context.createAiEditionChatSession,
		selectSession: context.selectAiEditionChatSession,
		renameSession: context.renameAiEditionChatSession,
		deleteSession: context.deleteAiEditionChatSession,
	});
	const documentOwners = new RendererDocumentOwnerRegistry({
		releaseOwner: async (owner) => {
			await Promise.all([
				compositorViewService.abortOwnerExports(owner),
				aiEditionService.chatOwnerDestroyed(owner),
			]);
		},
	});
	for (const contents of webContents.getAllWebContents()) {
		documentOwners.observe(contents);
	}
	app.on("web-contents-created", (_event, contents) => {
		documentOwners.observe(contents);
	});
	unsubscribeChatSessionUpdates?.();
	unsubscribeChatSessionUpdates = context.subscribeAiEditionChatSessionUpdates((update) => {
		for (const contents of webContents.getAllWebContents()) {
			if (contents.isDestroyed()) continue;
			try {
				contents.send("ai-edition.chat-session-updated", update);
			} catch {
				// A renderer may disappear between enumeration and send.
			}
		}
	});

	ipcMain.handle(NATIVE_BRIDGE_CHANNEL, async (event, request: unknown) => {
		if (!isBridgeRequest(request)) {
			return createErrorResponse(undefined, "INVALID_REQUEST", "Invalid native bridge request.");
		}

		const requestId = request.requestId;
		const domain = request.domain as string;

		try {
			documentOwners.observe(event.sender);
			switch (request.domain) {
				case "system": {
					const action = request.action as string;
					switch (request.action) {
						case "getPlatform":
							return createSuccessResponse(requestId, systemService.getPlatform());
						case "getAssetBasePath":
							return createSuccessResponse(requestId, systemService.getAssetBasePath());
						case "getCapabilities":
							return createSuccessResponse(requestId, await systemService.getCapabilities());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported system action: ${action}`,
							);
					}
				}

				case "project": {
					const action = request.action as string;
					switch (request.action) {
						case "getCurrentContext":
							return createSuccessResponse(requestId, projectService.getCurrentContext());
						case "saveProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.saveProjectFile(
									request.payload.projectData,
									request.payload.suggestedName,
									request.payload.existingProjectPath,
								),
							);
						case "loadProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFile(request.payload?.projectFolder),
							);
						case "loadCurrentProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadCurrentProjectFile(),
							);
						case "loadProjectFileFromPath":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFileFromPath(request.payload.path),
							);
						case "setCurrentVideoPath":
							return createSuccessResponse(
								requestId,
								await projectService.setCurrentVideoPath(request.payload.path),
							);
						case "getCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.getCurrentVideoPath());
						case "clearCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.clearCurrentVideoPath());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported project action: ${action}`,
							);
					}
				}

				case "cursor": {
					const action = request.action as string;
					switch (request.action) {
						case "getCapabilities":
							return createSuccessResponse(requestId, await cursorService.getCapabilities());
						case "getTelemetry":
							return createSuccessResponse(
								requestId,
								await cursorService.getTelemetry(request.payload?.videoPath),
							);
						case "getRecordingData":
							return createSuccessResponse(
								requestId,
								await cursorService.getRecordingData(request.payload?.videoPath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported cursor action: ${action}`,
							);
					}
				}

				case "compositor": {
					const action = request.action as string;
					switch (request.action) {
						case "createView": {
							const id = compositorViewService.createView(request.payload.rect, {
								screenPath: request.payload.screenPath,
								webcamPath: request.payload.webcamPath,
								cursorPath: request.payload.cursorPath,
							});
							return createSuccessResponse(requestId, { id });
						}
						case "probeBackend":
							// No view needed: the export dialog asks before any preview exists.
							return createSuccessResponse(requestId, {
								backend: compositorViewService.probeBackend(),
							});
						case "setRect":
							compositorViewService.setRect(request.payload.id, request.payload.rect);
							return createSuccessResponse(requestId, { ok: true });
						case "readFrame": {
							// The renderer polls this every rAF tick (~30fps). It passes the
							// generation it last painted as `sinceGen`; native returns `null` when
							// nothing newer exists (idle path — no buffer copy). On a new frame it
							// returns `{ gen, width, height, data }`. The response wrapper does NOT
							// JSON-stringify — `ipcMain.handle` round-trips via structured clone,
							// which preserves the nested `Buffer` in `.data` as binary.
							const frame = compositorViewService.readFrame(
								request.payload.id,
								request.payload.sinceGen,
							);
							return createSuccessResponse(requestId, frame);
						}
						case "setParam":
							compositorViewService.setParam(
								request.payload.id,
								request.payload.key,
								request.payload.value,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "setPlaying":
							compositorViewService.setPlaying(request.payload.id, request.payload.playing);
							return createSuccessResponse(requestId, { ok: true });
						case "presentTime":
							compositorViewService.presentTime(request.payload.id, request.payload.seconds);
							return createSuccessResponse(requestId, { ok: true });
						case "setScene":
							compositorViewService.setScene(request.payload.id, request.payload.sceneJson);
							return createSuccessResponse(requestId, { ok: true });
						case "setActiveClip":
							compositorViewService.setActiveClip(
								request.payload.id,
								request.payload.screenPath,
								request.payload.webcamPath,
								request.payload.webcamOffsetSec,
								request.payload.clipIndex,
								request.payload.sourceTimeSec,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "destroyView":
							compositorViewService.destroyView(request.payload.id);
							return createSuccessResponse(requestId, { ok: true });
						case "exportMulti": {
							const sender = event.sender;
							const owner = documentOwners.ownerFor(event);
							const stats = await compositorViewService.exportMulti(
								request.payload.clips,
								request.payload.outPath,
								request.payload.sceneJson,
								request.payload.params,
								(frames) => {
									if (!sender.isDestroyed()) {
										sender.send("export:native-progress", frames);
									}
								},
								owner,
							);
							if (!stats) {
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							return createSuccessResponse(requestId, stats);
						}
						case "exportMultiStaged": {
							const sender = event.sender;
							const owner = documentOwners.ownerFor(event);
							const result = await compositorViewService.exportMultiStaged(
								request.payload.clips,
								request.payload.outPath,
								request.payload.sceneJson,
								request.payload.params,
								request.payload.additionalInputPaths,
								(frames) => {
									if (!sender.isDestroyed()) {
										sender.send("export:native-progress", frames);
									}
								},
								owner,
							);
							if (!result) {
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							return createSuccessResponse(requestId, result);
						}
						case "readStagedExport": {
							const data = await compositorViewService.readStagedExport(
								documentOwners.ownerFor(event),
								request.payload.transactionId,
							);
							return createSuccessResponse(requestId, { data });
						}
						case "renewStagedExportLease":
							compositorViewService.renewStagedExportLease(
								documentOwners.ownerFor(event),
								request.payload.transactionId,
							);
							return createSuccessResponse(requestId, { ok: true as const });
						case "replaceStagedExport":
							await compositorViewService.replaceStagedExport(
								documentOwners.ownerFor(event),
								request.payload.transactionId,
								request.payload.data,
							);
							return createSuccessResponse(requestId, { ok: true as const });
						case "commitStagedExport":
							return createSuccessResponse(
								requestId,
								await compositorViewService.commitStagedExport(
									documentOwners.ownerFor(event),
									request.payload.transactionId,
								),
							);
						case "abortStagedExport":
							await compositorViewService.abortStagedExport(
								documentOwners.ownerFor(event),
								request.payload.transactionId,
							);
							return createSuccessResponse(requestId, { ok: true as const });
						case "exportGif": {
							const sender = event.sender;
							const owner = documentOwners.ownerFor(event);
							const stats = await compositorViewService.exportGif(
								request.payload.clips,
								request.payload.outPath,
								request.payload.sceneJson,
								request.payload.params,
								(frames) => {
									if (!sender.isDestroyed()) {
										sender.send("export:native-progress", frames);
									}
								},
								owner,
							);
							if (!stats) {
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							return createSuccessResponse(requestId, stats);
						}
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported compositor action: ${action}`,
							);
					}
				}

				case "aiEdition": {
					const action = request.action as string;
					switch (request.action) {
						case "document.listProjects":
							return createSuccessResponse(requestId, await aiEditionService.listProjects());
						case "document.get":
							return createSuccessResponse(
								requestId,
								await aiEditionService.get(request.payload.projectId),
							);
						case "document.create": {
							documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								await aiEditionService.create(request.payload?.title),
							);
						}
						case "document.save": {
							// Validate the committed document before dispatching the write. If navigation
							// already revoked this owner, the old renderer cannot enqueue a save behind
							// teardown reconciliation and land after the authoritative readback.
							documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								await aiEditionService.save(request.payload.document),
							);
						}
						case "document.delete": {
							documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								await aiEditionService.deleteProject(request.payload.projectId),
							);
						}
						case "document.addAsset": {
							documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								await aiEditionService.addAsset(
									request.payload.projectId,
									request.payload.path,
									request.payload.label,
								),
							);
						}
						case "document.removeAsset": {
							documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								await aiEditionService.removeAsset(
									request.payload.projectId,
									request.payload.assetId,
								),
							);
						}
						case "llm.getSnapshot":
							return createSuccessResponse(requestId, await aiEditionService.llmGetSnapshot());
						case "llm.setConfig":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetConfig(request.payload.config),
							);
						case "llm.setApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetApiKey(
									request.payload.providerId,
									request.payload.apiKey,
								),
							);
						case "llm.removeApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmRemoveApiKey(request.payload.providerId),
							);
						case "llm.disconnect":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmDisconnect(request.payload.providerId),
							);
						case "llm.listProviderModels":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmListProviderModels(request.payload.providerId),
							);
						case "chat.run": {
							const sessionId = request.payload.sessionId;
							const owner = documentOwners.ownerFor(event);
							const sink = buildChatEventSink(event.sender, sessionId, request.payload.operationId);
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatRun(
									request.payload.projectId,
									sessionId,
									request.payload.message,
									request.payload.document,
									request.payload.operationId,
									owner,
									sink,
								),
							);
						}
						case "chat.run.commit": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatCommitRun(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									owner,
								),
							);
						}
						case "chat.run.abort": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatAbortRun(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									owner,
								),
							);
						}
						case "chat.operation.beginPersistence": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatBeginPersistence(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									owner,
								),
							);
						}
						case "chat.operation.resolvePersistence": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatResolvePersistence(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									request.payload.outcome,
									owner,
								),
							);
						}
						case "chat.operation.status":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatOperationStatus(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
								),
							);
						case "chat.undoLastBatch":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatUndoLastBatch(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.listSessions":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatListSessions(request.payload.projectId),
							);
						case "chat.createSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatCreateSession(
									request.payload.projectId,
									request.payload.title,
								),
							);
						case "chat.selectSession":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatSelectSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.renameSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatRenameSession(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.title,
								),
							);
						case "chat.deleteSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatDeleteSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.budget":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatBudget(request.payload.projectId, request.payload.sessionId),
							);
						case "chat.compact":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompact(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.rewind.prepare": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatPrepareRewind(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.messageId,
									owner,
								),
							);
						}
						case "chat.rewind.commit": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatCommitRewind(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									request.payload.sessionRevision,
									owner,
								),
							);
						}
						case "chat.rewind.abort": {
							const owner = documentOwners.ownerFor(event);
							return createSuccessResponse(
								requestId,
								aiEditionService.chatAbortRewind(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operationId,
									owner,
								),
							);
						}
						case "chat.contextUsage":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatContextUsage(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.compactNow":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompactNow(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "captions.translate":
							return createSuccessResponse(
								requestId,
								await aiEditionService.captionsTranslate({
									segments: request.payload.segments,
									targetLanguage: request.payload.targetLanguage,
									sourceLanguage: request.payload.sourceLanguage,
								}),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported aiEdition action: ${action}`,
							);
					}
				}

				default:
					return createErrorResponse(
						requestId,
						"UNSUPPORTED_ACTION",
						`Unsupported bridge domain: ${domain}`,
					);
			}
		} catch (error) {
			// Not retryable by default: most failures here are permanent (a missing
			// file, a bad payload, an unavailable addon), and a blanket `true` tells
			// the client to spin on them. The message keeps the reason but drops any
			// absolute path — it crosses to the renderer and ends up in UI strings.
			console.error(`native bridge ${domain}.${request.action} failed:`, error);
			return createErrorResponse(
				requestId,
				"INTERNAL_ERROR",
				redactPaths(error instanceof Error ? error.message : "Unknown native bridge error."),
			);
		}
	});
}
