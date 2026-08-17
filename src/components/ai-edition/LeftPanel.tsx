import { ArrowLeft, Check, Film, Loader2, MessageSquare, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { type AxcutAsset, ensureDocument } from "@/lib/ai-edition/schema";
import { type DocumentOperationToken, useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { splitRoundedTime } from "@/lib/ai-edition/timeline/format";
import type { AssetTranscriptionView } from "@/lib/ai-edition/transcription/status";
import { nativeBridgeClient } from "@/native/client";
import type {
	AiEditionChatCommitResult,
	AiEditionChatEvent,
	AiEditionChatMessage,
	AiEditionChatOperationStatus,
	AiEditionChatPersistenceResolution,
	AiEditionChatRewindCommitResult,
	AiEditionChatSessionUpdatedEvent,
	AiEditionLlmConfig,
	AiEditionToolCallSummary,
} from "@/native/contracts";
import { formatBytes } from "@/utils/formatBytes";
import {
	getReasoningEffortLabel,
	getReasoningEffortOptions,
	PROVIDER_DEFINITIONS,
	type ReasoningEffort,
} from "../../../electron/ai-edition/provider-registry";
import { ChatWelcome } from "./ChatWelcome";
import { canSendChat } from "./chatAvailability";
import { computeBudget } from "./chatBudget";
import { ChatHistoryModal, SourceTranscriptModal } from "./Modals";
import styles from "./NewEditorShell.module.css";
import { ProviderSettings } from "./ProviderSettings";
import { TranscriptionStatusDot } from "./TranscriptionStatus";

export type LeftTab = "chat" | "media";

const THUMB_PALETTE = ["thumbRed", "thumbGreen", "thumbAmber", "thumbCyan"] as const;

// `h:mm:ss.t`, hours always shown — a third shape, so it formats itself rather
// than calling into format.ts. It shares `splitRoundedTime` because the carry is
// the part that must not be re-derived: deriving the minute field from the raw
// value while the second field rounded is what rendered `0:00:60.0`.
function formatTimecode(sec: number | undefined): string {
	if (!sec || !Number.isFinite(sec)) return "0:00:00.0";
	const { totalMinutes, seconds } = splitRoundedTime(sec);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	// padStart(4), not (3): "5.0" is already 3 chars, so a single-digit second
	// rendered as `0:00:5.0` instead of `0:00:05.0`.
	return `${h}:${m.toString().padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function createPanelOperationId(prefix: string): string {
	const id = typeof crypto !== "undefined" ? crypto.randomUUID?.() : undefined;
	return `${prefix}_${id ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

type PanelOperationPhase = "starting" | "running" | "persisting" | "committing" | "settled";

interface PanelOperation {
	localId: string;
	kind: "chat" | "rewind";
	projectId: string;
	sessionId: string | null;
	remoteId: string | null;
	phase: PanelOperationPhase;
	cancelled: boolean;
	uiAttached: boolean;
	abortRequested: boolean;
}

function operationMustFinish(operation: PanelOperation): boolean {
	return operation.phase === "persisting" || operation.phase === "committing";
}

type SuccessfulChatCommit = Extract<AiEditionChatCommitResult, { success: true }>;
type SuccessfulRewindCommit = Extract<AiEditionChatRewindCommitResult, { success: true }>;

interface RewindComposerDelivery {
	revision: number;
	applied: boolean;
	claimInFlight: boolean;
	claimAttempts: number;
	confirmAttempts: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
}

const REWIND_COMPOSER_RETRY_LIMIT = 4;
const REWIND_COMPOSER_RETRY_DELAY_MS = 100;
const REWIND_COMPOSER_MAX_RETRY_DELAY_MS = 15_100;

function clearRewindComposerRetry(delivery: RewindComposerDelivery): void {
	if (delivery.retryTimer !== null) clearTimeout(delivery.retryTimer);
	delivery.retryTimer = null;
}

function discardRewindComposerDelivery(
	deliveries: Map<string, RewindComposerDelivery>,
	key: string,
	delivery?: RewindComposerDelivery,
): void {
	const current = deliveries.get(key);
	if (!current || (delivery && current !== delivery)) return;
	clearRewindComposerRetry(current);
	deliveries.delete(key);
}

function clearRewindComposerDeliveries(deliveries: Map<string, RewindComposerDelivery>): void {
	for (const delivery of deliveries.values()) clearRewindComposerRetry(delivery);
	deliveries.clear();
}

type CommitResolution<T> =
	| { state: "committed"; result: T }
	| { state: "aborted"; error: string }
	| { state: "unknown"; error: string };

function boundedDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileAmbiguousCommit<T extends { success: true }>(options: {
	kind: "chat" | "rewind";
	commit: () => Promise<T | { success: false; error: string }>;
	status: () => Promise<AiEditionChatOperationStatus>;
}): Promise<CommitResolution<T>> {
	let lastError = "Commit acknowledgement is unavailable.";
	for (const delayMs of [0, 10, 25]) {
		if (delayMs > 0) await boundedDelay(delayMs);
		try {
			const result = await options.commit();
			if (result.success) return { state: "committed", result };
			lastError = result.error;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}

		try {
			const status = await options.status();
			if (status.state === "committed" && status.kind === options.kind) {
				return { state: "committed", result: status.result as unknown as T };
			}
			if (status.state === "aborted") return { state: "aborted", error: lastError };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	return { state: "unknown", error: lastError };
}

async function beginPersistenceBounded(
	projectId: string,
	sessionId: string,
	operationId: string,
): Promise<"started" | "committed" | "aborted" | "unknown"> {
	for (const delayMs of [0, 10]) {
		if (delayMs > 0) await boundedDelay(delayMs);
		try {
			await nativeBridgeClient.aiEdition.chatBeginPersistence(projectId, sessionId, operationId);
		} catch {
			// Fresh status distinguishes a lost transition reply from a rejected transition.
		}
		try {
			const status = await nativeBridgeClient.aiEdition.chatOperationStatus(
				projectId,
				sessionId,
				operationId,
			);
			if (status.state === "persisting") return "started";
			if (status.state === "committed") return "committed";
			if (status.state === "aborted") return "aborted";
		} catch {
			// The second bounded attempt may still recover a lost transition response.
		}
	}
	return "unknown";
}

function requestOperationAbort(operation: PanelOperation): void {
	if (!operation.sessionId || !operation.remoteId || operation.abortRequested) return;
	operation.abortRequested = true;
	const abort =
		operation.kind === "chat"
			? nativeBridgeClient.aiEdition.chatAbortRun
			: nativeBridgeClient.aiEdition.chatAbortRewind;
	void abort(operation.projectId, operation.sessionId, operation.remoteId).catch(() => undefined);
}

function MediaList({
	assets,
	onOpenTranscript,
	transcriptions,
}: {
	assets: AxcutAsset[];
	onOpenTranscript?: (asset: AxcutAsset) => void;
	/** Per-asset transcription state, keyed by asset id (see transcriptionStore). */
	transcriptions: Record<string, AssetTranscriptionView>;
}) {
	const t = useScopedT("editor");
	if (assets.length === 0) {
		return (
			<p
				style={{
					font: "400 12px var(--font-body)",
					color: "var(--muted)",
					padding: "16px var(--sp-4)",
					textAlign: "center",
					lineHeight: 1.5,
				}}
			>
				{t("leftPanel.emptyHint")}
			</p>
		);
	}
	return (
		<ul className={styles.mediaList}>
			{assets.map((asset, i) => {
				const label = asset.label || basename(asset.originalPath);
				const tc = formatTimecode(asset.durationSec);
				const size = formatBytes(asset.sizeBytes);
				const palette = THUMB_PALETTE[i % THUMB_PALETTE.length];
				const transcription = transcriptions[asset.id] ?? {
					assetId: asset.id,
					status: "idle" as const,
				};

				return (
					<li
						className={styles.mediaCard}
						key={asset.id}
						title={asset.originalPath}
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData("application/x-axcut-asset", asset.id);
							e.dataTransfer.effectAllowed = "copy";
						}}
					>
						<button
							type="button"
							style={{
								display: "flex",
								flexDirection: "column",
								border: 0,
								background: "none",
								padding: 0,
								cursor: "pointer",
								font: "inherit",
								textAlign: "left",
								width: "100%",
							}}
							onClick={() => onOpenTranscript?.(asset)}
						>
							<div className={`${styles.thumb} ${styles[palette]}`} aria-hidden>
								<Film size={22} />
							</div>
							<div className={styles.mediaMeta}>
								<div className={styles.name}>{label}</div>
								<div className={styles.row}>
									<TranscriptionStatusDot view={transcription} />
									<span className={styles.timecode}>{tc}</span>
									<span className={styles.size}>{size}</span>
								</div>
							</div>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export function MediaPane() {
	const t = useScopedT("editor");
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	// Transcripts land on their own (transcriptionStore's background pass); the
	// pane reports where each one is at and offers a per-asset re-run.
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [srcTranscriptAsset, setSrcTranscriptAsset] = useState<AxcutAsset | null>(null);
	const selectedTranscription = srcTranscriptAsset
		? transcriptions[srcTranscriptAsset.id]
		: undefined;

	const handleImport = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) return;
		setBusy(true);
		try {
			const label = picker.name || basename(picker.path);
			await addAsset(picker.path, label);
			toast.success(t("mediaStage.added", { label }));
		} catch (err) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const filtered = (document?.assets ?? []).filter((a) => {
		if (!query) return true;
		const text = `${a.label} ${a.originalPath}`.toLowerCase();
		return text.includes(query.toLowerCase());
	});

	return (
		<aside className={styles.panel}>
			<header className={styles.panelHead}>
				<h2>{t("leftPanel.mediaTitle")}</h2>
			</header>
			<div style={{ padding: "10px var(--sp-3) 8px" }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "6px 10px",
						background: "var(--surface-warm)",
						border: "1px solid var(--border-soft)",
						borderRadius: "var(--r-md)",
						color: "var(--meta)",
					}}
				>
					<Search size={14} />
					<input
						type="text"
						placeholder={t("leftPanel.searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						style={{
							flex: 1,
							border: 0,
							background: "transparent",
							outline: "none",
							font: "13px var(--font-body)",
							color: "var(--fg)",
						}}
					/>
					{query ? (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label={t("leftPanel.clearSearch")}
							style={{
								background: "transparent",
								border: 0,
								color: "var(--meta)",
								cursor: "pointer",
							}}
						>
							<X size={12} />
						</button>
					) : null}
				</div>
			</div>
			<div className={styles.panelBody} style={{ padding: "4px var(--sp-3) 8px" }}>
				<MediaList
					assets={filtered}
					onOpenTranscript={setSrcTranscriptAsset}
					transcriptions={transcriptions}
				/>
			</div>
			<button
				type="button"
				className={styles.importBtn}
				onClick={handleImport}
				disabled={!projectId || busy}
			>
				<Plus size={14} />
				{t("mediaStage.importMedia")}
			</button>
			{document?.transcript ? (
				<div
					style={{
						margin: "0 var(--sp-3) 8px",
						padding: "6px 10px",
						borderRadius: 999,
						background: "var(--success-soft)",
						color: "var(--success)",
						font: "500 11px/1 var(--font-mono)",
						letterSpacing: "0.04em",
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
					}}
				>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--success)",
						}}
					/>
					{t("leftPanel.transcriptReadyBadge")}
				</div>
			) : null}
			<SourceTranscriptModal
				open={srcTranscriptAsset !== null}
				onClose={() => setSrcTranscriptAsset(null)}
				assetLabel={srcTranscriptAsset?.label ?? ""}
				assetPath={srcTranscriptAsset?.originalPath ?? ""}
				tcFormatted={formatTimecode(srcTranscriptAsset?.durationSec)}
				transcript={
					srcTranscriptAsset && document?.transcripts
						? (document.transcripts.find((t) => t.assetId === srcTranscriptAsset.id) ?? null)
						: null
				}
				isTranscribing={
					selectedTranscription?.status === "running" || selectedTranscription?.status === "queued"
				}
				isFailed={selectedTranscription?.status === "failed"}
				failureMessage={
					selectedTranscription?.failure
						? selectedTranscription.failure.kind === "error"
							? selectedTranscription.failure.message
							: t("mediaStage.noAudioTrackHint")
						: undefined
				}
				onRegenerate={(language) => {
					if (!srcTranscriptAsset) return Promise.resolve();
					return requestTranscription(srcTranscriptAsset.id, language);
				}}
			/>
		</aside>
	);
}

export function LeftPanel({ active }: { active: LeftTab }) {
	return active === "chat" ? <ChatStripPanel /> : <MediaPane />;
}

interface ChatDisplayMessage {
	id?: string;
	role: string;
	content: string;
	time?: string;
	toolCalls?: AiEditionToolCallSummary[];
	// ponytail: axcut parity — non-null on user messages that have a
	// rewind-able document snapshot, so the per-message ↩ button shows.
	checkpointId?: string | null;
	// ponytail: when an assistant message carries the model's reasoning trace
	// (Anthropic/MiniMax thinking), the chat renders it as a collapsible block
	// above the answer. Ephemeral — only present for the turn that streamed it;
	// reloading a session won't show past traces.
	thinking?: string;
}

function toDisplayMessages(messages: AiEditionChatMessage[]): ChatDisplayMessage[] {
	return messages.map((message) => ({
		id: message.id,
		role: message.role,
		content: message.content,
		time: message.createdAt,
		toolCalls: message.toolCalls,
		checkpointId: message.checkpointId ?? null,
	}));
}

function rememberAppliedSessionUpdate(operationIds: Set<string>, operationId: string): void {
	operationIds.add(operationId);
	while (operationIds.size > 128) {
		const oldest = operationIds.values().next().value;
		if (typeof oldest !== "string") break;
		operationIds.delete(oldest);
	}
}

// Quick-access model picker anchored to the composer's model pill — mirrors
// axcut's LlmPopover in "models"/"providers" mode (a lightweight popover, not
// the full AI-settings modal). "Provider settings…" in the providers screen
// is the escape hatch into that full modal (same one the header gear opens),
// matching axcut's `openProviderSettings` from its popover's providers screen.
function ModelQuickPopover({
	anchorRect,
	llmConfig,
	connectedProviders,
	onClose,
	onConfigChange,
	onOpenFullSettings,
}: {
	anchorRect: { left: number; bottom: number; maxHeight: number };
	llmConfig: AiEditionLlmConfig;
	connectedProviders: string[];
	onClose: () => void;
	onConfigChange: () => void;
	onOpenFullSettings: () => void;
}) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const [screen, setScreen] = useState<"models" | "providers">("models");
	const [browseProviderId, setBrowseProviderId] = useState(llmConfig.provider);
	const [models, setModels] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);

	const browseDef = PROVIDER_DEFINITIONS.find((d) => d.id === browseProviderId);

	useEffect(() => {
		if (screen !== "models" || !browseProviderId) return;
		let cancelled = false;
		setModelsLoading(true);
		setModelsError(null);
		void nativeBridgeClient.aiEdition
			.llmListProviderModels(browseProviderId)
			.then((result) => {
				if (cancelled) return;
				setModels(result.models);
				setModelsError(result.error ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setModels([]);
				setModelsError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setModelsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [screen, browseProviderId]);

	const selectModel = async (nextModel: string) => {
		setBusy(true);
		try {
			const result = await nativeBridgeClient.aiEdition.llmSetConfig({
				...llmConfig,
				provider: browseProviderId,
				model: nextModel,
			});
			if (result.success) {
				onConfigChange();
				onClose();
			} else {
				setModelsError(result.error ?? t("chat.selectModelFailed"));
			}
		} finally {
			setBusy(false);
		}
	};

	const filteredModels = search.trim()
		? models.filter((candidate) => candidate.toLowerCase().includes(search.trim().toLowerCase()))
		: models;

	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			style={{ position: "fixed", inset: 0, zIndex: 999 }}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section
				style={{
					position: "fixed",
					left: anchorRect.left,
					bottom: anchorRect.bottom,
					width: 320,
					maxHeight: anchorRect.maxHeight,
					display: "flex",
					flexDirection: "column",
					background: "var(--surface)",
					border: "1px solid var(--border)",
					borderRadius: "var(--r-md)",
					boxShadow: "var(--elev-pop)",
					zIndex: 1000,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 12px",
						borderBottom: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						onClick={() => setScreen(screen === "models" ? "providers" : "models")}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							background: "transparent",
							border: "none",
							color: "var(--fg-2)",
							cursor: "pointer",
							fontSize: 12.5,
							padding: 0,
						}}
					>
						<ArrowLeft size={14} />
						{screen === "models" ? t("chat.changeProvider") : t("chat.back")}
					</button>
					<button
						type="button"
						onClick={onClose}
						aria-label={tc("actions.close")}
						style={{
							background: "transparent",
							border: "none",
							color: "var(--muted)",
							cursor: "pointer",
							padding: 0,
						}}
					>
						<X size={14} />
					</button>
				</div>
				<div style={{ overflowY: "auto", padding: 10, minHeight: 0, flex: 1 }}>
					{screen === "models" ? (
						<>
							<div style={{ marginBottom: 8 }}>
								<div style={{ fontWeight: 600, fontSize: 13 }}>
									{browseDef?.label ?? browseProviderId}
								</div>
								<div style={{ fontSize: 11.5, color: "var(--muted)" }}>
									{t("chat.currentModel")}{" "}
									{browseProviderId === llmConfig.provider
										? llmConfig.model
										: (browseDef?.defaultModel ?? t("chat.notSelected"))}
								</div>
							</div>
							<input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder={modelsLoading ? t("chat.loadingModels") : t("chat.searchModels")}
								disabled={modelsLoading || !models.length}
								style={{
									width: "100%",
									padding: "6px 8px",
									marginBottom: 8,
									borderRadius: "var(--r-sm)",
									border: "1px solid var(--border)",
									background: "var(--bg)",
									color: "var(--fg)",
								}}
							/>
							{!models.length ? (
								<div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>
									{modelsLoading
										? t("chat.loadingModels")
										: modelsError
											? t("chat.fetchModelsFailed", { error: modelsError })
											: t("chat.noModelsAvailable")}
								</div>
							) : (
								<div>
									{filteredModels.map((candidate) => (
										<button
											key={candidate}
											type="button"
											disabled={busy}
											onClick={() => void selectModel(candidate)}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												width: "100%",
												padding: "7px 8px",
												border: "none",
												borderRadius: "var(--r-sm)",
												background:
													candidate === llmConfig.model && browseProviderId === llmConfig.provider
														? "var(--surface-3)"
														: "transparent",
												color: "var(--fg)",
												cursor: "pointer",
												fontSize: 12.5,
												marginBottom: 2,
											}}
										>
											{candidate}
											{candidate === llmConfig.model && browseProviderId === llmConfig.provider ? (
												<Check size={12} />
											) : null}
										</button>
									))}
									{filteredModels.length === 0 ? (
										<div style={{ fontSize: 12, color: "var(--muted)" }}>
											{t("chat.noModelsMatch")}
										</div>
									) : null}
								</div>
							)}
						</>
					) : (
						<>
							{connectedProviders.map((providerId) => {
								const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
								if (!def) return null;
								return (
									<button
										key={providerId}
										type="button"
										onClick={() => {
											setBrowseProviderId(providerId);
											setScreen("models");
										}}
										style={{
											display: "flex",
											flexDirection: "column",
											alignItems: "flex-start",
											width: "100%",
											padding: "8px 10px",
											border: "none",
											borderRadius: "var(--r-sm)",
											background:
												providerId === browseProviderId ? "var(--surface-3)" : "transparent",
											color: "var(--fg)",
											cursor: "pointer",
											marginBottom: 4,
										}}
									>
										<strong style={{ fontSize: 12.5 }}>{def.label}</strong>
										<span style={{ fontSize: 11, color: "var(--muted)" }}>
											{providerId === llmConfig.provider ? llmConfig.model : def.defaultModel}
										</span>
									</button>
								);
							})}
							{connectedProviders.length === 0 ? (
								<div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
									{t("chat.noProvidersConnected")}
								</div>
							) : null}
							<button
								type="button"
								onClick={() => {
									onClose();
									onOpenFullSettings();
								}}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									width: "100%",
									padding: "8px 10px",
									border: "1px solid var(--border-soft)",
									borderRadius: "var(--r-sm)",
									background: "transparent",
									color: "var(--fg-2)",
									cursor: "pointer",
									marginTop: 6,
								}}
							>
								{t("chat.providerSettings")}
							</button>
						</>
					)}
				</div>
			</section>
		</div>,
		document.body,
	);
}

// ponytail: collapsible block that renders a model's reasoning trace (the
// streaming text from Anthropic/MiniMax `thinking` blocks). Default state is
// the last ~240 chars of the trace, clamped to two lines — the latest
// reasoning the model produced. Clicking the header toggles into "solid" mode
// (full text, scrollable). Used both while the reasoning is still streaming
// (so the user sees the model is alive) and on the completed message (so the
// trace is still there to revisit, collapsed by default).
const THINKING_PREVIEW_TAIL_CHARS = 240;
function ThinkingBlock({
	text,
	expanded,
	onToggle,
	label,
}: {
	text: string;
	expanded: boolean;
	onToggle: () => void;
	label: string;
}) {
	const preview =
		text.length > THINKING_PREVIEW_TAIL_CHARS
			? `…${text.slice(-THINKING_PREVIEW_TAIL_CHARS)}`
			: text;
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			style={{
				display: "block",
				width: "100%",
				textAlign: "left",
				background: "transparent",
				border: "1px solid var(--border-soft)",
				borderRadius: "var(--r-sm)",
				padding: "6px 8px",
				marginBottom: 4,
				color: expanded ? "var(--fg-2)" : "var(--muted)",
				font: "400 11px/1.5 var(--font-body)",
				cursor: "pointer",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 4,
					marginBottom: expanded ? 4 : 0,
					color: "var(--muted)",
					font: "500 10px/1 var(--font-mono)",
				}}
			>
				<svg
					width={10}
					height={10}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{
						transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
						transition: "transform 120ms ease",
						flex: "0 0 auto",
					}}
					aria-hidden="true"
				>
					<polyline points="9 6 15 12 9 18" />
				</svg>
				<span>{label}</span>
			</div>
			{expanded ? (
				<div
					style={{
						maxHeight: 220,
						overflow: "auto",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						font: "400 11px/1.5 var(--font-mono)",
					}}
				>
					{text}
				</div>
			) : (
				<div
					style={{
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
					}}
				>
					{preview}
				</div>
			)}
		</button>
	);
}

function ChatStripPanel() {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	// The Auto-enhance confirmation is timeline-owned copy, fired from here —
	// see the prompt-bus effect below.
	const tTimeline = useScopedT("timeline");
	const projectId = useProjectStore((s) => s.projectId);
	const documentGeneration = useProjectStore((s) => s.documentGeneration);
	const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [rewindBusy, setRewindBusy] = useState(false);
	const [compactNowPending, setCompactNowPending] = useState(false);
	const [rewindFor, setRewindFor] = useState<{
		messageId: string;
		anchor: { left: number; bottom: number } | null;
	} | null>(null);
	const mountedRef = useRef(true);
	const activeOperationRef = useRef<PanelOperation | null>(null);
	const sessionActionRef = useRef<object | null>(null);
	const [llmConfig, setLlmConfig] = useState<AiEditionLlmConfig | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [sessions, setSessions] = useState<
		Array<{ id: string; title: string; messageCount: number; createdAt: string }>
	>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	// Mirror in a ref so refreshSessions can read the current selection without
	// listing activeSessionId in its deps — otherwise refreshSessions is recreated
	// on every selection change, which re-runs the project effect below (with
	// preferFirst=true) and forces the selection back to list[0]. That feedback
	// loop is what made "new conversation" jump to the oldest chat instead of the
	// freshly-created empty one.
	const activeSessionIdRef = useRef<string | null>(activeSessionId);
	activeSessionIdRef.current = activeSessionId;
	const sessionRevisionRef = useRef(new Map<string, number>());
	const appliedSessionUpdatesRef = useRef(new Set<string>());
	const rewindComposerDeliveriesRef = useRef(new Map<string, RewindComposerDelivery>());
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// ponytail: live reasoning trace for the in-flight turn. Reset at send()
	// start; deltas append through the chat-event subscription; once the run
	// resolves we copy it onto the assistant message and clear it.
	const [thinkingText, setThinkingText] = useState("");
	const thinkingTextRef = useRef("");
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	// sessionId of the in-flight run — late events for prior runs (or for
	// other windows) are ignored so a stale stream can't pollute the new turn.
	const thinkingRunSessionRef = useRef<string | null>(null);
	// Per-message expand state for completed turns. Using a Set keeps the
	// default-collapsed preview lightweight and the click-to-expand obvious.
	const [thinkingExpandedIds, setThinkingExpandedIds] = useState<Set<string>>(() => new Set());
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const reasoningButtonRef = useRef<HTMLButtonElement | null>(null);
	const [reasoningMenuRect, setReasoningMenuRect] = useState<{
		left: number;
		bottom: number;
	} | null>(null);
	const [reasoningBusy, setReasoningBusy] = useState(false);
	// null until the first llmGetSnapshot() lands: "unknown", not "none".
	const [connectedProviders, setConnectedProviders] = useState<string[] | null>(null);
	// unknown ≠ none; see chatAvailability.ts.
	const canChat = canSendChat(llmConfig, connectedProviders);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const modelButtonRef = useRef<HTMLButtonElement | null>(null);
	const [modelPopoverRect, setModelPopoverRect] = useState<{
		left: number;
		bottom: number;
		maxHeight: number;
	} | null>(null);

	const refreshLlm = useCallback(async () => {
		try {
			const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
			setLlmConfig(snap.config);
			setConnectedProviders(snap.connectedProviders);
		} catch {
			// ponytail: silent
		}
	}, []);

	const refreshSessions = useCallback(
		async (pid: string, generation: number, preferFirst = false) => {
			try {
				const list = await nativeBridgeClient.aiEdition.chatListSessions(pid);
				const current = useProjectStore.getState();
				if (
					current.projectId !== pid ||
					current.documentGeneration !== generation ||
					activeOperationRef.current ||
					sessionActionRef.current
				) {
					return;
				}
				setSessions(list);
				if (list.length === 0) {
					setActiveSessionId(null);
					setMessages([]);
					return;
				}
				if (preferFirst || !list.some((s) => s.id === activeSessionIdRef.current)) {
					setActiveSessionId(list[0].id);
				}
			} catch {
				// ponytail: silent — shim mode or missing project
			}
		},
		[],
	);

	useEffect(() => {
		void refreshLlm();
	}, [refreshLlm]);

	const claimRewindComposer = useCallback(
		(projectId: string, sessionId: string, revision: number) => {
			const key = `${projectId}::${sessionId}`;
			const current = useProjectStore.getState();
			if (
				current.projectId !== projectId ||
				activeSessionIdRef.current !== sessionId ||
				sessionRevisionRef.current.get(sessionId) !== revision
			) {
				return;
			}
			const deliveries = rewindComposerDeliveriesRef.current;
			let delivery = deliveries.get(key);
			if (delivery && delivery.revision !== revision) {
				discardRewindComposerDelivery(deliveries, key, delivery);
				delivery = undefined;
			}
			if (!delivery) {
				delivery = {
					revision,
					applied: false,
					claimInFlight: false,
					claimAttempts: 0,
					confirmAttempts: 0,
					retryTimer: null,
				};
				deliveries.set(key, delivery);
			}
			if (delivery.applied || delivery.claimInFlight) return;
			if (delivery.claimAttempts >= REWIND_COMPOSER_RETRY_LIMIT) return;
			clearRewindComposerRetry(delivery);
			const ownsUi = () => {
				const latest = useProjectStore.getState();
				return (
					mountedRef.current &&
					latest.projectId === projectId &&
					activeSessionIdRef.current === sessionId &&
					sessionRevisionRef.current.get(sessionId) === revision &&
					deliveries.get(key) === delivery
				);
			};
			const retryDelay = (attempt: number) =>
				REWIND_COMPOSER_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
			const scheduleRetry = (retry: () => void, delayMs: number): void => {
				if (!ownsUi()) return;
				clearRewindComposerRetry(delivery);
				delivery.retryTimer = setTimeout(
					() => {
						delivery.retryTimer = null;
						if (ownsUi()) retry();
					},
					Math.max(0, Math.min(delayMs, REWIND_COMPOSER_MAX_RETRY_DELAY_MS)),
				);
			};
			const confirm = async (claimId: string): Promise<void> => {
				delivery.confirmAttempts++;
				try {
					const result = await nativeBridgeClient.aiEdition.chatConfirmRewindComposerClaim(claimId);
					if (result.confirmed) clearRewindComposerRetry(delivery);
				} catch {
					if (delivery.confirmAttempts < REWIND_COMPOSER_RETRY_LIMIT && ownsUi()) {
						scheduleRetry(() => void confirm(claimId), retryDelay(delivery.confirmAttempts));
					}
				}
			};
			const claim = async (): Promise<void> => {
				if (!ownsUi() || delivery.claimInFlight) return;
				if (delivery.claimAttempts >= REWIND_COMPOSER_RETRY_LIMIT) return;
				delivery.claimInFlight = true;
				delivery.claimAttempts++;
				let result: Awaited<
					ReturnType<typeof nativeBridgeClient.aiEdition.chatClaimRewindComposer>
				>;
				try {
					result = await nativeBridgeClient.aiEdition.chatClaimRewindComposer(
						projectId,
						sessionId,
						revision,
					);
				} catch {
					delivery.claimInFlight = false;
					if (ownsUi() && delivery.claimAttempts < REWIND_COMPOSER_RETRY_LIMIT) {
						scheduleRetry(() => void claim(), retryDelay(delivery.claimAttempts));
					} else if (!ownsUi()) {
						discardRewindComposerDelivery(deliveries, key, delivery);
					}
					return;
				}
				delivery.claimInFlight = false;
				if (!result.claimed) {
					if (!ownsUi()) {
						discardRewindComposerDelivery(deliveries, key, delivery);
						return;
					}
					if (
						result.leaseExpiresAt !== undefined &&
						delivery.claimAttempts < REWIND_COMPOSER_RETRY_LIMIT
					) {
						scheduleRetry(
							() => void claim(),
							Math.max(REWIND_COMPOSER_RETRY_DELAY_MS, result.leaseExpiresAt - Date.now() + 1),
						);
					}
					return;
				}
				if (!ownsUi()) {
					void nativeBridgeClient.aiEdition
						.chatReleaseRewindComposerClaim(result.claimId)
						.catch(() => undefined);
					discardRewindComposerDelivery(deliveries, key, delivery);
					return;
				}
				if (!delivery.applied) {
					delivery.applied = true;
					clearRewindComposerRetry(delivery);
					setInput(result.prompt);
				}
				await confirm(result.claimId);
			};
			void claim();
		},
		[],
	);

	// ponytail: subscribe to streamed chat events so the reasoning trace (and
	// any future streaming text deltas) lands live instead of arriving all at
	// once when chatRun resolves. We only act on `thinking` here — text deltas
	// are ignored in the renderer today because the chat already renders the
	// final assistant text on chatRun resolve, and a parallel live stream
	// would race the final message. Add `text` handling when that flow lands.
	useEffect(() => {
		const unsubChatEvent = window.electronAPI.onAiEditionChatEvent((event: AiEditionChatEvent) => {
			if (event.kind !== "thinking") return;
			if (event.sessionId !== thinkingRunSessionRef.current) return;
			const operation = activeOperationRef.current;
			if (operation?.kind !== "chat" || event.operationId !== operation.localId) return;
			thinkingTextRef.current += event.delta;
			setThinkingText(thinkingTextRef.current);
		});
		return unsubChatEvent;
	}, []);

	useEffect(() => {
		return window.electronAPI.onAiEditionChatSessionUpdated(
			(event: AiEditionChatSessionUpdatedEvent) => {
				const current = useProjectStore.getState();
				if (
					current.projectId !== projectId ||
					current.documentGeneration !== documentGeneration ||
					event.projectId !== projectId ||
					event.sessionId !== activeSessionIdRef.current
				) {
					return;
				}
				const knownRevision = sessionRevisionRef.current.get(event.sessionId) ?? -1;
				if (
					event.revision < knownRevision ||
					(event.revision === knownRevision &&
						appliedSessionUpdatesRef.current.has(event.operationId))
				) {
					return;
				}
				const deliveryKey = `${event.projectId}::${event.sessionId}`;
				const existingDelivery = rewindComposerDeliveriesRef.current.get(deliveryKey);
				if (existingDelivery && existingDelivery.revision !== event.revision) {
					discardRewindComposerDelivery(
						rewindComposerDeliveriesRef.current,
						deliveryKey,
						existingDelivery,
					);
				}
				sessionRevisionRef.current.set(event.sessionId, event.revision);
				rememberAppliedSessionUpdate(appliedSessionUpdatesRef.current, event.operationId);
				setMessages(toDisplayMessages(event.messages));
				setSessions((previous) =>
					previous.map((session) =>
						session.id === event.sessionId
							? { ...session, messageCount: event.messages.length }
							: session,
					),
				);
				const restoration = event.pendingComposerRestoration;
				if (
					(event.kind === "rewind" || event.kind === "rewind-composer-available") &&
					restoration
				) {
					claimRewindComposer(event.projectId, event.sessionId, restoration.revision);
				}
			},
		);
	}, [projectId, documentGeneration, claimRewindComposer]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearRewindComposerDeliveries(rewindComposerDeliveriesRef.current);
			sessionActionRef.current = null;
			thinkingRunSessionRef.current = null;
			const operation = activeOperationRef.current;
			activeOperationRef.current = null;
			if (!operation) return;
			operation.uiAttached = false;
			if (!operationMustFinish(operation)) {
				operation.cancelled = true;
				requestOperationAbort(operation);
			}
		};
	}, []);

	useEffect(() => {
		const operation = activeOperationRef.current;
		if (operation) {
			activeOperationRef.current = null;
			operation.uiAttached = false;
			const mustFinish = operationMustFinish(operation);
			if (!mustFinish) {
				operation.cancelled = true;
				requestOperationAbort(operation);
				toast.error(t("chat.applyEditsFailed"), {
					description: t("chat.documentChangedDuringOperation"),
				});
			}
		}
		sessionActionRef.current = null;
		setBusy(false);
		setRewindBusy(false);
		setCompactNowPending(false);
		setRewindFor(null);
		thinkingRunSessionRef.current = null;
		sessionRevisionRef.current.clear();
		appliedSessionUpdatesRef.current.clear();
		clearRewindComposerDeliveries(rewindComposerDeliveriesRef.current);
		thinkingTextRef.current = "";
		setThinkingText("");
		if (!projectId) {
			setSessions([]);
			setActiveSessionId(null);
			setMessages([]);
			return;
		}
		void refreshSessions(projectId, documentGeneration, true);
	}, [projectId, documentGeneration, refreshSessions, t]);

	useEffect(() => {
		const activeKey = projectId && activeSessionId ? `${projectId}::${activeSessionId}` : null;
		for (const [key, delivery] of rewindComposerDeliveriesRef.current) {
			if (key !== activeKey) {
				discardRewindComposerDelivery(rewindComposerDeliveriesRef.current, key, delivery);
			}
		}
	}, [projectId, activeSessionId]);

	useEffect(() => {
		if (!projectId || !activeSessionId) {
			setMessages([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const session = await nativeBridgeClient.aiEdition.chatSelectSession(
					projectId,
					activeSessionId,
				);
				const current = useProjectStore.getState();
				if (
					cancelled ||
					activeOperationRef.current ||
					sessionActionRef.current ||
					current.projectId !== projectId ||
					current.documentGeneration !== documentGeneration
				) {
					return;
				}
				if (session) {
					const knownRevision = sessionRevisionRef.current.get(activeSessionId) ?? -1;
					if (session.revision < knownRevision) return;
					const deliveryKey = `${projectId}::${activeSessionId}`;
					const existingDelivery = rewindComposerDeliveriesRef.current.get(deliveryKey);
					if (existingDelivery && existingDelivery.revision !== session.revision) {
						discardRewindComposerDelivery(
							rewindComposerDeliveriesRef.current,
							deliveryKey,
							existingDelivery,
						);
					}
					sessionRevisionRef.current.set(activeSessionId, session.revision);
					setMessages(toDisplayMessages(session.messages));
					const restoration = session.pendingComposerRestoration;
					if (restoration?.revision === session.revision) {
						claimRewindComposer(projectId, activeSessionId, restoration.revision);
					}
				} else {
					setMessages([]);
				}
			} catch {
				// ponytail: silent — shim mode
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId, documentGeneration, activeSessionId, claimRewindComposer]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	});

	// Full documents returned by chat and rewind are snapshots of the launch document. The
	// store validates that immutable version and performs replacement + persistence atomically.
	const applyAgentDocument = useCallback(
		async (doc: unknown, operation: DocumentOperationToken) =>
			useProjectStore.getState().applyDocumentResult(operation, ensureDocument(doc)),
		[],
	);
	const showStaleDocumentResult = useCallback(() => {
		toast.error(t("chat.applyEditsFailed"), {
			description: t("chat.documentChangedDuringOperation"),
		});
	}, [t]);

	const send = async (overrideText?: string) => {
		const text = (overrideText ?? input).trim();
		if (
			!projectId ||
			!text ||
			busy ||
			rewindBusy ||
			activeOperationRef.current ||
			sessionActionRef.current
		) {
			return;
		}
		// ponytail: nothing to talk to. Bounce to the settings modal instead of
		// firing a doomed request. The composer is disabled in this state too,
		// but Auto-enhance calls send() directly and Enter can slip through.
		if (!canChat) {
			toast.error(t("chat.composerDisabledNoProvider"));
			setSettingsOpen(true);
			return;
		}
		const launchState = useProjectStore.getState();
		if (launchState.projectId !== projectId || launchState.status !== "ready") return;
		const documentOperation: DocumentOperationToken = {
			projectId,
			documentGeneration: launchState.documentGeneration,
			revision: launchState.revision,
		};
		const documentSnapshot =
			launchState.document?.project.id === projectId ? launchState.document : undefined;
		const localOperationId = createPanelOperationId("chat");
		const operation: PanelOperation = {
			localId: localOperationId,
			kind: "chat",
			projectId,
			sessionId: activeSessionId,
			remoteId: null,
			phase: "starting",
			cancelled: false,
			uiAttached: true,
			abortRequested: false,
		};
		activeOperationRef.current = operation;
		setInput("");
		setBusy(true);
		// ponytail: prepare the live reasoning-trace accumulator. Late events
		// from a previous run (or from another panel/window) won't match this
		// sessionId and are dropped by the subscription above.
		thinkingTextRef.current = "";
		setThinkingText("");
		setThinkingExpanded(false);
		thinkingRunSessionRef.current = null;
		// ponytail: pre-seed the user message so the rewind ↩ button is
		// available before the server confirms. Mirrors axcut's
		// `before-message` checkpoint that runChat records in chat-service.
		const optimisticUserId = `${localOperationId}_user`;
		setMessages((prev) => [
			...prev,
			{
				id: optimisticUserId,
				role: "user",
				content: text,
				time: new Date().toLocaleTimeString(),
				checkpointId: optimisticUserId,
			},
		]);
		let canonicalUserId: string | null = null;
		const ownsUi = () =>
			mountedRef.current && operation.uiAttached && activeOperationRef.current === operation;
		const documentStillMatches = (applied: boolean) => {
			const current = useProjectStore.getState();
			return (
				current.projectId === documentOperation.projectId &&
				current.documentGeneration === documentOperation.documentGeneration &&
				current.revision === documentOperation.revision + (applied ? 1 : 0)
			);
		};
		const removeOptimisticMessage = (stale: boolean): boolean => {
			if (!ownsUi()) return false;
			setMessages((prev) =>
				prev.filter((message) => message.id !== optimisticUserId && message.id !== canonicalUserId),
			);
			if (stale) showStaleDocumentResult();
			return true;
		};
		const abortRunBeforePersistence = async (stale: boolean): Promise<boolean> => {
			if (operation.sessionId && operation.remoteId && !operation.abortRequested) {
				operation.abortRequested = true;
				try {
					await nativeBridgeClient.aiEdition.chatAbortRun(
						projectId,
						operation.sessionId,
						operation.remoteId,
					);
				} catch {
					// Expiry or an already-aborted operation needs no second error.
				}
			}
			return removeOptimisticMessage(stale);
		};
		const resolvePersistence = async (
			outcome: AiEditionChatPersistenceResolution,
			stale: boolean,
		): Promise<void> => {
			if (operation.sessionId && operation.remoteId) {
				try {
					await nativeBridgeClient.aiEdition.chatResolvePersistence(
						projectId,
						operation.sessionId,
						operation.remoteId,
						outcome,
					);
				} catch {
					// The non-expiring main-side fence remains safe if this acknowledgement is lost.
				}
			}
			removeOptimisticMessage(stale);
		};
		const reloadCanonicalSession = async (): Promise<void> => {
			if (!ownsUi() || !operation.sessionId) return;
			try {
				const session = await nativeBridgeClient.aiEdition.chatSelectSession(
					projectId,
					operation.sessionId,
				);
				if (!ownsUi()) return;
				if (!session) {
					setMessages([]);
					setSessions((previous) => previous.filter((item) => item.id !== operation.sessionId));
					if (activeSessionIdRef.current === operation.sessionId) setActiveSessionId(null);
					return;
				}
				sessionRevisionRef.current.set(session.id, session.revision);
				setMessages(toDisplayMessages(session.messages));
				if (session.pendingComposerRestoration?.revision === session.revision) {
					claimRewindComposer(projectId, session.id, session.revision);
				}
			} catch {
				// A process restart is represented by an unavailable/empty in-memory session.
			}
		};
		try {
			// Mirror axcut's `getOrCreateSession`: the composer works with zero
			// setup, so the first message on a project with no sessions yet
			// silently starts one instead of no-op'ing.
			let sessionId = activeSessionId;
			if (!sessionId) {
				const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
				if (operation.cancelled || !ownsUi()) {
					void nativeBridgeClient.aiEdition
						.chatDeleteSession(projectId, created.id)
						.catch(() => undefined);
					return;
				}
				if (!documentStillMatches(false)) {
					void nativeBridgeClient.aiEdition
						.chatDeleteSession(projectId, created.id)
						.catch(() => undefined);
					if (ownsUi()) {
						setMessages((prev) => prev.filter((message) => message.id !== optimisticUserId));
						showStaleDocumentResult();
					}
					return;
				}
				sessionId = created.id;
				setSessions((prev) => [...prev, created]);
				setActiveSessionId(sessionId);
			}
			if (operation.cancelled || !ownsUi()) return;
			operation.sessionId = sessionId;
			operation.remoteId = localOperationId;
			operation.phase = "running";
			// ponytail: start collecting the live reasoning trace for THIS run —
			// the subscription only appends deltas whose sessionId matches.
			thinkingRunSessionRef.current = sessionId;
			// Send exactly the document version represented by documentOperation so a later result
			// can only replace the same unchanged version.
			const runPromise = nativeBridgeClient.aiEdition.chatRun(
				projectId,
				sessionId,
				text,
				documentSnapshot,
				localOperationId,
			);
			const result = await runPromise;
			if (operation.cancelled || !ownsUi()) {
				await abortRunBeforePersistence(false);
				return;
			}
			const assistant = result.assistantMessage;
			if (result.success && assistant) {
				canonicalUserId = result.userMessageCheckpointId ?? null;
				setMessages((prev) =>
					prev.map((message) =>
						message.id === optimisticUserId
							? {
									...message,
									id: canonicalUserId ?? optimisticUserId,
									checkpointId: canonicalUserId,
								}
							: message,
					),
				);
				let persistenceAlreadyCommitted = false;
				if (result.document) {
					operation.phase = "persisting";
					const persistenceStart = await beginPersistenceBounded(
						projectId,
						sessionId,
						localOperationId,
					);
					if (persistenceStart === "committed") {
						persistenceAlreadyCommitted = true;
					} else if (persistenceStart !== "started") {
						await reloadCanonicalSession();
						return;
					}
					try {
						if (!persistenceAlreadyCommitted) {
							const outcome = await applyAgentDocument(result.document, documentOperation);
							if (!outcome.success) {
								await resolvePersistence(
									outcome.status === "stale"
										? "not-persisted"
										: outcome.status === "superseded"
											? "superseded"
											: "failed",
									outcome.status === "stale" || outcome.status === "superseded",
								);
								if (outcome.status === "diverged" && ownsUi()) {
									toast.error(t("chat.applyEditsFailed"), { description: outcome.error });
								}
								return;
							}
						}
					} catch (err) {
						await resolvePersistence("failed", false);
						if (ownsUi()) {
							toast.error(t("chat.applyEditsFailed"), {
								description: err instanceof Error ? err.message : String(err),
							});
						}
						await reloadCanonicalSession();
						return;
					}
				} else if (!documentStillMatches(false)) {
					await abortRunBeforePersistence(true);
					return;
				}
				operation.phase = "committing";
				const resolution = await reconcileAmbiguousCommit<SuccessfulChatCommit>({
					kind: "chat",
					commit: () =>
						nativeBridgeClient.aiEdition.chatCommitRun(projectId, sessionId, localOperationId),
					status: () =>
						nativeBridgeClient.aiEdition.chatOperationStatus(
							projectId,
							sessionId,
							localOperationId,
						),
				});
				if (resolution.state !== "committed") {
					await reloadCanonicalSession();
					if (resolution.state === "aborted" && ownsUi()) {
						toast.error(t("chat.chatFailed"), { description: resolution.error });
					}
					return;
				}
				if (ownsUi()) {
					const committedMessages = toDisplayMessages(resolution.result.messages);
					const completedThinking = thinkingTextRef.current;
					if (completedThinking) {
						const committedAssistant = committedMessages.find(
							(message) => message.id === assistant.id,
						);
						if (committedAssistant) committedAssistant.thinking = completedThinking;
					}
					sessionRevisionRef.current.set(sessionId, resolution.result.sessionRevision);
					rememberAppliedSessionUpdate(appliedSessionUpdatesRef.current, localOperationId);
					setMessages(committedMessages);
					setSessions((previous) =>
						previous.map((session) =>
							session.id === sessionId
								? { ...session, messageCount: resolution.result.messages.length }
								: session,
						),
					);
				}
				void refreshSessions(projectId, documentOperation.documentGeneration);
			} else {
				if (await abortRunBeforePersistence(false)) {
					toast.error(result.error ?? t("chat.chatFailed"));
				}
			}
		} catch (err) {
			if (operationMustFinish(operation)) {
				await reloadCanonicalSession();
				return;
			}
			if (operation.sessionId && !(await abortRunBeforePersistence(false))) return;
			if (!ownsUi()) return;
			toast.error(t("chat.chatFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			operation.phase = "settled";
			if (ownsUi()) {
				activeOperationRef.current = null;
				setBusy(false);
				// ponytail: stop accepting thinking deltas and drop the in-flight
				// preview — the snapshot was either attached to the assistant
				// message above, or there's no message to attach it to (failure).
				thinkingRunSessionRef.current = null;
				thinkingTextRef.current = "";
				setThinkingText("");
				setThinkingExpanded(false);
			}
		}
	};

	// Auto-send a prompt handed over by another part of the UI (e.g. the
	// timeline's Auto-enhance → "Smart zooms + cuts with AI"). Routes through
	// the normal send() so sessions/checkpoints/rewind all keep working; the
	// message shows in the composer's history exactly as if typed.
	// The confirmation toast lives here because only this side knows the prompt
	// was taken — send() bounces it to the settings modal with no provider.
	// ponytail: one producer today, so the toast copy is assumed to be its own.
	// A second producer needs the bus to carry its confirmation string.
	const pendingPrompt = useChatPromptBus((s) => s.pending);
	const consumePrompt = useChatPromptBus((s) => s.consume);
	// biome-ignore lint/correctness/useExhaustiveDependencies: send() is intentionally not a dep (recreated each render); consume() clears `pending` so this fires once per queued prompt.
	useEffect(() => {
		if (
			!pendingPrompt ||
			!projectId ||
			busy ||
			rewindBusy ||
			activeOperationRef.current ||
			sessionActionRef.current
		) {
			return;
		}
		consumePrompt();
		if (canChat) toast.success(tTimeline("toolbar.aiEnhanceRequested"));
		void send(pendingPrompt);
	}, [pendingPrompt, projectId, busy, rewindBusy, consumePrompt, canChat, tTimeline]);

	// ponytail: per-user-message rewind. Pops a confirmation popover, then
	// asks the main process to roll the session + document back to the
	// snapshot taken right before the user hit Send. axcut parity.
	const confirmRewind = useCallback(
		async (messageId: string) => {
			if (
				!projectId ||
				!activeSessionId ||
				busy ||
				rewindBusy ||
				activeOperationRef.current ||
				sessionActionRef.current
			) {
				return;
			}
			const launchState = useProjectStore.getState();
			if (launchState.projectId !== projectId || launchState.status !== "ready") return;
			const documentOperation: DocumentOperationToken = {
				projectId,
				documentGeneration: launchState.documentGeneration,
				revision: launchState.revision,
			};
			const localOperationId = createPanelOperationId("rewind");
			const operation: PanelOperation = {
				localId: localOperationId,
				kind: "rewind",
				projectId,
				sessionId: activeSessionId,
				remoteId: null,
				phase: "starting",
				cancelled: false,
				uiAttached: true,
				abortRequested: false,
			};
			activeOperationRef.current = operation;
			setRewindBusy(true);
			const ownsUi = () =>
				mountedRef.current && operation.uiAttached && activeOperationRef.current === operation;
			const abortPrepared = async (): Promise<boolean> => {
				if (operation.remoteId && !operation.abortRequested) {
					operation.abortRequested = true;
					try {
						await nativeBridgeClient.aiEdition.chatAbortRewind(
							projectId,
							activeSessionId,
							operation.remoteId,
						);
					} catch {
						// Expiry or an already-aborted preparation needs no second error.
					}
				}
				return ownsUi();
			};
			const resolvePersistence = async (
				outcome: AiEditionChatPersistenceResolution,
			): Promise<void> => {
				if (operation.remoteId) {
					try {
						await nativeBridgeClient.aiEdition.chatResolvePersistence(
							projectId,
							activeSessionId,
							operation.remoteId,
							outcome,
						);
					} catch {
						// The non-expiring main-side fence remains safe if this acknowledgement is lost.
					}
				}
			};
			const reloadCanonicalSession = async (): Promise<void> => {
				if (!ownsUi()) return;
				try {
					const session = await nativeBridgeClient.aiEdition.chatSelectSession(
						projectId,
						activeSessionId,
					);
					if (!ownsUi()) return;
					if (!session) {
						setMessages([]);
						setSessions((previous) => previous.filter((item) => item.id !== activeSessionId));
						setActiveSessionId(null);
						return;
					}
					sessionRevisionRef.current.set(session.id, session.revision);
					setMessages(toDisplayMessages(session.messages));
					if (session.pendingComposerRestoration?.revision === session.revision) {
						claimRewindComposer(projectId, session.id, session.revision);
					}
				} catch {
					// A restarted main process has no in-memory session to recover.
				}
			};
			try {
				const prepared = await nativeBridgeClient.aiEdition.chatPrepareRewind(
					projectId,
					activeSessionId,
					messageId,
				);
				if (!prepared.success) {
					if (!ownsUi()) return;
					toast.error(prepared.error ?? t("chat.rewindFailed"));
					return;
				}
				operation.remoteId = prepared.operationId;
				if (operation.cancelled || !ownsUi()) {
					await abortPrepared();
					return;
				}
				operation.phase = "persisting";
				const persistenceStart = await beginPersistenceBounded(
					projectId,
					activeSessionId,
					prepared.operationId,
				);
				if (persistenceStart !== "started" && persistenceStart !== "committed") {
					await reloadCanonicalSession();
					return;
				}

				if (persistenceStart !== "committed") {
					try {
						const outcome = await applyAgentDocument(prepared.document, documentOperation);
						if (!outcome.success) {
							await resolvePersistence(
								outcome.status === "stale"
									? "not-persisted"
									: outcome.status === "superseded"
										? "superseded"
										: "failed",
							);
							if (ownsUi()) {
								if (outcome.status === "stale" || outcome.status === "superseded") {
									showStaleDocumentResult();
								} else toast.error(t("chat.rewindFailed"), { description: outcome.error });
							}
							return;
						}
					} catch (error) {
						await resolvePersistence("failed");
						if (ownsUi()) {
							toast.error(t("chat.rewindFailed"), {
								description: error instanceof Error ? error.message : String(error),
							});
						}
						await reloadCanonicalSession();
						return;
					}
				}
				operation.phase = "committing";
				const resolution = await reconcileAmbiguousCommit<SuccessfulRewindCommit>({
					kind: "rewind",
					commit: () =>
						nativeBridgeClient.aiEdition.chatCommitRewind(
							projectId,
							activeSessionId,
							prepared.operationId,
							prepared.sessionRevision,
						),
					status: () =>
						nativeBridgeClient.aiEdition.chatOperationStatus(
							projectId,
							activeSessionId,
							prepared.operationId,
						),
				});
				if (resolution.state !== "committed") {
					await reloadCanonicalSession();
					if (resolution.state === "aborted" && ownsUi()) {
						toast.error(resolution.error || t("chat.rewindFailed"));
					}
					return;
				}
				if (ownsUi()) {
					sessionRevisionRef.current.set(activeSessionId, resolution.result.sessionRevision);
					rememberAppliedSessionUpdate(appliedSessionUpdatesRef.current, prepared.operationId);
					setMessages(toDisplayMessages(resolution.result.messages));
					claimRewindComposer(
						projectId,
						activeSessionId,
						resolution.result.pendingComposerRestoration.revision,
					);
					toast.success(t("chat.rewoundSuccess"));
				}
			} catch (err) {
				if (operationMustFinish(operation)) {
					await reloadCanonicalSession();
					return;
				}
				if (!(await abortPrepared())) return;
				toast.error(t("chat.rewindFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				operation.phase = "settled";
				if (ownsUi()) {
					activeOperationRef.current = null;
					setRewindBusy(false);
					setRewindFor(null);
				}
			}
		},
		[
			projectId,
			activeSessionId,
			busy,
			rewindBusy,
			applyAgentDocument,
			claimRewindComposer,
			showStaleDocumentResult,
			t,
		],
	);

	useEffect(() => {
		if (!rewindFor) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("[data-rewind-confirmation], [data-rewind-trigger]")) {
				return;
			}
			setRewindFor(null);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRewindFor(null);
		};
		globalThis.document.addEventListener("pointerdown", handlePointerDown);
		globalThis.document.addEventListener("keydown", handleKeyDown);
		return () => {
			globalThis.document.removeEventListener("pointerdown", handlePointerDown);
			globalThis.document.removeEventListener("keydown", handleKeyDown);
		};
	}, [rewindFor]);

	const modelLabel = llmConfig ? llmConfig.model : t("chat.configureModel");
	const providerSupportsReasoning = Boolean(
		llmConfig &&
			PROVIDER_DEFINITIONS.find((d) => d.id === llmConfig.provider)?.supportsReasoningEffort,
	);
	const currentReasoningEffort: ReasoningEffort =
		(llmConfig?.reasoningEffort as ReasoningEffort | undefined) ?? "medium";
	const reasoningLabel =
		providerSupportsReasoning && llmConfig
			? getReasoningEffortLabel(llmConfig.provider, currentReasoningEffort)
			: null;

	const selectReasoningEffort = useCallback(
		async (effort: ReasoningEffort) => {
			if (!llmConfig) return;
			setReasoningBusy(true);
			try {
				const result = await nativeBridgeClient.aiEdition.llmSetConfig({
					...llmConfig,
					reasoningEffort: effort,
				});
				if (result.success) {
					setLlmConfig({ ...llmConfig, reasoningEffort: effort });
					setReasoningOpen(false);
				} else {
					toast.error(result.error ?? t("chat.reasoningEffortUpdateFailed"));
				}
			} catch (err) {
				toast.error(t("chat.reasoningEffortUpdateFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setReasoningBusy(false);
			}
		},
		[llmConfig, t],
	);

	const toggleReasoningOpen = useCallback(() => {
		setReasoningOpen((wasOpen) => {
			if (!wasOpen) {
				const rect = reasoningButtonRef.current?.getBoundingClientRect();
				if (rect) {
					setReasoningMenuRect({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
				}
			}
			return !wasOpen;
		});
	}, []);

	const toggleModelPopoverOpen = useCallback(() => {
		// Mirrors axcut's providerButtonRef handler: with no provider configured
		// yet there's nothing to quick-pick a model from, so go straight to the
		// full settings modal (the "providers" screen) instead of toggling a
		// popover that would render empty.
		if (!llmConfig) {
			setSettingsOpen(true);
			return;
		}
		setModelPopoverOpen((wasOpen) => {
			if (!wasOpen) {
				const rect = modelButtonRef.current?.getBoundingClientRect();
				if (rect) {
					// The popover opens upward from the pill and can hold a long,
					// scrollable model list — cap its height to the space actually
					// available above the button so it never overflows off the top
					// of the window (only "bottom" is set; nothing clamps "top").
					setModelPopoverRect({
						left: rect.left,
						bottom: window.innerHeight - rect.top + 4,
						maxHeight: Math.max(160, rect.top - 12),
					});
				}
			}
			return !wasOpen;
		});
	}, [llmConfig]);

	// Real context usage — feeds the badge in the chat strip and gates the
	// auto-compact heuristic on the main side. Recomputed on every messages
	// change so the % tracks the live history.
	const budget = computeBudget(messages);

	const compactNow = useCallback(async () => {
		if (
			!projectId ||
			!activeSessionId ||
			compactNowPending ||
			activeOperationRef.current ||
			sessionActionRef.current
		) {
			return;
		}
		const token = {};
		const generation = useProjectStore.getState().documentGeneration;
		sessionActionRef.current = token;
		const ownsUi = () => {
			const current = useProjectStore.getState();
			return (
				mountedRef.current &&
				sessionActionRef.current === token &&
				current.projectId === projectId &&
				current.documentGeneration === generation
			);
		};
		setCompactNowPending(true);
		try {
			const result = await nativeBridgeClient.aiEdition.chatCompact(projectId, activeSessionId);
			if (!ownsUi()) return;
			if (!result) {
				toast.info(t("chat.notEnoughHistory"));
				return;
			}
			setMessages(
				result.session.messages.map((m) => ({
					id: m.id,
					role: m.role,
					content: m.content,
					time: m.createdAt,
					toolCalls: m.toolCalls,
					checkpointId: m.checkpointId ?? null,
				})),
			);
			toast.success(t("chat.compactedSuccess"));
		} catch (err) {
			if (!ownsUi()) return;
			toast.error(t("chat.compactFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			if (sessionActionRef.current === token) {
				sessionActionRef.current = null;
				if (mountedRef.current) setCompactNowPending(false);
			}
		}
	}, [projectId, activeSessionId, compactNowPending, t]);

	const newChat = useCallback(async () => {
		if (!projectId || activeOperationRef.current || sessionActionRef.current) return;
		const token = {};
		const generation = useProjectStore.getState().documentGeneration;
		sessionActionRef.current = token;
		const ownsUi = () => {
			const current = useProjectStore.getState();
			return (
				mountedRef.current &&
				sessionActionRef.current === token &&
				current.projectId === projectId &&
				current.documentGeneration === generation
			);
		};
		try {
			const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
			if (!ownsUi()) {
				void nativeBridgeClient.aiEdition
					.chatDeleteSession(projectId, created.id)
					.catch(() => undefined);
				return;
			}
			setSessions((prev) => [...prev, created]);
			setActiveSessionId(created.id);
			setMessages([]);
		} catch (err) {
			if (!ownsUi()) return;
			toast.error(t("chat.createSessionFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			if (sessionActionRef.current === token) sessionActionRef.current = null;
		}
	}, [projectId, t]);

	const selectSession = useCallback((id: string) => {
		if (activeOperationRef.current || sessionActionRef.current) return;
		setActiveSessionId(id);
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!projectId || activeOperationRef.current || sessionActionRef.current) return;
			const token = {};
			const generation = useProjectStore.getState().documentGeneration;
			sessionActionRef.current = token;
			const ownsUi = () => {
				const current = useProjectStore.getState();
				return (
					mountedRef.current &&
					sessionActionRef.current === token &&
					current.projectId === projectId &&
					current.documentGeneration === generation
				);
			};
			try {
				const res = await nativeBridgeClient.aiEdition.chatDeleteSession(projectId, id);
				if (!ownsUi() || !res.success) return;
				setSessions((prev) => prev.filter((s) => s.id !== id));
				if (activeSessionId === id) {
					setActiveSessionId(null);
					setMessages([]);
				}
			} catch (err) {
				if (!ownsUi()) return;
				toast.error(t("chat.deleteSessionFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				if (sessionActionRef.current === token) sessionActionRef.current = null;
			}
		},
		[projectId, activeSessionId, t],
	);

	const handleRename = useCallback(
		async (id: string, title: string) => {
			if (!projectId || activeOperationRef.current || sessionActionRef.current) return;
			const trimmed = title.trim();
			if (!trimmed) return;
			const token = {};
			const generation = useProjectStore.getState().documentGeneration;
			sessionActionRef.current = token;
			const ownsUi = () => {
				const current = useProjectStore.getState();
				return (
					mountedRef.current &&
					sessionActionRef.current === token &&
					current.projectId === projectId &&
					current.documentGeneration === generation
				);
			};
			try {
				const updated = await nativeBridgeClient.aiEdition.chatRenameSession(
					projectId,
					id,
					trimmed,
				);
				if (ownsUi() && updated) {
					setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
				}
			} catch (err) {
				if (!ownsUi()) return;
				toast.error(t("chat.renameSessionFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				if (sessionActionRef.current === token) sessionActionRef.current = null;
			}
		},
		[projectId, t],
	);

	// ponytail: inline session rename. Click the title to edit, Enter saves,
	// Escape cancels, blur saves when the value is non-empty (axcut parity).
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");
	const editingInputRef = useRef<HTMLInputElement | null>(null);
	const beginEditTitle = useCallback((id: string, currentTitle: string) => {
		setEditingSessionId(id);
		setEditingTitle(currentTitle);
	}, []);
	const cancelEditTitle = useCallback(() => {
		setEditingSessionId(null);
		setEditingTitle("");
	}, []);
	const commitEditTitle = useCallback(
		async (id: string) => {
			const next = editingTitle.trim();
			if (!next) {
				cancelEditTitle();
				return;
			}
			setEditingSessionId(null);
			await handleRename(id, next);
		},
		[editingTitle, handleRename, cancelEditTitle],
	);

	return (
		<aside className={styles.panel}>
			<div className={styles.panelHeader}>
				<div className={styles.chatStrip}>
					<div className={styles.chatStripRow}>
						<span
							className={styles.ctxPill}
							title={t("chat.contextTooltip", {
								usedTokens: budget.usedTokens,
								budgetTokens: budget.budgetTokens,
							})}
						>
							<span className={styles.d} aria-hidden />
							{t("chat.contextPercent", { percent: Math.min(100, Math.round(budget.ratio * 100)) })}
						</span>
						<span className={styles.stripActions}>
							<button
								type="button"
								title={t("chat.compactContext")}
								aria-label={t("chat.compactContext")}
								className={styles.iconBtn}
								onClick={() => void compactNow()}
								disabled={!activeSessionId || compactNowPending}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M8 4l4 4 4-4" />
									<path d="M8 20l4-4 4 4" />
									<path d="M6 12h12" />
								</svg>
							</button>
							<button
								type="button"
								title={t("chat.aiSettings")}
								aria-label={t("chat.aiSettings")}
								onClick={() => setSettingsOpen(true)}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<circle cx="12" cy="12" r="3" />
									<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
								</svg>
							</button>
							<button
								type="button"
								title={t("chat.history")}
								aria-label={t("chat.history")}
								onClick={() => setChatsOpen(true)}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
									<path d="M3 3v5h5" />
									<path d="M12 7v5l4 2" />
								</svg>
							</button>
							<button
								type="button"
								title={t("chat.newConversation")}
								aria-label={t("chat.newConversation")}
								onClick={newChat}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
									<path d="M12 7v6" />
									<path d="M9 10h6" />
								</svg>
							</button>
						</span>
					</div>
				</div>

				{activeSessionId ? (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "6px var(--sp-3)",
							borderTop: "1px solid var(--border-soft)",
							background: "var(--surface-warm)",
						}}
					>
						{editingSessionId === activeSessionId ? (
							<input
								ref={editingInputRef}
								type="text"
								autoFocus
								value={editingTitle}
								onChange={(event) => setEditingTitle(event.target.value)}
								onFocus={(event) => event.currentTarget.select()}
								onBlur={() => {
									if (editingSessionId) void commitEditTitle(editingSessionId);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										if (editingSessionId) void commitEditTitle(editingSessionId);
									} else if (event.key === "Escape") {
										event.preventDefault();
										cancelEditTitle();
									}
								}}
								style={{
									font: "500 12px/1.3 var(--font-body)",
									color: "var(--fg)",
									background: "var(--surface)",
									border: "1px solid var(--accent)",
									borderRadius: "var(--r-sm)",
									padding: "2px 6px",
									flex: 1,
									minWidth: 0,
								}}
							/>
						) : (
							<span
								style={{
									font: "500 12px/1.3 var(--font-body)",
									color: "var(--fg-2)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									flex: 1,
									cursor: "text",
								}}
								title={t("chat.clickToRename")}
								onClick={() => {
									const current = sessions.find((s) => s.id === activeSessionId);
									if (current) beginEditTitle(activeSessionId, current.title);
								}}
							>
								{sessions.find((s) => s.id === activeSessionId)?.title ??
									t("chat.untitledConversation")}
							</span>
						)}
						<button
							type="button"
							title={t("chat.renameConversation")}
							aria-label={t("chat.renameConversation")}
							disabled={editingSessionId === activeSessionId}
							onClick={() => {
								const current = sessions.find((s) => s.id === activeSessionId);
								if (current) beginEditTitle(activeSessionId, current.title);
							}}
							style={{
								background: "transparent",
								border: 0,
								color: "var(--meta)",
								cursor: "pointer",
								padding: 2,
							}}
						>
							<svg
								width={12}
								height={12}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M12 20h9" />
								<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
							</svg>
						</button>
						<button
							type="button"
							title={t("chat.deleteConversation")}
							aria-label={t("chat.deleteConversation")}
							onClick={() => {
								const current = sessions.find((s) => s.id === activeSessionId);
								if (!current) return;
								if (window.confirm(t("chat.confirmDeleteConversation", { title: current.title }))) {
									void handleDelete(activeSessionId);
								}
							}}
							style={{
								background: "transparent",
								border: 0,
								color: "var(--meta)",
								cursor: "pointer",
								padding: 2,
							}}
						>
							<svg
								width={12}
								height={12}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<polyline points="3 6 5 6 21 6" />
								<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
								<path d="M10 11v6" />
								<path d="M14 11v6" />
								<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
							</svg>
						</button>
					</div>
				) : null}
			</div>

			<div className={styles.panelBody} ref={scrollRef}>
				{!canChat && messages.length === 0 ? (
					<ChatWelcome onOpenProviderSettings={() => setSettingsOpen(true)} />
				) : messages.length === 0 ? (
					<p
						style={{
							font: "400 12px var(--font-body)",
							color: "var(--muted)",
							padding: "24px var(--sp-4)",
							textAlign: "center",
							lineHeight: 1.5,
						}}
					>
						{t("chat.emptyState")}
					</p>
				) : (
					<>
						{messages.map((m, i) => (
							<div className={styles.msg} key={i}>
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>
										{m.role === "user" ? t("chat.authorUser") : t("chat.authorAssistant")}
									</span>
									{m.time ? (
										<span
											className="right"
											style={{ font: "500 10px/1 var(--font-mono)", color: "var(--muted)" }}
										>
											{m.time}
										</span>
									) : null}
								</div>
								{m.thinking && m.role !== "user" ? (
									<ThinkingBlock
										text={m.thinking}
										expanded={m.id !== undefined && thinkingExpandedIds.has(m.id)}
										onToggle={() => {
											if (!m.id) return;
											setThinkingExpandedIds((prev) => {
												const next = new Set(prev);
												if (next.has(m.id!)) {
													next.delete(m.id!);
												} else {
													next.add(m.id!);
												}
												return next;
											});
										}}
										label={t("chat.thinking")}
									/>
								) : null}
								<div className={styles.msgBubble}>{m.content}</div>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 4,
										marginTop: 4,
										justifyContent: "flex-end",
									}}
								>
									{m.role === "user" && m.checkpointId ? (
										<button
											type="button"
											data-rewind-trigger="true"
											title={t("chat.rewindToMessage")}
											aria-label={t("chat.rewindToMessage")}
											aria-expanded={rewindFor?.messageId === m.id}
											disabled={busy || rewindBusy}
											onClick={(event) => {
												if (busy || rewindBusy || activeOperationRef.current) return;
												const rect = event.currentTarget.getBoundingClientRect();
												setRewindFor({
													messageId: m.id ?? "",
													anchor: {
														left: rect.left + rect.width / 2,
														bottom: window.innerHeight - rect.top + 6,
													},
												});
											}}
											style={{
												width: 22,
												height: 22,
												display: "inline-flex",
												alignItems: "center",
												justifyContent: "center",
												background: "transparent",
												border: "1px solid var(--border-soft)",
												borderRadius: "var(--r-sm)",
												color: "var(--fg-2)",
												cursor: "pointer",
											}}
										>
											<svg
												width={12}
												height={12}
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M3 7v6h6" />
												<path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
											</svg>
										</button>
									) : null}
									<button
										type="button"
										title={t("chat.copyMessage")}
										aria-label={t("chat.copyMessage")}
										onClick={() => {
											void navigator.clipboard.writeText(m.content).then(
												() => toast.success(t("chat.copiedToClipboard")),
												() => toast.error(t("chat.copyFailed")),
											);
										}}
										style={{
											width: 22,
											height: 22,
											display: "inline-flex",
											alignItems: "center",
											justifyContent: "center",
											background: "transparent",
											border: "1px solid var(--border-soft)",
											borderRadius: "var(--r-sm)",
											color: "var(--fg-2)",
											cursor: "pointer",
										}}
									>
										<svg
											width={12}
											height={12}
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<rect x="9" y="9" width="13" height="13" rx="2" />
											<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
										</svg>
									</button>
								</div>
								{m.toolCalls?.length ? (
									<div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
										{m.toolCalls.map((call, j) => (
											<div
												key={j}
												style={{
													font: "500 10px/1.5 var(--font-mono)",
													color: "var(--success)",
												}}
											>
												{t("chat.appliedPrefix")} {call.summary}
											</div>
										))}
									</div>
								) : null}
							</div>
						))}
						{busy ? (
							<div className={styles.msg} aria-live="polite">
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>{t("chat.authorAssistant")}</span>
								</div>
								{thinkingText ? (
									<div
										style={{
											display: "flex",
											alignItems: "flex-start",
											gap: 6,
										}}
									>
										<Loader2
											size={12}
											className="animate-spin"
											style={{
												marginTop: 10,
												flex: "0 0 auto",
												color: "var(--muted)",
											}}
										/>
										<div style={{ flex: 1, minWidth: 0 }}>
											<ThinkingBlock
												text={thinkingText}
												expanded={thinkingExpanded}
												onToggle={() => setThinkingExpanded((v) => !v)}
												label={t("chat.thinking")}
											/>
										</div>
									</div>
								) : (
									<div
										className={styles.msgBubble}
										style={{ color: "var(--muted)", fontStyle: "italic" }}
									>
										<Loader2
											size={12}
											className="animate-spin"
											style={{ marginRight: 6, verticalAlign: "middle" }}
										/>
										{t("chat.thinking")}
									</div>
								)}
							</div>
						) : null}
					</>
				)}
			</div>

			<div className={styles.chatInput}>
				<textarea
					placeholder={
						canChat ? t("chat.composerPlaceholder") : t("chat.composerDisabledNoProvider")
					}
					value={input}
					disabled={!canChat || rewindBusy}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<div className={styles.actions}>
					<button
						ref={modelButtonRef}
						type="button"
						className={styles.modelPicker}
						aria-label={t("chat.modelLabel")}
						aria-haspopup="menu"
						aria-expanded={modelPopoverOpen}
						onClick={toggleModelPopoverOpen}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="3" y1="6" x2="21" y2="6" />
							<line x1="3" y1="12" x2="21" y2="12" />
							<line x1="3" y1="18" x2="21" y2="18" />
						</svg>
						<span>{modelLabel}</span>
					</button>
					{reasoningLabel ? (
						<button
							ref={reasoningButtonRef}
							type="button"
							className={styles.reasoningBtn}
							aria-label={t("chat.reasoningEffortLabel")}
							aria-haspopup="menu"
							aria-expanded={reasoningOpen}
							onClick={toggleReasoningOpen}
						>
							<span className={styles.chip}>
								<span className={styles.d} />
								{reasoningLabel}
							</span>
						</button>
					) : null}
					{reasoningOpen && reasoningMenuRect
						? createPortal(
								<div
									role="menu"
									style={{
										position: "fixed",
										left: reasoningMenuRect.left,
										bottom: reasoningMenuRect.bottom,
										minWidth: 160,
										background: "var(--surface)",
										border: "1px solid var(--border)",
										borderRadius: "var(--r-md)",
										boxShadow: "var(--elev-pop)",
										padding: 4,
										zIndex: 1000,
									}}
								>
									{getReasoningEffortOptions(llmConfig?.provider ?? "").map((option) => (
										<button
											type="button"
											key={option}
											role="menuitem"
											disabled={reasoningBusy}
											onClick={() => void selectReasoningEffort(option)}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 8,
												width: "100%",
												padding: "6px 10px",
												border: "none",
												background:
													option === currentReasoningEffort ? "var(--surface-3)" : "transparent",
												color: "var(--fg)",
												borderRadius: "var(--r-sm)",
												cursor: "pointer",
												fontSize: 12.5,
											}}
										>
											{getReasoningEffortLabel(llmConfig?.provider ?? "", option)}
											{option === currentReasoningEffort ? <Check size={12} /> : null}
										</button>
									))}
								</div>,
								document.body,
							)
						: null}
					{modelPopoverOpen && modelPopoverRect && llmConfig ? (
						<ModelQuickPopover
							anchorRect={modelPopoverRect}
							llmConfig={llmConfig}
							connectedProviders={connectedProviders ?? []}
							onClose={() => setModelPopoverOpen(false)}
							onConfigChange={() => void refreshLlm()}
							onOpenFullSettings={() => setSettingsOpen(true)}
						/>
					) : null}
					<button
						type="button"
						className={styles.sendBtn}
						title={canChat ? t("chat.sendTitle") : t("chat.composerDisabledNoProvider")}
						aria-label={t("chat.send")}
						onClick={() => void send()}
						disabled={busy || rewindBusy || !input.trim() || !canChat}
					>
						<svg
							width={14}
							height={14}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.843 7.627a.498.498 0 0 0 .683.627l18-8.5a.5.5 0 0 0 0-.904Z" />
							<path d="M6 12h16" />
						</svg>
					</button>
				</div>
			</div>
			<ProviderSettings
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false);
					void refreshLlm();
				}}
			/>
			<ChatHistoryModal
				open={chatsOpen}
				onClose={() => setChatsOpen(false)}
				sessions={sessions}
				activeSessionId={activeSessionId}
				onSelect={selectSession}
				onNew={newChat}
			/>
			{rewindFor && rewindFor.anchor
				? createPortal(
						<div
							data-rewind-confirmation="true"
							role="dialog"
							aria-label={t("chat.rewindConfirmTitle")}
							style={{
								position: "fixed",
								left: rewindFor.anchor.left - 130,
								bottom: rewindFor.anchor.bottom,
								width: 260,
								background: "var(--surface)",
								border: "1px solid var(--border)",
								borderRadius: "var(--r-md)",
								boxShadow: "var(--elev-pop)",
								padding: 12,
								zIndex: 1000,
							}}
						>
							<strong style={{ display: "block", marginBottom: 4 }}>
								{t("chat.rewindConfirmTitle")}
							</strong>
							<p
								style={{
									font: "400 12px/1.4 var(--font-body)",
									color: "var(--muted)",
									margin: "0 0 8px",
								}}
							>
								{t("chat.rewindConfirmBody")}
							</p>
							<div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
								<button
									type="button"
									onClick={() => setRewindFor(null)}
									style={{
										padding: "4px 10px",
										background: "transparent",
										border: "1px solid var(--border-soft)",
										borderRadius: "var(--r-sm)",
										color: "var(--fg-2)",
										font: "500 12px var(--font-body)",
										cursor: "pointer",
									}}
								>
									{tc("actions.cancel")}
								</button>
								<button
									type="button"
									onClick={() => void confirmRewind(rewindFor.messageId)}
									disabled={busy || rewindBusy}
									style={{
										padding: "4px 10px",
										background: "var(--accent)",
										border: "1px solid var(--accent)",
										borderRadius: "var(--r-sm)",
										color: "var(--bg)",
										font: "500 12px var(--font-body)",
										cursor: "pointer",
									}}
								>
									{t("chat.rewindConfirm")}
								</button>
							</div>
						</div>,
						document.body,
					)
				: null}
		</aside>
	);
}

const RAIL_BUTTONS: Array<{ id: LeftTab; labelKey: string; icon: React.ElementType }> = [
	{ id: "chat", labelKey: "leftRail.chat", icon: MessageSquare },
	{ id: "media", labelKey: "leftRail.media", icon: Film },
];

export function LeftRail({
	active,
	onChange,
}: {
	active: LeftTab;
	onChange: (id: LeftTab) => void;
}) {
	const t = useScopedT("editor");
	return (
		<aside className={`${styles.rail} ${styles.leftRail}`} aria-label={t("leftRail.ariaLabel")}>
			{RAIL_BUTTONS.map(({ id, labelKey, icon: Icon }) => (
				<button
					type="button"
					key={id}
					title={t(labelKey)}
					aria-label={t(labelKey)}
					aria-pressed={active === id}
					onClick={() => onChange(id)}
				>
					<Icon size={18} />
				</button>
			))}
		</aside>
	);
}
