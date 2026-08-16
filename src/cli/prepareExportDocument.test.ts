import { describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { buildSceneDescription } from "@/native/sceneDescription";
import { CLI_EXPORT_DIMENSIONS_ERROR, prepareCliExportDocument } from "./prepareExportDocument";

function documentWithAssets(
	assets: AxcutDocument["assets"],
	aspectRatio: "9:16" | "native" = "9:16",
): AxcutDocument {
	return {
		schemaVersion: 7,
		project: {
			id: "project-1",
			title: "CLI export",
			createdAt: "2026-08-16T10:00:00.000Z",
			updatedAt: "2026-08-16T10:00:00.000Z",
			primaryAssetId: assets[0]?.id,
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips: assets.map((asset, index) => ({
				id: `clip-${index}`,
				assetId: asset.id,
				sourceStartSec: 0,
				sourceEndSec: 1,
				timelineStartSec: index,
				timelineEndSec: index + 1,
				wordRefs: [],
				origin: "user",
				reason: "",
			})),
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: { aspectRatio },
	};
}

function asset(id: string): AxcutDocument["assets"][number] {
	return {
		id,
		kind: "video",
		label: id,
		originalPath: `/tmp/${id}.mp4`,
		cameraTrack: null,
	};
}

describe("prepareCliExportDocument", () => {
	it("hydrates probed dimensions into the export-only scene document", async () => {
		const original = documentWithAssets([asset("primary")]);
		const probed = {
			width: 1080,
			height: 1920,
			durationMs: 1000,
		};
		const prepared = await prepareCliExportDocument(original, ["primary"], "primary", probed);

		expect(original.assets[0].video).toBeUndefined();
		expect(prepared.assets[0].video).toMatchObject({ width: 1080, height: 1920 });
		expect(prepared.assets[0].video).not.toHaveProperty("durationMs");
		expect(buildSceneDescription(prepared).output).toEqual({
			width: 1080,
			height: 1920,
			fps: null,
		});
	});

	it("keeps odd probed source geometry in scene layout while output stays even", async () => {
		const prepared = await prepareCliExportDocument(
			documentWithAssets([asset("primary")], "native"),
			["primary"],
			"primary",
			{ width: 1365, height: 767 },
		);
		const scene = buildSceneDescription(prepared);
		const screenRect = scene.layout.screenRect;

		expect(prepared.assets[0].video).toMatchObject({ width: 1365, height: 767 });
		expect(scene.output.width % 2).toBe(0);
		expect(scene.output.height % 2).toBe(0);
		expect(screenRect).not.toBeNull();
		if (!screenRect) throw new Error("Expected a screen rect");
		const renderedAspect =
			(screenRect.width * scene.output.width) / (screenRect.height * scene.output.height);
		expect(renderedAspect).toBeCloseTo(1365 / 767, 3);
	});

	it("blocks when another visible asset cannot be probed", async () => {
		const probe = vi.fn(async () => null);
		await expect(
			prepareCliExportDocument(
				documentWithAssets([asset("primary"), asset("secondary")]),
				["primary", "secondary"],
				"primary",
				{ width: 1920, height: 1080 },
				probe,
			),
		).rejects.toThrow(CLI_EXPORT_DIMENSIONS_ERROR);
		expect(probe).toHaveBeenCalledOnce();
	});

	it("rejects pathological probed source metadata before scene/native allocation", async () => {
		await expect(
			prepareCliExportDocument(
				documentWithAssets([asset("primary")]),
				["primary"],
				"primary",
				{ width: 8192, height: 4322 },
				async () => null,
			),
		).rejects.toThrow(CLI_EXPORT_DIMENSIONS_ERROR);
	});
});
