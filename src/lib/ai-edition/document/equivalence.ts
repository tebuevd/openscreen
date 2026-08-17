import type { AxcutDocument } from "../schema";

function serializeSubstantiveDocument(document: AxcutDocument): string {
	return JSON.stringify({
		...document,
		project: { ...document.project, updatedAt: "" },
	});
}

export function documentsHaveEquivalentSaveContent(
	left: AxcutDocument,
	right: AxcutDocument,
): boolean {
	return serializeSubstantiveDocument(left) === serializeSubstantiveDocument(right);
}
