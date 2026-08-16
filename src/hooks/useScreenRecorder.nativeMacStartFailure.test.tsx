// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createRecorderHandle = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("./recorderHandle", () => ({ createRecorderHandle }));

import type { RecorderHandle } from "./recorderHandle";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
let fakeHandles: ReturnType<typeof fakeRecorderHandle>[];
let getUserMedia: ReturnType<typeof vi.fn>;

function fakeRecorderHandle() {
	let state: MediaRecorder["state"] = "recording";
	let resolveBlob: (blob: Blob) => void = () => undefined;
	const recordedBlobPromise = new Promise<Blob>((resolve) => {
		resolveBlob = resolve;
	});
	const stop = vi.fn(() => {
		state = "inactive";
		resolveBlob(new Blob([]));
	});
	const pause = vi.fn(() => {
		state = "paused";
	});
	const resume = vi.fn(() => {
		state = "recording";
	});
	const recorder = {
		get state() {
			return state;
		},
		stop,
		pause,
		resume,
	} as unknown as MediaRecorder;
	const discard = vi.fn(async () => undefined);
	const handle: RecorderHandle = {
		recorder,
		recordedBlobPromise,
		isStreaming: () => true,
		discard,
	};
	return { handle, stop, pause, resume, discard };
}

function stubElectronAPI(overrides: Record<string, unknown> = {}) {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "darwin"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeMacRecording: vi.fn(async () => ({ success: true, recordingId: 42 })),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		requestNativeMacCursorAccess: vi.fn(async () => ({ granted: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
	};
	window.electronAPI = { ...api, ...overrides } as unknown as ElectronAPI;
}

async function enableWebcam(view: RecorderView) {
	await act(async () => {
		await view.result.current.setWebcamEnabled(true);
	});
	await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
	fakeHandles = [];
	createRecorderHandle.mockReset();
	createRecorderHandle.mockImplementation(() => {
		const fake = fakeRecorderHandle();
		fakeHandles.push(fake);
		return fake.handle;
	});

	const webcamTrack = { onended: null, stop: vi.fn() };
	const webcamStream = {
		getTracks: () => [webcamTrack],
		getVideoTracks: () => [webcamTrack],
	} as unknown as MediaStream;
	getUserMedia = vi.fn(async () => webcamStream);
	vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
	vi.stubGlobal(
		"MediaRecorder",
		class {
			static isTypeSupported() {
				return true;
			}
		},
	);
	stubElectronAPI();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native macOS start failure", () => {
	it("discards the webcam sidecar and starts cleanly on retry after native start rejects", async () => {
		api.startNativeMacRecording
			.mockRejectedValueOnce(new Error("Native capture reported invalid dimensions"))
			.mockResolvedValueOnce({ success: true, recordingId: 42 });

		const view = renderHook(() => useScreenRecorder());
		await enableWebcam(view);

		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});

		expect(fakeHandles).toHaveLength(1);
		expect(fakeHandles[0].stop).toHaveBeenCalledTimes(1);
		expect(fakeHandles[0].discard).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.paused).toBe(false);
		expect(view.result.current.saving).toBe(false);
		expect(view.result.current.canPauseRecording).toBe(false);

		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});

		expect(api.startNativeMacRecording).toHaveBeenCalledTimes(2);
		expect(fakeHandles).toHaveLength(2);
		expect(fakeHandles[0].stop).toHaveBeenCalledTimes(1);
		expect(fakeHandles[0].discard).toHaveBeenCalledTimes(1);
		expect(fakeHandles[1].stop).not.toHaveBeenCalled();
		expect(fakeHandles[1].discard).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(true);
		expect(view.result.current.canPauseRecording).toBe(true);

		await act(async () => {
			view.result.current.cancelRecording();
		});
		await waitFor(() => expect(view.result.current.recording).toBe(false));
	});

	it("discards the webcam sidecar when a completed native start belongs to a canceled run", async () => {
		let resolveNativeStart: (result: { success: true; recordingId: number }) => void = () =>
			undefined;
		api.startNativeMacRecording.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveNativeStart = resolve;
				}),
		);

		const view = renderHook(() => useScreenRecorder());
		await enableWebcam(view);
		vi.useFakeTimers();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_500);
		});

		expect(api.startNativeMacRecording).toHaveBeenCalledTimes(1);
		expect(fakeHandles).toHaveLength(1);

		// Starting another countdown invalidates the run whose native IPC is pending.
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await act(async () => {
			resolveNativeStart({ success: true, recordingId: 42 });
			await Promise.resolve();
		});

		expect(api.stopNativeMacRecording).toHaveBeenCalledWith(true);
		expect(fakeHandles[0].stop).toHaveBeenCalledTimes(1);
		expect(fakeHandles[0].discard).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.canPauseRecording).toBe(false);

		view.unmount();
	});
});
