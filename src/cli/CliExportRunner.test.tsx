// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliExportRequest } from "@/lib/cliContracts";

const nativeMocks = vi.hoisted(() => ({
	abortStagedNativeExport: vi.fn(),
	commitStagedNativeExport: vi.fn(),
	exportGifNative: vi.fn(),
	exportMultiNative: vi.fn(),
	exportMultiNativeStaged: vi.fn(),
	loadProjectFileFromPath: vi.fn(),
	getTelemetry: vi.fn(),
	replaceStagedNativeExport: vi.fn(),
}));
const voiceoverMocks = vi.hoisted(() => ({ mixVoiceoverIntoVideo: vi.fn() }));

vi.mock("@/native", () => ({
	abortStagedNativeExport: nativeMocks.abortStagedNativeExport,
	commitStagedNativeExport: nativeMocks.commitStagedNativeExport,
	exportGifNative: nativeMocks.exportGifNative,
	exportMultiNative: nativeMocks.exportMultiNative,
	exportMultiNativeStaged: nativeMocks.exportMultiNativeStaged,
	nativeBridgeClient: {
		project: { loadProjectFileFromPath: nativeMocks.loadProjectFileFromPath },
		cursor: { getTelemetry: nativeMocks.getTelemetry },
	},
	replaceStagedNativeExport: nativeMocks.replaceStagedNativeExport,
}));

vi.mock("@/lib/exporter/voiceoverMix", () => ({
	mixVoiceoverIntoVideo: voiceoverMocks.mixVoiceoverIntoVideo,
}));

import { runExport } from "./CliExportRunner";

function request(quality: "good" | "source"): CliExportRequest {
	return {
		kind: "export",
		projectPath: "/tmp/project.openscreen",
		outPath: "/tmp/export.mp4",
		format: "mp4",
		quality,
		gifFrameRate: null,
		gifSizePreset: null,
		autoZoom: false,
		audioPath: null,
		audioMode: "mix",
		audioOffsetSec: 0,
	};
}

function mockVideoMetadata(width: number, height: number): void {
	const createElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((
		tagName: string,
		options?: ElementCreationOptions,
	) => {
		const element = createElement(tagName, options);
		if (tagName.toLowerCase() !== "video") return element;

		const video = element as HTMLVideoElement;
		Object.defineProperties(video, {
			videoWidth: { configurable: true, value: width },
			videoHeight: { configurable: true, value: height },
			duration: { configurable: true, value: 1 },
			src: {
				configurable: true,
				get: () => "file:///tmp/source.mp4",
				set: () => queueMicrotask(() => video.onloadedmetadata?.(new Event("loadedmetadata"))),
			},
		});
		video.load = vi.fn();
		return video;
	}) as typeof document.createElement);
}

describe("CLI MP4 export submission", () => {
	beforeEach(() => {
		nativeMocks.loadProjectFileFromPath.mockResolvedValue({
			success: true,
			project: {
				version: 2,
				media: { screenVideoPath: "/tmp/source.mp4" },
				editor: {},
			},
		});
		nativeMocks.exportMultiNative.mockResolvedValue({
			frames: 60,
			wallS: 1,
			fps: 60,
			videoDurationS: 1,
		});
		nativeMocks.exportMultiNativeStaged.mockResolvedValue({
			transactionId: "transaction-1",
			temporaryPath: "/tmp/.export-stage.mp4",
			stats: { frames: 60, wallS: 1, fps: 60, videoDurationS: 1 },
		});
		nativeMocks.replaceStagedNativeExport.mockResolvedValue({ ok: true });
		nativeMocks.commitStagedNativeExport.mockResolvedValue({ outputPath: "/tmp/export.mp4" });
		nativeMocks.abortStagedNativeExport.mockResolvedValue({ ok: true });
		voiceoverMocks.mixVoiceoverIntoVideo.mockResolvedValue(
			new Blob(["mixed output"], { type: "video/mp4" }),
		);
		window.electronAPI = {
			getCurrentRecordingSession: vi.fn().mockResolvedValue({ success: false, session: null }),
			onNativeExportProgress: vi.fn().mockReturnValue(() => undefined),
			cliProgress: vi.fn(),
		} as unknown as Window["electronAPI"];
		mockVideoMetadata(3840, 2160);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		["default 1080p", "good" as const, 1920, 1080, 20_000_000],
		["high-resolution Source", "source" as const, 3840, 2160, 80_000_000],
	])("passes the calculated bitrate for %s", async (_label, quality, width, height, bitrate) => {
		await runExport(request(quality));

		expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce();
		const call = nativeMocks.exportMultiNative.mock.calls[0];
		expect(call?.[3]).toEqual({
			width,
			height,
			fps: 60,
			bitrate,
			codec: "h264",
		});
		const scene = JSON.parse(call?.[2] as string) as {
			clips: unknown[];
			output: { width: number; height: number; fps: number | null };
		};
		expect(scene.output).toEqual({ width, height, fps: null });
		expect(call?.[0]).toEqual(scene.clips);
	});

	it("blocks a fully trimmed timeline before native export", async () => {
		nativeMocks.loadProjectFileFromPath.mockResolvedValue({
			success: true,
			project: {
				version: 2,
				media: { screenVideoPath: "/tmp/source.mp4" },
				editor: {
					trimRegions: [{ id: "trim-all", startMs: 0, endMs: 1000 }],
				},
			},
		});

		await expect(runExport(request("good"))).rejects.toThrow(
			"The project's timeline has no visible clips to export",
		);
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
	});

	it("aborts a staged export and preserves the old destination when voiceover mixing fails", async () => {
		const withVoiceover = { ...request("good"), audioPath: "/tmp/voiceover.wav" };
		let destinationBytes = "old destination";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("voiceover")
					? ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response)
					: ({ ok: true, blob: async () => new Blob(["native output"]) } as Response),
			),
		);
		voiceoverMocks.mixVoiceoverIntoVideo.mockRejectedValueOnce(new Error("voiceover failed"));
		nativeMocks.commitStagedNativeExport.mockImplementation(async () => {
			destinationBytes = "unexpected commit";
			return { outputPath: "/tmp/export.mp4" };
		});

		await expect(runExport(withVoiceover)).rejects.toThrow("voiceover failed");

		expect(destinationBytes).toBe("old destination");
		expect(nativeMocks.exportMultiNative).not.toHaveBeenCalled();
		expect(nativeMocks.exportMultiNativeStaged).toHaveBeenCalledOnce();
		expect(nativeMocks.commitStagedNativeExport).not.toHaveBeenCalled();
		expect(nativeMocks.abortStagedNativeExport).toHaveBeenCalledWith("transaction-1");
	});

	it("commits the fully mixed bytes once and reports the selected CLI destination", async () => {
		const withVoiceover = { ...request("good"), audioPath: "/tmp/voiceover.wav" };
		let stagedBytes = "native output";
		let destinationBytes = "old destination";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("voiceover")
					? ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response)
					: ({ ok: true, blob: async () => new Blob([stagedBytes]) } as Response),
			),
		);
		nativeMocks.replaceStagedNativeExport.mockImplementation(
			async (_transactionId: string, data: ArrayBuffer) => {
				stagedBytes = new TextDecoder().decode(data);
				return { ok: true };
			},
		);
		nativeMocks.commitStagedNativeExport.mockImplementation(async () => {
			destinationBytes = stagedBytes;
			return { outputPath: "/tmp/export.mp4" };
		});

		const result = await runExport(withVoiceover);

		expect(nativeMocks.exportMultiNativeStaged.mock.calls[0]?.[1]).toBe("/tmp/export.mp4");
		expect(nativeMocks.exportMultiNativeStaged.mock.calls[0]?.[4]).toEqual(["/tmp/voiceover.wav"]);
		expect(nativeMocks.replaceStagedNativeExport).toHaveBeenCalledOnce();
		expect(nativeMocks.commitStagedNativeExport).toHaveBeenCalledWith("transaction-1");
		expect(nativeMocks.abortStagedNativeExport).not.toHaveBeenCalled();
		expect(destinationBytes).toBe("mixed output");
		expect(result.outputPath).toBe("/tmp/export.mp4");
	});
});
