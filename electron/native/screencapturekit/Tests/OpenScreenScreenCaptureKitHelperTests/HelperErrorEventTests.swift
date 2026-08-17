import XCTest

@testable import OpenScreenScreenCaptureKitHelper

final class HelperErrorEventTests: XCTestCase {
	func testErrorCodesDeclareTerminalityInTheirPayloads() {
		let expectedTerminality: [(HelperErrorCode, Bool)] = [
			(.captureStoppedWithError, false),
			(.writerFailedDuringCapture, true),
			(.writerFailed, true),
			(.helperError, true),
		]

		for (code, isTerminal) in expectedTerminality {
			let payload = helperErrorPayload(code: code, message: "test message")
			XCTAssertEqual(payload["event"] as? String, "error")
			XCTAssertEqual(payload["code"] as? String, code.rawValue)
			XCTAssertEqual(payload["message"] as? String, "test message")
			XCTAssertEqual(payload["terminal"] as? Bool, isTerminal)
		}
	}

	func testCaptureFailureReportsNonterminalDiagnosticBeforeFinalization() async {
		var actions: [String] = []

		await CaptureFailureFinalization.run(
			message: "capture disconnected",
			report: { code, message in
				actions.append("\(code.rawValue):\(code.isTerminal):\(message)")
			},
			finalize: {
				actions.append("finalize")
			}
		)

		XCTAssertEqual(
			actions,
			["capture-stopped-with-error:false:capture disconnected", "finalize"]
		)
	}
}
