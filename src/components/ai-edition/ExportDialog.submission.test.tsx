// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

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

function LifecycleDialog({ document }: { document: AxcutDocument }) {
	const [open, setOpen] = useState(true);
	return (
		<I18nProvider>
			<button type="button" onClick={() => setOpen(true)}>
				Reopen export
			</button>
			<ExportDialog open={open} onClose={() => setOpen(false)} document={document} />
		</I18nProvider>
	);
}

function renderLifecycleDialog(document: AxcutDocument) {
	return render(<LifecycleDialog document={document} />);
}

async function submitMp4() {
	fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
	await Promise.resolve();
}

function submittedScene(call: unknown[] | undefined) {
	const sceneJson = call?.[2];
	if (typeof sceneJson !== "string") throw new Error("Expected submitted scene JSON");
	return JSON.parse(sceneJson) as {
		clips: Array<{ screenPath: string; sourceStartSec: number; sourceEndSec: number }>;
		output: { width: number; height: number; fps: number | null };
		layout: {
			screenRect: { width: number; height: number } | null;
		};
	};
}

describe("ExportDialog submission", () => {
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
		expect(call?.[3]).toEqual({
			width: 2880,
			height: 1864,
			fps: 60,
			bitrate: 80_000_000,
			codec: "h264",
		});
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

	it("passes the calculated default 1080p bitrate and builds the scene from source geometry", async () => {
		probeVideoDimensionsMock.mockResolvedValue({ width: 2880, height: 1864 });
		renderDialog(makeDocument(undefined));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[1]).toBe("/tmp/export.mp4");
		expect(call?.[3]).toEqual({
			width: 1920,
			height: 1080,
			fps: 60,
			bitrate: 20_000_000,
			codec: "h264",
		});
		const scene = submittedScene(call);
		expect(scene.output).toEqual({ width: 1920, height: 1080, fps: null });
		expect(scene.layout.screenRect).not.toBeNull();
		if (!scene.layout.screenRect) throw new Error("Expected a screen rect");
		const renderedAspect =
			(scene.layout.screenRect.width * scene.output.width) /
			(scene.layout.screenRect.height * scene.output.height);
		expect(renderedAspect).toBeCloseTo(2880 / 1864, 3);
	});

	it("passes exact source pixels and calculated bitrate for high-resolution Source", async () => {
		renderDialog(makeDocument(video(2880, 1864), "native"));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(call?.[3]).toEqual({
			width: 2880,
			height: 1864,
			fps: 60,
			bitrate: 80_000_000,
			codec: "h264",
		});
		expect(submittedScene(call).output).toEqual({ width: 2880, height: 1864, fps: null });
	});

	it("excludes non-exported clips from Source size, Original aspect, and the native scene", async () => {
		const document = makeDocument(video(2880, 1864), "native");
		document.assets.push(
			{
				id: "trimmed-portrait",
				kind: "video",
				label: "Trimmed portrait",
				originalPath: "/tmp/trimmed.mp4",
				cameraTrack: null,
				video: video(2160, 3840),
			},
			{
				id: "pathless",
				kind: "video",
				label: "Pathless",
				originalPath: "",
				cameraTrack: null,
				video: video(100, 100),
			} as AxcutAsset,
		);
		document.timeline.clips.push(
			{
				...document.timeline.clips[0],
				id: "trimmed-clip",
				assetId: "trimmed-portrait",
				timelineStartSec: 1,
				timelineEndSec: 2,
			},
			{
				...document.timeline.clips[0],
				id: "pathless-clip",
				assetId: "pathless",
				timelineStartSec: 2,
				timelineEndSec: 3,
			},
			{
				...document.timeline.clips[0],
				id: "missing-clip",
				assetId: "missing",
				timelineStartSec: 3,
				timelineEndSec: 4,
			},
		);
		document.timeline.trimRanges.push({
			id: "trim-all",
			assetId: "trimmed-portrait",
			clipId: "trimmed-clip",
			startSec: 0,
			endSec: 1,
			origin: "user",
			reason: "",
		});
		renderDialog(document);
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toMatchObject({ width: 2880, height: 1864 });
		const scene = submittedScene(call);
		expect(scene.output).toEqual({ width: 2880, height: 1864, fps: null });
		expect(scene.clips.map((clip) => clip.screenPath)).toEqual(["/tmp/recording.mp4"]);
		expect(call?.[0]).toEqual(scene.clips);
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
	});

	it("uses every visible clip's contain-fit capacity for 4:3 Source", async () => {
		const document = makeDocument(video(1600, 100), "4:3");
		document.assets.push({
			id: "asset-2",
			kind: "video",
			label: "Second clip",
			originalPath: "/tmp/second.mp4",
			cameraTrack: null,
			video: video(800, 600),
		});
		document.timeline.clips.push({
			...document.timeline.clips[0],
			id: "clip-2",
			assetId: "asset-2",
			timelineStartSec: 1,
			timelineEndSec: 2,
		});
		renderDialog(document);
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toMatchObject({ width: 800, height: 600 });
		const scene = submittedScene(call);
		expect(scene.output).toEqual({ width: 800, height: 600, fps: null });
		expect(scene.clips.map((clip) => clip.screenPath)).toEqual([
			"/tmp/recording.mp4",
			"/tmp/second.mp4",
		]);
		expect(call?.[0]).toEqual(scene.clips);
		for (const source of [video(1600, 100), video(800, 600)]) {
			expect(Math.min(800 / source.width, 600 / source.height)).toBeLessThanOrEqual(1);
		}
	});

	it("blocks a fully trimmed timeline before save or native export", async () => {
		const document = makeDocument(video(1920, 1080));
		document.timeline.trimRanges.push({
			id: "trim-all",
			assetId: "asset-1",
			clipId: "clip-1",
			startSec: 0,
			endSec: 1,
			origin: "user",
			reason: "",
		});
		renderDialog(document);

		await submitMp4();

		expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing to export/);
		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it.each([
		[
			"portrait",
			"9:16" as const,
			{ width: 1080, height: 1920 },
			{ width: 1080, height: 1920, bitrate: 20_000_000 },
		],
		[
			"square",
			"1:1" as const,
			{ width: 1200, height: 1200 },
			{ width: 1080, height: 1080, bitrate: 20_000_000 },
		],
	])("builds a hydrated %s scene while keeping fixed-tier output concrete", async (_label, aspectRatio, probed, expectedParams) => {
		probeVideoDimensionsMock.mockResolvedValue(probed);
		renderDialog(makeDocument(undefined, aspectRatio));

		await submitMp4();

		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toEqual({ ...expectedParams, fps: 60, codec: "h264" });
		const scene = submittedScene(call);
		expect(scene.output).toEqual({
			width: expectedParams.width,
			height: expectedParams.height,
			fps: null,
		});
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
		expect(submittedScene(call).output).toEqual({ width: 404, height: 720, fps: null });
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("does not continue when a source probe resolves after close", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock.mockReturnValueOnce(probe.promise);
		renderLifecycleDialog(makeDocument(undefined));

		await submitMp4();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await act(async () => {
			probe.resolve({ width: 1920, height: 1080 });
			await probe.promise;
			await Promise.resolve();
		});

		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("does not restore a stale probe error after close and reopen", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		probeVideoDimensionsMock.mockReturnValueOnce(probe.promise);
		renderLifecycleDialog(makeDocument(undefined));

		await submitMp4();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		fireEvent.click(screen.getByRole("button", { name: "Reopen export" }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await act(async () => {
			probe.reject(new Error("probe failed"));
			await probe.promise.catch(noop);
			await Promise.resolve();
		});

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled();
		expect(bridgeMocks.pickExportSavePath).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("does not start native export when the save picker resolves after close", async () => {
		const picker = deferred<{ success: true; path: string }>();
		bridgeMocks.pickExportSavePath.mockReturnValueOnce(picker.promise);
		renderLifecycleDialog(makeDocument(video(1920, 1080)));

		await submitMp4();
		await waitFor(() => expect(bridgeMocks.pickExportSavePath).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "Close" }));

		await act(async () => {
			picker.resolve({ success: true, path: "/tmp/stale.mp4" });
			await picker.promise;
			await Promise.resolve();
		});

		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Reopen export" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled();
	});

	it("completes the current deferred submission attempt", async () => {
		const probe = deferred<{ width: number; height: number } | null>();
		const picker = deferred<{ success: true; path: string }>();
		probeVideoDimensionsMock.mockReturnValueOnce(probe.promise);
		bridgeMocks.pickExportSavePath.mockReturnValueOnce(picker.promise);
		renderLifecycleDialog(makeDocument(undefined));

		await submitMp4();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledOnce());
		probe.resolve({ width: 1920, height: 1080 });
		await waitFor(() => expect(bridgeMocks.pickExportSavePath).toHaveBeenCalledOnce());
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();

		picker.resolve({ success: true, path: "/tmp/current.mp4" });
		await waitFor(() => expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce());
		expect(await screen.findByText("/tmp/current.mp4")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
