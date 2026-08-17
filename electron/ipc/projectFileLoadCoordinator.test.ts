import { describe, expect, it, vi } from "vitest";
import { ProjectFileLoadCoordinator } from "./projectFileLoadCoordinator";

describe("ProjectFileLoadCoordinator", () => {
	it("keeps prepared project context read-only until commit", () => {
		const apply = vi.fn();
		const coordinator = new ProjectFileLoadCoordinator(apply, () => "load-1");
		const prepared = {
			path: "/projects/example.openscreen",
			project: { title: "Example" },
			session: { screenVideoPath: "/projects/example.mp4", createdAt: 1 },
		};

		expect(coordinator.prepare(prepared)).toEqual({
			success: true,
			path: prepared.path,
			project: prepared.project,
			preparationId: "load-1",
		});
		expect(apply).not.toHaveBeenCalled();

		expect(coordinator.commit("load-1")).toEqual({ success: true, path: prepared.path });
		expect(apply).toHaveBeenCalledWith(prepared);
		expect(coordinator.commit("load-1")).toMatchObject({ success: false });
	});

	it("drops an aborted preparation without applying it", () => {
		const apply = vi.fn();
		const coordinator = new ProjectFileLoadCoordinator(apply, () => "load-2");
		coordinator.prepare({ path: "/project.openscreen", project: {}, session: null });

		expect(coordinator.abort("load-2")).toEqual({ success: true });
		expect(coordinator.commit("load-2")).toMatchObject({ success: false });
		expect(apply).not.toHaveBeenCalled();
	});
});
