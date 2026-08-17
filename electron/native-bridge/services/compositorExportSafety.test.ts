import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClipInput,
	CompositorViewAddon,
	ExportStats,
	GifExportStats,
} from "../../native/compositor-view/addon";
import { CompositorViewService, collectNativeExportSourcePaths } from "./compositorViewService";
import { ExportDestinationTransactionManager } from "./exportDestinationTransaction";

const MP4_STATS: ExportStats = { frames: 60, wallS: 1, fps: 60, videoDurationS: 1 };
const GIF_STATS: GifExportStats = { ...MP4_STATS, fileBytes: 10 };

function clip(screenPath: string, webcamPath = ""): ClipInput {
	return {
		screenPath,
		webcamPath,
		sourceStartSec: 0,
		sourceEndSec: 1,
		webcamOffsetSec: 0,
		hasAudio: true,
	};
}

function sceneJson(clips: ClipInput[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ clips, ...extra });
}

describe("compositor export destination safety", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-compositor-export-"));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeService() {
		const exportMulti = vi.fn(async (_clips: ClipInput[], outputPath: string) => {
			await fs.writeFile(outputPath, "native mp4");
			return MP4_STATS;
		});
		const exportGif = vi.fn(async (_clips: ClipInput[], outputPath: string) => {
			await fs.writeFile(outputPath, "native gif");
			return GIF_STATS;
		});
		const addon = { exportMulti, exportGif } as unknown as CompositorViewAddon;
		return {
			exportMulti,
			exportGif,
			service: new CompositorViewService({
				addon,
				exportDestinationTransactions: new ExportDestinationTransactionManager(),
			}),
		};
	}

	it.each([
		"exact",
		"relative",
		"symlink",
		"hard-link",
	])("rejects a %s source alias before calling native", async (aliasKind) => {
		const sourcePath = path.join(directory, "recording.mp4");
		await fs.writeFile(sourcePath, "recording bytes");
		let destination = sourcePath;
		if (aliasKind === "relative") {
			destination = path.relative(process.cwd(), sourcePath);
		} else if (aliasKind === "symlink") {
			destination = path.join(directory, "recording-symlink.mp4");
			await fs.symlink(sourcePath, destination);
		} else if (aliasKind === "hard-link") {
			destination = path.join(directory, "recording-hard-link.mp4");
			await fs.link(sourcePath, destination);
		}
		const clips = [clip(sourcePath)];
		const { service, exportMulti } = makeService();

		await expect(
			service.exportMulti(clips, destination, sceneJson(clips), {
				width: 1920,
				height: 1080,
			}),
		).rejects.toThrow(/same file as an export source/);

		expect(exportMulti).not.toHaveBeenCalled();
		expect(await fs.readFile(sourcePath, "utf8")).toBe("recording bytes");
	});

	it.each([
		"webcam",
		"background",
		"annotation",
		"cursor",
	])("rejects a destination matching the native %s input", async (inputKind) => {
		const sourcePath = path.join(directory, "recording.mp4");
		const inputPath = path.join(directory, `${inputKind}.mp4`);
		await fs.writeFile(sourcePath, "recording bytes");
		await fs.writeFile(inputPath, `${inputKind} bytes`);
		const clips = [clip(sourcePath, inputKind === "webcam" ? inputPath : "")];
		const scene = sceneJson(clips, {
			...(inputKind === "background" ? { background: { kind: "image", path: inputPath } } : {}),
			...(inputKind === "annotation"
				? { annotations: [{ kind: "image", imagePath: inputPath }] }
				: {}),
			...(inputKind === "cursor"
				? { cursor: { cursorSprites: { arrow: { path: inputPath } } } }
				: {}),
		});
		const { service, exportMulti } = makeService();

		await expect(
			service.exportMulti(clips, inputPath, scene, { width: 1920, height: 1080 }),
		).rejects.toThrow(/same file as an export source/);

		expect(exportMulti).not.toHaveBeenCalled();
		expect(await fs.readFile(inputPath, "utf8")).toBe(`${inputKind} bytes`);
	});

	it("passes only a same-directory .mp4 temp to native, then replaces the selected path", async () => {
		const sourcePath = path.join(directory, "recording.mp4");
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(sourcePath, "recording bytes");
		await fs.writeFile(destination, "old export");
		const clips = [clip(sourcePath)];
		const { service, exportMulti } = makeService();

		const result = await service.exportMulti(clips, destination, sceneJson(clips), {
			width: 1920,
			height: 1080,
		});

		expect(result).toEqual(MP4_STATS);
		const nativePath = exportMulti.mock.calls[0]?.[1];
		expect(nativePath).not.toBe(destination);
		expect(path.dirname(nativePath ?? "")).toBe(directory);
		expect(path.extname(nativePath ?? "")).toBe(".mp4");
		expect(await fs.readFile(destination, "utf8")).toBe("native mp4");
		expect((await fs.readdir(directory)).some((name) => name.includes(".openscreen-export-"))).toBe(
			false,
		);
	});

	it("applies the same transaction policy to GIF", async () => {
		const sourcePath = path.join(directory, "recording.mp4");
		const destination = path.join(directory, "output.gif");
		await fs.writeFile(sourcePath, "recording bytes");
		await fs.writeFile(destination, "old gif");
		const clips = [clip(sourcePath)];
		const { service, exportGif } = makeService();

		const result = await service.exportGif(clips, destination, sceneJson(clips), { fps: 15 });

		expect(result).toEqual(GIF_STATS);
		const nativePath = exportGif.mock.calls[0]?.[1];
		expect(nativePath).not.toBe(destination);
		expect(path.dirname(nativePath ?? "")).toBe(directory);
		expect(path.extname(nativePath ?? "")).toBe(".gif");
		expect(await fs.readFile(destination, "utf8")).toBe("native gif");
	});

	it("holds a staged MP4 off-destination until post-processing is committed", async () => {
		const sourcePath = path.join(directory, "recording.mp4");
		const voiceoverPath = path.join(directory, "voiceover.wav");
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(sourcePath, "recording bytes");
		await fs.writeFile(voiceoverPath, "voiceover bytes");
		await fs.writeFile(destination, "old export");
		const clips = [clip(sourcePath)];
		const { service } = makeService();

		const staged = await service.exportMultiStaged(
			clips,
			destination,
			sceneJson(clips),
			{ width: 1920, height: 1080 },
			[voiceoverPath],
		);
		if (!staged) throw new Error("Expected staged export");
		expect(await fs.readFile(destination, "utf8")).toBe("old export");

		await service.replaceStagedExport(
			staged.transactionId,
			new TextEncoder().encode("mixed mp4").buffer,
		);
		await expect(service.commitStagedExport(staged.transactionId)).resolves.toBe(destination);

		expect(await fs.readFile(destination, "utf8")).toBe("mixed mp4");
		expect((await fs.readdir(directory)).some((name) => name.includes(".openscreen-export-"))).toBe(
			false,
		);
	});

	it("treats a voiceover as an explicit staged-export input before native runs", async () => {
		const sourcePath = path.join(directory, "recording.mp4");
		const voiceoverPath = path.join(directory, "voiceover.mp4");
		const destination = path.join(directory, "output.mp4");
		await fs.writeFile(sourcePath, "recording bytes");
		await fs.writeFile(voiceoverPath, "voiceover bytes");
		await fs.link(voiceoverPath, destination);
		const clips = [clip(sourcePath)];
		const { service, exportMulti } = makeService();

		await expect(
			service.exportMultiStaged(
				clips,
				destination,
				sceneJson(clips),
				{ width: 1920, height: 1080 },
				[voiceoverPath],
			),
		).rejects.toThrow(/same file as an export source/);
		expect(exportMulti).not.toHaveBeenCalled();
		expect(await fs.readFile(voiceoverPath, "utf8")).toBe("voiceover bytes");
	});
});

describe("collectNativeExportSourcePaths", () => {
	it("uses only validated native input fields rather than recursively scanning arbitrary paths", () => {
		const clips = [clip("/media/screen.mp4", "/media/webcam.mp4")];
		const sources = collectNativeExportSourcePaths(
			clips,
			JSON.stringify({
				clips,
				background: { kind: "image", path: "/media/background.png" },
				annotations: [{ kind: "image", imagePath: "/media/annotation.png" }],
				cursor: {
					cursorSprites: { arrow: { path: "/media/cursor.png", hotspotX: 0, hotspotY: 0 } },
				},
				metadata: { path: "/not/a/native/input.mp4" },
				ignoredData: { path: "data:image/png;base64,AAAA" },
			}),
			["/media/voiceover.wav"],
		);

		expect(sources).toEqual(
			expect.arrayContaining([
				"/media/screen.mp4",
				"/media/screen.mp4.cursor.json",
				"/media/webcam.mp4",
				"/media/background.png",
				"/media/annotation.png",
				"/media/cursor.png",
				"/media/voiceover.wav",
			]),
		);
		expect(sources).not.toContain("/not/a/native/input.mp4");
		expect(sources.some((source) => source.startsWith("data:"))).toBe(false);
	});
});
