import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NativeMacCaptureOutput,
	stopNativeMacCapture,
	teardownFailedNativeMacCapture,
	terminateNativeMacCapture,
} from "./nativeMacCaptureProcess";

class FakeMacHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	pid = 4242;
	killSignals: NodeJS.Signals[] = [];
	diesOnTerm = true;
	diesOnKill = true;

	kill(signal: NodeJS.Signals = "SIGTERM") {
		this.killSignals.push(signal);
		if ((signal === "SIGTERM" && this.diesOnTerm) || (signal === "SIGKILL" && this.diesOnKill)) {
			this.signalCode = signal;
			this.emit("close", null, signal);
		}
		return true;
	}
}

function asProc(helper: FakeMacHelper) {
	return helper as unknown as ChildProcessWithoutNullStreams;
}

function captureOutput(helper: FakeMacHelper, targetPath = "/recordings/complete.mp4") {
	return new NativeMacCaptureOutput(asProc(helper), targetPath);
}

function helperErrorLine(code: string, terminal: boolean, message = `${code} message`) {
	return `${JSON.stringify({ event: "error", code, message, terminal })}\n`;
}

type WriteCallback = (error?: Error | null) => void;

function mockStdinWrite(
	helper: FakeMacHelper,
	implementation: (callback: WriteCallback | undefined) => boolean,
) {
	const write = ((...args: unknown[]) => {
		let callback: WriteCallback | undefined;
		for (let index = args.length - 1; index >= 0; index--) {
			if (typeof args[index] === "function") {
				callback = args[index] as WriteCallback;
				break;
			}
		}
		return implementation(callback);
	}) as typeof helper.stdin.write;
	return vi.spyOn(helper.stdin, "write").mockImplementation(write);
}

let temporaryDirectories: string[];

beforeEach(() => {
	vi.useFakeTimers();
	temporaryDirectories = [];
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("NativeMacCaptureOutput", () => {
	it("keeps helper output and events isolated by process", () => {
		const oldHelper = new FakeMacHelper();
		const newHelper = new FakeMacHelper();
		const oldOutput = captureOutput(oldHelper, "/recordings/old.mp4");
		const newOutput = captureOutput(newHelper, "/recordings/new.mp4");
		const oldEvents: Array<Record<string, unknown>> = [];
		const newEvents: Array<Record<string, unknown>> = [];
		oldOutput.onEvent((event) => oldEvents.push(event));
		newOutput.onEvent((event) => newEvents.push(event));

		oldHelper.stdout.write('{"event":"error","message":"old"}\n');
		expect(oldEvents).toHaveLength(1);
		expect(newEvents).toHaveLength(0);

		const oldOutputBeforeIsolation = oldOutput.output;
		oldOutput.isolate();
		oldHelper.stdout.write('{"event":"recording-started","width":1920}\n');
		newHelper.stdout.write('{"event":"ready","schemaVersion":1}\n');

		expect(oldOutput.output).toBe(oldOutputBeforeIsolation);
		expect(oldOutput.events).toHaveLength(0);
		expect(oldEvents).toHaveLength(1);
		expect(newEvents).toEqual([{ event: "ready", schemaVersion: 1 }]);
	});

	it("retains terminal events only for their owning process and path", () => {
		const oldHelper = new FakeMacHelper();
		const newHelper = new FakeMacHelper();
		const oldOutput = captureOutput(oldHelper, "/recordings/old.mp4");
		const newOutput = captureOutput(newHelper, "/recordings/new.mp4");

		oldHelper.stdout.write('{"event":"recording-stopped","screenPath":"/recordings/new.mp4"}\n');
		expect(oldOutput.recordingStoppedEvent).toBeNull();
		expect(newOutput.recordingStoppedEvent).toBeNull();

		oldHelper.stdout.write('{"event":"recording-stopped","screenPath":"/recordings/old.mp4"}\n');
		expect(oldOutput.recordingStoppedEvent).toEqual({
			event: "recording-stopped",
			screenPath: "/recordings/old.mp4",
		});
		expect(newOutput.recordingStoppedEvent).toBeNull();
	});
});

describe("terminateNativeMacCapture", () => {
	it("escalates to SIGKILL when the helper ignores SIGTERM", async () => {
		const helper = new FakeMacHelper();
		helper.diesOnTerm = false;

		const pending = terminateNativeMacCapture(asProc(helper), 100);
		await vi.advanceTimersByTimeAsync(100);

		await expect(pending).resolves.toBe(true);
		expect(helper.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("returns after a bounded wait when both signals fail", async () => {
		const helper = new FakeMacHelper();
		helper.diesOnTerm = false;
		helper.diesOnKill = false;

		const pending = terminateNativeMacCapture(asProc(helper), 100);
		await vi.advanceTimersByTimeAsync(200);

		await expect(pending).resolves.toBe(false);
		expect(helper.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("stopNativeMacCapture", () => {
	it("rejects immediately when a clean helper exit has no terminal event", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper);
		const write = vi.spyOn(helper.stdin, "write");
		helper.exitCode = 0;
		const baselineCloseListeners = helper.listenerCount("close");
		const baselineErrorListeners = helper.listenerCount("error");
		const baselineStdinErrorListeners = helper.stdin.listenerCount("error");

		const result = await stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/complete.mp4",
			timeoutMs: 100,
		});

		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) expect(result.error.message).toMatch(/authoritative recording-stopped event/);
		expect(write).not.toHaveBeenCalled();
		expect(helper.listenerCount("close")).toBe(baselineCloseListeners);
		expect(helper.listenerCount("error")).toBe(baselineErrorListeners);
		expect(helper.stdin.listenerCount("error")).toBe(baselineStdinErrorListeners);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains a terminal event received before stop waiter registration", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);
		const write = vi.spyOn(helper.stdin, "write");
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);

		await expect(
			stopNativeMacCapture({
				proc: asProc(helper),
				output,
				targetPath,
				timeoutMs: 100,
			}),
		).resolves.toEqual({ ok: true, screenVideoPath: targetPath });
		expect(write).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts an authoritative event immediately followed by process close", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);
		helper.exitCode = 0;
		helper.emit("close", 0, null);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: targetPath });
		expect(helper.killSignals).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("allows a live nonterminal capture error to finalize successfully", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "capture disconnected"),
		);
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: targetPath });
		expect(output.nonterminalErrors).toEqual([
			{
				event: "error",
				code: "capture-stopped-with-error",
				message: "capture disconnected",
				terminal: false,
			},
		]);
	});

	it("honors pre-wait nonterminal error then successful finalization ordering", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);
		const write = vi.spyOn(helper.stdin, "write");
		helper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "capture disconnected"),
		);
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);

		await expect(
			stopNativeMacCapture({
				proc: asProc(helper),
				output,
				targetPath,
				timeoutMs: 100,
			}),
		).resolves.toEqual({ ok: true, screenVideoPath: targetPath });
		expect(write).not.toHaveBeenCalled();
	});

	it("fails usefully when a nonterminal error is followed by clean close", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper);
		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/complete.mp4",
			timeoutMs: 100,
		});
		helper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "capture disconnected"),
		);
		helper.exitCode = 0;
		helper.emit("close", 0, null);

		const result = await pending;
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) {
			expect(result.error.message).toMatch(/without an authoritative recording-stopped event/);
			expect(result.error.message).toMatch(/capture-stopped-with-error: capture disconnected/);
		}
	});

	it("fails when a nonterminal diagnostic is followed by terminal writer failure", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper);
		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/complete.mp4",
			timeoutMs: 100,
		});
		helper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "capture disconnected"),
		);
		helper.stdout.write(helperErrorLine("writer-failed", true, "writer could not finalize"));

		const result = await pending;
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) {
			expect(result.error.message).toMatch(/writer could not finalize/);
			expect(result.error.message).toMatch(/capture-stopped-with-error: capture disconnected/);
		}
	});

	it("does not let success overwrite a retained terminal failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);
		const write = vi.spyOn(helper.stdin, "write");
		helper.stdout.write(helperErrorLine("writer-failed", true, "writer could not finalize"));
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);
		expect(output.stopTerminalEvent).toMatchObject({
			event: "error",
			code: "writer-failed",
			terminal: true,
		});
		expect(output.recordingStoppedEvent).toBeNull();

		const result = await stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) expect(result.error.message).toMatch(/writer could not finalize/);
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		["missing", "missing.mp4"],
		["empty", "empty.mp4"],
		["non-file", "directory.mp4"],
	])("rejects a terminal event whose output is %s", async (kind, name) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, name);
		if (kind === "empty") await fs.writeFile(targetPath, "");
		if (kind === "non-file") await fs.mkdir(targetPath);
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);

		const result = await pending;
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) expect(result.error.message).toMatch(/missing|unreadable|empty|regular file/);
		expect(helper.killSignals).toEqual(["SIGTERM"]);
	});

	it("rejects a terminal event for a path not owned by its helper", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "owned.mp4");
		const wrongPath = path.join(directory, "wrong.mp4");
		await Promise.all([
			fs.writeFile(targetPath, "owned capture"),
			fs.writeFile(wrongPath, "wrong capture"),
		]);
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: wrongPath })}\n`,
		);

		const result = await pending;
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) expect(result.error.message).toMatch(/unexpected output path/);
		expect(output.recordingStoppedEvent).toBeNull();
	});

	it("escalates a stop timeout without affecting a newer helper", async () => {
		const failedHelper = new FakeMacHelper();
		failedHelper.diesOnTerm = false;
		const newerHelper = new FakeMacHelper();
		const failedOutput = captureOutput(failedHelper, "/recordings/partial.mp4");
		captureOutput(newerHelper, "/recordings/new.mp4");

		const pending = stopNativeMacCapture({
			proc: asProc(failedHelper),
			output: failedOutput,
			targetPath: "/recordings/partial.mp4",
			timeoutMs: 100,
			killGraceMs: 50,
		});
		failedHelper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "capture disconnected"),
		);
		await vi.advanceTimersByTimeAsync(150);

		const result = await pending;
		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) {
			expect(result.error.message).toMatch(/Timed out/);
			expect(result.error.message).toMatch(/capture-stopped-with-error: capture disconnected/);
		}
		expect(failedHelper.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(newerHelper.killSignals).toEqual([]);
		expect(failedHelper.listenerCount("close")).toBe(0);
		expect(failedHelper.listenerCount("error")).toBe(0);
		expect(failedHelper.stdin.listenerCount("error")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		failedHelper.stdout.write(
			'{"event":"recording-stopped","screenPath":"/recordings/partial.mp4"}\n',
		);
		expect(failedOutput.recordingStoppedEvent).toBeNull();
	});

	it("removes waiter listeners even when the helper survives both stop signals", async () => {
		const helper = new FakeMacHelper();
		helper.diesOnTerm = false;
		helper.diesOnKill = false;
		const output = captureOutput(helper, "/recordings/partial.mp4");
		const baselineCloseListeners = helper.listenerCount("close");
		const baselineErrorListeners = helper.listenerCount("error");
		const baselineStdinErrorListeners = helper.stdin.listenerCount("error");

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/partial.mp4",
			timeoutMs: 100,
			killGraceMs: 50,
			warn: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(200);

		await expect(pending).resolves.toMatchObject({ ok: false, exited: false });
		expect(helper.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(helper.listenerCount("close")).toBe(baselineCloseListeners);
		expect(helper.listenerCount("error")).toBe(baselineErrorListeners);
		expect(helper.stdin.listenerCount("error")).toBe(baselineStdinErrorListeners);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disposes the waiter and terminates after a synchronous write failure", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, "/recordings/partial.mp4");
		const writeError = new Error("write threw");
		mockStdinWrite(helper, () => {
			throw writeError;
		});

		const result = await stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/partial.mp4",
			timeoutMs: 100,
		});

		expect(result).toEqual({ ok: false, error: writeError, exited: true });
		expect(helper.killSignals).toEqual(["SIGTERM"]);
		expect(helper.listenerCount("close")).toBe(0);
		expect(helper.listenerCount("error")).toBe(0);
		expect(helper.stdin.listenerCount("error")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("terminates after a write callback failure before any terminal event", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, "/recordings/partial.mp4");
		const writeError = new Error("write callback failed");
		mockStdinWrite(helper, (callback) => {
			queueMicrotask(() => callback?.(writeError));
			return true;
		});

		const result = await stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/partial.mp4",
			timeoutMs: 100,
		});

		expect(result).toEqual({ ok: false, error: writeError, exited: true });
		expect(helper.killSignals).toEqual(["SIGTERM"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores a late write callback error while terminal file validation is pending", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const stats = await fs.stat(targetPath);
		let resolveStat: (_stats: typeof stats) => void = () => undefined;
		vi.spyOn(fs, "stat").mockReturnValueOnce(
			new Promise<typeof stats>((resolve) => {
				resolveStat = resolve;
			}),
		);
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let completeWrite: WriteCallback = () => {
			throw new Error("stop command callback was not registered");
		};
		mockStdinWrite(helper, (callback) => {
			if (callback) completeWrite = callback;
			return true;
		});

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);
		helper.stdout.write(
			helperErrorLine("capture-stopped-with-error", false, "late capture diagnostic"),
		);
		completeWrite(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		helper.emit("error", new Error("late process error"));
		resolveStat(stats);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: targetPath });
		expect(helper.killSignals).toEqual([]);
		expect(output.nonterminalErrors).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("fails immediately when stdin is already closed", async () => {
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, "/recordings/partial.mp4");
		helper.stdin.end();

		const result = await stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath: "/recordings/partial.mp4",
			timeoutMs: 100,
		});

		expect(result).toMatchObject({ ok: false, exited: true });
		if (!result.ok) expect(result.error.message).toMatch(/command channel is closed/);
		expect(helper.killSignals).toEqual(["SIGTERM"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts backpressure while the queued stop command completes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-stop-"));
		temporaryDirectories.push(directory);
		const targetPath = path.join(directory, "complete.mp4");
		await fs.writeFile(targetPath, "complete capture");
		const helper = new FakeMacHelper();
		const output = captureOutput(helper, targetPath);
		mockStdinWrite(helper, (callback) => {
			queueMicrotask(() => callback?.());
			return false;
		});

		const pending = stopNativeMacCapture({
			proc: asProc(helper),
			output,
			targetPath,
			timeoutMs: 100,
		});
		helper.stdout.write(
			`${JSON.stringify({ event: "recording-stopped", screenPath: targetPath })}\n`,
		);

		await expect(pending).resolves.toEqual({
			ok: true,
			screenVideoPath: targetPath,
		});
		expect(helper.killSignals).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("teardownFailedNativeMacCapture", () => {
	it("terminates only the failed helper and removes its partial screen file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-start-"));
		temporaryDirectories.push(directory);
		const outputPath = path.join(directory, "partial.mp4");
		await fs.writeFile(outputPath, "partial");
		const failedHelper = new FakeMacHelper();
		const newerHelper = new FakeMacHelper();
		const failedOutput = captureOutput(failedHelper, outputPath);
		captureOutput(newerHelper, path.join(directory, "new.mp4"));

		await expect(
			teardownFailedNativeMacCapture({
				proc: asProc(failedHelper),
				output: failedOutput,
				outputPath,
			}),
		).resolves.toBe(true);

		expect(failedHelper.killSignals).toEqual(["SIGTERM"]);
		expect(newerHelper.killSignals).toEqual([]);
		await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not reject when partial-file cleanup fails", async () => {
		const helper = new FakeMacHelper();
		const warn = vi.fn();
		const cleanupError = new Error("disk busy");

		await expect(
			teardownFailedNativeMacCapture({
				proc: asProc(helper),
				output: captureOutput(helper, "/recordings/partial.mp4"),
				outputPath: "/recordings/partial.mp4",
				removeFile: async () => Promise.reject(cleanupError),
				warn,
			}),
		).resolves.toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"[native-sck] could not remove failed capture output",
			"/recordings/partial.mp4",
			cleanupError,
		);
	});

	it("isolates a surviving helper and still removes its partial path", async () => {
		const helper = new FakeMacHelper();
		helper.diesOnTerm = false;
		helper.diesOnKill = false;
		const output = captureOutput(helper, "/recordings/partial.mp4");
		helper.stdout.write('{"event":"ready"}\n');
		const outputBeforeTeardown = output.output;
		const removeFile = vi.fn(async () => undefined);
		const warn = vi.fn();

		const pending = teardownFailedNativeMacCapture({
			proc: asProc(helper),
			output,
			outputPath: "/recordings/partial.mp4",
			graceMs: 100,
			removeFile,
			warn,
		});
		await vi.advanceTimersByTimeAsync(200);

		await expect(pending).resolves.toBe(false);
		helper.stdout.write('{"event":"recording-started"}\n');
		expect(output.output).toBe(outputBeforeTeardown);
		expect(removeFile).toHaveBeenCalledWith("/recordings/partial.mp4");
		expect(warn).toHaveBeenCalledWith(
			"[native-sck] helper survived failed-start termination",
			4242,
		);
	});

	it("does not reject when cleanup diagnostics throw", async () => {
		const helper = new FakeMacHelper();

		await expect(
			teardownFailedNativeMacCapture({
				proc: asProc(helper),
				output: captureOutput(helper, "/recordings/partial.mp4"),
				outputPath: "/recordings/partial.mp4",
				removeFile: async () => Promise.reject(new Error("disk busy")),
				warn: () => {
					throw new Error("logger failed");
				},
			}),
		).resolves.toBe(true);
	});
});
