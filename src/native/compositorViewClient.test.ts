import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MP4_EXPORT_BITRATE } from "@/lib/exporter/mp4ExportSettings";

const requireNativeBridgeDataMock = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
	requireNativeBridgeData: requireNativeBridgeDataMock,
}));

import {
	abortStagedNativeExport,
	commitStagedNativeExport,
	exportMultiNative,
	exportMultiNativeStaged,
	replaceStagedNativeExport,
} from "./compositorViewClient";

describe("exportMultiNative params", () => {
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
		{ width: 2880, height: 1864, fps: 60, bitrate: 80_000_000, codec: "h264" },
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

	it.each([
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["NaN", Number.NaN],
		["positive infinity", Number.POSITIVE_INFINITY],
		["negative infinity", Number.NEGATIVE_INFINITY],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["excessive", MAX_MP4_EXPORT_BITRATE + 1],
	])("rejects %s bitrate before IPC", async (_label, bitrate) => {
		await expect(
			exportMultiNative([], "/tmp/out.mp4", "{}", {
				width: 1920,
				height: 1080,
				bitrate,
			}),
		).rejects.toThrow(/bitrate.*positive safe integer/);
		expect(requireNativeBridgeDataMock).not.toHaveBeenCalled();
	});

	it("wires staged render, replacement, commit, and abort through typed bridge actions", async () => {
		const params = { width: 1920, height: 1080, bitrate: 20_000_000 };
		const data = new ArrayBuffer(4);

		await exportMultiNativeStaged([], "/tmp/selected.mp4", "{}", params, ["/tmp/voiceover.wav"]);
		await replaceStagedNativeExport("transaction-1", data);
		await commitStagedNativeExport("transaction-1");
		await abortStagedNativeExport("transaction-2");

		expect(requireNativeBridgeDataMock).toHaveBeenNthCalledWith(1, {
			domain: "compositor",
			action: "exportMultiStaged",
			payload: {
				clips: [],
				outPath: "/tmp/selected.mp4",
				sceneJson: "{}",
				params,
				additionalInputPaths: ["/tmp/voiceover.wav"],
			},
		});
		expect(requireNativeBridgeDataMock).toHaveBeenNthCalledWith(2, {
			domain: "compositor",
			action: "replaceStagedExport",
			payload: { transactionId: "transaction-1", data },
		});
		expect(requireNativeBridgeDataMock).toHaveBeenNthCalledWith(3, {
			domain: "compositor",
			action: "commitStagedExport",
			payload: { transactionId: "transaction-1" },
		});
		expect(requireNativeBridgeDataMock).toHaveBeenNthCalledWith(4, {
			domain: "compositor",
			action: "abortStagedExport",
			payload: { transactionId: "transaction-2" },
		});
	});
});
