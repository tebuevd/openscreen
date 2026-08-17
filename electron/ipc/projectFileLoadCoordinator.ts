import { randomUUID } from "node:crypto";
import type { RecordingSession } from "../../src/lib/recordingSession";
import type { ProjectFileResult } from "../../src/native/contracts";

export interface PreparedProjectFileLoad {
	path: string;
	project: unknown;
	session: RecordingSession | null;
}

type ApplyPreparedProjectFileLoad = (prepared: PreparedProjectFileLoad) => void;

export class ProjectFileLoadCoordinator {
	private readonly preparedLoads = new Map<string, PreparedProjectFileLoad>();

	constructor(
		private readonly apply: ApplyPreparedProjectFileLoad,
		private readonly createId: () => string = randomUUID,
	) {}

	prepare(prepared: PreparedProjectFileLoad): ProjectFileResult {
		const preparationId = this.createId();
		this.preparedLoads.set(preparationId, prepared);
		return {
			success: true,
			path: prepared.path,
			project: prepared.project,
			preparationId,
		};
	}

	commit(preparationId: string): ProjectFileResult {
		const prepared = this.preparedLoads.get(preparationId);
		if (!prepared) {
			return { success: false, message: "Prepared project load is no longer available" };
		}

		this.preparedLoads.delete(preparationId);
		this.apply(prepared);
		return { success: true, path: prepared.path };
	}

	abort(preparationId: string): ProjectFileResult {
		this.preparedLoads.delete(preparationId);
		return { success: true };
	}
}
