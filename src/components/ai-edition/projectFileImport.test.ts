import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { importPreparedProjectFile } from "./projectFileImport";

describe("importPreparedProjectFile", () => {
	it("commits main-process context only after renderer import succeeds", async () => {
		const document = createEmptyDocument({ projectId: "proj_import", title: "Imported" });
		const importProject = vi.fn(async () => true);
		const api = {
			commitProjectFileLoad: vi.fn(async () => ({ success: true })),
			abortProjectFileLoad: vi.fn(async () => ({ success: true })),
		};

		await expect(
			importPreparedProjectFile(
				async () => ({ success: true, project: document, preparationId: "prepare-1" }),
				importProject,
				api,
			),
		).resolves.toBe(true);

		expect(importProject).toHaveBeenCalledWith(document);
		expect(api.commitProjectFileLoad).toHaveBeenCalledWith("prepare-1");
		expect(api.abortProjectFileLoad).not.toHaveBeenCalled();
	});

	it("aborts prepared context when renderer import is superseded", async () => {
		const document = createEmptyDocument({ projectId: "proj_import", title: "Imported" });
		const api = {
			commitProjectFileLoad: vi.fn(async () => ({ success: true })),
			abortProjectFileLoad: vi.fn(async () => ({ success: true })),
		};

		await expect(
			importPreparedProjectFile(
				async () => ({ success: true, project: document, preparationId: "prepare-2" }),
				async () => false,
				api,
			),
		).rejects.toThrow("Project import was superseded");

		expect(api.commitProjectFileLoad).not.toHaveBeenCalled();
		expect(api.abortProjectFileLoad).toHaveBeenCalledWith("prepare-2");
	});
});
