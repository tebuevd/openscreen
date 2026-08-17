enum HelperErrorCode: String {
	case captureStoppedWithError = "capture-stopped-with-error"
	case writerFailedDuringCapture = "writer-failed-during-capture"
	case writerFailed = "writer-failed"
	case helperError = "helper-error"

	var isTerminal: Bool {
		self != .captureStoppedWithError
	}
}

func helperErrorPayload(code: HelperErrorCode, message: String) -> [String: Any] {
	[
		"event": "error",
		"code": code.rawValue,
		"message": message,
		"terminal": code.isTerminal,
	]
}

enum CaptureFailureFinalization {
	static func run(
		message: String,
		report: (HelperErrorCode, String) -> Void,
		finalize: () async -> Void
	) async {
		report(.captureStoppedWithError, message)
		await finalize()
	}
}
