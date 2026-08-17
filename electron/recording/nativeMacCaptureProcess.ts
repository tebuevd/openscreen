import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type {
	NativeMacHelperErrorEvent,
	NativeMacHelperRecordingStoppedEvent,
} from "../../src/lib/nativeMacRecording";

type NativeMacHelperEvent = Record<string, unknown>;
type NativeMacHelperEventListener = (event: NativeMacHelperEvent) => void;
type WarningReporter = (message: string, ...details: unknown[]) => void;

type NativeMacCaptureTerminalEvent =
	| NativeMacHelperRecordingStoppedEvent
	| NativeMacHelperErrorEvent;

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

function parseHelperErrorEvent(event: NativeMacHelperEvent): NativeMacHelperErrorEvent | null {
	if (
		event.event !== "error" ||
		typeof event.code !== "string" ||
		typeof event.message !== "string" ||
		typeof event.terminal !== "boolean"
	) {
		return null;
	}
	return {
		event: "error",
		code: event.code,
		message: event.message,
		terminal: event.terminal,
	};
}

function helperErrorFromEvent(event: NativeMacHelperEvent, context = "") {
	const helperError = parseHelperErrorEvent(event);
	return new Error(
		`${helperError?.message ?? String(event.message ?? event.code ?? "Native macOS capture failed")}${context}`,
	);
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
	private terminalEvent: NativeMacCaptureTerminalEvent | null = null;
	private readonly nonterminalErrorEvents: NativeMacHelperErrorEvent[] = [];
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

	constructor(
		readonly proc: ChildProcessWithoutNullStreams,
		readonly targetPath: string,
	) {
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

	get recordingStoppedEvent() {
		return this.terminalEvent?.event === "recording-stopped" ? this.terminalEvent : null;
	}

	get stopTerminalEvent() {
		return this.terminalEvent;
	}

	get nonterminalErrors() {
		return [...this.nonterminalErrorEvents];
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
		this.terminalEvent = null;
		this.nonterminalErrorEvents.length = 0;
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
			if (stream === "stdout") {
				const helperError = parseHelperErrorEvent(event);
				if (helperError && !helperError.terminal) {
					this.nonterminalErrorEvents.push(helperError);
				}
				if (this.terminalEvent === null) {
					if (
						event.event === "recording-stopped" &&
						typeof event.screenPath === "string" &&
						event.screenPath === this.targetPath
					) {
						this.terminalEvent = {
							event: "recording-stopped",
							screenPath: event.screenPath,
						};
					} else if (helperError?.terminal) {
						this.terminalEvent = helperError;
					}
				}
			}
			this.eventHistory.push(event);
			this.eventEmitter.emit("helper-event", event);
		}
	}
}

async function validateFinalizedCaptureFile(filePath: string) {
	let stats;
	try {
		stats = await fs.stat(filePath);
	} catch {
		throw new Error(
			`Native macOS capture reported completion, but the output file is missing or unreadable: ${filePath}`,
		);
	}
	if (!stats.isFile()) {
		throw new Error(
			`Native macOS capture reported completion, but the output path is not a regular file: ${filePath}`,
		);
	}
	if (stats.size <= 0) {
		throw new Error(
			`Native macOS capture reported completion, but the output file is empty: ${filePath}`,
		);
	}
}

function nonterminalErrorContext(output: NativeMacCaptureOutput) {
	if (output.nonterminalErrors.length === 0) return "";
	const details = output.nonterminalErrors
		.map((event) => `${event.code}: ${event.message}`)
		.join("; ");
	return ` Nonterminal diagnostics: ${details}.`;
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
	if (!targetPath || output.targetPath !== targetPath) {
		return Promise.reject(
			new Error("Native macOS capture process does not own the requested output path."),
		);
	}
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let validatingTerminalEvent = false;
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
		const settleFromTerminalEvent = () => {
			if (settled || validatingTerminalEvent) return validatingTerminalEvent;
			const terminalEvent = output.stopTerminalEvent;
			if (!terminalEvent) return false;
			if (terminalEvent.event === "error") {
				fail(helperErrorFromEvent(terminalEvent, nonterminalErrorContext(output)));
				return true;
			}

			validatingTerminalEvent = true;
			void validateFinalizedCaptureFile(terminalEvent.screenPath).then(
				() => succeed(terminalEvent.screenPath),
				(error) => fail(error),
			);
			return true;
		};
		const inspect = (event: NativeMacHelperEvent) => {
			if (validatingTerminalEvent) return;
			if (event.event === "recording-stopped") {
				if (!settleFromTerminalEvent()) {
					fail(
						new Error(
							`Native macOS capture returned a terminal event for an unexpected output path; expected ${targetPath}.`,
						),
					);
				}
				return;
			}
			if (event.event === "error") {
				const helperError = parseHelperErrorEvent(event);
				if (helperError && !helperError.terminal) return;
				if (!settleFromTerminalEvent()) {
					fail(helperErrorFromEvent(event, nonterminalErrorContext(output)));
				}
			}
		};
		const settleFromTerminalState = () => {
			if (!hasExited(proc)) return false;
			if (settleFromTerminalEvent()) return true;
			fail(
				new Error(
					`Native macOS capture exited without an authoritative recording-stopped event (code=${proc.exitCode ?? "unknown"}, signal=${proc.signalCode ?? "none"}).${nonterminalErrorContext(output)} Output: ${output.output.trim()}`,
				),
			);
			return true;
		};
		const onOutput = (event: NativeMacHelperEvent) => inspect(event);
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settleFromTerminalEvent()) return;
			fail(
				new Error(
					`Native macOS capture exited without an authoritative recording-stopped event (code=${code ?? "unknown"}, signal=${signal ?? "none"}).${nonterminalErrorContext(output)} Output: ${output.output.trim()}`,
				),
			);
		};
		const onProcessError = (error: Error) => {
			if (!validatingTerminalEvent) fail(error);
		};
		const onStdinError = (error: Error) => {
			if (!validatingTerminalEvent) fail(error);
		};

		timer = setTimeout(
			() =>
				fail(
					new Error(
						`Timed out waiting for native macOS capture to stop. Output path: ${
							targetPath ?? "unknown"
						}.${nonterminalErrorContext(output)} Output: ${output.output.trim()}`,
					),
				),
			timeoutMs,
		);
		output.onEvent(onOutput);
		proc.once("close", onClose);
		proc.once("error", onProcessError);
		proc.stdin.once("error", onStdinError);
		for (const event of output.events) {
			inspect(event);
			if (settled || validatingTerminalEvent) return;
		}
		if (settleFromTerminalEvent()) return;

		// The retained terminal event and process state cover output/close races around registration.
		if (settleFromTerminalState()) return;
		if (!proc.stdin.writable || proc.stdin.destroyed || proc.stdin.writableEnded) {
			fail(new Error("Native macOS capture command channel is closed."));
			return;
		}

		try {
			const accepted = proc.stdin.write("stop\n", (error) => {
				if (error && !validatingTerminalEvent) fail(error);
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
