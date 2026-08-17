// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { replaceCurrentProject } from "./projectReplacementGate";

export type PendingRecordingImportResult = "none" | "imported" | "blocked";

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
 *
 * Returns `none` when there is nothing pending so the caller can reopen the most
 * recent project. A blocked replacement leaves the session in place without
 * falling through to another replacement; failures throw so a later mount can retry.
 */
export async function importPendingRecording(): Promise<PendingRecordingImportResult> {
	const api = window.electronAPI;
	if (!api) return "none";

	const result = await api.getCurrentRecordingSession();
	// Project-file commits also expose their media as the current session for legacy
	// preview/export consumers, but only recorder hand-offs are eligible for auto-import.
	const screenPath = result.success && result.pending ? result.session?.screenVideoPath : undefined;
	if (!screenPath) return "none";

	const label = screenPath.split(/[\\/]/).pop() || "Recording";
	const outcome = await replaceCurrentProject("new", async () => {
		await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
		await useProjectStore.getState().addAsset(screenPath, label);
		// Consumed: the recording now lives in a project. Cleared here rather than
		// after the timeline seed below so a failure down there can't hand the same
		// recording to the next editor window.
		await api.setCurrentRecordingSession(null);

		// ponytail: MediaRecorder WebMs ship with duration = NaN until
		// fix-webm-duration patches the EBML header; until that flows through the
		// asset, drop a default 60s clip into the timeline so the editor isn't stuck
		// on "No clips yet" the moment the user lands in the project. Real duration
		// overwrites this when handleLoadedMetadata fires with a finite value.
		const doc = useProjectStore.getState().document;
		if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
			await useProjectStore
				.getState()
				.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording");
		}
	});
	return outcome.status === "completed" ? "imported" : "blocked";
}
