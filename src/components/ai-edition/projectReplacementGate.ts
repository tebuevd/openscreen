import { toast } from "sonner";
import { DocumentSaveError, useProjectStore } from "@/lib/ai-edition/store/projectStore";

export type ProjectReplacementAction = "new" | "open" | "record";
export type ProjectReplacementChoice = "save" | "discard" | "cancel";

export type ProjectReplacementOutcome<T> =
	| { status: "completed"; value: T }
	| { status: "cancelled" | "busy" | "save-failed" };

type ProjectReplacementPrompt = (
	action: ProjectReplacementAction,
) => Promise<ProjectReplacementChoice>;

let promptReplacement: ProjectReplacementPrompt | null = null;
let activeLifecycleOperation: symbol | null = null;

export interface ProjectLifecycleLease {
	release: () => void;
}

export function tryBeginProjectLifecycleOperation(): ProjectLifecycleLease | null {
	if (activeLifecycleOperation) return null;

	const operation = Symbol("project-lifecycle-operation");
	activeLifecycleOperation = operation;
	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			if (activeLifecycleOperation === operation) activeLifecycleOperation = null;
		},
	};
}

export function registerProjectReplacementPrompt(prompt: ProjectReplacementPrompt): () => void {
	promptReplacement = prompt;
	return () => {
		if (promptReplacement === prompt) promptReplacement = null;
	};
}

export async function saveCurrentProjectFromUserIntent(): Promise<void> {
	const state = useProjectStore.getState();
	if (!state.document) throw new DocumentSaveError("No project document is loaded");

	const outcome =
		state.status === "error"
			? await state.saveRecoveryDocument()
			: await state.saveDocument(state.document);
	if (!outcome.appliedToCurrent) {
		throw new DocumentSaveError("The project changed while it was being saved");
	}

	const current = useProjectStore.getState();
	if (
		current.documentGeneration !== outcome.documentGeneration ||
		current.revision !== outcome.revision ||
		current.projectId !== outcome.projectId ||
		current.document?.project.id !== outcome.projectId ||
		current.status !== "ready" ||
		current.dirty
	) {
		throw new DocumentSaveError("The current project was not authoritatively saved");
	}
}

export async function replaceCurrentProject<T>(
	action: ProjectReplacementAction,
	replacement: () => Promise<T>,
): Promise<ProjectReplacementOutcome<T>> {
	return runProjectLifecycleOperation(action, replacement);
}

export async function deleteProjectThroughLifecycleGate<T>(
	projectId: string,
	deletion: () => Promise<T>,
): Promise<ProjectReplacementOutcome<T>> {
	const activeProjectId = useProjectStore.getState().projectId;
	return runProjectLifecycleOperation(activeProjectId === projectId ? "open" : null, deletion);
}

async function runProjectLifecycleOperation<T>(
	action: ProjectReplacementAction | null,
	operation: () => Promise<T>,
): Promise<ProjectReplacementOutcome<T>> {
	const lease = tryBeginProjectLifecycleOperation();
	if (!lease) return { status: "busy" };
	try {
		const state = useProjectStore.getState();
		if (action && state.document && state.dirty) {
			if (!promptReplacement) return { status: "cancelled" };
			const choice = await promptReplacement(action).catch(() => "cancel" as const);
			if (choice === "cancel") return { status: "cancelled" };
			if (choice === "save") {
				try {
					await saveCurrentProjectFromUserIntent();
				} catch (error) {
					toast.error("Save failed", {
						description: error instanceof Error ? error.message : String(error),
					});
					return { status: "save-failed" };
				}
			}
		}

		return { status: "completed", value: await operation() };
	} finally {
		lease.release();
	}
}
