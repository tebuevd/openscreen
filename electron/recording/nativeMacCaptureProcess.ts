import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

type NativeMacHelperEvent = Record<string, unknown>;
type NativeMacHelperEventListener = (event: NativeMacHelperEvent) => void;

export const NATIVE_MAC_CAPTURE_KILL_GRACE_MS = 1_000;

function isHelperEvent(value: unknown): value is NativeMacHelperEvent {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParseHelperEvent(line: string): NativeMacHelperEvent | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return isHelperEvent(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Owns one helper's output for its full lifetime. A failed helper can keep its
 * pipes alive without ever writing into the next helper's buffer or event bus.
 */
export class NativeMacCaptureOutput {
	private readonly eventEmitter = new EventEmitter();
	private readonly eventHistory: NativeMacHelperEvent[] = [];
	private stdoutLineBuffer = "";
	private stderrLineBuffer = "";
	private outputBuffer = "";
	private isolated = false;
	private disposed = false;

	private readonly drainStdout = (chunk: Buffer) => {
		this.drain(chunk, "stdout");
	};

	private readonly drainStderr = (chunk: Buffer) => {
		this.drain(chunk, "stderr");
	};

	private readonly handleClose = () => {
		this.dispose();
	};

	private readonly handleProcessError = (error: Error) => {
		if (!this.isolated) console.warn("[native-sck] helper process error:", error);
	};

	private readonly handleStdoutError = (error: Error) => {
		if (!this.isolated) console.warn("[native-sck] helper stdout error:", error);
	};

	private readonly handleStdinError = (error: Error) => {
		if (!this.isolated) console.warn("[native-sck] helper stdin error:", error);
	};

	private readonly handleStderrError = (error: Error) => {
		if (!this.isolated) console.warn("[native-sck] helper stderr error:", error);
	};

	constructor(readonly proc: ChildProcessWithoutNullStreams) {
		proc.stdout.on("data", this.drainStdout);
		proc.stderr.on("data", this.drainStderr);
		proc.stdin.on("error", this.handleStdinError);
		proc.stdout.on("error", this.handleStdoutError);
		proc.stderr.on("error", this.handleStderrError);
		proc.on("error", this.handleProcessError);
		proc.once("close", this.handleClose);
	}

	get output() {
		return this.outputBuffer;
	}

	get events() {
		return [...this.eventHistory];
	}

	onEvent(listener: NativeMacHelperEventListener) {
		this.eventEmitter.on("helper-event", listener);
	}

	offEvent(listener: NativeMacHelperEventListener) {
		this.eventEmitter.off("helper-event", listener);
	}

	/** Keeps draining an orphan safely while dropping all future output and events. */
	isolate() {
		this.isolated = true;
		this.stdoutLineBuffer = "";
		this.stderrLineBuffer = "";
		this.eventHistory.length = 0;
		this.eventEmitter.removeAllListeners();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.eventEmitter.removeAllListeners();
		this.proc.stdout.off("data", this.drainStdout);
		this.proc.stderr.off("data", this.drainStderr);
		this.proc.stdin.off("error", this.handleStdinError);
		this.proc.stdout.off("error", this.handleStdoutError);
		this.proc.stderr.off("error", this.handleStderrError);
		this.proc.off("error", this.handleProcessError);
		this.proc.off("close", this.handleClose);
	}

	private drain(chunk: Buffer, stream: "stdout" | "stderr") {
		if (this.isolated || this.disposed) return;

		const text = chunk.toString();
		this.outputBuffer += text;
		const buffered = (stream === "stdout" ? this.stdoutLineBuffer : this.stderrLineBuffer) + text;
		const lines = buffered.split(/\r?\n/);
		const remainder = lines.pop() ?? "";
		if (stream === "stdout") this.stdoutLineBuffer = remainder;
		else this.stderrLineBuffer = remainder;

		for (const line of lines) {
			const event = tryParseHelperEvent(line.trim());
			if (!event) continue;
			this.eventHistory.push(event);
			this.eventEmitter.emit("helper-event", event);
		}
	}
}

function hasExited(proc: ChildProcessWithoutNullStreams) {
	return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number) {
	if (hasExited(proc)) return Promise.resolve(true);

	return new Promise<boolean>((resolve) => {
		const settle = (exited: boolean) => {
			clearTimeout(timer);
			proc.off("close", onClose);
			resolve(exited);
		};
		const onClose = () => settle(true);
		const timer = setTimeout(() => settle(false), timeoutMs);
		proc.once("close", onClose);
	});
}

/** Sends SIGTERM, then bounds a SIGKILL escalation and reports whether the helper exited. */
export async function terminateNativeMacCapture(
	proc: ChildProcessWithoutNullStreams,
	graceMs = NATIVE_MAC_CAPTURE_KILL_GRACE_MS,
) {
	if (hasExited(proc)) return true;

	try {
		proc.kill("SIGTERM");
	} catch {
		// The process may have exited between the state check and the signal.
	}
	if (await waitForExit(proc, graceMs)) return true;

	try {
		proc.kill("SIGKILL");
	} catch {
		// A second exit race is harmless; the bounded wait below confirms it.
	}
	return waitForExit(proc, graceMs);
}

export async function teardownFailedNativeMacCapture(options: {
	proc: ChildProcessWithoutNullStreams;
	output: NativeMacCaptureOutput | null;
	outputPath: string | null;
	graceMs?: number;
	removeFile?: (filePath: string) => Promise<void>;
	warn?: (message: string, ...details: unknown[]) => void;
}) {
	const reportCleanupFailure = (message: string, ...details: unknown[]) => {
		try {
			if (options.warn) options.warn(message, ...details);
			else console.warn(message, ...details);
		} catch {
			// Diagnostics must not replace the start error this cleanup is preserving.
		}
	};
	try {
		options.output?.isolate();
	} catch (error) {
		reportCleanupFailure("[native-sck] could not isolate failed helper output", error);
	}

	let exited = false;
	try {
		exited = await terminateNativeMacCapture(
			options.proc,
			options.graceMs ?? NATIVE_MAC_CAPTURE_KILL_GRACE_MS,
		);
	} catch (error) {
		reportCleanupFailure("[native-sck] failed-start termination raised an error", error);
	}
	if (!exited) {
		reportCleanupFailure("[native-sck] helper survived failed-start termination", options.proc.pid);
	}

	if (options.outputPath) {
		try {
			const removeFile = options.removeFile ?? ((filePath) => fs.rm(filePath, { force: true }));
			await removeFile(options.outputPath);
		} catch (error) {
			reportCleanupFailure(
				"[native-sck] could not remove failed capture output",
				options.outputPath,
				error,
			);
		}
	}

	return exited;
}
