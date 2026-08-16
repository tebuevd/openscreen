import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	type ExportDimensionProbe,
	hydrateExportDocumentDimensions,
} from "@/lib/exporter/exportDocumentDimensions";
import type { ExportDimensions } from "@/lib/exporter/mp4ExportSettings";

export const CLI_EXPORT_DIMENSIONS_ERROR =
	"Export dimensions could not be determined from the source video. Verify the media file and retry.";

export async function prepareCliExportDocument(
	document: AxcutDocument,
	assetIds: Iterable<string>,
	primaryAssetId: string,
	primaryDimensions: ExportDimensions,
	probe?: ExportDimensionProbe,
): Promise<AxcutDocument> {
	const result = await hydrateExportDocumentDimensions(document, assetIds, {
		knownDimensions: { [primaryAssetId]: primaryDimensions },
		probe,
	});
	if (!result.ok) throw new Error(CLI_EXPORT_DIMENSIONS_ERROR);
	return result.document;
}
