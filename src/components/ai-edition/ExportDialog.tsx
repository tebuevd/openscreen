// Export dialog for the new editor. Wires together:
// 1. pickExportSavePath (native save dialog)
// 2. the native D3D exporter (exportMultiNative / exportGifNative)
// 3. writeExportToPath (writes the resulting buffer to disk)
//
// Format/quality/GIF options live in the dialog's local state. The
// legacy `ExportDialog` (in components/video-editor) is the rich version
// used by the legacy VideoEditor; this one is a compact surface tuned for
// the new shell's modal style.

import { Download, FileVideo, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import {
	collectEffectiveClipDims,
	type Dims,
	pickExtremeDims,
	resolveAspectRatioValue,
	resolveVisibleClips,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import {
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportVideoCodec,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "@/lib/exporter";
import { hydrateExportDocumentDimensions } from "@/lib/exporter/exportDocumentDimensions";
import {
	calculateMp4ExportSettingsForSources,
	hasPracticalExportSourceDimensions,
	type Mp4ExportSettings,
	resolveMp4ExportSettings,
	wouldUpscale,
} from "@/lib/exporter/mp4ExportSettings";
import { exportGifNative, exportMultiNative, useIsCpuCompositor } from "@/native";
import { buildSceneDescription } from "@/native/sceneDescription";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Phase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";

/** hh:mm:ss (always shows hours, unlike the shared mm:ss `formatTimePadded`) — exports can run
 *  past an hour on either axis (video duration or render wall-time). */
function formatHms(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return [h, m, sec].map((v) => v.toString().padStart(2, "0")).join(":");
}

const QUALITY_OPTIONS: Array<{
	value: ExportQuality;
	labelKey: string;
}> = [
	{ value: "medium", labelKey: "exportQuality.low" },
	{ value: "good", labelKey: "exportQuality.medium" },
	{ value: "source", labelKey: "exportQuality.high" },
];

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	document: AxcutDocument | null;
}

export function ExportDialog({ open, onClose, document }: ExportDialogProps) {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	// No usable GPU: the export still applies every effect (output is identical), it
	// just runs on the software encoder and takes minutes instead of seconds.
	const cpuCompositor = useIsCpuCompositor();
	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [quality, setQuality] = useState<ExportQuality>("good");
	const [fps, setFps] = useState<24 | 30 | 60>(60);
	const [codec, setCodec] = useState<ExportVideoCodec>("h264");
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(15);
	const [gifSize, setGifSize] = useState<GifSizePreset>("medium");
	const [gifLoop, setGifLoop] = useState(true);
	const [phase, setPhase] = useState<Phase>("idle");
	const [progress, setProgress] = useState<ExportProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	// Invalidates stale async continuations; it does not cancel an in-flight native export.
	const submissionGenerationRef = useRef(0);

	// (Old behavior: the native compositor overlay used to be a top-level OS window outside the
	//  Chromium surface, so we'd hide it here to put this modal in front. The compositor now
	//  streams into a normal `<canvas>` inside the DOM — CSS z-index handles stacking naturally
	//  and there's no OS window to hide. The hide/show dance is now dead code; removed.)

	// Persisted `asset.video` metadata drives the configuration preview. Submission hydrates an
	// export-only clone on demand so older projects with missing metadata can still export safely.
	const primaryAsset = useMemo(
		() =>
			document
				? (document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0])
				: null,
		[document],
	);

	// Crop is per clip, so Source sizing must retain every resolved clip footprint rather than
	// collapsing the stream to one area-based representative.
	const visibleClips = useMemo(() => (document ? resolveVisibleClips(document) : []), [document]);
	const effectiveClipDims = useMemo<Dims[]>(
		() => (document ? collectEffectiveClipDims(document, {}, visibleClips) : []),
		[document, visibleClips],
	);
	const largestSource = useMemo(
		() => pickExtremeDims(effectiveClipDims, "largest"),
		[effectiveClipDims],
	);
	// Source and legacy Original exports must not infer readiness from a partial list: if any clip
	// that will reach native export still lacks valid asset metadata, fail closed at submission.
	const hasCompleteSourceMetadata = useMemo(() => {
		if (!document) return false;
		const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
		return (
			visibleClips.length > 0 &&
			visibleClips.every((clip) => {
				const video = assetById.get(clip.assetId)?.video;
				return hasPracticalExportSourceDimensions(video ?? null);
			})
		);
	}, [document, visibleClips]);
	const validatedSourceDimensions = hasCompleteSourceMetadata ? effectiveClipDims : [];
	const validatedLargestSource = hasCompleteSourceMetadata ? largestSource : null;

	// Aspect the export normalizes to: the timeline's selected ratio (mirrors documentExporter),
	// so the sizes shown match what the export produces. Read through `getEditorSettings` — the
	// same typed façade the ratio dropdown writes through and `buildSceneDescription` reads — so
	// this dialog can't drift from the compositor if the storage ever moves. MP4 receives the token
	// so legacy Original cannot silently resolve to 16:9.
	const exportAspectRatio = useMemo(() => getEditorSettings(document).aspectRatio, [document]);
	// Only Source quality uses clip dimensions; 720p/1080p keep their fixed short side.
	// GIF is 8-bit indexed and grows fast with area, so the size preset caps the
	// output height rather than following the quality tier.
	const gifOutputDims = (
		preset: GifSizePreset,
		tierDims: { width: number; height: number } | null,
	): { width?: number; height?: number } => {
		if (!tierDims) return {};
		const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
		if (!Number.isFinite(maxHeight) || tierDims.height <= maxHeight) {
			return { width: tierDims.width, height: tierDims.height };
		}
		const scale = maxHeight / tierDims.height;
		// Even dimensions: the compositor rasterises to this size and the readback
		// assumes a tightly-packed RGBA buffer.
		const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
		return { width: even(tierDims.width), height: even(tierDims.height) };
	};

	const resolveMp4Tier = (value: ExportQuality) =>
		resolveMp4ExportSettings({
			quality: value,
			aspectRatio: exportAspectRatio,
			sourceDimensions: validatedSourceDimensions[0] ?? null,
			sourceClipDimensions: validatedSourceDimensions,
			originalDimensions: validatedLargestSource,
		});
	const tierOutputDims = (value: ExportQuality) => {
		const resolution = resolveMp4Tier(value);
		return resolution.ok ? resolution.settings : null;
	};

	useEffect(() => {
		if (!open) {
			submissionGenerationRef.current += 1;
			setPhase("idle");
			setProgress(null);
			setError(null);
			setSavedPath(null);
		}
	}, [open]);
	useEffect(
		() => () => {
			submissionGenerationRef.current += 1;
		},
		[],
	);

	const handleClose = () => {
		if (phase === "rendering" || phase === "writing") return;
		submissionGenerationRef.current += 1;
		onClose();
	};

	const handleStart = async () => {
		if (!document) return;
		const asset = primaryAsset;
		if (!asset) {
			setError(t("exportDialog.addVideoBeforeExporting"));
			setPhase("error");
			return;
		}
		const submissionGeneration = ++submissionGenerationRef.current;
		const isCurrentSubmission = () => submissionGenerationRef.current === submissionGeneration;
		const dimensionsUnavailable = t("exportDialog.dimensionsUnavailable");
		setPhase("configuring");
		setError(null);
		setProgress(null);
		setSavedPath(null);

		const visibleAssetIds = resolveVisibleClips(document).map((clip) => clip.assetId);
		const hydrated = await hydrateExportDocumentDimensions(document, visibleAssetIds);
		if (!isCurrentSubmission()) return;
		if (!hydrated.ok) {
			setError(dimensionsUnavailable);
			setPhase("error");
			return;
		}
		const exportDocument = hydrated.document;
		const exportVisibleClips = resolveVisibleClips(exportDocument);
		if (exportVisibleClips.length === 0) {
			setError(t("exportDialog.nothingToExport"));
			setPhase("error");
			return;
		}
		const exportEffectiveDims = collectEffectiveClipDims(exportDocument, {}, exportVisibleClips);
		if (exportEffectiveDims.length !== exportVisibleClips.length) {
			setError(dimensionsUnavailable);
			setPhase("error");
			return;
		}
		const exportLargestSource = pickExtremeDims(exportEffectiveDims, "largest");
		const exportAspectRatio = getEditorSettings(exportDocument).aspectRatio;
		const exportAspectValue = resolveAspectRatioValue(
			exportDocument,
			exportAspectRatio,
			{},
			exportVisibleClips,
		);
		let mp4Output: Mp4ExportSettings | null = null;
		let gifOutput: { width: number; height: number } | null = null;
		if (format === "mp4") {
			const resolution = resolveMp4ExportSettings({
				quality,
				aspectRatio: exportAspectRatio,
				sourceDimensions: exportEffectiveDims[0] ?? null,
				sourceClipDimensions: exportEffectiveDims,
				originalDimensions: exportLargestSource,
			});
			if (!resolution.ok) {
				setError(dimensionsUnavailable);
				setPhase("error");
				return;
			}
			mp4Output = resolution.settings;
		} else {
			const gifTier = calculateMp4ExportSettingsForSources({
				quality,
				sourceDimensions: exportEffectiveDims,
				aspectRatioValue: exportAspectValue,
			});
			const dimensions = gifOutputDims(gifSize, gifTier);
			if (dimensions.width === undefined || dimensions.height === undefined) {
				setError(dimensionsUnavailable);
				setPhase("error");
				return;
			}
			gifOutput = { width: dimensions.width, height: dimensions.height };
		}
		const outputDims = mp4Output ? { width: mp4Output.width, height: mp4Output.height } : gifOutput;
		if (!outputDims) {
			setError(dimensionsUnavailable);
			setPhase("error");
			return;
		}
		const scene = buildSceneDescription(exportDocument, null, {
			visibleClips: exportVisibleClips,
			outputDims,
		});
		const clips = scene.clips;
		const sceneJson = JSON.stringify(scene);

		const safeName = (exportDocument.project.title || "OpenScreen")
			.replace(/[^a-z0-9-_]+/gi, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60);
		const suggested = `${safeName || "export"}${format === "gif" ? ".gif" : ".mp4"}`;

		let pickedPath: string | undefined;
		try {
			const picker = await window.electronAPI?.pickExportSavePath?.(suggested);
			if (!isCurrentSubmission()) return;
			pickedPath = picker && "path" in picker ? picker.path : undefined;
		} catch (err) {
			if (!isCurrentSubmission()) return;
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			return;
		}
		if (!pickedPath) {
			setPhase("idle");
			return;
		}

		// Both formats go through the native D3D exporter — same clips, same scene,
		// same frame walk in the compositor crate; only the container differs. There
		// is no CPU/web fallback: that path silently regressed to an ultra-slow CPU
		// render once, which is exactly the failure mode a flag-gated fallback
		// invites. Background/layout/webcam/cursor/effects come from the same scene
		// as the live preview, so an export can no longer disagree with what the
		// user previewed.
		{
			setPhase("rendering");
			// GIF runs at its own frame rate, so the progress total has to use it.
			const outFps = format === "gif" ? gifFrameRate : fps;
			// Total frames the encoder will produce, known upfront from the timeline (sum of
			// each clip's trimmed source duration) — the native side only reports frames
			// AFTER encoding one (onNativeExportProgress), it doesn't know/send a total, so
			// this is computed here to turn that raw count into a percentage.
			const totalDurationSec = clips.reduce(
				(sum, c) => sum + Math.max(0, c.sourceEndSec - c.sourceStartSec),
				0,
			);
			const totalFrames = Math.max(1, Math.round(totalDurationSec * outFps));
			const startedAt = Date.now();
			const unsubscribeProgress = window.electronAPI?.onNativeExportProgress?.((frames) => {
				if (!isCurrentSubmission()) return;
				const elapsedS = (Date.now() - startedAt) / 1000;
				const fractionDone = Math.min(1, frames / totalFrames);
				const estimatedTimeRemaining = fractionDone > 0 ? elapsedS / fractionDone - elapsedS : 0;
				setProgress({
					currentFrame: frames,
					totalFrames,
					percentage: fractionDone * 100,
					estimatedTimeRemaining,
				});
			});
			try {
				let stats: { videoDurationS: number; wallS: number };
				if (format === "gif") {
					if (!gifOutput) throw new Error(dimensionsUnavailable);
					stats = await exportGifNative(clips, pickedPath, sceneJson, {
						...gifOutput,
						fps: gifFrameRate,
						// 0 = infinite, the historical GIF default; 1 = play once.
						loopCount: gifLoop ? 0 : 1,
					});
				} else {
					if (!mp4Output) {
						throw new Error(dimensionsUnavailable);
					}
					stats = await exportMultiNative(clips, pickedPath, sceneJson, {
						width: mp4Output.width,
						height: mp4Output.height,
						fps,
						bitrate: mp4Output.bitrate,
						codec,
					});
				}
				if (!isCurrentSubmission()) return;
				setSavedPath(pickedPath);
				setPhase("done");
				toast.success(t("exportDialog.exportedVideo"), {
					description: `${pickedPath} · ${formatHms(stats.videoDurationS)} ${t("exportDialog.exportedVideoOf")} ${formatHms(stats.wallS)}`,
					action: {
						label: t("exportDialog.showInFolder"),
						onClick: () => {
							// `revealInFolder` is a bare ipcRenderer.invoke, so it rejects when
							// the main handler throws. The export already succeeded — failing to
							// open the folder is not worth a second toast, but it is worth a line.
							void window.electronAPI?.revealInFolder?.(pickedPath).catch((err) => {
								console.warn("[export] failed to reveal the file in its folder:", err);
							});
						},
					},
				});
			} catch (err) {
				if (!isCurrentSubmission()) return;
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				toast.error(t("exportDialog.exportFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				unsubscribeProgress?.();
			}
			return;
		}
	};

	const isBusy = phase === "rendering" || phase === "writing" || phase === "configuring";
	const pct = progress?.percentage ?? 0;
	const gifSizeLabel = GIF_SIZE_PRESETS[gifSize].label;

	return (
		<ModalShell
			open={open}
			onClose={handleClose}
			title={t("exportDialog.title")}
			subtitle={t("exportDialog.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: 8,
					}}
				>
					<FormatToggle
						active={format === "mp4"}
						label={ts("exportFormat.mp4")}
						icon={<FileVideo size={18} />}
						onClick={() => setFormat("mp4")}
						disabled={isBusy}
					/>
					<FormatToggle
						active={format === "gif"}
						label={ts("exportFormat.gif")}
						icon={<Download size={18} />}
						onClick={() => setFormat("gif")}
						disabled={isBusy}
					/>
				</div>

				{format === "mp4" ? (
					<section>
						<div
							style={{
								font: "500 11px/1 var(--font-body)",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
								color: "var(--muted)",
								marginBottom: 8,
							}}
						>
							{t("exportDialog.quality")}
						</div>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
							{QUALITY_OPTIONS.map((q) => (
								<button
									type="button"
									key={q.value}
									disabled={isBusy}
									onClick={() => setQuality(q.value)}
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 2,
										padding: "10px 12px",
										border: `1px solid ${quality === q.value ? "var(--accent)" : "var(--border)"}`,
										borderRadius: 10,
										background: quality === q.value ? "var(--accent-wash)" : "var(--surface)",
										color: "var(--fg-2)",
										cursor: "pointer",
										font: "500 13px/1 var(--font-body)",
									}}
								>
									<span style={{ color: "var(--fg)", fontWeight: 600 }}>{ts(q.labelKey)}</span>
									{(() => {
										const dims = tierOutputDims(q.value);
										if (!dims) return null;
										// Downscale badge removed everywhere — restated what picking a lower
										// tier already means, not actionable. The upscale badge asks whether
										// the clip has to be STRETCHED to fill this frame (`wouldUpscale`),
										// which is a contain-fit question: a short-side compare read the
										// letterbox rows a non-16:9 source gets in a 16:9 project as if they
										// were stretched pixels, and flagged "1080p" on the very frame
										// "Source" produced unflagged. No "Source" special case any more —
										// its frame is capped by every clip's contain-fit capacity, so the
										// general test covers it without a Source special case.
										const isUpscale = effectiveClipDims.some((source) =>
											wouldUpscale(dims, source),
										);
										return (
											<span
												style={{
													font: "500 11px var(--font-body)",
													color: isUpscale ? "var(--warn)" : "var(--muted)",
												}}
											>
												{dims.width} × {dims.height}
												{isUpscale ? ` · ${t("exportDialog.qualityUpscaleWarning")}` : ""}
											</span>
										);
									})()}
								</button>
							))}
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 12,
								marginTop: 12,
							}}
						>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.frameRate")}
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
									{([24, 30, 60] as const).map((r) => (
										<button
											type="button"
											key={r}
											disabled={isBusy}
											onClick={() => setFps(r)}
											style={segStyle(fps === r)}
										>
											{r}
										</button>
									))}
								</div>
							</div>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.codec")}
								</div>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "repeat(2, 1fr)",
										gap: 6,
									}}
								>
									{(
										[
											["h264", "H.264"],
											["h265", "H.265"],
											// VP9 has no AMF hardware encoder on this GPU — the native pipeline
											// (the only MP4 export path now) rejects it outright (tested: a
											// software libvpx-vp9 fallback worked but was too slow to ship).
											// Hidden here rather than left selectable-then-erroring.
										] as Array<[ExportVideoCodec, string]>
									).map(([value, label]) => (
										<button
											type="button"
											key={value}
											disabled={isBusy}
											onClick={() => setCodec(value)}
											style={segStyle(codec === value)}
											title={
												value === "h264"
													? t("exportDialog.codecBestCompatibility")
													: t("exportDialog.codecMaySupportVary")
											}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						</div>
					</section>
				) : (
					<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.frameRate")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
								{GIF_FRAME_RATES.map((r) => (
									<button
										type="button"
										key={r.value}
										disabled={isBusy}
										onClick={() => setGifFrameRate(r.value)}
										style={segStyle(gifFrameRate === r.value)}
									>
										{r.value} FPS
									</button>
								))}
							</div>
						</div>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.size")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
								{(Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]).map((s) => (
									<button
										type="button"
										key={s}
										disabled={isBusy}
										onClick={() => setGifSize(s)}
										style={segStyle(gifSize === s)}
									>
										{GIF_SIZE_PRESETS[s].label}
									</button>
								))}
							</div>
						</div>
						<div className={styles.paneRow} style={{ margin: 0 }}>
							<span className="label">{t("exportDialog.loopGif")}</span>
							<button
								type="button"
								className={`${styles.toggle} ${gifLoop ? styles.isOn : ""}`}
								aria-pressed={gifLoop}
								disabled={isBusy}
								onClick={() => setGifLoop((v) => !v)}
							/>
						</div>
						<div
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--muted)",
								letterSpacing: "0.04em",
							}}
						>
							{gifFrameRate} FPS · {gifSizeLabel} ·{" "}
							{gifLoop ? t("exportDialog.loopOn") : t("exportDialog.loopOff")}
						</div>
					</section>
				)}

				<ProgressBlock
					phase={phase}
					progress={progress}
					error={error}
					pct={pct}
					savedPath={savedPath}
				/>

				{cpuCompositor && phase !== "done" && (
					// Placed next to the export button, not in a toast: it has to land while
					// the user is still deciding. A CPU export renders every effect correctly
					// but takes minutes rather than seconds, and an unexplained ten-minute
					// wait reads as a hang.
					<p
						data-testid="export-cpu-warning"
						style={{
							margin: "0 0 4px",
							fontSize: "0.8125rem",
							lineHeight: 1.4,
							color: "var(--text-muted, rgb(0 0 0 / 0.65))",
						}}
					>
						{t("cpuCompositor.exportWarning")}
					</p>
				)}

				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						paddingTop: 12,
						borderTop: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={handleClose}
						disabled={isBusy}
					>
						{phase === "done" ? t("exportDialog.close") : t("exportDialog.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={handleStart}
						disabled={isBusy || !document}
					>
						{isBusy ? (
							<>
								<Loader2 size={14} className="animate-spin" />
								{phase === "rendering"
									? t("exportDialog.rendering")
									: phase === "writing"
										? t("exportDialog.saving")
										: t("exportDialog.starting")}
							</>
						) : (
							<>
								<Download size={14} />
								{format === "gif" ? t("exportDialog.exportGif") : t("exportDialog.exportMp4")}
							</>
						)}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

function FormatToggle({
	active,
	label,
	icon,
	onClick,
	disabled,
}: {
	active: boolean;
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
				padding: "12px 16px",
				border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
				borderRadius: 10,
				background: active ? "var(--accent-wash)" : "var(--surface)",
				// Selection is conveyed by border + wash background (like the quality
				// cards below), not by swapping text color -- `--accent-on` is meant
				// for text on a SOLID accent fill, and paired with the near-transparent
				// `--accent-wash` it read as near-invisible dark-on-dark text.
				color: "var(--fg)",
				cursor: "pointer",
				font: "600 14px/1 var(--font-body)",
			}}
		>
			{icon}
			{label}
		</button>
	);
}

function ProgressBlock({
	phase,
	progress,
	error,
	pct,
	savedPath,
}: {
	phase: Phase;
	progress: ExportProgress | null;
	error: string | null;
	pct: number;
	savedPath: string | null;
}) {
	const t = useScopedT("editor");
	if (phase === "idle" || phase === "configuring") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--border)",
					borderRadius: 10,
					background: "var(--surface-1)",
					color: "var(--muted)",
					font: "500 12px var(--font-body)",
					textAlign: "center",
				}}
			>
				{t("exportDialog.pickFormatAndExport")}
			</div>
		);
	}
	if (phase === "done") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--brand)",
					borderRadius: 10,
					background: "var(--success-soft)",
					color: "var(--fg-2)",
					font: "500 12px var(--font-body)",
				}}
			>
				{t("exportDialog.savedTo")}{" "}
				<span style={{ fontFamily: "var(--font-mono)" }}>{savedPath}</span>
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div
				role="alert"
				style={{
					padding: "16px",
					border: "1px solid var(--danger)",
					borderRadius: 10,
					background: "var(--danger-soft)",
					color: "var(--danger)",
					font: "500 12px var(--font-body)",
				}}
			>
				{error ?? t("exportDialog.exportFailedGeneric")}
			</div>
		);
	}
	const current = progress?.currentFrame ?? 0;
	const total = progress?.totalFrames ?? 0;
	const eta = progress?.estimatedTimeRemaining ?? 0;
	return (
		<div
			style={{
				padding: "12px 14px",
				border: "1px solid var(--border)",
				borderRadius: 10,
				background: "var(--surface-1)",
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ font: "500 12px var(--font-body)", color: "var(--fg-2)" }}>
					{phase === "writing" ? t("exportDialog.writingFile") : t("exportDialog.renderingFrames")}
				</span>
				<span
					style={{
						font: "500 12px/1 var(--font-mono)",
						color: "var(--brand)",
					}}
				>
					{Math.round(pct)}%
				</span>
			</div>
			<div
				style={{
					position: "relative",
					height: 8,
					background: "var(--surface-3)",
					borderRadius: 999,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						inset: 0,
						width: `${Math.max(0, Math.min(100, pct))}%`,
						background: "var(--brand)",
						transition: "width 200ms var(--ease)",
					}}
				/>
			</div>
			<div
				style={{
					font: "500 11px/1.4 var(--font-mono)",
					color: "var(--muted)",
					letterSpacing: "0.04em",
				}}
			>
				{total > 0
					? t("exportDialog.framesEta", { current, total, eta: Math.max(0, Math.round(eta)) })
					: t("exportDialog.preparingEncoder")}
			</div>
		</div>
	);
}

function segStyle(active: boolean): React.CSSProperties {
	return {
		padding: "8px 10px",
		border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
		borderRadius: 8,
		background: active ? "var(--brand)" : "var(--bg)",
		color: active ? "var(--accent-on)" : "var(--fg-2)",
		cursor: "pointer",
		font: "500 12px/1 var(--font-body)",
	};
}
