import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../../../src/lib/ai-edition/schema";
import { DocumentNotFoundError } from "../../ai-edition/document-service";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

describe("AiEditionService asset results", () => {
	it("returns the newly appended asset id instead of the existing primary id", async () => {
		const document = {
			project: { primaryAssetId: "asset_primary" },
			assets: [{ id: "asset_primary" }, { id: "asset_added" }],
		} as unknown as AxcutDocument;
		const service = new AiEditionService({
			documents: { addAsset: async () => document },
		} as unknown as AiEditionServiceOptions);

		await expect(service.addAsset("proj_test", "/tmp/added.mp4")).resolves.toMatchObject({
			assetId: "asset_added",
			document,
		});
	});
});

describe("AiEditionService document results", () => {
	it("distinguishes a missing document from other load failures", async () => {
		const service = new AiEditionService({
			documents: {
				getProject: async () => {
					throw new DocumentNotFoundError("proj_missing");
				},
			},
		} as unknown as AiEditionServiceOptions);

		await expect(service.get("proj_missing")).resolves.toMatchObject({
			success: false,
			notFound: true,
		});
	});
});
