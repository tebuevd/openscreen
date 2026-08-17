import { describe, expect, it, vi } from "vitest";
import { createNativeBridgeState } from "../store";
import { ProjectService } from "./projectService";

describe("ProjectService project-file transactions", () => {
	it("does not publish prepared context until commit", async () => {
		let currentProjectPath: string | null = "/projects/current.openscreen";
		let currentVideoPath: string | null = "/projects/current.mp4";
		const store = createNativeBridgeState("linux");
		const service = new ProjectService({
			store,
			getCurrentProjectPath: () => currentProjectPath,
			getCurrentVideoPath: () => currentVideoPath,
			saveProjectFile: vi.fn(),
			prepareProjectFile: vi.fn(async () => ({
				success: true,
				project: { title: "Next" },
				preparationId: "prepare-1",
			})),
			loadCurrentProjectFile: vi.fn(),
			prepareProjectFileFromPath: vi.fn(),
			commitProjectFileLoad: vi.fn(() => {
				currentProjectPath = "/projects/next.openscreen";
				currentVideoPath = "/projects/next.mp4";
				return { success: true };
			}),
			abortProjectFileLoad: vi.fn(() => ({ success: true })),
			setCurrentVideoPath: vi.fn(),
			getCurrentVideoPathResult: vi.fn(() => ({ success: true })),
			clearCurrentVideoPath: vi.fn(() => ({ success: true })),
		});
		service.getCurrentContext();

		await service.prepareProjectFile();
		expect(store.getState().project).toEqual({
			currentProjectPath: "/projects/current.openscreen",
			currentVideoPath: "/projects/current.mp4",
		});

		await service.commitProjectFileLoad("prepare-1");
		expect(store.getState().project).toEqual({
			currentProjectPath: "/projects/next.openscreen",
			currentVideoPath: "/projects/next.mp4",
		});
	});
});
