import { beforeEach, describe, expect, it, vi } from "vitest";

const requireNativeBridgeDataMock = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
	requireNativeBridgeData: requireNativeBridgeDataMock,
}));

import { exportMultiNative } from "./compositorViewClient";

describe("exportMultiNative dimensions", () => {
	beforeEach(() => {
		requireNativeBridgeDataMock.mockReset();
		requireNativeBridgeDataMock.mockResolvedValue({});
	});

	it.each([
		["missing", undefined],
		["one-sided", { width: 1920 }],
		["malformed", { width: 1920.5, height: 1080 }],
		["oversized", { width: 8192, height: 4322 }],
	])("rejects %s params before IPC", async (_label, params) => {
		await expect(exportMultiNative([], "/tmp/out.mp4", "{}", params as never)).rejects.toThrow(
			/width and height must both/,
		);
		expect(requireNativeBridgeDataMock).not.toHaveBeenCalled();
	});

	it.each([
		{ width: 1920, height: 1080, fps: 60, codec: "h264" },
		{ width: 2880, height: 1864, fps: 60, codec: "h264" },
	])("submits exact valid dimensions: $width x $height", async (params) => {
		await exportMultiNative([], "/tmp/out.mp4", "{}", params);
		expect(requireNativeBridgeDataMock).toHaveBeenCalledWith({
			domain: "compositor",
			action: "exportMulti",
			payload: {
				clips: [],
				outPath: "/tmp/out.mp4",
				sceneJson: "{}",
				params,
			},
		});
	});
});
