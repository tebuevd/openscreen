import { describe, expect, it } from "vitest";
import { ASPECT_RATIO_PRESETS, type AspectRatio } from "@/utils/aspectRatioUtils";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	calculateSourceExportDimensions,
	MAX_MP4_EXPORT_DIMENSION,
	MAX_MP4_EXPORT_PIXEL_AREA,
	resolveMp4ExportSettings,
	validateMp4ExportDimensions,
	wouldUpscale,
} from "./mp4ExportSettings";

function resolvedSettings(
	quality: "medium" | "good" | "source",
	aspectRatio: AspectRatio,
	sourceDimensions: { width: number; height: number } | null,
	originalDimensions = sourceDimensions,
) {
	const result = resolveMp4ExportSettings({
		quality,
		aspectRatio,
		sourceDimensions,
		originalDimensions,
	});
	if (!result.ok) throw new Error(`Expected settings, received ${result.reason}`);
	return result.settings;
}

describe("calculateMp4ExportSettings", () => {
	it("keeps 1080p explicit even when it upscales short native captures", () => {
		const aspectRatioValue = 1920 / 1032;

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 2008,
			height: 1080,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 1920,
			height: 1032,
			bitrate: 30_000_000,
		});
	});

	it("keeps lower quality presets below the source size when downscaling is useful", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "medium",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue: 1920 / 1032,
			}),
		).toMatchObject({
			width: 1338,
			height: 720,
			bitrate: 20_000_000,
		});
	});

	it("keeps 1080p explicit even for 720p source dimensions", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1280,
				sourceHeight: 720,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 20_000_000,
		});
	});

	it("preserves source-sized High exports when the source is already 1080p or larger", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 3840,
			height: 2160,
			bitrate: 80_000_000,
		});
	});

	it("keeps portrait presets on the short side", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1080,
				sourceHeight: 1920,
				aspectRatioValue: 9 / 16,
			}),
		).toMatchObject({
			width: 1080,
			height: 1920,
			bitrate: 20_000_000,
		});
	});

	it("does not call letterbox rows an upscale (1920x1032 window capture, 16:9 project)", () => {
		const source = { width: 1920, height: 1032 };
		const tier = (quality: "medium" | "good" | "source") =>
			calculateMp4ExportSettings({
				quality,
				sourceWidth: source.width,
				sourceHeight: source.height,
				aspectRatioValue: 16 / 9,
			});

		// The reported bug: both tiers resolve to the exact same 1920x1080 frame, so they must
		// carry the same badge. The old short-side test flagged only one of them.
		expect(tier("good")).toMatchObject({ width: 1920, height: 1080 });
		expect(tier("source")).toMatchObject({ width: 1920, height: 1080 });
		expect(wouldUpscale(tier("good"), source)).toBe(false);
		expect(wouldUpscale(tier("source"), source)).toBe(false);
		expect(wouldUpscale(tier("medium"), source)).toBe(false);
	});

	it("still flags a tier that genuinely stretches the source", () => {
		const source = { width: 1280, height: 720 };
		expect(
			wouldUpscale(
				calculateMp4ExportSettings({
					quality: "good",
					sourceWidth: source.width,
					sourceHeight: source.height,
					aspectRatioValue: 16 / 9,
				}),
				source,
			),
		).toBe(true);
	});

	it("uses the cropped area as the effective source size", () => {
		const effectiveSource = calculateEffectiveSourceDimensions(3840, 2160, {
			width: 854 / 3840,
			height: 480 / 2160,
		});

		expect(effectiveSource).toEqual({
			width: 854,
			height: 480,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 854,
			height: 480,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 20_000_000,
		});
	});
});

describe("resolveMp4ExportSettings", () => {
	it("preserves 2880x1864 for Original + Source", () => {
		expect(resolvedSettings("source", "native", { width: 2880, height: 1864 })).toMatchObject({
			width: 2880,
			height: 1864,
		});
	});

	it("keeps the default 16:9 + 1080p output at 1920x1080 without source metadata", () => {
		expect(resolvedSettings("good", "16:9", null)).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});

	it("resolves both fixed tiers for every predefined aspect ratio without source metadata", () => {
		for (const aspectRatio of ASPECT_RATIO_PRESETS) {
			for (const quality of ["medium", "good"] as const) {
				const settings = resolvedSettings(quality, aspectRatio, null);
				expect(Number.isInteger(settings.width), `${quality} ${aspectRatio} width`).toBe(true);
				expect(Number.isInteger(settings.height), `${quality} ${aspectRatio} height`).toBe(true);
				expect(settings.width, `${quality} ${aspectRatio} width`).toBeGreaterThan(0);
				expect(settings.height, `${quality} ${aspectRatio} height`).toBeGreaterThan(0);
				expect(settings.width % 2, `${quality} ${aspectRatio} width`).toBe(0);
				expect(settings.height % 2, `${quality} ${aspectRatio} height`).toBe(0);
			}
		}
	});

	it("keeps vertical and square fixed outputs concrete", () => {
		expect(resolvedSettings("medium", "9:16", null)).toMatchObject({
			width: 720,
			height: 1280,
		});
		expect(resolvedSettings("good", "1:1", null)).toMatchObject({
			width: 1080,
			height: 1080,
		});
	});

	it.each([
		["missing", null],
		["zero", { width: 0, height: 1080 }],
		["non-integer", { width: 1920.5, height: 1080 }],
		["non-finite", { width: Number.POSITIVE_INFINITY, height: 1080 }],
	])("blocks Source when %s source metadata is supplied", (_label, sourceDimensions) => {
		expect(
			resolveMp4ExportSettings({
				quality: "source",
				aspectRatio: "16:9",
				sourceDimensions,
			}),
		).toEqual({ ok: false, reason: "source-dimensions-unavailable" });
	});

	it("blocks Original when source metadata cannot resolve its frame shape", () => {
		expect(
			resolveMp4ExportSettings({
				quality: "good",
				aspectRatio: "native",
				sourceDimensions: null,
				originalDimensions: null,
			}),
		).toEqual({ ok: false, reason: "original-dimensions-unavailable" });
	});

	it("resolves a valid Source export without changing its dimensions", () => {
		expect(resolvedSettings("source", "16:9", { width: 2560, height: 1440 })).toMatchObject({
			width: 2560,
			height: 1440,
		});
	});

	it("constrains 4:3 Source output by every visible clip's contain-fit capacity", () => {
		const sources = [
			{ width: 1600, height: 100 },
			{ width: 800, height: 600 },
		];
		const result = resolveMp4ExportSettings({
			quality: "source",
			aspectRatio: "4:3",
			sourceDimensions: sources[0],
			sourceClipDimensions: sources,
		});
		expect(result).toMatchObject({ ok: true, settings: { width: 800, height: 600 } });
		if (!result.ok) throw new Error(result.reason);
		for (const source of sources) {
			expect(wouldUpscale(result.settings, source)).toBe(false);
		}
	});

	it("keeps mixed landscape, portrait, and display-rotated source geometry even", () => {
		const sources = [
			{ width: 1920, height: 1080 },
			{ width: 1080, height: 1920 },
			// A 1281x721 coded source rotated 90 degrees is reported display-first as 721x1281.
			{ width: 721, height: 1281 },
		];
		const output = calculateSourceExportDimensions(sources, 1);
		expect(output).toEqual({ width: 1280, height: 1280 });
		if (!output) throw new Error("Expected Source dimensions");
		expect(output.width % 2).toBe(0);
		expect(output.height % 2).toBe(0);
		for (const source of sources) {
			expect(wouldUpscale(output, source)).toBe(false);
		}
	});

	it("allows DCI 8K landscape and portrait at the allocation boundary", () => {
		expect(validateMp4ExportDimensions({ width: 8192, height: 4320 }).ok).toBe(true);
		expect(validateMp4ExportDimensions({ width: 4320, height: 8192 }).ok).toBe(true);
		expect(MAX_MP4_EXPORT_DIMENSION).toBe(8192);
		expect(MAX_MP4_EXPORT_PIXEL_AREA).toBe(35_389_440);
	});

	it.each([
		["one-sided", { width: 1920 }],
		["odd", { width: 1920, height: 1079 }],
		["axis limit", { width: 8194, height: 4320 }],
		["pixel-area limit", { width: 8192, height: 4322 }],
		["pathological square", { width: 8192, height: 8192 }],
	])("rejects %s output dimensions", (_label, dimensions) => {
		expect(validateMp4ExportDimensions(dimensions).ok).toBe(false);
	});

	it("rejects pathological fixed-tier aspect ratios and oversized Source before calculation", () => {
		expect(
			resolveMp4ExportSettings({
				quality: "good",
				aspectRatio: "10000:1",
				sourceDimensions: null,
			}),
		).toEqual({ ok: false, reason: "invalid-output-dimensions" });
		expect(
			resolveMp4ExportSettings({
				quality: "source",
				aspectRatio: "16:9",
				sourceDimensions: { width: Number.MAX_SAFE_INTEGER, height: 1080 },
			}),
		).toEqual({ ok: false, reason: "invalid-output-dimensions" });
	});
});
