import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

type NativeMacHelperEvent = Record<string, unknown>;
type NativeMacHelperEventListener = (event: NativeMacHelperEvent) => void;
type WarningReporter = (message: string, ...details: unknown[]) => void;

export const NATIVE_MAC_CAPTURE_KILL_GRACE_MS = 1_000;
export const NATIVE_MAC_CAPTURE_STOP_TIMEOUT_MS = 30_000;

function reportCleanupFailure(
	warn: WarningReporter | undefined,
	message: string,
	...details: unknown[]
) {
	try {
		if (warn) warn(message, ...details);
		else console.warn(message, ...details);
	} catch {
		// Cleanup diagnostics must never replace the capture error being preserved.
	}
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

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
		if (hasExited(proc)) settle(true);
	});
}

function requestNativeMacCaptureStop(options: {
	proc: ChildProcessWithoutNullStreams;
	output: NativeMacCaptureOutput;
	targetPath: string | null;
	timeoutMs: number;
}) {
	const { proc, output, targetPath, timeoutMs } = options;
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = () => {
			if (timer !== null) clearTimeout(timer);
			output.offEvent(onOutput);
			proc.off("close", onClose);
			proc.off("error", onProcessError);
			proc.stdin.off("error", onStdinError);
		};
		const succeed = (screenPath: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(screenPath);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(toError(error));
		};
		const inspect = (event: NativeMacHelperEvent) => {
			if (event.event === "recording-stopped") {
				const screenPath =
					typeof event.screenPath === "string" && event.screenPath.trim()
						? event.screenPath
						: targetPath;
				if (screenPath) succeed(screenPath);
				else fail(new Error("Native macOS capture did not return an output path."));
				return;
			}
			if (event.event === "error") {
				fail(new Error(String(event.message ?? event.code ?? "Native macOS capture failed")));
			}
		};
		const settleFromTerminalState = () => {
			if (!hasExited(proc)) return false;
			if (proc.exitCode === 0 && targetPath) succeed(targetPath);
			else {
				fail(
					new Error(
						output.output.trim() ||
							`Native macOS capture exited before stop completed (code=${proc.exitCode ?? "unknown"}, signal=${proc.signalCode ?? "none"})`,
					),
				);
			}
			return true;
		};
		const onOutput = (event: NativeMacHelperEvent) => inspect(event);
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			if (code === 0 && targetPath) succeed(targetPath);
			else {
				fail(
					new Error(
						output.output.trim() ||
							`Native macOS capture exited before stop completed (code=${code ?? "unknown"}, signal=${signal ?? "none"})`,
					),
				);
			}
		};
		const onProcessError = (error: Error) => fail(error);
		const onStdinError = (error: Error) => fail(error);

		for (const event of output.events) {
			inspect(event);
			if (settled) return;
		}
		if (settleFromTerminalState()) return;

		timer = setTimeout(
			() =>
				fail(
					new Error(
						`Timed out waiting for native macOS capture to stop. Output path: ${
							targetPath ?? "unknown"
						}. Output: ${output.output.trim()}`,
					),
				),
			timeoutMs,
		);
		output.onEvent(onOutput);
		proc.once("close", onClose);
		proc.once("error", onProcessError);
		proc.stdin.once("error", onStdinError);

		// Close can happen between the first state check and listener registration.
		if (settleFromTerminalState()) return;
		if (!proc.stdin.writable || proc.stdin.destroyed || proc.stdin.writableEnded) {
			fail(new Error("Native macOS capture command channel is closed."));
			return;
		}

		try {
			const accepted = proc.stdin.write("stop\n", (error) => {
				if (error) fail(error);
			});
			if (!accepted) {
				// The command is queued. Its callback or the child close/error event owns completion.
			}
		} catch (error) {
			fail(error);
		}
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

export async function teardownFailedNativeMacStop(options: {
	proc: ChildProcessWithoutNullStreams;
	output: NativeMacCaptureOutput;
	graceMs?: number;
	warn?: WarningReporter;
}) {
	try {
		options.output.isolate();
	} catch (error) {
		reportCleanupFailure(options.warn, "[native-sck] could not isolate failed-stop output", error);
	}

	let exited = false;
	try {
		exited = await terminateNativeMacCapture(
			options.proc,
			options.graceMs ?? NATIVE_MAC_CAPTURE_KILL_GRACE_MS,
		);
	} catch (error) {
		reportCleanupFailure(
			options.warn,
			"[native-sck] failed-stop termination raised an error",
			error,
		);
	}
	if (!exited) {
		reportCleanupFailure(
			options.warn,
			"[native-sck] helper survived failed-stop termination",
			options.proc.pid,
		);
	}
	return exited;
}

export type NativeMacCaptureStopResult =
	| { ok: true; screenVideoPath: string }
	| { ok: false; error: Error; exited: boolean };

export async function stopNativeMacCapture(options: {
	proc: ChildProcessWithoutNullStreams;
	output: NativeMacCaptureOutput;
	targetPath: string | null;
	timeoutMs?: number;
	killGraceMs?: number;
	warn?: WarningReporter;
}): Promise<NativeMacCaptureStopResult> {
	try {
		const screenVideoPath = await requestNativeMacCaptureStop({
			proc: options.proc,
			output: options.output,
			targetPath: options.targetPath,
			timeoutMs: options.timeoutMs ?? NATIVE_MAC_CAPTURE_STOP_TIMEOUT_MS,
		});
		return { ok: true, screenVideoPath };
	} catch (error) {
		const stopError = toError(error);
		const exited = await teardownFailedNativeMacStop({
			proc: options.proc,
			output: options.output,
			graceMs: options.killGraceMs,
			warn: options.warn,
		});
		return { ok: false, error: stopError, exited };
	}
}

export async function teardownFailedNativeMacCapture(options: {
	proc: ChildProcessWithoutNullStreams;
	output: NativeMacCaptureOutput | null;
	outputPath: string | null;
	graceMs?: number;
	removeFile?: (filePath: string) => Promise<void>;
	warn?: WarningReporter;
}) {
	try {
		options.output?.isolate();
	} catch (error) {
		reportCleanupFailure(
			options.warn,
			"[native-sck] could not isolate failed helper output",
			error,
		);
	}

	let exited = false;
	try {
		exited = await terminateNativeMacCapture(
			options.proc,
			options.graceMs ?? NATIVE_MAC_CAPTURE_KILL_GRACE_MS,
		);
	} catch (error) {
		reportCleanupFailure(
			options.warn,
			"[native-sck] failed-start termination raised an error",
			error,
		);
	}
	if (!exited) {
		reportCleanupFailure(
			options.warn,
			"[native-sck] helper survived failed-start termination",
			options.proc.pid,
		);
	}

	if (options.outputPath) {
		try {
			const removeFile = options.removeFile ?? ((filePath) => fs.rm(filePath, { force: true }));
			await removeFile(options.outputPath);
		} catch (error) {
			reportCleanupFailure(
				options.warn,
				"[native-sck] could not remove failed capture output",
				options.outputPath,
				error,
			);
		}
	}

	return exited;
}
