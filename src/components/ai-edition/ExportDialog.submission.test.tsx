// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutAsset, type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import type { AspectRatio } from "@/utils/aspectRatioUtils";

const nativeMocks = vi.hoisted(() => ({
	exportGifNative: vi.fn(),
	exportMultiNative: vi.fn(),
}));

vi.mock("@/native", () => ({
	exportGifNative: nativeMocks.exportGifNative,
	exportMultiNative: nativeMocks.exportMultiNative,
	useIsCpuCompositor: () => false,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { ExportDialog } from "./ExportDialog";

const bridgeMocks = {
	pickExportSavePath: vi.fn(),
};
const noop = () => undefined;

function video(width: number, height: number): NonNullable<AxcutAsset["video"]> {
	return { codec: "h264", width, height, fps: 60 };
}

function makeDocument(
	metadata: AxcutAsset["video"] | undefined,
	aspectRatio: AspectRatio = "16:9",
): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "project-1",
			title: "Retina recording",
			createdAt: "2026-08-16T10:00:00.000Z",
			updatedAt: "2026-08-16T10:00:00.000Z",
			primaryAssetId: "asset-1",
		},
		assets: [
			{
				id: "asset-1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/recording.mp4",
				cameraTrack: null,
				...(metadata ? { video: metadata } : {}),
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 0,
					timelineEndSec: 1,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: { aspectRatio },
	};
}

function renderDialog(document: AxcutDocument) {
	return render(
		<I18nProvider>
			<ExportDialog open onClose={noop} document={document} />
		</I18nProvider>,
	);
}

async function submitMp4() {
	fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
	await Promise.resolve();
}

describe("ExportDialog MP4 submission dimensions", () => {
	beforeEach(() => {
		localStorage.clear();
		bridgeMocks.pickExportSavePath.mockResolvedValue({
			success: true,
			path: "/tmp/export.mp4",
		});
		nativeMocks.exportMultiNative.mockResolvedValue({
			frames: 60,
			wallS: 1,
			fps: 60,
			videoDurationS: 1,
		});
		window.electronAPI = {
			pickExportSavePath: bridgeMocks.pickExportSavePath,
		} as unknown as Window["electronAPI"];
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it.each([
		["missing", undefined],
		["invalid", video(0, 1864)],
	])("blocks Source with %s metadata before invoking native export", async (_label, metadata) => {
		renderDialog(makeDocument(metadata));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		expect(
			screen.getByText(
				"Export dimensions could not be determined. Reopen the project to retry media analysis, then export again.",
			),
		).toBeInTheDocument();
		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("blocks Original without metadata instead of substituting 16:9", async () => {
		renderDialog(makeDocument(undefined, "native"));

		await submitMp4();

		expect(screen.getByText(/Export dimensions could not be determined/)).toBeInTheDocument();
		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("passes 1920x1080 for default 16:9 + 1080p without source metadata", async () => {
		renderDialog(makeDocument(undefined));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		expect(nativeMocks.exportMultiNative).toHaveBeenCalledWith(
			expect.any(Array),
			"/tmp/export.mp4",
			expect.any(String),
			{ width: 1920, height: 1080, fps: 60, codec: "h264" },
		);
	});

	it("passes exact source pixels for valid Original + Source", async () => {
		renderDialog(makeDocument(video(2880, 1864), "native"));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		expect(nativeMocks.exportMultiNative).toHaveBeenCalledWith(
			expect.any(Array),
			"/tmp/export.mp4",
			expect.any(String),
			{ width: 2880, height: 1864, fps: 60, codec: "h264" },
		);
	});
});
