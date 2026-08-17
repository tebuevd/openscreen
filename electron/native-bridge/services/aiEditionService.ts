import { documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	AiEditionAssetResult,
	AiEditionCaptionTranslateResult,
	AiEditionChatBudget,
	AiEditionChatCommitResult,
	AiEditionChatCompactResult,
	AiEditionChatMessage,
	AiEditionChatOperationResult,
	AiEditionChatOperationStatus,
	AiEditionChatPersistenceResolution,
	AiEditionChatResult,
	AiEditionChatRewindCommitResult,
	AiEditionChatRewindComposerClaimResult,
	AiEditionChatRewindComposerConfirmResult,
	AiEditionChatRewindComposerReleaseResult,
	AiEditionChatRewindPrepareResult,
	AiEditionChatSession,
	AiEditionChatSessionSummary,
	AiEditionDocumentResult,
	AiEditionLlmConfig,
	AiEditionLlmDisconnectResult,
	AiEditionLlmSnapshot,
	AiEditionProjectSummary,
} from "../../../src/native/contracts";
import {
	type CaptionTranslateSegment,
	translateCaptionSegments,
} from "../../ai-edition/caption-translate";
import type { ChatEventSink, ChatOperationOwner } from "../../ai-edition/chat-service";
import { DocumentNotFoundError, type DocumentService } from "../../ai-edition/document-service";
import type { LlmConfigStore, LlmCredential } from "../../ai-edition/llm-config-store";
import {
	listAnthropicModels,
	listGoogleModels,
	listMistralModels,
	listOpenAiCompatibleModels,
	listOpenRouterModels,
	probeMiniMaxModels,
} from "../../ai-edition/llm-provider-auth";
import { PROVIDER_DEFINITIONS } from "../../ai-edition/provider-registry";

export interface AiEditionServiceOptions {
	documents: DocumentService;
	/**
	 * A factory, not an instance: building `LlmConfigStore` does two sync
	 * readFileSync plus a `safeStorage` decrypt, and on macOS that decrypt is
	 * backed by a Keychain item — so resolving it while wiring the bridge made
	 * every app launch prompt for Keychain access, including for users who never
	 * open the AI layer. The caller memoises, so this still yields one instance.
	 * Nothing here may call it at construction time; every use sits behind a
	 * method the renderer has to invoke first.
	 */
	llmConfig: () => LlmConfigStore;
	runChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document: unknown | undefined,
		operationId: string,
		owner: ChatOperationOwner,
		sink: ChatEventSink,
	) => Promise<AiEditionChatResult>;
	commitChatRun: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatCommitResult;
	abortChatRun: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatOperationResult;
	beginChatOperationPersistence: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatOperationResult;
	resolveChatOperationPersistence: (
		projectId: string,
		sessionId: string,
		operationId: string,
		outcome: AiEditionChatPersistenceResolution,
		owner: ChatOperationOwner,
	) => AiEditionChatOperationResult;
	getChatOperationStatus: (
		projectId: string,
		sessionId: string,
		operationId: string,
	) => AiEditionChatOperationStatus;
	prepareRewindToMessage: (
		projectId: string,
		sessionId: string,
		messageId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatRewindPrepareResult;
	commitRewindToMessage: (
		projectId: string,
		sessionId: string,
		operationId: string,
		sessionRevision: number,
		owner: ChatOperationOwner,
	) => AiEditionChatRewindCommitResult;
	abortRewindToMessage: (
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatOperationResult;
	handleChatOwnerTeardown: (owner: ChatOperationOwner, documents: DocumentService) => Promise<void>;
	reconcileChatProject: (projectId: string, documents: DocumentService) => Promise<void>;
	reconcileChatOperation: (
		projectId: string,
		sessionId: string,
		operationId: string,
		documents: DocumentService,
	) => Promise<void>;
	compactNow: (projectId: string, sessionId: string) => Promise<AiEditionChatCompactResult | null>;
	getContextUsage: (
		projectId: string,
		sessionId: string,
	) => { usedTokens: number; budgetTokens: number; ratio: number; fillPercent: number } | null;
	// ponytail: legacy per-batch undo retired in favor of per-message rewind.
	// Kept on the surface for IPC compatibility; always returns success=false.
	undoLastToolBatch: (projectId: string, sessionId: string) => AiEditionChatResult;
	listSessions: (projectId: string) => AiEditionChatSessionSummary[];
	createSession: (projectId: string, title?: string) => AiEditionChatSessionSummary;
	selectSession: (projectId: string, sessionId: string) => AiEditionChatSession | null;
	claimRewindComposer: (
		projectId: string,
		sessionId: string,
		revision: number,
		owner: ChatOperationOwner,
	) => AiEditionChatRewindComposerClaimResult;
	confirmRewindComposerClaim: (
		claimId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatRewindComposerConfirmResult;
	releaseRewindComposerClaim: (
		claimId: string,
		owner: ChatOperationOwner,
	) => AiEditionChatRewindComposerReleaseResult;
	renameSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => AiEditionChatSessionSummary | null;
	deleteSession: (projectId: string, sessionId: string) => boolean;
}

export class AiEditionService {
	constructor(private readonly options: AiEditionServiceOptions) {}

	private llmConfigInstance: LlmConfigStore | null = null;

	/**
	 * Resolves the store on first use, then holds it — `llmGetSnapshot` alone
	 * reads it once per provider definition. See `AiEditionServiceOptions.llmConfig`.
	 */
	private get llmConfig(): LlmConfigStore {
		if (!this.llmConfigInstance) {
			this.llmConfigInstance = this.options.llmConfig();
		}
		return this.llmConfigInstance;
	}

	async listProjects(): Promise<AiEditionProjectSummary[]> {
		return this.options.documents.listProjects();
	}

	async get(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.getProject(projectId);
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				notFound: error instanceof DocumentNotFoundError,
			};
		}
	}

	async create(title?: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.createProject(title ?? "");
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async save(document: unknown): Promise<AiEditionDocumentResult> {
		try {
			const parsed = documentSchema.parse(document);
			const saved = await this.options.documents.saveProject(parsed);
			return { success: true, document: saved };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async deleteProject(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.documents.deleteProject(projectId);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async addAsset(projectId: string, path: string, label?: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.addAsset(projectId, { path, label });
		const assetId = document.assets.at(-1)?.id ?? "";
		return { assetId, document };
	}

	async removeAsset(projectId: string, assetId: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.removeAsset(projectId, assetId);
		return { assetId, document };
	}

	async llmGetSnapshot(): Promise<AiEditionLlmSnapshot> {
		const config = this.llmConfig.getConfig();
		const credentialSummary: AiEditionLlmSnapshot["credentialSummary"] = [];
		const connectedProviders: string[] = [];
		for (const def of PROVIDER_DEFINITIONS) {
			const resolved = this.llmConfig.getCredential(def.id, def.envKeys);
			const connected = Boolean(resolved);
			if (connected) connectedProviders.push(def.id);
			credentialSummary.push({
				providerId: def.id,
				connected,
				authKind: def.authKind,
				credentialKind: resolved ? resolved.entry.kind : null,
			});
		}
		return {
			config,
			connectedProviders,
			availableProviders: PROVIDER_DEFINITIONS.map((d) => ({
				id: d.id,
				label: d.label,
				authKind: d.authKind,
			})),
			credentialSummary,
		};
	}

	async llmSetConfig(config: AiEditionLlmConfig): Promise<AiEditionDocumentResult> {
		try {
			await this.llmConfig.setConfig(config);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmSetApiKey(providerId: string, apiKey: string): Promise<AiEditionDocumentResult> {
		try {
			const entry: LlmCredential = { kind: "api-key", apiKey };
			await this.llmConfig.setCredential(providerId, entry);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmRemoveApiKey(providerId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.llmConfig.removeCredential(providerId);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmDisconnect(providerId: string): Promise<AiEditionLlmDisconnectResult> {
		await this.llmConfig.removeCredential(providerId);
		const active = this.llmConfig.getConfig();
		if (active?.provider === providerId) {
			await this.llmConfig.setConfig({
				provider: "",
				model: "",
			});
		}
		return { success: true, snapshot: await this.llmGetSnapshot() };
	}

	async llmListProviderModels(providerId: string): Promise<{ models: string[]; error?: string }> {
		try {
			const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
			if (!def) return { models: [], error: `Unknown provider ${providerId}` };
			const cred = this.llmConfig.getCredential(providerId, def.envKeys);
			if (!cred) return { models: [], error: "Not connected" };
			const config = this.llmConfig.getConfig();
			const baseUrl = (config?.provider === providerId ? config.baseUrl : undefined) ?? def.baseUrl;

			if (providerId === "anthropic") {
				return { models: await listAnthropicModels(cred.value) };
			}
			if (providerId === "google") {
				return { models: await listGoogleModels(cred.value) };
			}
			if (providerId === "mistral") {
				return { models: await listMistralModels(cred.value) };
			}
			if (providerId === "openrouter") {
				return { models: await listOpenRouterModels() };
			}
			if (providerId === "minimax" || providerId === "minimax-token-plan") {
				return { models: await probeMiniMaxModels(cred.value, baseUrl) };
			}
			if (providerId === "openai" || providerId === "openai-compatible") {
				if (!baseUrl) return { models: [], error: "Missing base URL" };
				return { models: await listOpenAiCompatibleModels(baseUrl, cred.value) };
			}
			return { models: [], error: `Provider ${providerId} does not expose a dynamic model list` };
		} catch (error) {
			return { models: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async chatRun(
		projectId: string,
		sessionId: string,
		message: string,
		document: unknown | undefined,
		operationId: string,
		owner: ChatOperationOwner,
		sink: ChatEventSink,
	): Promise<AiEditionChatResult> {
		return this.options.runChat(projectId, sessionId, message, document, operationId, owner, sink);
	}

	chatCommitRun(
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	): AiEditionChatCommitResult {
		return this.options.commitChatRun(projectId, sessionId, operationId, owner);
	}

	chatAbortRun(
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	): AiEditionChatOperationResult {
		return this.options.abortChatRun(projectId, sessionId, operationId, owner);
	}

	chatBeginPersistence(
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	): AiEditionChatOperationResult {
		return this.options.beginChatOperationPersistence(projectId, sessionId, operationId, owner);
	}

	chatResolvePersistence(
		projectId: string,
		sessionId: string,
		operationId: string,
		outcome: AiEditionChatPersistenceResolution,
		owner: ChatOperationOwner,
	): AiEditionChatOperationResult {
		return this.options.resolveChatOperationPersistence(
			projectId,
			sessionId,
			operationId,
			outcome,
			owner,
		);
	}

	async chatOperationStatus(
		projectId: string,
		sessionId: string,
		operationId: string,
	): Promise<AiEditionChatOperationStatus> {
		void this.options
			.reconcileChatOperation(projectId, sessionId, operationId, this.options.documents)
			.catch((error) => console.warn("[ai-edition] could not request chat reconciliation:", error));
		return this.options.getChatOperationStatus(projectId, sessionId, operationId);
	}

	chatOwnerDestroyed(owner: ChatOperationOwner): Promise<void> {
		return this.options.handleChatOwnerTeardown(owner, this.options.documents);
	}

	chatUndoLastBatch(_projectId: string, _sessionId: string): AiEditionChatResult {
		return { success: false, error: "Per-tool-batch undo retired in favor of per-message rewind." };
	}

	chatPrepareRewind(
		projectId: string,
		sessionId: string,
		messageId: string,
		owner: ChatOperationOwner,
	): AiEditionChatRewindPrepareResult {
		return this.options.prepareRewindToMessage(projectId, sessionId, messageId, owner);
	}

	chatCommitRewind(
		projectId: string,
		sessionId: string,
		operationId: string,
		sessionRevision: number,
		owner: ChatOperationOwner,
	): AiEditionChatRewindCommitResult {
		return this.options.commitRewindToMessage(
			projectId,
			sessionId,
			operationId,
			sessionRevision,
			owner,
		);
	}

	chatAbortRewind(
		projectId: string,
		sessionId: string,
		operationId: string,
		owner: ChatOperationOwner,
	): AiEditionChatOperationResult {
		return this.options.abortRewindToMessage(projectId, sessionId, operationId, owner);
	}

	chatContextUsage(projectId: string, sessionId: string): AiEditionChatBudget | null {
		return this.options.getContextUsage(projectId, sessionId);
	}

	chatCompactNow(projectId: string, sessionId: string): Promise<AiEditionChatCompactResult | null> {
		return this.options.compactNow(projectId, sessionId);
	}

	async chatListSessions(projectId: string): Promise<AiEditionChatSessionSummary[]> {
		void this.options
			.reconcileChatProject(projectId, this.options.documents)
			.catch((error) =>
				console.warn("[ai-edition] could not request project reconciliation:", error),
			);
		return this.options.listSessions(projectId);
	}

	chatCreateSession(projectId: string, title?: string): AiEditionChatSessionSummary {
		return this.options.createSession(projectId, title);
	}

	async chatSelectSession(
		projectId: string,
		sessionId: string,
	): Promise<AiEditionChatSession | null> {
		void this.options
			.reconcileChatProject(projectId, this.options.documents)
			.catch((error) =>
				console.warn("[ai-edition] could not request project reconciliation:", error),
			);
		return this.options.selectSession(projectId, sessionId);
	}

	chatClaimRewindComposer(
		projectId: string,
		sessionId: string,
		revision: number,
		owner: ChatOperationOwner,
	): AiEditionChatRewindComposerClaimResult {
		return this.options.claimRewindComposer(projectId, sessionId, revision, owner);
	}

	chatConfirmRewindComposerClaim(
		claimId: string,
		owner: ChatOperationOwner,
	): AiEditionChatRewindComposerConfirmResult {
		return this.options.confirmRewindComposerClaim(claimId, owner);
	}

	chatReleaseRewindComposerClaim(
		claimId: string,
		owner: ChatOperationOwner,
	): AiEditionChatRewindComposerReleaseResult {
		return this.options.releaseRewindComposerClaim(claimId, owner);
	}

	chatRenameSession(
		projectId: string,
		sessionId: string,
		title: string,
	): AiEditionChatSessionSummary | null {
		return this.options.renameSession(projectId, sessionId, title);
	}

	chatDeleteSession(projectId: string, sessionId: string): { success: boolean } {
		return { success: this.options.deleteSession(projectId, sessionId) };
	}

	chatMessages(projectId: string, sessionId: string): AiEditionChatMessage[] {
		const session = this.options.selectSession(projectId, sessionId);
		return session?.messages ?? [];
	}

	chatBudget(projectId: string, sessionId: string): AiEditionChatBudget | null {
		const usage = this.options.getContextUsage(projectId, sessionId);
		if (!usage) return null;
		return {
			usedTokens: usage.usedTokens,
			budgetTokens: usage.budgetTokens,
			ratio: usage.ratio,
			fillPercent: usage.fillPercent,
		};
	}

	async chatCompact(
		projectId: string,
		sessionId: string,
	): Promise<AiEditionChatCompactResult | null> {
		const result = await this.options.compactNow(projectId, sessionId);
		if (!result) return null;
		return result;
	}

	/**
	 * Translate transcript segments for the caption layer, using whichever
	 * provider/model the chat is already configured with. Returns a plain
	 * `segmentId → text` map: the caller writes it into the document's caption
	 * translation layer, so nothing here can touch the transcript SSOT.
	 */
	async captionsTranslate(input: {
		segments: CaptionTranslateSegment[];
		targetLanguage: string;
		sourceLanguage?: string;
	}): Promise<AiEditionCaptionTranslateResult> {
		const config = this.llmConfig.getConfig();
		if (!config) {
			return {
				success: false,
				segments: {},
				error: "No AI provider is configured. Connect one in the agent settings first.",
			};
		}
		const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
		const credential = def ? this.llmConfig.getCredential(def.id, def.envKeys) : null;
		const result = await translateCaptionSegments({
			segments: input.segments,
			targetLanguage: input.targetLanguage,
			sourceLanguage: input.sourceLanguage,
			provider: config.provider,
			model: config.model,
			apiKey: credential?.value ?? "",
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
		});
		return { ...result, model: config.model };
	}
}
