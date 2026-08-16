# macOS Retina Capture Resolution Fix

Status: Implemented in code; manual macOS hardware validation pending.

## Decision

Retain OpenScreen's existing `3840x2160` capture ceiling. Capture Retina displays at their
backing-pixel resolution when that resolution fits within the ceiling, and downscale larger
sources uniformly so their aspect ratio is preserved.

For the affected 15-inch MacBook Air:

- Display backing resolution: `2880x1864`
- macOS logical "Looks like" size at 2x: `1440x932`
- Pre-fix raw recording: `1440x932`
- Expected post-fix raw recording (hardware validation pending): `2880x1864`

## Implementation Outcome

The implementation described below is now in code and covered by Swift, TypeScript, and Rust
tests. The historical analysis, implementation plan, and acceptance criteria remain as design
context; no hardware-only criterion is marked passed, and the manual macOS run is still required.

- macOS capture now derives Retina backing pixels from ScreenCaptureKit point geometry and scale
  (with the macOS 13 display/window fallbacks described below), then applies one proportional fit
  inside `3840x2160` and floors both output axes to positive even values. A `2880x1864` source is
  retained, while an above-limit `5120x1440` source becomes `3840x1080` rather than being distorted.
- The helper reports point bounds, uncapped source pixels, applied scale, and final capture pixels
  after the first frame is appended. Electron validates that geometry before accepting startup.
  The start/stop lifecycle is validated by automated process tests covering success, early exit,
  malformed or late events, timeouts, failed cleanup, and stale-process races; this is not a claim
  that the real-hardware procedure below has run.
- Asset dimension backfill, asset mutations, project saves, and project lifecycle transitions are
  serialized and generation-safe, so a completed metadata probe or project operation cannot be
  overwritten by a concurrent stale save.
- Export hydrates valid source dimensions for every visible asset before constructing clips or the
  scene. Missing geometry is probed into an export-only document clone; if it remains unavailable,
  export fails closed instead of constructing a scene or silently falling back to `1920x1080`.
- MP4 export requires explicit positive even dimensions, with an `8192` maximum per axis and a
  `35,389,440`-pixel area limit. The native contract also accepts an optional bitrate override in
  bits per second (up to `200,000,000`); omission retains the area-based native fallback with a
  `2 Mbps` floor.

## Conclusion

The quarter-resolution result was a bug, not intended behavior. Before this implementation, the
macOS helper used `CGDisplayPixelsWide` and `CGDisplayPixelsHigh` in
`electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`.
In the affected scaled display mode, those calls resolve to the logical `1440x932` desktop rather
than the `2880x1864` backing surface.

The helper then used those values for both:

- `SCStreamConfiguration.width` and `height`
- `AVVideoWidthKey` and `AVVideoHeightKey`

The loss therefore happened before the editor or exporter saw the video. Halving both axes left
one quarter of the available pixels, and no export setting can recover that missing detail.

The source picker's `320x180` thumbnail request is presentation-only and is not involved in the
recording dimensions.

## Intended Behavior

- Raw macOS capture uses backing pixels, not logical display points.
- Sources at or below the 4K ceiling are not downscaled.
- Sources above the ceiling are fit inside `3840x2160` with one common scale factor.
- Cursor and source bounds remain in macOS points because cursor normalization operates in point
  space.
- The default export tier remains `1080p`.
- The `Source` export tier remains the way to request source-sized output.
- A pixel-exact `2880x1864` export requires both `Original` aspect ratio and `Source` resolution.
  Keeping the default `16:9` composition is an intentional edit and produces a different frame
  shape.

## Root Causes And Related Findings (Historical)

### 1. Incorrect display pixel query

`ScreenCaptureRecorder.makeCaptureTarget` treats `CGDisplayPixelsWide/High` as the authoritative
ScreenCaptureKit output size. That is not reliable for a Retina display running a scaled mode.

ScreenCaptureKit exposes the correct relationship directly on macOS 14 and newer:

- `SCContentFilter.contentRect`: source geometry in screen points
- `SCContentFilter.pointPixelScale`: points-to-pixels scale

The backing-pixel dimensions are `contentRect.size * pointPixelScale`.

### 2. Aspect ratio can be changed by the 4K cap

`clampCaptureDimension` caps width and height independently. This distorts any source where only
one axis exceeds its limit. For example, `5120x1440` currently becomes `3840x1440`; it should
become `3840x1080`.

### 3. Native dimensions are emitted and discarded

The helper's `recording-started` event already includes `width` and `height`, but
`src/lib/nativeMacRecording.ts` omits them from the TypeScript event type and the main process only
retains `captureBounds`. This makes incorrect dimensions silent and harder to diagnose.

### 4. Asset metadata backfill can lose a successful probe

`src/lib/ai-edition/store/useTimeline.ts` marks an asset as probed before awaiting the metadata
probe. Any concurrent document update cancels the effect, discards the result, and prevents a
retry. A Source export can then omit explicit dimensions and fall back to the native exporter's
`1920x1080` default.

### 5. The native exporter ignores the requested bitrate

`calculateMp4ExportSettings` computes up to `80 Mbps` for Source output, but `ExportDialog` passes
only width, height, frame rate, and codec. The Rust exporters instead use approximately `8 Mbps`
per `1920x1080` pixels. This does not cause the quarter-resolution capture, but it can make a
correctly sized high-resolution export look softer than intended.

## Implementation Plan

### 1. Make native capture geometry Retina-aware

Update `ScreenCaptureRecorder.makeCaptureTarget` to construct the `SCContentFilter` before
calculating output dimensions.

On macOS 14 and newer:

- Read the source point rectangle from `filter.contentRect`.
- Read the backing scale from `filter.pointPixelScale`.
- Calculate uncapped pixels by multiplying width and height by that scale.
- Round deliberately rather than truncating before multiplication.

On macOS 13:

- For display capture, use the current `CGDisplayMode.pixelWidth` and `pixelHeight`, accounting for
  the display's current orientation.
- For window capture, multiply the point-space window frame by the selected display's floating
  pixel-to-point ratio.
- Select the window's display by its center or largest intersection, not the first intersecting
  display returned by ScreenCaptureKit.

Keep `captureFrame` in point space on all versions. Do not apply the backing scale to cursor
coordinates or Electron display bounds.

For independent-window capture, request `SCCaptureResolutionType.best` where the API is available.
Do not apply that setting to full-display capture because Apple's `.best` policy only applies to
independent windows.

### 2. Replace independent clamping with aspect-preserving fitting

Calculate one scale factor:

```text
scale = min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
width = evenFloor(sourceWidth * scale)
height = evenFloor(sourceHeight * scale)
```

The result must be at least two pixels on each axis and even for H.264 4:2:0 encoding.

Expected examples:

| Source pixels | Output pixels |
| --- | --- |
| `2880x1864` | `2880x1864` |
| `3840x2160` | `3840x2160` |
| `5120x2880` | `3840x2160` |
| `5120x1440` | `3840x1080` |
| `2160x3840` | approximately `1214x2160` |

Use the fitted dimensions for both `SCStreamConfiguration` and `AVAssetWriter` so the captured
pixel buffer and encoded track always agree.

### 3. Preserve capture-dimension observability

Add `width` and `height` to `NativeMacHelperRecordingStartedEvent`.

Change the main-process start wait to retain the complete `recording-started` event and:

- Log source point bounds, uncapped source pixels, scale, and final output pixels.
- Include final width and height in `NativeMacRecordingStartResult` for diagnostics.
- Validate that both dimensions are finite, positive, and even.

Do not expand the persisted recording-session schema unless the metadata probe hardening below
proves insufficient. The final media file remains authoritative for imported and external assets.

### 4. Make editor dimension probing race-safe

Update the dimension backfill in `useTimeline` to distinguish:

- assets currently in flight
- assets successfully persisted
- assets that failed during this editor session

Do not mark an asset complete before the probe and save both succeed. Do not discard a result
merely because an unrelated document update changed the document object. Before saving, re-read
the current store and verify that the project ID still matches the project that started the probe.

Add a defensive Source-export check:

- Fixed `720p` and `1080p` tiers should always resolve concrete output dimensions from the chosen
  aspect ratio.
- `Source` must wait for valid source metadata or show a clear error; it must not silently omit
  dimensions and fall back to `1920x1080`.

### 5. Wire the existing export bitrate policy separately

Keep this as a separate commit from capture geometry so the native-resolution fix remains easy to
review and bisect.

- Add optional `bitrate` to `CompositorExportParams` and the N-API `ExportParamsInput`.
- Pass `outDims.bitrate` from `ExportDialog` for MP4 exports.
- Add bitrate to the macOS, Windows, and Linux Rust `ExportParams` structures because the export
  contract is shared across platforms.
- Use the caller's bitrate when supplied.
- Retain the current area-based formula as the fallback for callers that omit bitrate.

## Automated Tests

### Swift geometry tests

Add a SwiftPM test target in `electron/native/screencapturekit/Package.swift`. Keep the platform API
lookup in the recorder, but place the pure conversion and fitting arithmetic in a testable helper.

Cover at least:

- `1440x932` points at 2x becomes `2880x1864` pixels.
- A 1x external display remains unchanged.
- A source below both caps remains unchanged.
- `5120x2880` becomes `3840x2160`.
- `5120x1440` becomes `3840x1080` without distortion.
- Portrait sources fit within the same landscape limits without becoming square.
- Fractional window point sizes are multiplied before rounding.
- Every output dimension is positive and even.
- Window display selection prefers the center or largest intersection on mixed-DPI setups.

### TypeScript tests

Add or extend tests for:

- Parsing and retaining `recording-started.width` and `height`.
- A delayed metadata probe surviving an unrelated document save.
- A failed probe not spinning continuously.
- Source export refusing to use implicit native defaults when dimensions are unknown.
- A `2880x1864` Original + Source export passing `2880x1864` to the native exporter.
- Fixed 1080p export continuing to pass `1920x1080` for a 16:9 project.
- The requested export bitrate reaching the native contract.

### Verification commands

```sh
swift test --package-path electron/native/screencapturekit
npm run build:native:mac
npx vitest --run src/lib/ai-edition/store/useTimeline.test.ts
npx vitest --run src/lib/exporter/mp4ExportSettings.test.ts
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npm run lint
```

Run `npm run test` once at the end if the implementation includes the cross-platform export
contract change.

## Manual macOS Validation

Use a freshly rebuilt helper. `npm run dev` does not rebuild native helpers automatically, so
confirm the running binary contains the new implementation before trusting a result.

On the built-in 2x Retina display:

1. Record the entire display with no crop or display-mode change during capture.
2. Inspect the raw recording before opening or exporting it:

   ```sh
   ffprobe -v error -select_streams v:0 \
     -show_entries stream=width,height -of csv=p=0 recording.mp4
   ```

3. Confirm the raw track is `2880,1864`, not `1440,932`.
4. Export with the default 16:9 + 1080p settings and confirm `1920,1080` remains intentional.
5. Select Original aspect ratio + Source resolution and confirm the export is `2880,1864`.
6. Extract a frame from the Source export and inspect text and one-pixel edges at 100% zoom.

Also validate where hardware is available:

- A 1x external display.
- A scaled Retina mode other than the default.
- A source above the 4K ceiling.
- Portrait and ultrawide displays.
- A window entirely on a 1x display and entirely on a 2x display.
- A window spanning displays with different scale factors.

Add the Retina and `ffprobe` assertions to
`technical-documentation/testing/manual-e2e-checklist.md` so future macOS release checks cannot
pass by judging only the preview.

## Acceptance Criteria

- A `1440x932` point display at 2x records as `2880x1864` backing pixels.
- Raw capture dimensions match the helper's `recording-started` dimensions.
- Sources below the 4K ceiling are never downscaled by capture.
- Sources above the ceiling retain their aspect ratio and fit within `3840x2160`.
- Width and height are always valid even values.
- Cursor normalization remains correct because point-space bounds are unchanged.
- Original + Source exports retain the recording's source dimensions.
- Source export never silently falls back to `1920x1080` because metadata is missing.
- Default 1080p and default 16:9 behavior remain unchanged.
- The packaged macOS application contains and runs the rebuilt helper.

## Likely Files

- `electron/native/screencapturekit/Package.swift`
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`
- `electron/native/screencapturekit/Tests/OpenScreenScreenCaptureKitHelperTests/*`
- `src/lib/nativeMacRecording.ts`
- `electron/ipc/handlers.ts`
- `src/lib/ai-edition/store/useTimeline.ts`
- `src/lib/ai-edition/store/useTimeline.test.ts`
- `src/components/ai-edition/ExportDialog.tsx`
- `src/native/contracts.ts`
- `crates/compositor-view-napi/src/lib.rs`
- `crates/compositor/src/pipeline_macos.rs`
- `crates/compositor/src/pipeline_windows.rs`
- `crates/compositor/src/pipeline_linux.rs`
- `technical-documentation/testing/manual-e2e-checklist.md`

## Non-Goals

- Removing the 4K capture ceiling.
- Changing the default export tier from 1080p to Source.
- Changing the default project aspect ratio from 16:9 to Original.
- Converting cursor coordinates or capture bounds from points to pixels.
- Redesigning source selection or using thumbnail dimensions for capture sizing.
