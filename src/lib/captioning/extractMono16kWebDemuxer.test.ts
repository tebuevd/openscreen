import { describe, expect, it } from "vitest";

import { resolveWebDemuxerWasmUrl } from "./extractMono16kWebDemuxer";

describe("resolveWebDemuxerWasmUrl", () => {
	it.each([
		[
			"development",
			"http://localhost:5173/?windowType=editor",
			"http://localhost:5173/wasm/web-demuxer.wasm",
		],
		[
			"packaged",
			"file:///Applications/Openscreen.app/Contents/Resources/app.asar/dist/index.html?windowType=editor",
			"file:///Applications/Openscreen.app/Contents/Resources/app.asar/dist/wasm/web-demuxer.wasm",
		],
	])("resolves the %s asset beside the renderer entrypoint", (_name, baseUrl, expected) => {
		expect(resolveWebDemuxerWasmUrl(baseUrl)).toBe(expected);
	});
});
