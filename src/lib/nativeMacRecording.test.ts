import { describe, expect, it } from "vitest";
import {
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	parseNativeMacHelperRecordingStartedEvent,
} from "./nativeMacRecording";

describe("native macOS recording-started events", () => {
	const validEvent = () => ({
		event: "recording-started",
		timestampMs: 1_725_000_000_000,
		width: 2880,
		height: 1864,
		captureBounds: { x: -1440.5, y: 0.25, width: 1440, height: 932 },
		sourcePixelWidth: 2880,
		sourcePixelHeight: 1864,
		scale: 1,
	});

	it("returns a complete trusted event when all geometry is valid", () => {
		expect(parseNativeMacHelperRecordingStartedEvent(validEvent())).toEqual({
			event: "recording-started",
			timestampMs: 1_725_000_000_000,
			width: 2880,
			height: 1864,
			captureBounds: { x: -1440.5, y: 0.25, width: 1440, height: 932 },
			sourcePixelWidth: 2880,
			sourcePixelHeight: 1864,
			scale: 1,
		});
	});

	it("accepts a source uniformly fitted to the capture ceiling", () => {
		expect(
			parseNativeMacHelperRecordingStartedEvent({
				...validEvent(),
				width: 3840,
				height: 2160,
				sourcePixelWidth: 5120,
				sourcePixelHeight: 2880,
				scale: 0.75,
			}),
		).toMatchObject({ width: 3840, height: 2160, scale: 0.75 });
	});

	it.each([
		["missing", undefined, 1864],
		["non-numeric", "2880", 1864],
		["NaN", Number.NaN, 1864],
		["non-finite", Number.POSITIVE_INFINITY, 1864],
		["unsafe", 2 ** 53, 1864],
		["fractional", 2880.5, 1864],
		["zero", 0, 1864],
		["negative", -2880, 1864],
		["odd", 2880, 1863],
		["oversized width", 3842, 1864],
		["oversized height", 2880, 2162],
	])("rejects %s capture dimensions", (_description, width, height) => {
		expect(() =>
			parseNativeMacHelperRecordingStartedEvent({
				...validEvent(),
				width,
				height,
			}),
		).toThrow(/invalid recording-started event/);
	});

	it.each([
		["missing diagnostics", { sourcePixelWidth: undefined }],
		["unsafe timestamp", { timestampMs: 2 ** 53 }],
		["fractional timestamp", { timestampMs: 1.5 }],
		["missing bounds", { captureBounds: undefined }],
		["NaN bounds coordinate", { captureBounds: { x: Number.NaN, y: 0, width: 1, height: 1 } }],
		["infinite bounds coordinate", { captureBounds: { x: 0, y: Infinity, width: 1, height: 1 } }],
		[
			"unsafe bounds extent",
			{ captureBounds: { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 } },
		],
		["non-positive bounds width", { captureBounds: { x: 0, y: 0, width: 0, height: 1 } }],
		["NaN source width", { sourcePixelWidth: Number.NaN }],
		["unsafe source height", { sourcePixelHeight: 2 ** 53 }],
		["NaN scale", { scale: Number.NaN }],
		["zero scale", { scale: 0 }],
		["scale above one", { scale: 1.01 }],
		["scale inconsistent with source", { scale: 0.5 }],
		["final pixels inconsistent with geometry", { width: 1920, height: 1080 }],
	])("rejects %s", (_description, overrides) => {
		expect(() =>
			parseNativeMacHelperRecordingStartedEvent({ ...validEvent(), ...overrides }),
		).toThrow(/invalid recording-started event/);
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
