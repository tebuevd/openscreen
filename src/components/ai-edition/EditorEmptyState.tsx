// Empty state for the new editor's preview.
//
// Mirrors the legacy `EditorEmptyState` (import video + load project + drag
// drop) but on top of the project store: a "no project" branch offers
// `createProject` + `loadProject`, and a "has project, no asset" branch offers
// the file picker + load (for the rare user who already has a .openscreen
// project without media attached).
//
// ponytail: keeps the existing copy from the legacy component and the same
// drag/drop affordance, but the actions map to project-store operations
// rather than the legacy `nativeBridgeClient.project.*` ones. The two editor
// shells will collapse once we have a single render path; until then the
// "open screen" feature lives here in the new UX and in the legacy
// `EditorEmptyState.tsx` for the deprecated editor.

import { AlertCircle, Film, FolderOpen, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./NewEditorShell.module.css";
import { importPreparedProjectFile } from "./projectFileImport";
import { replaceCurrentProject } from "./projectReplacementGate";

type DropError = "unsupported-format" | "load-failed" | null;

interface EditorEmptyStateProps {
	/** True when a project exists (so the copy becomes "add a video" not "no project"). */
	hasProject: boolean;
	/** Show the file dialog (Open Video) and a Load Project button when no project is loaded. */
	showLoadProjectButton?: boolean;
}

export function EditorEmptyState({
	hasProject,
	showLoadProjectButton = true,
}: EditorEmptyStateProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [dropError, setDropError] = useState<DropError>(null);
	const lastDropErrorRef = useRef<Exclude<DropError, null>>("unsupported-format");
	if (dropError !== null) {
		lastDropErrorRef.current = dropError;
	}

	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const importProject = useProjectStore((s) => s.importProject);

	const handleImportVideo = useCallback(async () => {
		const result = await window.electronAPI?.openVideoFilePicker?.();
		if (!result || result.canceled || !result.success || !result.path) return;
		const path = result.path;
		try {
			const label = result.name || path.split(/[\\/]/).pop() || "Recording";
			if (useProjectStore.getState().projectId) {
				await addAsset(path, label);
			} else {
				await replaceCurrentProject("new", async () => {
					await createProject(`Project ${new Date().toLocaleString()}`);
					await addAsset(path, label);
				});
			}
		} catch (err) {
			setDropError("load-failed");
			// ponytail: surface as a console message only — the dialog above
			// already tells the user something went wrong.
			console.error("Failed to import video", err);
		}
	}, [addAsset, createProject]);

	const handleLoadProject = useCallback(async () => {
		try {
			const api = window.electronAPI;
			if (!api) return;
			await replaceCurrentProject("open", () =>
				importPreparedProjectFile(() => api.prepareProjectFile(), importProject, api),
			);
		} catch {
			setDropError("load-failed");
		}
	}, [importProject]);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.items.length > 0) {
			setIsDraggingOver(true);
		}
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDraggingOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDraggingOver(false);
			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) return;
			const projectFile = files.find((f) => f.name.endsWith(".openscreen"));
			if (!projectFile) {
				setDropError("unsupported-format");
				return;
			}
			let filePath: string;
			try {
				filePath = window.electronAPI?.getPathForFile(projectFile) ?? "";
			} catch {
				setDropError("load-failed");
				return;
			}
			if (!filePath) {
				setDropError("load-failed");
				return;
			}
			try {
				const api = window.electronAPI;
				if (!api) throw new Error("Desktop project API is unavailable");
				await replaceCurrentProject("open", () =>
					importPreparedProjectFile(
						() => api.prepareProjectFileFromPath(filePath),
						importProject,
						api,
					),
				);
			} catch {
				setDropError("load-failed");
			}
		},
		[importProject],
	);

	return (
		<div
			className={styles.previewEmptyDrop}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{isDraggingOver ? (
				<div className={styles.previewEmptyDropOverlay}>
					<Upload className={styles.previewEmptyDropIcon} />
					<p className={styles.previewEmptyDropLabel}>{t("emptyState.dropOverlay")}</p>
				</div>
			) : null}

			<Dialog open={dropError !== null} onOpenChange={(open) => !open && setDropError(null)}>
				<DialogContent className={styles.previewEmptyDialog}>
					<DialogHeader className={styles.previewEmptyDialogHeader}>
						<div className={styles.previewEmptyDialogHeaderInner}>
							<img
								src="./openscreen.png"
								alt=""
								aria-hidden="true"
								className={styles.previewEmptyDialogLogo}
							/>
							<DialogTitle className={styles.previewEmptyDialogTitle}>
								{lastDropErrorRef.current === "unsupported-format"
									? t("emptyState.dropErrors.unsupportedFormatTitle")
									: t("emptyState.dropErrors.couldNotOpenTitle")}
							</DialogTitle>
						</div>
					</DialogHeader>
					<div className={styles.previewEmptyDialogBody}>
						<div className={styles.previewEmptyDialogIcon}>
							<AlertCircle className={styles.previewEmptyDialogAlertIcon} />
						</div>
						<p className={styles.previewEmptyDialogMessage}>
							{lastDropErrorRef.current === "unsupported-format"
								? t("emptyState.dropErrors.unsupportedFormatMessage")
								: t("emptyState.dropErrors.couldNotOpenMessage")}
						</p>
					</div>
					<button
						type="button"
						onClick={() => setDropError(null)}
						className={styles.previewEmptyDialogClose}
					>
						<X className={styles.previewEmptyDialogCloseIcon} />
						{tc("actions.close")}
					</button>
				</DialogContent>
			</Dialog>

			<div className={styles.previewEmptyInner}>
				<img src="./openscreen.png" alt="" aria-hidden="true" className={styles.previewEmptyLogo} />
				<div className={styles.previewEmptyHeading}>
					<h2 className={styles.previewEmptyTitle}>
						{hasProject ? t("emptyState.titleHasAsset") : t("emptyState.title")}
					</h2>
					<p className={styles.previewEmptyDescription}>
						{hasProject ? t("emptyState.descriptionHasAsset") : t("emptyState.description")}
					</p>
				</div>
				<div className={styles.previewEmptyActions}>
					<button
						type="button"
						onClick={() => void handleImportVideo()}
						className={styles.previewEmptyPrimaryButton}
					>
						<Film className={styles.previewEmptyButtonIcon} />
						{hasProject ? t("emptyState.importVideoButton") : t("emptyState.newProjectButton")}
					</button>
					{showLoadProjectButton && !hasProject ? (
						<button
							type="button"
							onClick={() => void handleLoadProject()}
							className={styles.previewEmptySecondaryButton}
						>
							<FolderOpen className={styles.previewEmptyButtonIcon} />
							{t("emptyState.loadProjectButton")}
						</button>
					) : null}
				</div>
				<p className={styles.previewEmptyHint}>{t("emptyState.supportedFormats")}</p>
				<p className={styles.previewEmptyDragHint}>
					<Upload className={styles.previewEmptyDragHintIcon} />
					{t("emptyState.dragDropHint")}
				</p>
			</div>
		</div>
	);
}
