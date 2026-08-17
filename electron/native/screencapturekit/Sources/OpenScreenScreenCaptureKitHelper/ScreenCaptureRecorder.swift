import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct Rectangle: Decodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct RecordingRequest: Decodable {
	struct Source: Decodable {
		let type: String
		let sourceId: String
		let displayId: UInt32?
		let windowId: UInt32?
		let bounds: Rectangle?
	}

	struct Video: Decodable {
		let fps: Int
		let width: Int
		let height: Int
		let bitrate: Int?
		let hideSystemCursor: Bool
	}

	struct Audio: Decodable {
		struct SystemAudio: Decodable {
			let enabled: Bool
		}

		struct Microphone: Decodable {
			let enabled: Bool
			let deviceId: String?
			let deviceName: String?
			let gain: Double
		}

		let system: SystemAudio
		let microphone: Microphone
	}

	struct Webcam: Decodable {
		let enabled: Bool
		let deviceId: String?
		let deviceName: String?
		let width: Int
		let height: Int
		let fps: Int
	}

	struct Cursor: Decodable {
		let mode: String
	}

	struct Outputs: Decodable {
		let screenPath: String
		let manifestPath: String?
	}

	let schemaVersion: Int?
	let recordingId: Int?
	let source: Source
	let video: Video
	let audio: Audio
	let webcam: Webcam
	let cursor: Cursor
	let outputs: Outputs
}

enum HelperError: Error, CustomStringConvertible {
	case invalidArguments
	case unsupportedMacOS
	case unsupportedFeature(String)
	case sourceNotFound(String)
	case invalidSourceType(String)
	case permissionDenied(String)
	case writerSetupFailed(String)
	case invalidCaptureGeometry(String)

	var description: String {
		switch self {
		case .invalidArguments:
			return "Expected one JSON recording request argument."
		case .unsupportedMacOS:
			return "ScreenCaptureKit recording requires macOS 13 or newer."
		case .unsupportedFeature(let message):
			return message
		case .sourceNotFound(let message):
			return message
		case .invalidSourceType(let sourceType):
			return "Unsupported source type: \(sourceType)."
		case .permissionDenied(let message):
			return message
		case .writerSetupFailed(let message):
			return message
		case .invalidCaptureGeometry(let message):
			return "Invalid capture geometry: \(message)"
		}
	}
}

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func emitError(code: HelperErrorCode, message: String) {
	emit(helperErrorPayload(code: code, message: message))
}

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		let sourcePixelSize: CGSize
		let scale: Double
		let sourcePointGeometry: SourcePointGeometry
		let capturesIndependentWindow: Bool
		// Global frame (points, top-left origin) of the captured region. Used by the
		// renderer to normalize cursor positions into the captured window's space.
		let captureFrame: CGRect
	}

	private let request: RecordingRequest
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	// One AAC track, never one per source: the editor preview is an HTML5 <video>, which plays
	// audio track 0 and nothing else. See AudioTrackMixer.
	private var audioInput: AVAssetWriterInput?
	private var audioMixer: AudioTrackMixer?
	private var didStartWriting = false
	private var didEmitRecordingStarted = false
	private var didReportWriterFailure = false
	private var isStopping = false
	private var didFinishStopping = false
	private var stopWaiters: [CheckedContinuation<Void, Never>] = []
	private var isPaused = false
	private var pauseStartedAt: CMTime?
	private var totalPausedDuration = CMTime.zero
	private var nativeMicrophoneEnabled = false
	private var outputWidth = 1920
	private var outputHeight = 1080
	private var sourcePixelSize = CGSize(width: 1920, height: 1080)
	private var captureScale = 1.0
	private var sourcePointGeometry = SourcePointGeometry(
		contentRectPoints: CGRect(x: 0, y: 0, width: 1920, height: 1080),
		pixelsPerPoint: 1,
		method: .screenCaptureKitContentRect
	)
	private var captureFrame = CGRect.zero
	private let microphoneOutputTypeRawValue = 2
	private let hostClock = CMClockGetHostTimeClock()

	init(request: RecordingRequest) {
		self.request = request
	}

	func start() async throws {
		try ensureRequestedPermissions()

		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: true
		)
		let target = try makeCaptureTarget(from: content)
		outputWidth = target.width
		outputHeight = target.height
		sourcePixelSize = target.sourcePixelSize
		captureScale = target.scale
		sourcePointGeometry = target.sourcePointGeometry
		captureFrame = target.captureFrame
		let configuration = makeStreamConfiguration(for: target)
		let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		if request.audio.system.enabled {
			try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		}
		if nativeMicrophoneEnabled {
			guard let microphoneOutputType = SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) else {
				throw HelperError.unsupportedFeature(
					"Native microphone capture requires a macOS version with ScreenCaptureKit microphone output."
				)
			}
			try stream.addStreamOutput(self, type: microphoneOutputType, sampleHandlerQueue: sampleQueue)
		}
		try setupWriter()

		self.stream = stream
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		try await stream.startCapture()
	}

	func stop() async {
		let shouldStop = stateQueue.sync {
			if isStopping {
				return false
			}
			isStopping = true
			return true
		}
		if !shouldStop {
			await waitForStopCompletion()
			return
		}

		do {
			try await stream?.stopCapture()
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}

		await finishWriter()
		completeStop()
	}

	private func waitForStopCompletion() async {
		await withCheckedContinuation { continuation in
			let shouldResume = stateQueue.sync {
				if didFinishStopping {
					return true
				}
				stopWaiters.append(continuation)
				return false
			}
			if shouldResume {
				continuation.resume()
			}
		}
	}

	private func completeStop() {
		let waiters = stateQueue.sync {
			didFinishStopping = true
			let waiters = stopWaiters
			stopWaiters.removeAll()
			return waiters
		}
		for waiter in waiters {
			waiter.resume()
		}
	}

	func pause() {
		let didPause = stateQueue.sync {
			if isStopping || isPaused {
				return false
			}

			isPaused = true
			pauseStartedAt = CMClockGetTime(hostClock)
			return true
		}

		if didPause {
			emit([
				"event": "recording-paused",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func resume() {
		let didResume = stateQueue.sync {
			if isStopping || !isPaused {
				return false
			}

			if let pauseStartedAt {
				let now = CMClockGetTime(hostClock)
				totalPausedDuration = CMTimeAdd(
					totalPausedDuration,
					CMTimeSubtract(now, pauseStartedAt)
				)
			}
			isPaused = false
			pauseStartedAt = nil
			return true
		}

		if didResume {
			emit([
				"event": "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		Task {
			await CaptureFailureFinalization.run(
				message: "\(error)",
				report: { code, message in emitError(code: code, message: message) },
				finalize: { await self.stop() }
			)
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}

		if type == .audio {
			audioMixer?.ingest(sampleBuffer, from: .system)
			return
		}

		if type.rawValue == microphoneOutputTypeRawValue {
			audioMixer?.ingest(sampleBuffer, from: .microphone)
			return
		}

		guard type == .screen else {
			return
		}
		guard isCompleteFrame(sampleBuffer) else {
			return
		}
		guard let videoInput, let writer else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			didStartWriting = true
			audioMixer?.beginTimeline(at: presentationTime)
		}

		if videoInput.isReadyForMoreMediaData {
			let appended = videoInput.append(sampleBuffer)
			if appended, !didEmitRecordingStarted {
				didEmitRecordingStarted = true
				emit([
					"event": "recording-started",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"width": outputWidth,
					"height": outputHeight,
					"sourcePixelWidth": Double(sourcePixelSize.width),
					"sourcePixelHeight": Double(sourcePixelSize.height),
					"scale": captureScale,
					"sourceGeometryMethod": sourcePointGeometry.method.rawValue,
					"sourceContentRectPoints": rectanglePayload(sourcePointGeometry.contentRectPoints),
					"sourcePixelsPerPoint": Double(sourcePointGeometry.pixelsPerPoint),
					"captureBounds": rectanglePayload(captureFrame),
				])
			} else if !appended {
				reportWriterFailure("video append")
			}
		}
	}

	/// A failed AVAssetWriter keeps accepting appends and keeps answering false, so
	/// a recorder that discards that Bool records nothing while the HUD counts on.
	/// That is how a two-minute take was already lost by its fourth second and only
	/// said so at finishWriting(). The Windows helper checks every WriteSample
	/// HRESULT and escalates; this is the macOS half of the same contract -- report
	/// once, at the append that actually failed, carrying the live writer.error.
	///
	/// Deliberately not the code finishWriter() emits. Both errors are terminal, but
	/// this one records when the writer died while `writer-failed` records the final
	/// stop outcome. Keeping both codes preserves that timing without hiding either
	/// failure behind this one-shot guard.
	private func reportWriterFailure(_ stage: String) {
		guard !didReportWriterFailure, let writer else {
			return
		}
		didReportWriterFailure = true
		emitError(
			code: .writerFailedDuringCapture,
			message: "\(stage): "
				+ (writer.error.map { "\($0)" }
					?? "AVAssetWriter status \(writer.status.rawValue)"),
		)
	}

	private func ensureRequestedPermissions() throws {
		if !CGPreflightScreenCaptureAccess() {
			let granted = CGRequestScreenCaptureAccess()
			if !granted {
				throw HelperError.permissionDenied("Screen recording permission is required for ScreenCaptureKit capture.")
			}
		}

		if request.audio.microphone.enabled {
			switch AVCaptureDevice.authorizationStatus(for: .audio) {
			case .authorized:
				break
			case .notDetermined:
				let semaphore = DispatchSemaphore(value: 0)
				AVCaptureDevice.requestAccess(for: .audio) { _ in
					semaphore.signal()
				}
				let waitResult = semaphore.wait(timeout: .now() + 30)
				if waitResult == .timedOut || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
					throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
				}
			default:
				throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
			}
		}
	}

	private func rectanglePayload(_ rectangle: CGRect) -> [String: Double] {
		return [
			"x": CaptureGeometry.jsonSafeNumber(rectangle.origin.x),
			"y": CaptureGeometry.jsonSafeNumber(rectangle.origin.y),
			"width": CaptureGeometry.jsonSafeNumber(rectangle.size.width),
			"height": CaptureGeometry.jsonSafeNumber(rectangle.size.height),
		]
	}

	private func makeCaptureTarget(from content: SCShareableContent) throws -> CaptureTarget {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let filter = SCContentFilter(display: display, excludingWindows: [])
			let rawSourceSize: CGSize
			let sourceContentRectPoints: CGRect
			let sourcePixelsPerPoint: CGFloat
			let sourceGeometryMethod: SourceGeometryMethod
			if #available(macOS 14.0, *) {
				sourceContentRectPoints = filter.contentRect
				sourcePixelsPerPoint = CGFloat(filter.pointPixelScale)
				sourceGeometryMethod = .screenCaptureKitContentRect
				rawSourceSize = CaptureGeometry.pixelSize(
					for: sourceContentRectPoints.size,
					pointPixelScale: sourcePixelsPerPoint
				)
			} else {
				sourceContentRectPoints = display.frame
				sourceGeometryMethod = .displayModeFallback
				guard let displayPixelSize = Self.displayPixelSize(for: display.displayID) else {
					throw HelperError.invalidCaptureGeometry(
						"Unable to read the selected display's backing pixel dimensions."
					)
				}
				rawSourceSize = displayPixelSize
				guard let derivedScale = CaptureGeometry.derivedPixelsPerPoint(
					pointSize: sourceContentRectPoints.size,
					pixelSize: rawSourceSize
				) else {
					throw HelperError.invalidCaptureGeometry(
						"Unable to derive the selected display's backing pixels-per-point scale."
					)
				}
				sourcePixelsPerPoint = derivedScale
			}
			guard let sourceSize = CaptureGeometry.validatedPixelSize(rawSourceSize) else {
				throw HelperError.invalidCaptureGeometry(
					"Display source pixels must round to positive safe integer dimensions."
				)
			}
			guard let sourcePointGeometry = CaptureGeometry.sourcePointGeometry(
				contentRectPoints: sourceContentRectPoints,
				pixelsPerPoint: sourcePixelsPerPoint,
				sourcePixelSize: sourceSize,
				method: sourceGeometryMethod
			) else {
				throw HelperError.invalidCaptureGeometry(
					"Display point bounds, backing scale, and source pixels are inconsistent."
				)
			}
			guard let dimensions = CaptureGeometry.fittedDimensions(for: sourceSize) else {
				throw HelperError.invalidCaptureGeometry("Unable to fit the display source pixels.")
			}
			return CaptureTarget(
				filter: filter,
				width: dimensions.width,
				height: dimensions.height,
				sourcePixelSize: sourceSize,
				scale: dimensions.scale,
				sourcePointGeometry: sourcePointGeometry,
				capturesIndependentWindow: false,
				captureFrame: display.frame
			)
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			let filter = SCContentFilter(desktopIndependentWindow: window)
			let rawSourceSize: CGSize
			let sourceContentRectPoints: CGRect
			let sourcePixelsPerPoint: CGFloat
			let sourceGeometryMethod: SourceGeometryMethod
			if #available(macOS 14.0, *) {
				sourceContentRectPoints = filter.contentRect
				sourcePixelsPerPoint = CGFloat(filter.pointPixelScale)
				sourceGeometryMethod = .screenCaptureKitContentRect
				rawSourceSize = CaptureGeometry.pixelSize(
					for: sourceContentRectPoints.size,
					pointPixelScale: sourcePixelsPerPoint
				)
			} else {
				let displayIndex = CaptureGeometry.displayIndex(
					for: window.frame,
					displayFrames: content.displays.map(\.frame)
				)
				let displayId = displayIndex.map { content.displays[$0].displayID } ?? CGMainDisplayID()
				sourceContentRectPoints = window.frame
				guard let displayScale = Self.pointPixelScale(for: displayId) else {
					throw HelperError.invalidCaptureGeometry(
						"Unable to read the selected window display's backing pixels-per-point scale."
					)
				}
				sourcePixelsPerPoint = displayScale
				sourceGeometryMethod = .displayModeFallback
				rawSourceSize = CaptureGeometry.pixelSize(
					for: sourceContentRectPoints.size,
					pointPixelScale: sourcePixelsPerPoint
				)
			}
			guard let sourceSize = CaptureGeometry.validatedPixelSize(rawSourceSize) else {
				throw HelperError.invalidCaptureGeometry(
					"Window source pixels must round to positive safe integer dimensions."
				)
			}
			guard let sourcePointGeometry = CaptureGeometry.sourcePointGeometry(
				contentRectPoints: sourceContentRectPoints,
				pixelsPerPoint: sourcePixelsPerPoint,
				sourcePixelSize: sourceSize,
				method: sourceGeometryMethod
			) else {
				throw HelperError.invalidCaptureGeometry(
					"Window point bounds, backing scale, and source pixels are inconsistent."
				)
			}
			guard let dimensions = CaptureGeometry.fittedDimensions(for: sourceSize) else {
				throw HelperError.invalidCaptureGeometry("Unable to fit the window source pixels.")
			}
			return CaptureTarget(
				filter: filter,
				width: dimensions.width,
				height: dimensions.height,
				sourcePixelSize: sourceSize,
				scale: dimensions.scale,
				sourcePointGeometry: sourcePointGeometry,
				capturesIndependentWindow: true,
				captureFrame: window.frame
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration(for target: CaptureTarget) -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = outputWidth
		configuration.height = outputHeight
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
		configuration.queueDepth = 6
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio = request.audio.system.enabled
		if target.capturesIndependentWindow {
			if #available(macOS 14.0, *) {
				configuration.captureResolution = .best
			}
		}

		if request.audio.microphone.enabled {
			guard supportsNativeMicrophoneCapture(streamConfig: configuration) else {
				nativeMicrophoneEnabled = false
				emit([
					"event": "warning",
					"code": "microphone-unavailable",
					"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
				])
				return configuration
			}
			nativeMicrophoneEnabled = true
			configuration.capturesAudio = true
			configuration.setValue(true, forKey: "captureMicrophone")
			if let deviceId = resolveMicrophoneCaptureDeviceID() {
				configuration.setValue(deviceId, forKey: "microphoneCaptureDeviceID")
			}
		} else {
			nativeMicrophoneEnabled = false
		}

		return configuration
	}

	private func setupWriter() throws {
		let outputUrl = URL(fileURLWithPath: request.outputs.screenPath)
		try? FileManager.default.removeItem(at: outputUrl)
		try FileManager.default.createDirectory(
			at: outputUrl.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
		// Costs nothing on a clean stop -- finishWriting() still writes a normal
		// moov -- and is the difference between a readable file and a total loss
		// when the helper dies before reaching it. The Windows helper gets the
		// same property from MFCreateFMPEG4MediaSink; see issues #252/#292/#327.
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outputWidth,
			AVVideoHeightKey: outputHeight,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: request.video.bitrate ?? 18_000_000,
				AVVideoExpectedSourceFrameRateKey: request.video.fps,
				// Without this the encoder defaults to B-frames, and a reordered
				// stream needs a composition offset per sample. AVAssetWriter emits
				// those in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines
				// the field as UNSIGNED -- so a negative offset goes out as
				// 0xFFFFFFF6 and the fragment writer refuses the fragment it is
				// about to emit. That refusal is -11800 / -16341, raised from the
				// single site in MediaToolbox that writes moof/traf/trun, which is
				// why it appears if and only if movieFragmentInterval is set and
				// lands exactly on a fragment boundary.
				//
				// Turning reordering off makes every offset zero and PTS == DTS, so
				// the fragment stays representable. A screen recorder gives up
				// nothing for it: B-frames buy compression on lookahead-friendly
				// content and cost encode latency, which is the wrong trade for
				// real-time capture.
				//
				// Measured on macOS 26.5 / M1, 1080p with system audio. How reliably
				// the bug bites scales with append rate, so quote the rate with the
				// result: at ~57 fps, the rate the app actually drives, reordering
				// on dies at 13.0s while reordering off stops clean at 31.6s; at
				// 30 fps it is intermittent, dying at 1.0s and 2.0s but once
				// surviving 22.2s. That intermittency is why the byte-level evidence
				// leads here and the run counts only corroborate: the offsets are
				// out of spec in every fragmented file whether or not that
				// particular run happened to die. Reordering off is 3/3 clean across
				// both rates, and a SIGKILL at 25s still leaves 27 readable `moof`.
				AVVideoAllowFrameReorderingKey: false,
			],
		]
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add H.264 video input to AVAssetWriter.")
		}

		writer.add(input)
		self.writer = writer
		self.videoInput = input

		// A single mixed AAC track at the bitrate Windows encodes its own mixed track with
		// (24 000 B/s), so the two platforms produce comparable files.
		if request.audio.system.enabled || nativeMicrophoneEnabled {
			let input = try addAudioInput(to: writer, bitRate: 192_000)
			audioInput = input
			audioMixer = AudioTrackMixer(
				input: input,
				includesSystemAudio: request.audio.system.enabled,
				includesMicrophone: nativeMicrophoneEnabled,
				microphoneGain: request.audio.microphone.gain
			)
		}
	}

	private func finishWriter() async {
		guard let writer, didStartWriting else {
			return
		}

		// Capture has stopped, so nothing is in flight on the sample queue any more; hopping
		// onto it once is what makes the mixer's final flush safe without a lock.
		sampleQueue.sync {
			audioMixer?.finish()
		}

		videoInput?.markAsFinished()
		audioInput?.markAsFinished()

		await withCheckedContinuation { continuation in
			writer.finishWriting {
				continuation.resume()
			}
		}

		if writer.status == .completed {
			emit([
				"event": "recording-stopped",
				"screenPath": request.outputs.screenPath,
			])
		} else {
			emitError(
				code: .writerFailed,
				message: writer.error.map { "\($0)" } ?? "AVAssetWriter failed with status \(writer.status.rawValue)."
			)
		}
	}

	private func addAudioInput(to writer: AVAssetWriter, bitRate: Int) throws -> AVAssetWriterInput {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add AAC audio input to AVAssetWriter.")
		}

		writer.add(input)
		return input
	}

	private func currentPauseState() -> (paused: Bool, offset: CMTime) {
		stateQueue.sync {
			(isPaused, totalPausedDuration)
		}
	}

	private func retimedSampleBuffer(_ sampleBuffer: CMSampleBuffer, subtracting offset: CMTime) -> CMSampleBuffer? {
		if !offset.isValid || offset == .zero {
			return sampleBuffer
		}

		let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
		if sampleCount <= 0 {
			return sampleBuffer
		}

		var timing = Array(repeating: CMSampleTimingInfo(), count: sampleCount)
		let timingStatus = CMSampleBufferGetSampleTimingInfoArray(
			sampleBuffer,
			entryCount: sampleCount,
			arrayToFill: &timing,
			entriesNeededOut: nil
		)
		if timingStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to read sample timing info: \(timingStatus).",
			])
			return sampleBuffer
		}

		for index in timing.indices {
			if timing[index].presentationTimeStamp.isValid {
				timing[index].presentationTimeStamp = CMTimeSubtract(
					timing[index].presentationTimeStamp,
					offset
				)
			}
			if timing[index].decodeTimeStamp.isValid {
				timing[index].decodeTimeStamp = CMTimeSubtract(timing[index].decodeTimeStamp, offset)
			}
		}

		var retimedBuffer: CMSampleBuffer?
		let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
			allocator: kCFAllocatorDefault,
			sampleBuffer: sampleBuffer,
			sampleTimingEntryCount: sampleCount,
			sampleTimingArray: &timing,
			sampleBufferOut: &retimedBuffer
		)
		if copyStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to copy sample timing info: \(copyStatus).",
			])
			return sampleBuffer
		}

		return retimedBuffer
	}

	private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
			sampleBuffer,
			createIfNecessary: false
		) as? [[SCStreamFrameInfo: Any]],
			let attachment = attachments.first,
			let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
			let status = SCFrameStatus(rawValue: statusRawValue)
		else {
			return true
		}

		return status == .complete
	}

	private static func displayPixelSize(for displayId: CGDirectDisplayID) -> CGSize? {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return nil
		}

		return CaptureGeometry.displayModePixelSize(
			CGSize(width: mode.pixelWidth, height: mode.pixelHeight),
			rotationDegrees: CGDisplayRotation(displayId)
		)
	}

	private static func pointPixelScale(for displayId: CGDirectDisplayID) -> CGFloat? {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return nil
		}
		return CaptureGeometry.displayModePixelsPerPoint(
			pixelWidth: mode.pixelWidth,
			pointWidth: mode.width
		)
	}

	private func supportsNativeMicrophoneCapture(streamConfig: SCStreamConfiguration) -> Bool {
		streamConfig.responds(to: Selector(("setCaptureMicrophone:"))) &&
			streamConfig.responds(to: Selector(("setMicrophoneCaptureDeviceID:"))) &&
			SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) != nil
	}

	private func resolveMicrophoneCaptureDeviceID() -> String? {
		let devices = AVCaptureDevice.devices(for: .audio)

		if let deviceName = request.audio.microphone.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceName.isEmpty,
			let device = devices.first(where: { $0.localizedName == deviceName })
		{
			return device.uniqueID
		}

		if let deviceId = request.audio.microphone.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceId.isEmpty,
			devices.contains(where: { $0.uniqueID == deviceId })
		{
			return deviceId
		}

		return nil
	}
}

@main
struct OpenScreenScreenCaptureKitHelper {
	static func main() async {
		do {
			guard CommandLine.arguments.count == 2 else {
				throw HelperError.invalidArguments
			}

			guard #available(macOS 13.0, *) else {
				throw HelperError.unsupportedMacOS
			}

			let requestData = Data(CommandLine.arguments[1].utf8)
			let decoder = JSONDecoder()
			let request = try decoder.decode(RecordingRequest.self, from: requestData)
			let recorder = ScreenCaptureRecorder(request: request)

			try await recorder.start()
			let stopTask = Task.detached {
				await CaptureCommandLoop.run(
					nextLine: { readLine() },
					pause: { recorder.pause() },
					resume: { recorder.resume() },
					stopAndFinalize: { await recorder.stop() }
				)
			}

			await stopTask.value
		} catch let error as HelperError {
			emitError(code: .helperError, message: error.description)
			exit(1)
		} catch {
			emitError(code: .helperError, message: "\(error)")
			exit(1)
		}
	}
}
