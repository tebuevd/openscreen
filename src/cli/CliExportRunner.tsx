// Hidden-window runner for `openscreen export`. Loads an .openscreen project,
// migrates it to the AxcutDocument the native Rust compositor consumes, and
// drives exportMultiNative/exportGifNative — mirroring the v4 ExportDialog so
// CLI exports and GUI exports stay pixel-identical. The hidden window does no
// compositing itself: the render runs in the main process; this runner only
// builds the clip list + scene JSON and relays progress.

import { useEffect, useRef, useState } from "react";
import {
	normalizeProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import {
	collectEffectiveClipDims,
	pickExtremeDims,
	resolveAspectRatioValue,
	resolveVisibleClips,
} from "@/lib/ai-edition/document/outputFormat";
import { applyProbedDuration } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES } from "@/lib/ai-edition/timeline/zoom-scale";
import { buildAutoZoomSuggestions } from "@/lib/ai-edition/timeline/zoom-suggestions";
import type { CliDoneResult, CliExportRequest } from "@/lib/cliContracts";
import { GIF_SIZE_PRESETS, type GifSizePreset } from "@/lib/exporter";
import {
	calculateMp4ExportSettingsForSources,
	resolveMp4ExportSettings,
} from "@/lib/exporter/mp4ExportSettings";
import { mixVoiceoverIntoVideo } from "@/lib/exporter/voiceoverMix";
import {
	abortStagedNativeExport,
	commitStagedNativeExport,
	exportGifNative,
	exportMultiNative,
	exportMultiNativeStaged,
	nativeBridgeClient,
	readStagedNativeExport,
	renewStagedNativeExportLease,
	replaceStagedNativeExport,
} from "@/native";
import { buildSceneDescription } from "@/native/sceneDescription";
import { CLI_EXPORT_DIMENSIONS_ERROR, prepareCliExportDocument } from "./prepareExportDocument";
import { clampZoomFocus } from "./vendor/zoomHelpers";

const MP4_EXPORT_FPS = 60;
const STAGED_EXPORT_LEASE_HEARTBEAT_MS = 60_000;

function probeVideoMetadata(
	url: string,
): Promise<{ width: number; height: number; durationMs: number }> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => {
			clearTimeout(timer);
			video.removeAttribute("src");
			video.load();
		};
		// A stalled load fires neither event; without a deadline the CLI hangs.
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out reading video metadata: ${url}`));
		}, 30_000);
		video.onloadedmetadata = () => {
			const width = video.videoWidth;
			const height = video.videoHeight;
			const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
			cleanup();
			resolve({ width, height, durationMs });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error(`Failed to load video metadata: ${url}`));
		};
		video.src = url;
	});
}

function replaceExtension(filePath: string, newExtension: string): string {
	return filePath.replace(/\.(openscreen|json)$/i, "") + newExtension;
}

/** Mirrors ExportDialog.gifOutputDims: cap height at the preset, keep even. */
function gifOutputDims(
	preset: GifSizePreset,
	tierDims: { width: number; height: number } | null,
): { width?: number; height?: number } {
	if (!tierDims) return {};
	const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
	if (!Number.isFinite(maxHeight) || tierDims.height <= maxHeight) {
		return { width: tierDims.width, height: tierDims.height };
	}
	const scale = maxHeight / tierDims.height;
	const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
	return { width: even(tierDims.width), height: even(tierDims.height) };
}

function appendAutoZoomRanges(
	axcutDocument: AxcutDocument,
	cursorTelemetry: CursorTelemetryPoint[],
	totalMs: number,
): number {
	const suggestions = buildAutoZoomSuggestions({
		cursorTelemetry,
		totalMs,
		existingRegions: axcutDocument.zoomRanges,
		defaultDurationMs: Math.max(1000, Math.round(totalMs * 0.05)),
	});
	let nextId = 1;
	for (const suggestion of suggestions) {
		axcutDocument.zoomRanges.push({
			id: `cli-auto-zoom-${nextId++}`,
			startMs: Math.round(suggestion.span.start),
			endMs: Math.round(suggestion.span.end),
			depth: DEFAULT_ZOOM_DEPTH,
			customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
			focus: clampZoomFocus(suggestion.focus),
			focusMode: "auto",
			source: "auto",
		});
	}
	return suggestions.length;
}

export async function runExport(
	request: CliExportRequest,
	abortSignal?: AbortSignal,
): Promise<CliDoneResult> {
	const loaded = await nativeBridgeClient.project.loadProjectFileFromPath(request.projectPath);
	if (!loaded.success || loaded.project === undefined) {
		throw new Error(loaded.error ?? loaded.message ?? "Failed to load project file");
	}
	if (!validateProjectData(loaded.project)) {
		throw new Error("Project file is not a valid .openscreen project");
	}
	const project = loaded.project;
	const media = resolveProjectMedia(project);
	if (!media) {
		throw new Error("Project file does not reference any recorded media");
	}
	// Prefer the main process's approved session paths: they carry the
	// packed-project sibling fallback when the stored absolute paths are stale.
	try {
		const sessionResult = await window.electronAPI.getCurrentRecordingSession();
		const session = sessionResult?.session;
		if (session?.screenVideoPath) {
			media.screenVideoPath = session.screenVideoPath;
			if (media.webcamVideoPath && session.webcamVideoPath) {
				media.webcamVideoPath = session.webcamVideoPath;
			}
		}
	} catch {
		// Fall back to the paths stored in the project file.
	}
	const editor = normalizeProjectEditor(project.editor ?? {});

	const format = request.format ?? editor.exportFormat;
	if (request.audioPath && format === "gif") {
		throw new Error(
			"--audio is only supported for MP4 exports (this project's stored format is gif; pass --format mp4)",
		);
	}
	const quality = request.quality ?? editor.exportQuality;
	const gifFrameRate = request.gifFrameRate ?? editor.gifFrameRate;
	const gifSizePreset = request.gifSizePreset ?? editor.gifSizePreset;
	const outPath =
		request.outPath ?? replaceExtension(request.projectPath, format === "gif" ? ".gif" : ".mp4");
	// Cursor telemetry: only needed to compute --auto-zoom suggestions. The
	// native compositor discovers the `<video>.cursor.json` sidecar itself.
	let cursorTelemetry: CursorTelemetryPoint[] = [];
	if (request.autoZoom) {
		try {
			cursorTelemetry = await nativeBridgeClient.cursor.getTelemetry(media.screenVideoPath);
		} catch {
			cursorTelemetry = [];
		}
	}

	const probed = await probeVideoMetadata(toFileUrl(media.screenVideoPath));

	// Migrate the .openscreen project onto the AxcutDocument the native
	// compositor consumes. The migration is pure and carries zooms, annotations,
	// trims and the legacy editor settings; the clip's duration is unknown until
	// probed, so applyProbedDuration must run or the export is a single frame.
	let axcutDocument = migrateProjectDataToAxcutDocument({
		...project,
		media,
		editor,
	});
	const primaryAssetId = axcutDocument.project.primaryAssetId ?? axcutDocument.assets[0]?.id;
	if (!primaryAssetId) {
		throw new Error("Project migration produced no media asset");
	}
	if (probed.durationMs > 0) {
		axcutDocument = applyProbedDuration(axcutDocument, primaryAssetId, probed.durationMs / 1000);
	}

	if (request.autoZoom) {
		const added = appendAutoZoomRanges(axcutDocument, cursorTelemetry, probed.durationMs);
		window.electronAPI.cliLog("info", `Auto-zoom: added ${added} region(s) from cursor telemetry`);
	}
	const initialVisibleClips = resolveVisibleClips(axcutDocument);
	if (initialVisibleClips.length === 0) {
		throw new Error("The project's timeline has no visible clips to export");
	}
	const visibleAssetIds = initialVisibleClips.map((clip) => clip.assetId);
	axcutDocument = await prepareCliExportDocument(
		axcutDocument,
		visibleAssetIds,
		primaryAssetId,
		probed,
	);

	const visibleClips = resolveVisibleClips(axcutDocument);
	if (visibleClips.length === 0) {
		throw new Error("The project's timeline has no visible clips to export");
	}
	const effectiveClipDims = collectEffectiveClipDims(axcutDocument, {}, visibleClips);
	if (effectiveClipDims.length !== visibleClips.length) {
		throw new Error(CLI_EXPORT_DIMENSIONS_ERROR);
	}
	const largestSource = pickExtremeDims(effectiveClipDims, "largest");
	const aspectRatio = getEditorSettings(axcutDocument).aspectRatio;
	const aspectRatioValue = resolveAspectRatioValue(axcutDocument, aspectRatio, {}, visibleClips);
	const tierSettings =
		format === "gif"
			? calculateMp4ExportSettingsForSources({
					quality,
					sourceDimensions: effectiveClipDims,
					aspectRatioValue,
				})
			: null;
	const mp4Resolution =
		format === "mp4"
			? resolveMp4ExportSettings({
					quality,
					aspectRatio,
					sourceDimensions: effectiveClipDims[0] ?? null,
					sourceClipDimensions: effectiveClipDims,
					originalDimensions: largestSource,
				})
			: null;
	if (mp4Resolution && !mp4Resolution.ok) {
		throw new Error(CLI_EXPORT_DIMENSIONS_ERROR);
	}
	const gifDims = format === "gif" ? gifOutputDims(gifSizePreset, tierSettings) : null;
	const outputDims = mp4Resolution?.ok
		? { width: mp4Resolution.settings.width, height: mp4Resolution.settings.height }
		: gifDims?.width !== undefined && gifDims.height !== undefined
			? { width: gifDims.width, height: gifDims.height }
			: null;
	if (!outputDims) {
		throw new Error(CLI_EXPORT_DIMENSIONS_ERROR);
	}
	const scene = buildSceneDescription(axcutDocument, null, { visibleClips, outputDims });
	const clips = scene.clips;
	const sceneJson = JSON.stringify(scene);
	const warnings: string[] = [];

	// Progress: native pushes raw encoded-frame counts; totals and pacing are
	// computed here, mirroring the ExportDialog.
	const outFps = format === "gif" ? gifFrameRate : MP4_EXPORT_FPS;
	const totalFrames = Math.max(
		1,
		Math.round(
			clips.reduce((sum, clip) => sum + Math.max(0, clip.sourceEndSec - clip.sourceStartSec), 0) *
				outFps,
		),
	);
	const exportStartedAt = Date.now();
	const unsubscribeProgress = window.electronAPI.onNativeExportProgress?.((frames: number) => {
		const elapsedSec = (Date.now() - exportStartedAt) / 1000;
		const rate = frames > 0 ? frames / Math.max(elapsedSec, 0.001) : 0;
		window.electronAPI.cliProgress({
			percentage: Math.min(100, (frames / totalFrames) * 100),
			currentFrame: frames,
			totalFrames,
			estimatedTimeRemaining: rate > 0 ? Math.max(0, (totalFrames - frames) / rate) : 0,
		});
	});

	try {
		if (format === "gif") {
			const dims = gifDims ?? {};
			const result = await exportGifNative(clips, outPath, sceneJson, {
				...dims,
				fps: gifFrameRate,
				loopCount: editor.gifLoop ? 0 : 1,
			});
			if (result.cleanupWarning) warnings.push(result.cleanupWarning.message);
			return {
				success: true,
				...(warnings.length > 0 ? { warnings } : {}),
				outputPath: outPath,
				format,
				width: dims.width,
				height: dims.height,
			};
		}

		if (!mp4Resolution?.ok) {
			throw new Error(CLI_EXPORT_DIMENSIONS_ERROR);
		}
		const mp4Params = {
			width: mp4Resolution.settings.width,
			height: mp4Resolution.settings.height,
			fps: MP4_EXPORT_FPS,
			bitrate: mp4Resolution.settings.bitrate,
			codec: "h264",
		};

		if (!request.audioPath) {
			const result = await exportMultiNative(clips, outPath, sceneJson, mp4Params);
			if (result.cleanupWarning) warnings.push(result.cleanupWarning.message);
		} else {
			let transactionId: string | null = null;
			let leaseTimer: number | null = null;
			let renewalInFlight = false;
			const stopLeaseRenewal = () => {
				if (leaseTimer !== null) window.clearInterval(leaseTimer);
				leaseTimer = null;
			};
			try {
				const staged = await exportMultiNativeStaged(clips, outPath, sceneJson, mp4Params, [
					request.audioPath,
				]);
				transactionId = staged.transactionId;
				if (!abortSignal?.aborted) {
					leaseTimer = window.setInterval(() => {
						if (renewalInFlight) return;
						renewalInFlight = true;
						void renewStagedNativeExportLease(staged.transactionId)
							.catch((error) => {
								console.warn("[cli-export] failed to renew staged export lease:", error);
							})
							.finally(() => {
								renewalInFlight = false;
							});
					}, STAGED_EXPORT_LEASE_HEARTBEAT_MS);
					abortSignal?.addEventListener("abort", stopLeaseRenewal, { once: true });
				}
				window.electronAPI.cliProgress({ percentage: 100, phase: "mixing-voiceover" });
				const [videoData, audioResponse] = await Promise.all([
					readStagedNativeExport(transactionId),
					fetch(toFileUrl(request.audioPath)),
				]);
				if (!audioResponse.ok) {
					throw new Error(`Failed to read voiceover file: ${request.audioPath}`);
				}
				const mixed = await mixVoiceoverIntoVideo(new Blob([videoData], { type: "video/mp4" }), {
					voiceoverData: await audioResponse.arrayBuffer(),
					mode: request.audioMode,
					offsetSec: request.audioOffsetSec,
				});
				await replaceStagedNativeExport(transactionId, await mixed.arrayBuffer());
				const commit = await commitStagedNativeExport(transactionId);
				if (commit.cleanupWarning) warnings.push(commit.cleanupWarning.message);
				transactionId = null;
			} finally {
				stopLeaseRenewal();
				abortSignal?.removeEventListener("abort", stopLeaseRenewal);
				if (transactionId) {
					await abortStagedNativeExport(transactionId).catch((error) => {
						console.warn("[cli-export] failed to abort staged export:", error);
					});
				}
			}
		}

		return {
			success: true,
			...(warnings.length > 0 ? { warnings } : {}),
			outputPath: outPath,
			format,
			width: mp4Resolution.settings.width,
			height: mp4Resolution.settings.height,
		};
	} finally {
		unsubscribeProgress?.();
	}
}

export function CliExportRunner() {
	const startedRef = useRef(false);
	const abortControllerRef = useRef<AbortController | null>(null);
	const abortTimerRef = useRef<number | null>(null);
	const [status, setStatus] = useState("Starting export…");

	useEffect(() => {
		if (abortTimerRef.current !== null) window.clearTimeout(abortTimerRef.current);
		abortTimerRef.current = null;
		if (!startedRef.current) {
			startedRef.current = true;
			const abortController = new AbortController();
			abortControllerRef.current = abortController;

			void (async () => {
				try {
					const request = (await window.electronAPI.cliGetRequest()) as CliExportRequest;
					if (request.kind !== "export") {
						throw new Error(`cli-export window received a ${request.kind} request`);
					}
					setStatus(`Exporting ${request.projectPath}…`);
					const result = await runExport(request, abortController.signal);
					await window.electronAPI.cliDone(result);
				} catch (error) {
					const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
					await window.electronAPI.cliDone({ success: false, error: message });
				}
			})();
		}
		return () => {
			// StrictMode immediately remounts this effect in development; defer abort so that
			// synthetic cleanup can be cancelled while a real unmount still stops renewal.
			abortTimerRef.current = window.setTimeout(() => abortControllerRef.current?.abort(), 0);
		};
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliExportRunner;
