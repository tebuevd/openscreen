// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliExportRequest } from "@/lib/cliContracts";

const nativeMocks = vi.hoisted(() => ({
	exportGifNative: vi.fn(),
	exportMultiNative: vi.fn(),
	loadProjectFileFromPath: vi.fn(),
	getTelemetry: vi.fn(),
}));

vi.mock("@/native", () => ({
	exportGifNative: nativeMocks.exportGifNative,
	exportMultiNative: nativeMocks.exportMultiNative,
	nativeBridgeClient: {
		project: { loadProjectFileFromPath: nativeMocks.loadProjectFileFromPath },
		cursor: { getTelemetry: nativeMocks.getTelemetry },
	},
}));

vi.mock("@/lib/exporter/voiceoverMix", () => ({
	mixVoiceoverIntoVideo: vi.fn(),
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
	});

	it.each([
		["default 1080p", "good" as const, 1920, 1080, 20_000_000],
		["high-resolution Source", "source" as const, 3840, 2160, 80_000_000],
	])("passes the calculated bitrate for %s", async (_label, quality, width, height, bitrate) => {
		await runExport(request(quality));

		expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce();
		expect(nativeMocks.exportMultiNative.mock.calls[0]?.[3]).toEqual({
			width,
			height,
			fps: 60,
			bitrate,
			codec: "h264",
		});
	});
});
