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
const probeVideoDimensionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/native", () => ({
	exportGifNative: nativeMocks.exportGifNative,
	exportMultiNative: nativeMocks.exportMultiNative,
	useIsCpuCompositor: () => false,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/ai-edition/timeline/duration", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ai-edition/timeline/duration")>()),
	probeVideoDimensions: probeVideoDimensionsMock,
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

function submittedScene(call: unknown[] | undefined) {
	const sceneJson = call?.[2];
	if (typeof sceneJson !== "string") throw new Error("Expected submitted scene JSON");
	return JSON.parse(sceneJson) as {
		output: { width: number; height: number; fps: number | null };
		layout: {
			screenRect: { width: number; height: number } | null;
		};
	};
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
		nativeMocks.exportGifNative.mockResolvedValue({
			frames: 15,
			wallS: 1,
			fps: 15,
			videoDurationS: 1,
			fileBytes: 1024,
		});
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
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
	])("probes %s persisted metadata before a Source export", async (_label, metadata) => {
		probeVideoDimensionsMock.mockResolvedValue({ width: 2880, height: 1864 });
		renderDialog(makeDocument(metadata, "native"));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		expect(probeVideoDimensionsMock).toHaveBeenCalledOnce();
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toEqual({ width: 2880, height: 1864, fps: 60, codec: "h264" });
		expect(submittedScene(call).output).toEqual({ width: 2880, height: 1864, fps: null });
	});

	it("blocks before save/native export when the on-demand probe fails", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null);
		renderDialog(makeDocument(undefined));

		await submitMp4();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/Export dimensions could not be determined/,
		);
		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("passes 1920x1080 but builds the 16:9 scene from probed source geometry", async () => {
		probeVideoDimensionsMock.mockResolvedValue({ width: 2880, height: 1864 });
		renderDialog(makeDocument(undefined));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[1]).toBe("/tmp/export.mp4");
		expect(call?.[3]).toEqual({ width: 1920, height: 1080, fps: 60, codec: "h264" });
		const scene = submittedScene(call);
		expect(scene.output).toEqual({ width: 2880, height: 1620, fps: null });
		expect(scene.layout.screenRect).not.toBeNull();
		if (!scene.layout.screenRect) throw new Error("Expected a screen rect");
		const renderedAspect =
			(scene.layout.screenRect.width * scene.output.width) /
			(scene.layout.screenRect.height * scene.output.height);
		expect(renderedAspect).toBeCloseTo(2880 / 1864, 3);
	});

	it("passes exact source pixels for valid Original + Source", async () => {
		renderDialog(makeDocument(video(2880, 1864), "native"));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(call?.[3]).toEqual({ width: 2880, height: 1864, fps: 60, codec: "h264" });
		expect(submittedScene(call).output).toEqual({ width: 2880, height: 1864, fps: null });
	});

	it.each([
		["portrait", "9:16" as const, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }],
		["square", "1:1" as const, { width: 1200, height: 1200 }, { width: 1080, height: 1080 }],
	])("builds a hydrated %s scene while keeping fixed-tier output concrete", async (_label, aspectRatio, probed, expectedParams) => {
		probeVideoDimensionsMock.mockResolvedValue(probed);
		renderDialog(makeDocument(undefined, aspectRatio));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toEqual({ ...expectedParams, fps: 60, codec: "h264" });
		const scene = submittedScene(call);
		expect(scene.output).toEqual({ ...probed, fps: null });
		expect(scene.layout.screenRect).not.toBeNull();
		if (!scene.layout.screenRect) throw new Error("Expected a screen rect");
		const renderedAspect =
			(scene.layout.screenRect.width * scene.output.width) /
			(scene.layout.screenRect.height * scene.output.height);
		expect(renderedAspect).toBeCloseTo(probed.width / probed.height, 3);
	});

	it("hydrates shared scene geometry without changing GIF sizing", async () => {
		probeVideoDimensionsMock.mockResolvedValue({ width: 1080, height: 1920 });
		renderDialog(makeDocument(undefined, "9:16"));
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		fireEvent.click(screen.getByRole("button", { name: "Export GIF" }));

		await waitFor(() => expect(nativeMocks.exportGifNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportGifNative.mock.calls[0];
		expect(call?.[3]).toEqual({ width: 404, height: 720, fps: 15, loopCount: 0 });
		expect(submittedScene(call).output).toEqual({ width: 1080, height: 1920, fps: null });
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});
});
