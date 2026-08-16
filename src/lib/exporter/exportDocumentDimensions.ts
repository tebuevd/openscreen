import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { probeVideoDimensions } from "@/lib/ai-edition/timeline/duration";
import { type ExportDimensions, hasPracticalExportSourceDimensions } from "./mp4ExportSettings";

export type ExportDimensionProbe = (asset: AxcutAsset) => Promise<ExportDimensions | null>;

export type HydratedExportDocument =
	| { ok: true; document: AxcutDocument }
	| { ok: false; assetId: string };

async function defaultProbe(asset: AxcutAsset): Promise<ExportDimensions | null> {
	return asset.originalPath ? probeVideoDimensions(toFileUrl(asset.originalPath)) : null;
}

/**
 * Supplies authoritative source geometry to an export-only document clone. Existing valid
 * metadata is reused; missing/invalid metadata is probed without persisting anything.
 */
export async function hydrateExportDocumentDimensions(
	document: AxcutDocument,
	assetIds: Iterable<string>,
	options: {
		knownDimensions?: Readonly<Record<string, ExportDimensions>>;
		probe?: ExportDimensionProbe;
	} = {},
): Promise<HydratedExportDocument> {
	const ids = new Set(assetIds);
	const dimensionsById = new Map<string, ExportDimensions>();
	const probe = options.probe ?? defaultProbe;

	for (const assetId of ids) {
		const asset = document.assets.find((candidate) => candidate.id === assetId);
		if (!asset) return { ok: false, assetId };

		const knownDimensions = options.knownDimensions?.[assetId];
		let dimensions: ExportDimensions | null | undefined = knownDimensions ?? asset.video;
		if (!hasPracticalExportSourceDimensions(dimensions)) {
			try {
				dimensions = await probe(asset);
			} catch {
				dimensions = null;
			}
		}
		if (!hasPracticalExportSourceDimensions(dimensions)) {
			return { ok: false, assetId };
		}
		dimensionsById.set(assetId, { width: dimensions.width, height: dimensions.height });
	}

	if (dimensionsById.size === 0) return { ok: true, document };
	return {
		ok: true,
		document: {
			...document,
			assets: document.assets.map((asset) => {
				const dimensions = dimensionsById.get(asset.id);
				if (!dimensions) return asset;
				return {
					...asset,
					video: {
						codec: "unknown",
						fps: 0,
						...asset.video,
						...dimensions,
					},
				};
			}),
		},
	};
}
