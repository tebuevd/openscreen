import XCTest

@testable import OpenScreenScreenCaptureKitHelper

final class CaptureCommandLoopTests: XCTestCase {
	func testStopCommandAndEOFUseTheSameFinalizationPath() async {
		for lines in [["stop"], []] {
			var pendingLines = lines
			var finalizationCount = 0

			await CaptureCommandLoop.run(
				nextLine: { pendingLines.isEmpty ? nil : pendingLines.removeFirst() },
				pause: {},
				resume: {},
				stopAndFinalize: {
					await Task.yield()
					finalizationCount += 1
				}
			)

			XCTAssertEqual(finalizationCount, 1)
		}
	}

	func testCommandLoopProcessesControlsBeforeFinalizingOnEOF() async {
		var pendingLines = [" pause ", "unknown", "resume"]
		var actions: [String] = []

		await CaptureCommandLoop.run(
			nextLine: { pendingLines.isEmpty ? nil : pendingLines.removeFirst() },
			pause: { actions.append("pause") },
			resume: { actions.append("resume") },
			stopAndFinalize: { actions.append("stop") }
		)

		XCTAssertEqual(actions, ["pause", "resume", "stop"])
	}
}
