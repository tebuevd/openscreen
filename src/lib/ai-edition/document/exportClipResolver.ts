export interface ExportClipAsset {
	id: string;
	originalPath?: string;
	durationSec?: number;
}

export interface ExportClipWindow {
	id: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec?: number;
	timelineStartSec: number;
	timelineEndSec: number;
}

export interface ExportClipTrim {
	assetId: string;
	clipId?: string;
	startSec: number;
	endSec: number;
}

export type ResolvedExportClipWindow<T extends ExportClipWindow> = T & { sourceEndSec: number };

function trimAppliesToClip(trim: ExportClipTrim, clip: ExportClipWindow): boolean {
	return trim.clipId !== undefined ? trim.clipId === clip.id : trim.assetId === clip.assetId;
}

function subtractTrim(
	intervals: Array<{ startSec: number; endSec: number }>,
	trim: ExportClipTrim,
): Array<{ startSec: number; endSec: number }> {
	const output: Array<{ startSec: number; endSec: number }> = [];
	for (const interval of intervals) {
		if (trim.endSec <= interval.startSec || trim.startSec >= interval.endSec) {
			output.push(interval);
			continue;
		}
		if (trim.startSec > interval.startSec) {
			output.push({ startSec: interval.startSec, endSec: trim.startSec });
		}
		if (trim.endSec < interval.endSec) {
			output.push({ startSec: trim.endSec, endSec: interval.endSec });
		}
	}
	return output;
}

/**
 * Pure export eligibility and trim resolver shared by raw schema migration and runtime documents.
 * It deliberately depends only on structural inputs so importing it from the schema cannot cycle
 * back through runtime document modules.
 */
export function resolveExportClipWindows<T extends ExportClipWindow>(
	clips: readonly T[],
	trimRanges: readonly ExportClipTrim[],
	assets: readonly ExportClipAsset[],
): Array<ResolvedExportClipWindow<T>> {
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const ordered = clips
		.map((clip, index) => ({ clip, index }))
		.sort((a, b) => a.clip.timelineStartSec - b.clip.timelineStartSec || a.index - b.index);
	const result: Array<ResolvedExportClipWindow<T>> = [];
	let timelineCursor = 0;

	for (const { clip } of ordered) {
		const asset = assetById.get(clip.assetId);
		if (
			!asset?.originalPath ||
			!Number.isFinite(clip.sourceStartSec) ||
			!Number.isFinite(clip.timelineStartSec) ||
			!Number.isFinite(clip.timelineEndSec) ||
			clip.timelineEndSec <= clip.timelineStartSec
		) {
			continue;
		}
		const assetDuration =
			Number.isFinite(asset.durationSec) && (asset.durationSec ?? 0) > 0
				? asset.durationSec
				: undefined;
		const sourceEndSec =
			clip.sourceEndSec !== undefined
				? assetDuration !== undefined
					? Math.min(clip.sourceEndSec, assetDuration)
					: clip.sourceEndSec
				: (assetDuration ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec));
		if (!Number.isFinite(sourceEndSec) || sourceEndSec <= clip.sourceStartSec) continue;

		let kept = [{ startSec: clip.sourceStartSec, endSec: sourceEndSec }];
		for (const trim of trimRanges) {
			if (
				!Number.isFinite(trim.startSec) ||
				!Number.isFinite(trim.endSec) ||
				!trimAppliesToClip(trim, clip)
			) {
				continue;
			}
			kept = subtractTrim(kept, trim);
		}
		kept.forEach((interval, index) => {
			const durationSec = interval.endSec - interval.startSec;
			if (durationSec <= 0) return;
			result.push({
				...clip,
				id: kept.length === 1 ? clip.id : `${clip.id}_seg${index + 1}`,
				sourceStartSec: interval.startSec,
				sourceEndSec: interval.endSec,
				timelineStartSec: timelineCursor,
				timelineEndSec: timelineCursor + durationSec,
			});
			timelineCursor += durationSec;
		});
	}
	return result;
}

export function calculateEffectiveOrientedDimensions(
	width: number,
	height: number,
	crop?: { width: number; height: number },
): { width: number; height: number } | null {
	// Width/height are display-oriented metadata, so container rotation has already been applied.
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return null;
	}
	const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
	return {
		width: even(Math.round(width * (crop?.width ?? 1))),
		height: even(Math.round(height * (crop?.height ?? 1))),
	};
}
