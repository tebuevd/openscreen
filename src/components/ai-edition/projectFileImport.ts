import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import {
	migrateProjectDataToAxcutDocument,
	migrateRawDocumentToCurrent,
} from "@/lib/ai-edition/document/migrate";
import { type AxcutDocument, documentSchema } from "@/lib/ai-edition/schema";
import type { ProjectFileResult } from "@/native/contracts";

interface ProjectFileTransactionApi {
	commitProjectFileLoad: (preparationId: string) => Promise<ProjectFileResult>;
	abortProjectFileLoad: (preparationId: string) => Promise<ProjectFileResult>;
}

export async function importPreparedProjectFile(
	prepare: () => Promise<ProjectFileResult | undefined>,
	importProject: (document: AxcutDocument) => Promise<boolean>,
	api: ProjectFileTransactionApi,
): Promise<boolean | null> {
	const prepared = await prepare();
	if (!prepared?.success || prepared.project === undefined) return null;
	if (!prepared.preparationId) throw new Error("Project load did not create a preparation");

	let committed = false;
	try {
		const raw = prepared.project;
		const isAxcutDocument =
			typeof raw === "object" && raw !== null && "schemaVersion" in raw && "timeline" in raw;
		const document = isAxcutDocument
			? documentSchema.parse(migrateRawDocumentToCurrent(raw))
			: migrateProjectDataToAxcutDocument(raw as EditorProjectData);
		if (!(await importProject(document))) throw new Error("Project import was superseded");

		const commit = await api.commitProjectFileLoad(prepared.preparationId);
		if (!commit.success) {
			throw new Error(commit.error ?? commit.message ?? "Could not commit project load");
		}
		committed = true;
		return isAxcutDocument;
	} finally {
		if (!committed) {
			await api.abortProjectFileLoad(prepared.preparationId).catch(() => undefined);
		}
	}
}
