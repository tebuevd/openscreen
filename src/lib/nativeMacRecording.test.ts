import { describe, expect, it } from "vitest";
import {
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	parseNativeMacHelperRecordingStartedEvent,
} from "./nativeMacRecording";

describe("native macOS recording-started events", () => {
	it("retains the complete event when capture dimensions are valid", () => {
		const event = {
			event: "recording-started",
			timestampMs: 1_725_000_000_000,
			width: 2880,
			height: 1864,
			captureBounds: { x: 0, y: 0, width: 1440, height: 932 },
			sourcePixelWidth: 2880,
			sourcePixelHeight: 1864,
			scale: 1,
		};

		const parsed = parseNativeMacHelperRecordingStartedEvent(event);

		expect(parsed).toBe(event);
		expect(parsed).toMatchObject({
			width: 2880,
			height: 1864,
			sourcePixelWidth: 2880,
			sourcePixelHeight: 1864,
			scale: 1,
		});
	});

	it.each([
		["missing", undefined, 1080],
		["non-numeric", "1920", 1080],
		["non-finite", Number.POSITIVE_INFINITY, 1080],
		["fractional", 1920.5, 1080],
		["zero", 0, 1080],
		["negative", -1920, 1080],
		["odd", 1920, 1079],
	])("rejects %s capture dimensions", (_description, width, height) => {
		expect(() =>
			parseNativeMacHelperRecordingStartedEvent({
				event: "recording-started",
				timestampMs: 1_725_000_000_000,
				width,
				height,
			}),
		).toThrow(/invalid dimensions/);
	});
});

describe("nativeMacRecording source parsing", () => {
	it("parses Electron window source ids into ScreenCaptureKit window ids", () => {
		expect(parseMacWindowIdFromSourceId("window:12345:0")).toBe(12345);
		expect(parseMacWindowIdFromSourceId("window:987")).toBe(987);
	});

	it("rejects non-window source ids for window parsing", () => {
		expect(parseMacWindowIdFromSourceId("screen:1:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId("window:not-a-number:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId(null)).toBeNull();
	});

	it("parses Electron display source ids into ScreenCaptureKit display ids", () => {
		expect(parseMacDisplayIdFromSourceId("screen:1:0")).toBe(1);
		expect(parseMacDisplayIdFromSourceId("screen:69733248")).toBe(69733248);
	});

	it("rejects non-display source ids for display parsing", () => {
		expect(parseMacDisplayIdFromSourceId("window:123:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId("screen:not-a-number:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId(undefined)).toBeNull();
	});
});
