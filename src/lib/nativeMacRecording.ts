import type { Rectangle } from "electron";
import type { CursorCaptureMode } from "./recordingSession";

export type NativeMacSourceType = "display" | "window";

export type NativeMacRecordingRequest = {
	schemaVersion: 1;
	recordingId?: number;
	source: {
		type: NativeMacSourceType;
		sourceId: string;
		displayId?: number;
		windowId?: number;
		bounds?: Rectangle;
	};
	video: {
		fps: number;
		width: number;
		height: number;
		bitrate?: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
	};
};

export type NativeMacHelperReadyEvent = {
	event: "ready";
	schemaVersion: 1;
};

export type NativeMacSourceGeometryMethod =
	| "screen-capture-kit-content-rect"
	| "display-mode-fallback"
	| "sanitized-fallback";

export type NativeMacHelperRecordingStartedEvent = {
	event: "recording-started";
	timestampMs: number;
	width: number;
	height: number;
	captureBounds: Rectangle;
	sourcePixelWidth: number;
	sourcePixelHeight: number;
	scale: number;
	sourceGeometryMethod: NativeMacSourceGeometryMethod;
	sourceContentRectPoints: Rectangle;
	sourcePixelsPerPoint: number;
};

export type NativeMacHelperRecordingStoppedEvent = {
	event: "recording-stopped";
	screenPath: string;
};

export type NativeMacHelperWarningEvent = {
	event: "warning";
	code: string;
	message: string;
};

export type NativeMacHelperErrorEvent = {
	event: "error";
	code: string;
	message: string;
};

export type NativeMacHelperEvent =
	| NativeMacHelperReadyEvent
	| NativeMacHelperRecordingStartedEvent
	| NativeMacHelperRecordingStoppedEvent
	| NativeMacHelperWarningEvent
	| NativeMacHelperErrorEvent;

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	width?: number;
	height?: number;
	error?: string;
};

const NATIVE_MAC_MAX_CAPTURE_WIDTH = 3840;
const NATIVE_MAC_MAX_CAPTURE_HEIGHT = 2160;
const NATIVE_MAC_MAX_SENSIBLE_PIXELS_PER_POINT = 16;
const SOURCE_PIXEL_ROUNDING_TOLERANCE = 0.5;

function isFiniteSafeNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Math.abs(value) <= Number.MAX_SAFE_INTEGER
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidCaptureDimension(value: unknown, maximum: number): value is number {
	return isPositiveSafeInteger(value) && value % 2 === 0 && value <= maximum;
}

function invalidRecordingStartedEvent(reason: string): never {
	throw new Error(`Native macOS capture reported an invalid recording-started event: ${reason}`);
}

function positiveEvenFloor(value: number) {
	const floored = Math.floor(value);
	return Math.max(2, floored - (floored % 2));
}

function isExpectedScale(actual: number, expected: number) {
	return Math.abs(actual - expected) <= Number.EPSILON * 8 * Math.max(1, Math.abs(expected));
}

function isSourceGeometryMethod(value: unknown): value is NativeMacSourceGeometryMethod {
	return (
		value === "screen-capture-kit-content-rect" ||
		value === "display-mode-fallback" ||
		value === "sanitized-fallback"
	);
}

function matchesSourcePixels(actual: number, expected: number) {
	const floatingPointTolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(expected));
	return Math.abs(actual - expected) <= SOURCE_PIXEL_ROUNDING_TOLERANCE + floatingPointTolerance;
}

export function parseNativeMacHelperRecordingStartedEvent(
	event: Record<string, unknown>,
): NativeMacHelperRecordingStartedEvent | null {
	if (event.event !== "recording-started") return null;

	if (!isPositiveSafeInteger(event.timestampMs)) {
		invalidRecordingStartedEvent("timestampMs must be a positive safe integer");
	}

	if (
		!isValidCaptureDimension(event.width, NATIVE_MAC_MAX_CAPTURE_WIDTH) ||
		!isValidCaptureDimension(event.height, NATIVE_MAC_MAX_CAPTURE_HEIGHT)
	) {
		invalidRecordingStartedEvent(
			`final dimensions must be positive, even safe integers within ${NATIVE_MAC_MAX_CAPTURE_WIDTH}x${NATIVE_MAC_MAX_CAPTURE_HEIGHT}`,
		);
	}

	if (!isRecord(event.captureBounds)) {
		invalidRecordingStartedEvent("captureBounds must be an object");
	}
	const bounds = event.captureBounds;
	if (
		!isFiniteSafeNumber(bounds.x) ||
		!isFiniteSafeNumber(bounds.y) ||
		!isFiniteSafeNumber(bounds.width) ||
		!isFiniteSafeNumber(bounds.height) ||
		bounds.width <= 0 ||
		bounds.height <= 0
	) {
		invalidRecordingStartedEvent(
			"captureBounds components must be finite safe numbers with positive dimensions",
		);
	}
	if (
		!isFiniteSafeNumber(bounds.x + bounds.width) ||
		!isFiniteSafeNumber(bounds.y + bounds.height)
	) {
		invalidRecordingStartedEvent("captureBounds extents must remain finite safe numbers");
	}

	if (
		!isFiniteSafeNumber(event.sourcePixelWidth) ||
		!isFiniteSafeNumber(event.sourcePixelHeight) ||
		event.sourcePixelWidth <= 0 ||
		event.sourcePixelHeight <= 0
	) {
		invalidRecordingStartedEvent("source pixel dimensions must be positive finite safe numbers");
	}
	if (!isFiniteSafeNumber(event.scale) || event.scale <= 0 || event.scale > 1) {
		invalidRecordingStartedEvent("scale must be a finite safe number in the range (0, 1]");
	}
	if (!isSourceGeometryMethod(event.sourceGeometryMethod)) {
		invalidRecordingStartedEvent("sourceGeometryMethod is not recognized");
	}
	if (!isRecord(event.sourceContentRectPoints)) {
		invalidRecordingStartedEvent("sourceContentRectPoints must be an object");
	}
	const sourceContentRectPoints = event.sourceContentRectPoints;
	if (
		!isFiniteSafeNumber(sourceContentRectPoints.x) ||
		!isFiniteSafeNumber(sourceContentRectPoints.y) ||
		!isFiniteSafeNumber(sourceContentRectPoints.width) ||
		!isFiniteSafeNumber(sourceContentRectPoints.height) ||
		sourceContentRectPoints.width <= 0 ||
		sourceContentRectPoints.height <= 0
	) {
		invalidRecordingStartedEvent(
			"sourceContentRectPoints components must be finite safe numbers with positive dimensions",
		);
	}
	if (
		!isFiniteSafeNumber(sourceContentRectPoints.x + sourceContentRectPoints.width) ||
		!isFiniteSafeNumber(sourceContentRectPoints.y + sourceContentRectPoints.height)
	) {
		invalidRecordingStartedEvent("sourceContentRectPoints extents must remain finite safe numbers");
	}
	if (
		!isFiniteSafeNumber(event.sourcePixelsPerPoint) ||
		event.sourcePixelsPerPoint <= 0 ||
		event.sourcePixelsPerPoint > NATIVE_MAC_MAX_SENSIBLE_PIXELS_PER_POINT
	) {
		invalidRecordingStartedEvent(
			`sourcePixelsPerPoint must be in the range (0, ${NATIVE_MAC_MAX_SENSIBLE_PIXELS_PER_POINT}]`,
		);
	}
	if (
		!matchesSourcePixels(
			event.sourcePixelWidth,
			sourceContentRectPoints.width * event.sourcePixelsPerPoint,
		) ||
		!matchesSourcePixels(
			event.sourcePixelHeight,
			sourceContentRectPoints.height * event.sourcePixelsPerPoint,
		)
	) {
		invalidRecordingStartedEvent(
			"source pixel dimensions do not match sourceContentRectPoints and sourcePixelsPerPoint",
		);
	}

	const expectedScale = Math.min(
		1,
		NATIVE_MAC_MAX_CAPTURE_WIDTH / event.sourcePixelWidth,
		NATIVE_MAC_MAX_CAPTURE_HEIGHT / event.sourcePixelHeight,
	);
	if (!isExpectedScale(event.scale, expectedScale)) {
		invalidRecordingStartedEvent(
			"scale does not fit the reported source pixels within the capture limit",
		);
	}
	if (
		event.width !== positiveEvenFloor(event.sourcePixelWidth * event.scale) ||
		event.height !== positiveEvenFloor(event.sourcePixelHeight * event.scale)
	) {
		invalidRecordingStartedEvent(
			"final dimensions do not match the reported source pixels and scale",
		);
	}

	return {
		event: "recording-started",
		timestampMs: event.timestampMs,
		width: event.width,
		height: event.height,
		captureBounds: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		},
		sourcePixelWidth: event.sourcePixelWidth,
		sourcePixelHeight: event.sourcePixelHeight,
		scale: event.scale,
		sourceGeometryMethod: event.sourceGeometryMethod,
		sourceContentRectPoints: {
			x: sourceContentRectPoints.x,
			y: sourceContentRectPoints.y,
			width: sourceContentRectPoints.width,
			height: sourceContentRectPoints.height,
		},
		sourcePixelsPerPoint: event.sourcePixelsPerPoint,
	};
}

export function parseMacWindowIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const windowIdPart = sourceId.split(":")[1];
	if (!windowIdPart || !/^\d+$/.test(windowIdPart)) {
		return null;
	}

	return Number(windowIdPart);
}

export function parseMacDisplayIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("screen:")) {
		return null;
	}

	const displayIdPart = sourceId.split(":")[1];
	if (!displayIdPart || !/^\d+$/.test(displayIdPart)) {
		return null;
	}

	return Number(displayIdPart);
}
