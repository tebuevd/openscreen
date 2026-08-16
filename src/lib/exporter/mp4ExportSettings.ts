import { type AspectRatio, parseAspectRatio } from "../../utils/aspectRatioUtils";
import type { ExportQuality } from "./types";

export interface Mp4ExportSettings {
	width: number;
	height: number;
	bitrate: number;
}

interface SourceCropRegion {
	width: number;
	height: number;
}

export interface ExportDimensions {
	width: number;
	height: number;
}

// Bound allocations to ordinary DCI 8K in either orientation. 8192 is a conservative cross-GPU
// texture axis; the pixel cap admits 8192x4320 and 4320x8192 while rejecting pathological squares
// and extreme aspect-ratio metadata before any native/GPU allocation.
export const MAX_MP4_EXPORT_DIMENSION = 8192;
export const MAX_MP4_EXPORT_PIXEL_AREA = 8192 * 4320;
export const MP4_EXPORT_DIMENSIONS_ERROR = `MP4 export width and height must both be positive even integers, no greater than ${MAX_MP4_EXPORT_DIMENSION} per axis or ${MAX_MP4_EXPORT_PIXEL_AREA} total pixels.`;

// Bits per second. This covers the current UI policy maximum (80 Mbps) and the legacy
// area-based fallback at the largest allowed DCI-8K frame (~136.5 Mbps), while bounding raw
// callers that accidentally submit another unit or an otherwise unreasonable encoder target.
export const MAX_MP4_EXPORT_BITRATE = 200_000_000;
export const MP4_EXPORT_BITRATE_ERROR = `MP4 export bitrate must be a positive safe integer no greater than ${MAX_MP4_EXPORT_BITRATE} bits per second.`;

export type Mp4ExportDimensionValidation =
	| { ok: true; dimensions: ExportDimensions }
	| { ok: false; reason: "missing" | "invalid" | "too-large" };

export type Mp4ExportSettingsResolution =
	| { ok: true; settings: Mp4ExportSettings }
	| {
			ok: false;
			reason:
				| "source-dimensions-unavailable"
				| "original-dimensions-unavailable"
				| "invalid-output-dimensions";
	  };

/**
 * Would rendering a `source`-sized clip into an `output`-sized frame stretch it past its own
 * resolution?
 *
 * The clip is CONTAIN-fitted into the output frame, so the answer is that fit scale — not a
 * comparison of short sides, which counts letterbox rows as if they were stretched pixels. A
 * 1920x1032 window capture in a 16:9 project gives a 1920x1080 frame whose 48 extra rows are
 * wallpaper, at scale 1.0: nothing is upscaled. The short-side test called that frame an
 * upscale under the "1080p" tier while "Source" produced the exact same frame unflagged.
 */
export function wouldUpscale(output: ExportDimensions, source: ExportDimensions): boolean {
	return Math.min(output.width / source.width, output.height / source.height) > 1;
}

export function hasValidExportSourceDimensions(
	dimensions: ExportDimensions | null | undefined,
): dimensions is ExportDimensions {
	return (
		Number.isSafeInteger(dimensions?.width) &&
		Number.isSafeInteger(dimensions?.height) &&
		(dimensions?.width ?? 0) > 0 &&
		(dimensions?.height ?? 0) > 0
	);
}

export function hasPracticalExportSourceDimensions(
	dimensions: ExportDimensions | null | undefined,
): dimensions is ExportDimensions {
	return (
		hasValidExportSourceDimensions(dimensions) &&
		dimensions.width <= MAX_MP4_EXPORT_DIMENSION &&
		dimensions.height <= MAX_MP4_EXPORT_DIMENSION &&
		dimensions.width <= Math.floor(MAX_MP4_EXPORT_PIXEL_AREA / dimensions.height)
	);
}

export function validateMp4ExportDimensions(
	dimensions: { width?: unknown; height?: unknown } | null | undefined,
): Mp4ExportDimensionValidation {
	if (dimensions?.width === undefined || dimensions.height === undefined) {
		return { ok: false, reason: "missing" };
	}
	const { width, height } = dimensions;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		width % 2 !== 0 ||
		height % 2 !== 0
	) {
		return { ok: false, reason: "invalid" };
	}
	if (
		width > MAX_MP4_EXPORT_DIMENSION ||
		height > MAX_MP4_EXPORT_DIMENSION ||
		width > Math.floor(MAX_MP4_EXPORT_PIXEL_AREA / height)
	) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, dimensions: { width, height } };
}

export function validateMp4ExportBitrate(bitrate: unknown): bitrate is number | undefined {
	return (
		bitrate === undefined ||
		(typeof bitrate === "number" &&
			Number.isFinite(bitrate) &&
			Number.isSafeInteger(bitrate) &&
			bitrate > 0 &&
			bitrate <= MAX_MP4_EXPORT_BITRATE)
	);
}

const MEDIUM_SHORT_SIDE = 720;
const HIGH_SHORT_SIDE = 1080;

function even(value: number) {
	return Math.floor(value / 2) * 2;
}

function atLeastEven(value: number) {
	return Math.max(2, even(value));
}

export function calculateEffectiveSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	cropRegion?: SourceCropRegion,
) {
	const cropWidth = cropRegion?.width ?? 1;
	const cropHeight = cropRegion?.height ?? 1;

	return {
		width: atLeastEven(Math.round(sourceWidth * cropWidth)),
		height: atLeastEven(Math.round(sourceHeight * cropHeight)),
	};
}

function calculateDimensionsForShortSide(targetShortSide: number, aspectRatioValue: number) {
	if (aspectRatioValue >= 1) {
		const height = even(targetShortSide);
		return {
			width: even(height * aspectRatioValue),
			height,
		};
	}

	const width = even(targetShortSide);
	return {
		width,
		height: even(width / aspectRatioValue),
	};
}

function calculateSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatioValue: number,
) {
	const sourceLongDim = Math.max(sourceWidth, sourceHeight);

	if (aspectRatioValue === 1) {
		const baseDimension = even(Math.min(sourceWidth, sourceHeight));
		return {
			width: baseDimension,
			height: baseDimension,
		};
	}

	if (aspectRatioValue > 1) {
		const baseWidth = even(sourceLongDim);
		for (let width = baseWidth; width >= 100; width -= 2) {
			const height = Math.round(width / aspectRatioValue);
			if (height % 2 === 0 && Math.abs(width / height - aspectRatioValue) < 0.0001) {
				return { width, height };
			}
		}
		return {
			width: baseWidth,
			height: even(baseWidth / aspectRatioValue),
		};
	}

	const baseHeight = even(sourceLongDim);
	for (let height = baseHeight; height >= 100; height -= 2) {
		const width = Math.round(height * aspectRatioValue);
		if (width % 2 === 0 && Math.abs(width / height - aspectRatioValue) < 0.0001) {
			return { width, height };
		}
	}
	return {
		width: even(baseHeight * aspectRatioValue),
		height: baseHeight,
	};
}

function calculateBitrate(width: number, height: number, quality: ExportQuality) {
	const totalPixels = width * height;

	if (quality === "source") {
		if (totalPixels > 2560 * 1440) return 80_000_000;
		if (totalPixels > 1920 * 1080) return 50_000_000;
		return 30_000_000;
	}

	if (totalPixels <= 1280 * 720) return 10_000_000;
	if (totalPixels <= 1920 * 1080) return 20_000_000;
	return 30_000_000;
}

export function calculateMp4ExportSettings({
	quality,
	sourceWidth,
	sourceHeight,
	aspectRatioValue,
}: {
	quality: ExportQuality;
	sourceWidth: number;
	sourceHeight: number;
	aspectRatioValue: number;
}): Mp4ExportSettings {
	if (quality === "medium") {
		const dimensions = calculateDimensionsForShortSide(MEDIUM_SHORT_SIDE, aspectRatioValue);
		return {
			...dimensions,
			bitrate: calculateBitrate(dimensions.width, dimensions.height, quality),
		};
	}

	if (quality === "good") {
		const dimensions = calculateDimensionsForShortSide(HIGH_SHORT_SIDE, aspectRatioValue);
		return {
			...dimensions,
			bitrate: calculateBitrate(dimensions.width, dimensions.height, quality),
		};
	}

	const sourceDimensions = calculateSourceDimensions(sourceWidth, sourceHeight, aspectRatioValue);
	return {
		...sourceDimensions,
		bitrate: calculateBitrate(sourceDimensions.width, sourceDimensions.height, quality),
	};
}

/**
 * Resolves the complete MP4 output pair before export submission. Fixed tiers only need a
 * concrete aspect ratio; Source needs source pixels, and the legacy Original token needs source
 * pixels to avoid its historical silent 16:9 fallback.
 */
export function resolveMp4ExportSettings({
	quality,
	aspectRatio,
	sourceDimensions,
	originalDimensions = sourceDimensions,
}: {
	quality: ExportQuality;
	aspectRatio: AspectRatio;
	sourceDimensions: ExportDimensions | null;
	originalDimensions?: ExportDimensions | null;
}): Mp4ExportSettingsResolution {
	let aspectRatioValue: number;
	if (aspectRatio === "native") {
		if (!hasValidExportSourceDimensions(originalDimensions)) {
			return { ok: false, reason: "original-dimensions-unavailable" };
		}
		aspectRatioValue = originalDimensions.width / originalDimensions.height;
	} else {
		const parsed = parseAspectRatio(aspectRatio);
		if (!parsed) {
			return { ok: false, reason: "invalid-output-dimensions" };
		}
		aspectRatioValue = parsed.width / parsed.height;
	}

	if (quality === "source") {
		if (!hasValidExportSourceDimensions(sourceDimensions)) {
			return { ok: false, reason: "source-dimensions-unavailable" };
		}
		if (
			sourceDimensions.width > MAX_MP4_EXPORT_DIMENSION ||
			sourceDimensions.height > MAX_MP4_EXPORT_DIMENSION ||
			sourceDimensions.width > Math.floor(MAX_MP4_EXPORT_PIXEL_AREA / sourceDimensions.height)
		) {
			return { ok: false, reason: "invalid-output-dimensions" };
		}
	}

	// The fixed tiers do not read source dimensions. Supplying a valid sentinel keeps the legacy
	// calculator's required input shape without making 720p/1080p depend on media probing.
	const source = hasValidExportSourceDimensions(sourceDimensions)
		? sourceDimensions
		: { width: 2, height: 2 };
	const settings = calculateMp4ExportSettings({
		quality,
		sourceWidth: source.width,
		sourceHeight: source.height,
		aspectRatioValue,
	});
	if (!validateMp4ExportDimensions(settings).ok) {
		return { ok: false, reason: "invalid-output-dimensions" };
	}

	return { ok: true, settings };
}
