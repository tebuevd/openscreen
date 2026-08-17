// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliExportRequest } from "@/lib/cliContracts";

const nativeMocks = vi.hoisted(() => ({
	abortStagedNativeExport: vi.fn(),
	commitStagedNativeExport: vi.fn(),
	exportGifNative: vi.fn(),
	exportMultiNative: vi.fn(),
	exportMultiNativeStaged: vi.fn(),
	prepareProjectFileFromPath: vi.fn(),
	commitProjectFileLoad: vi.fn(),
	abortProjectFileLoad: vi.fn(),
	getTelemetry: vi.fn(),
	readStagedNativeExport: vi.fn(),
	renewStagedNativeExportLease: vi.fn(),
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
		project: {
			prepareProjectFileFromPath: nativeMocks.prepareProjectFileFromPath,
			commitProjectFileLoad: nativeMocks.commitProjectFileLoad,
			abortProjectFileLoad: nativeMocks.abortProjectFileLoad,
		},
		cursor: { getTelemetry: nativeMocks.getTelemetry },
	},
	readStagedNativeExport: nativeMocks.readStagedNativeExport,
	renewStagedNativeExportLease: nativeMocks.renewStagedNativeExportLease,
	replaceStagedNativeExport: nativeMocks.replaceStagedNativeExport,
}));

vi.mock("@/lib/exporter/voiceoverMix", () => ({
	mixVoiceoverIntoVideo: voiceoverMocks.mixVoiceoverIntoVideo,
}));

import { CliExportRunner, runExport } from "./CliExportRunner";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, reject, resolve };
}

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
		nativeMocks.prepareProjectFileFromPath.mockResolvedValue({
			success: true,
			preparationId: "prepared-project",
			project: {
				version: 2,
				media: { screenVideoPath: "/tmp/source.mp4" },
				editor: {},
			},
		});
		nativeMocks.commitProjectFileLoad.mockResolvedValue({ success: true });
		nativeMocks.abortProjectFileLoad.mockResolvedValue({ success: true });
		nativeMocks.exportMultiNative.mockResolvedValue({
			frames: 60,
			wallS: 1,
			fps: 60,
			videoDurationS: 1,
		});
		nativeMocks.exportMultiNativeStaged.mockResolvedValue({
			transactionId: "transaction-1",
			stats: { frames: 60, wallS: 1, fps: 60, videoDurationS: 1 },
		});
		nativeMocks.readStagedNativeExport.mockResolvedValue(
			new TextEncoder().encode("native output").buffer,
		);
		nativeMocks.replaceStagedNativeExport.mockResolvedValue({ ok: true });
		nativeMocks.commitStagedNativeExport.mockResolvedValue({ outputPath: "/tmp/export.mp4" });
		nativeMocks.abortStagedNativeExport.mockResolvedValue({ ok: true });
		nativeMocks.renewStagedNativeExportLease.mockResolvedValue({ ok: true });
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
		vi.useRealTimers();
		cleanup();
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
		nativeMocks.prepareProjectFileFromPath.mockResolvedValue({
			success: true,
			preparationId: "prepared-trimmed-project",
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
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response),
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
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response),
		);
		nativeMocks.readStagedNativeExport.mockImplementation(
			async () => new TextEncoder().encode(stagedBytes).buffer,
		);
		nativeMocks.replaceStagedNativeExport.mockImplementation(
			async (_transactionId: string, data: ArrayBuffer) => {
				stagedBytes = new TextDecoder().decode(data);
				return { ok: true };
			},
		);
		nativeMocks.commitStagedNativeExport.mockImplementation(async () => {
			destinationBytes = stagedBytes;
			return {
				outputPath: "/tmp/export.mp4",
				cleanupWarning: {
					code: "EXPORT_CLEANUP_PENDING",
					message: "Export saved, but temporary cleanup is still pending.",
				},
			};
		});

		const result = await runExport(withVoiceover);

		expect(nativeMocks.exportMultiNativeStaged.mock.calls[0]?.[1]).toBe("/tmp/export.mp4");
		expect(nativeMocks.exportMultiNativeStaged.mock.calls[0]?.[4]).toEqual(["/tmp/voiceover.wav"]);
		expect(nativeMocks.replaceStagedNativeExport).toHaveBeenCalledOnce();
		expect(nativeMocks.readStagedNativeExport).toHaveBeenCalledWith("transaction-1");
		expect(nativeMocks.commitStagedNativeExport).toHaveBeenCalledWith("transaction-1");
		expect(nativeMocks.abortStagedNativeExport).not.toHaveBeenCalled();
		expect(destinationBytes).toBe("mixed output");
		expect(result.outputPath).toBe("/tmp/export.mp4");
		expect(result.warnings).toEqual(["Export saved, but temporary cleanup is still pending."]);
	});

	it("renews a long voiceover lease and stops renewal when its owner signal aborts", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const withVoiceover = { ...request("good"), audioPath: "/tmp/voiceover.wav" };
		const mix = deferred<Blob>();
		let mixingStarted!: () => void;
		const didStartMixing = new Promise<void>((resolve) => {
			mixingStarted = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response),
		);
		voiceoverMocks.mixVoiceoverIntoVideo.mockImplementationOnce(() => {
			mixingStarted();
			return mix.promise;
		});
		const abortController = new AbortController();
		const exportPromise = runExport(withVoiceover, abortController.signal);
		await didStartMixing;

		await vi.advanceTimersByTimeAsync(6 * 60_000);
		expect(nativeMocks.renewStagedNativeExportLease).toHaveBeenCalledTimes(6);
		expect(nativeMocks.renewStagedNativeExportLease).toHaveBeenLastCalledWith("transaction-1");

		abortController.abort();
		const renewalsAtAbort = nativeMocks.renewStagedNativeExportLease.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(nativeMocks.renewStagedNativeExportLease).toHaveBeenCalledTimes(renewalsAtAbort);

		mix.resolve(new Blob(["mixed output"], { type: "video/mp4" }));
		await expect(exportPromise).resolves.toEqual(
			expect.objectContaining({ success: true, outputPath: "/tmp/export.mp4" }),
		);
	});

	it("stops voiceover lease renewal when the CLI runner unmounts", async () => {
		vi.useFakeTimers({
			toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
		});
		const withVoiceover = { ...request("good"), audioPath: "/tmp/voiceover.wav" };
		const mix = deferred<Blob>();
		let mixingStarted!: () => void;
		const didStartMixing = new Promise<void>((resolve) => {
			mixingStarted = resolve;
		});
		let cliFinished!: () => void;
		const didFinishCli = new Promise<void>((resolve) => {
			cliFinished = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response),
		);
		voiceoverMocks.mixVoiceoverIntoVideo.mockImplementationOnce(() => {
			mixingStarted();
			return mix.promise;
		});
		Object.assign(window.electronAPI, {
			cliGetRequest: vi.fn(async () => withVoiceover),
			cliDone: vi.fn(async () => cliFinished()),
		});
		const view = render(<CliExportRunner />);
		await didStartMixing;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(nativeMocks.renewStagedNativeExportLease).toHaveBeenCalledOnce();

		view.unmount();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(nativeMocks.renewStagedNativeExportLease).toHaveBeenCalledOnce();

		mix.resolve(new Blob(["mixed output"], { type: "video/mp4" }));
		await didFinishCli;
	});

	it("returns cleanup warnings for an installed direct export", async () => {
		nativeMocks.exportMultiNative.mockResolvedValueOnce({
			frames: 60,
			wallS: 1,
			fps: 60,
			videoDurationS: 1,
			cleanupWarning: {
				code: "EXPORT_CLEANUP_PENDING",
				message: "Export saved, but temporary cleanup is still pending.",
			},
		});

		const result = await runExport(request("good"));

		expect(result.success).toBe(true);
		expect(result.warnings).toEqual(["Export saved, but temporary cleanup is still pending."]);
	});
});
