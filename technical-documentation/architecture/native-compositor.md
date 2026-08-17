# Native compositor

[`crates/compositor/`](../../crates/compositor) is OpenScreen's production,
cross-platform Rust composition library. The
[`compositor-view-napi`](../../crates/compositor-view-napi) crate exposes it to
Electron as `compositor_view.node`, which
[`CompositorViewService`](../../electron/native-bridge/services/compositorViewService.ts)
loads for the live preview and native export operations.

The reusable architecture is not a Direct3D pipeline with ports bolted on. All
platforms consume the same TypeScript `SceneDescription`, Rust `Scene`, region
sampling, clip ordering, output-time projection, and backend-neutral frame geometry.
Platform modules supply the decoder frame seam, GPU draws, text rasterization,
readback, and MP4 encoder integration:

| Platform | Decode and composition | MP4 output |
|---|---|---|
| Windows | D3D11 with D3D11VA decode when available; software decode plus WARP composition is the CPU fallback | Runtime-selected H.264/H.265 hardware, system-frame, or software encoder |
| macOS | Metal with VideoToolbox decode; software-decoded frames can be uploaded through CoreVideo | VideoToolbox H.264/H.265, then software fallback |
| Linux | wgpu over Vulkan (hardware adapter or Mesa lavapipe) with software decode and texture upload | RGBA readback, YUV conversion, and software H.264/H.265 encoding |

These rows describe implemented code paths, not a claim that this documentation
change exercised each path on physical hardware. Platform runtime validation belongs
in the [manual end-to-end checklist](../testing/manual-e2e-checklist.md).

The live preview and export share scene and composition semantics, but their sinks
differ. The preview publishes RGBA frame packets for an HTML canvas. MP4 passes
composed frames to the platform pipeline and muxer. GIF reads composed RGBA frames
back and passes them to the Rust palette/LZW writer. See
[export-pipeline.md](export-pipeline.md) for clip walking, audio ordering, encoder
selection, destination transactions, and the detailed export flow; this document
focuses on the compositor itself.

## Shared core

[`crates/compositor/src/lib.rs`](../../crates/compositor/src/lib.rs) selects a
platform implementation with `cfg` re-exports while keeping portable call sites on
`crate::d3d`, `crate::compositor`, `crate::pipeline`, and `crate::text`. The `d3d`
name is a legacy API alias; on macOS it resolves to Metal, and on Linux to wgpu/Vulkan.

| Source | Responsibility |
|---|---|
| [`scene.rs`](../../crates/compositor/src/scene.rs) | Rust mirror of the app's `SceneDescription`; per-clip scene filtering through `Scene::for_clip_window` |
| [`frame_geometry.rs`](../../crates/compositor/src/frame_geometry.rs) | Backend-neutral crop, contain/cover fit, layer placement, zoom, rotation, masks, shadows, and cursor geometry |
| [`regions.rs`](../../crates/compositor/src/regions.rs) | Zoom, speed, and Full Camera envelope sampling |
| [`timeline_walk.rs`](../../crates/compositor/src/timeline_walk.rs) | Shared MP4/GIF clip walk, decoder advancement, speed segments, and output frame numbering |
| [`live.rs`](../../crates/compositor/src/live.rs) | Cross-platform preview player and render thread; publishes the latest RGBA packet |
| [`audio.rs`](../../crates/compositor/src/audio.rs) | Per-clip audio decode/mix, 48 kHz planar conversion, WSOLA stretch, concatenation, and AAC encoding |
| [`gif_export.rs`](../../crates/compositor/src/gif_export.rs) | Native GIF frame sink, palette quantization, optional dithering, and GIF89a/LZW output |
| [`cursor.rs`](../../crates/compositor/src/cursor.rs) | Cursor sidecar parsing and interpolated position/click state |
| [`text_anim.rs`](../../crates/compositor/src/text_anim.rs) and [`text_plate.rs`](../../crates/compositor/src/text_plate.rs) | Portable annotation animation and text-plate geometry |
| [`config.rs`](../../crates/compositor/src/config.rs) | Composition feature configuration and benchmark fixtures |
| [`export_bitrate.rs`](../../crates/compositor/src/export_bitrate.rs) | Shared MP4 bitrate validation and fallback policy |

The format-specific export functions use one `timeline_walk` rather than separate
frame-selection loops. That keeps the source frame assigned to output frame `N`, the
active `clipIndex`, and each clip's produced frame count consistent between MP4 and
GIF. The live preview does not use the export walk, but it consumes the same `Scene`
and calls the same platform compositor with source time supplied by playback sync.

## Platform modules

| Platform | Device/frame modules | Compositor, text, and pipeline |
|---|---|---|
| Windows | [`d3d_windows.rs`](../../crates/compositor/src/d3d_windows.rs), [`cpu_frames_windows.rs`](../../crates/compositor/src/cpu_frames_windows.rs) | [`compositor_windows.rs`](../../crates/compositor/src/compositor_windows.rs), [`text_windows.rs`](../../crates/compositor/src/text_windows.rs), [`pipeline_windows.rs`](../../crates/compositor/src/pipeline_windows.rs), [`shaders.hlsl`](../../crates/compositor/src/shaders.hlsl) |
| macOS | [`d3d_macos.rs`](../../crates/compositor/src/d3d_macos.rs), [`mac_frames.rs`](../../crates/compositor/src/mac_frames.rs) | [`compositor_macos.rs`](../../crates/compositor/src/compositor_macos.rs), [`text_macos.rs`](../../crates/compositor/src/text_macos.rs), [`pipeline_macos.rs`](../../crates/compositor/src/pipeline_macos.rs), [`shaders.metal`](../../crates/compositor/src/shaders.metal) |
| Linux | [`d3d_linux.rs`](../../crates/compositor/src/d3d_linux.rs), [`linux_decode.rs`](../../crates/compositor/src/linux_decode.rs), [`linux_frames.rs`](../../crates/compositor/src/linux_frames.rs) | [`compositor_linux.rs`](../../crates/compositor/src/compositor_linux.rs), [`text_linux.rs`](../../crates/compositor/src/text_linux.rs), [`pipeline_linux.rs`](../../crates/compositor/src/pipeline_linux.rs), [`vk_shaders/`](../../crates/compositor/src/vk_shaders) |

### Windows

`d3d_windows::Gpu` owns the D3D11 device used by decode, composition, and the
zero-copy encoder candidates. The hardware device requests feature level 11_1 and
`VIDEO_SUPPORT | BGRA_SUPPORT`; multithread protection is enabled because ffmpeg and
the render loop can touch the device from different threads. HLSL renders the scene,
while DirectWrite/Direct2D rasterizes text into cached textures.

`Gpu::create_auto` prefers that hardware path. WARP cannot provide D3D11 video
decode, so the CPU backend combines software libavcodec decode with WARP rendering.
The MP4 encoder probes its ordered candidates at runtime; a working D3D11 encoder is
preferred, but system-frame and software candidates remain available. This fallback
is compositor/export behavior and is separate from the Windows capture helper.

### macOS

`d3d_macos::Gpu` owns an `MTLDevice` and command queue. VideoToolbox frames arrive as
IOSurface-backed `CVPixelBuffer`s and are exposed to shaders through
`CVMetalTextureCache`; the software-decode path converts frames into the same
CoreVideo seam before composition. MSL implements the GPU passes and CoreText/Core
Graphics supplies cached text textures.

Metal render targets use private storage. Readback copies them to shared buffers and
waits for command completion before exposing RGBA bytes to the preview or GIF sink.
MP4 prefers VideoToolbox encoders and can fall back to the software H.264/H.265
encoders linked through ffmpeg.

### Linux

`d3d_linux::Gpu` exposes the same device API over a wgpu `Device` and `Queue`. A
hardware Vulkan adapter is preferred; Mesa lavapipe is classified as the CPU
fallback when available. `linux_decode.rs` performs software decode and
`linux_frames.rs` uploads the frame planes consumed by WGSL. Text uses cosmic-text.

The Linux MP4 path currently reads composed RGBA frames through a staging ring,
converts them to YUV420P, and feeds the software H.264/H.265 encoders. The two-entry
readback ring overlaps GPU copies with CPU conversion/encoding; it does not turn this
into a zero-copy hardware encoder path.

## Scene and composition

The TypeScript producer is
[`buildSceneDescription`](../../src/native/sceneDescription.ts), and the Rust wire
type is [`Scene`](../../crates/compositor/src/scene.rs). The preview's
`NativeCompositorOverlay` and `ExportDialog` both use that serializer. It carries the
ordered clips, per-clip crop/layout, background, effects, zoom/speed/Full Camera
regions, annotations/captions, cursor settings, and output geometry.

Regions are authored against the editor timeline but native composition samples
source time. `projectRegionsToSource` emits per-clip source intervals and
`clipIndex`; `Scene::for_clip_window` retains only entries belonging to the clip and
source window currently being composed. See
[timeline-model.md](timeline-model.md) for the coordinate contract.

`frame_geometry::plan_frame` is the shared placement calculation. It decides crop
and cover UVs, screen/webcam rectangles, zoom and rotation, masks, shadows, and other
normalized geometry without importing D3D11, Metal, or wgpu. Each platform compositor
turns that plan into its own draw calls and shaders. Shared geometry removes one
source of drift, but shader, text, and readback implementations remain
platform-specific and require platform-specific verification.

The scene's semantic layer order is:

1. Background image, color, or gradient, with optional background blur.
2. Screen shadow.
3. Cropped screen video with zoom, rotation, corner mask, and motion effects.
4. Cursor sprite/trail/click state, projected with the screen where required.
5. Webcam shadow for floating layouts.
6. Webcam video with mirror, shape, reactive scale, and Full Camera transition.
7. Annotations and derived captions above the media layers.

Several dimensions are deliberately serialized as fractions rather than pixels so
the same scene scales between preview and export:

- `effects.roundnessFrac` is relative to the output frame's short side.
- `layout.screenRadiusFrac` and `layout.webcamRadiusFrac` are relative to their own
  boxes.
- Annotation position/size and text size are relative to the screen rectangle.

## Output geometry

Production composition is not fixed at `1920x1080`. The app resolves the visible
clip stream and scene shape in
[`outputFormat.ts`](../../src/lib/ai-edition/document/outputFormat.ts), while
[`mp4ExportSettings.ts`](../../src/lib/exporter/mp4ExportSettings.ts) resolves the
selected MP4 tier and bitrate. The resulting width and height are included in
`SceneDescription.output` and the export parameters.

For MP4, width and height are explicit. The renderer client, Electron service, and
N-API boundary require positive even integers, at most `8192` per axis and at most
`35,389,440` pixels in total. `ExportMultiTask` constructs
`Compositor::new_sized(width, height)`, so layers are rasterized at the encoded
resolution instead of rendering a lower-resolution intermediate and enlarging it
afterward.

For GIF, `ExportDialog` passes concrete dimensions derived from the selected output
geometry and GIF size preset. The lower-level N-API contract keeps optional defaults
for non-editor callers, but still constructs a compositor at the resolved GIF size.

The live preview uses `Scene.output` for aspect and as an upper detail bound, then
contain-fits it into the current panel. `live.rs` recreates the compositor when that
bounded render size changes. The `OUT_W`/`OUT_H` constants remain defaults for
fixtures and construction before a real scene size is known; they are not the MP4
export resolution contract.

## MP4, GIF, and audio

MP4 and GIF receive the same ordered clips and scene, and both drive
`walk_composited_timeline`. MP4 sends each composed frame to its platform pipeline,
encodes H.264 or H.265, muxes AAC audio, and writes MP4. GIF performs RGBA readback,
palette quantization, optional dithering, and GIF89a/LZW output; GIF has no audio
track. Exact frame/audio sequencing and current encoder selection are documented in
[export-pipeline.md](export-pipeline.md) rather than repeated here.

[`audio.rs`](../../crates/compositor/src/audio.rs) is shared by the three MP4
pipelines. For each clip it enumerates and mixes the source's audio streams into
planar float stereo at 48 kHz, then applies WSOLA to speed sub-segments. After the
video walk, the concatenation plan uses actual per-clip output frame counts to place
PCM without cumulative floating-point drift, applies short boundary fades, and
encodes AAC once before the trailer.

The live preview is video-only: `live.rs` does not decode or play this export audio.

## Build and packaging

The compositor links the ffmpeg libraries through bindgen-generated FFI and must be
built against a compatible shared SDK. Release artifacts use the repository's pinned
LGPL-compatible ffmpeg inputs; a GPL or nonfree build is not packageable for this MIT
application. Platform details and artifact layout are documented in
[build-and-packaging.md](../engineering/build-and-packaging.md).

| Platform | Prepare ffmpeg | Build the addon |
|---|---|---|
| Windows | `npm run fetch:ffmpeg` | `npm run build:native:compositor` |
| macOS | `npm run fetch:ffmpeg:mac` | `npm run build:native:compositor:mac` |
| Linux | `npm run fetch:ffmpeg:sdk` | `npm run build:native:compositor:linux` |

The scripts build `compositor-view-napi`, install `compositor_view.node`, and stage
the platform's required ffmpeg runtime libraries under
`electron/native/bin/<platform>-<arch>/` for packaging. A normal `npm run dev` does
not rebuild this native artifact.

[`crates/poc-d3d/`](../../crates/poc-d3d) remains a Windows-only benchmark/demo
consumer of the library. It is not the production owner and is not packaged. Keep
performance measurements and historical alternatives in
[rendering-performance.md](../engineering/rendering-performance.md), not in the
runtime architecture contract above.

## Boundaries

- H.264 and H.265 are the supported MP4 codecs. VP9 is not a runtime export option.
- Linux MP4 encoding currently crosses a GPU-to-CPU readback boundary and uses
  software encoding; the Windows/macOS zero-copy candidates do not describe Linux.
- macOS can fall back to software decode/encode, but composition still requires
  Metal; it has no WARP/lavapipe-style software renderer.
- Shared scene and geometry code reduce cross-platform drift but do not prove shader
  or hardware equivalence. Native changes still require the platform-specific tests
  and manual checks called out in the repository testing guidance.
