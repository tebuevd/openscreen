import type {
	ProjectContext,
	ProjectFileResult,
	ProjectPathResult,
} from "../../../src/native/contracts";
import type { NativeBridgeState } from "../store";

interface ProjectServiceOptions {
	store: NativeBridgeState;
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	prepareProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	prepareProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	commitProjectFileLoad: (preparationId: string) => Promise<ProjectFileResult> | ProjectFileResult;
	abortProjectFileLoad: (preparationId: string) => Promise<ProjectFileResult> | ProjectFileResult;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
}

export class ProjectService {
	constructor(private readonly options: ProjectServiceOptions) {}

	getCurrentContext(): ProjectContext {
		const context = {
			currentProjectPath: this.options.getCurrentProjectPath(),
			currentVideoPath: this.options.getCurrentVideoPath(),
		};

		this.options.store.setProjectContext(context);
		return context;
	}

	async saveProjectFile(
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) {
		const result = await this.options.saveProjectFile(
			projectData,
			suggestedName,
			existingProjectPath,
		);
		this.getCurrentContext();
		return result;
	}

	async prepareProjectFile(projectFolder?: string) {
		const result = await this.options.prepareProjectFile(projectFolder);
		return result;
	}

	async loadCurrentProjectFile() {
		const result = await this.options.loadCurrentProjectFile();
		this.getCurrentContext();
		return result;
	}

	async prepareProjectFileFromPath(path: string) {
		const result = await this.options.prepareProjectFileFromPath(path);
		return result;
	}

	async commitProjectFileLoad(preparationId: string) {
		const result = await this.options.commitProjectFileLoad(preparationId);
		this.getCurrentContext();
		return result;
	}

	abortProjectFileLoad(preparationId: string) {
		return this.options.abortProjectFileLoad(preparationId);
	}

	async setCurrentVideoPath(path: string) {
		const result = await this.options.setCurrentVideoPath(path);
		this.getCurrentContext();
		return result;
	}

	getCurrentVideoPath() {
		const result = this.options.getCurrentVideoPathResult();
		this.getCurrentContext();
		return result;
	}

	clearCurrentVideoPath() {
		const result = this.options.clearCurrentVideoPath();
		this.getCurrentContext();
		return result;
	}
}
