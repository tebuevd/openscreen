import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NativeMacCaptureOutput,
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
		const oldOutput = new NativeMacCaptureOutput(asProc(oldHelper));
		const newOutput = new NativeMacCaptureOutput(asProc(newHelper));
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

describe("teardownFailedNativeMacCapture", () => {
	it("terminates only the failed helper and removes its partial screen file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mac-start-"));
		temporaryDirectories.push(directory);
		const outputPath = path.join(directory, "partial.mp4");
		await fs.writeFile(outputPath, "partial");
		const failedHelper = new FakeMacHelper();
		const newerHelper = new FakeMacHelper();
		const failedOutput = new NativeMacCaptureOutput(asProc(failedHelper));
		new NativeMacCaptureOutput(asProc(newerHelper));

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
				output: new NativeMacCaptureOutput(asProc(helper)),
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
		const output = new NativeMacCaptureOutput(asProc(helper));
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
				output: new NativeMacCaptureOutput(asProc(helper)),
				outputPath: "/recordings/partial.mp4",
				removeFile: async () => Promise.reject(new Error("disk busy")),
				warn: () => {
					throw new Error("logger failed");
				},
			}),
		).resolves.toBe(true);
	});
});
