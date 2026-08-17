import XCTest

@testable import OpenScreenScreenCaptureKitHelper

final class CaptureCommandLoopTests: XCTestCase {
	func testStopCommandAndEOFUseTheSameFinalizationPath() async {
		for lines in [["stop"], []] {
			var pendingLines = lines
			var finalizationCount = 0
			var exitCodes: [Int32] = []

			await CaptureCommandLoop.run(
				nextLine: { pendingLines.isEmpty ? nil : pendingLines.removeFirst() },
				pause: {},
				resume: {},
				stopAndFinalize: {
					await Task.yield()
					finalizationCount += 1
					return .finalized
				},
				terminate: { exitCodes.append($0.exitCode) }
			)

			XCTAssertEqual(finalizationCount, 1)
			XCTAssertEqual(exitCodes, [0])
		}
	}

	func testCommandLoopProcessesControlsBeforeFinalizingOnEOF() async {
		var pendingLines = [" pause ", "unknown", "resume"]
		var actions: [String] = []

		await CaptureCommandLoop.run(
			nextLine: { pendingLines.isEmpty ? nil : pendingLines.removeFirst() },
			pause: { actions.append("pause") },
			resume: { actions.append("resume") },
			stopAndFinalize: {
				actions.append("stop")
				return .finalized
			},
			terminate: { actions.append("exit:\($0.exitCode)") }
		)

		XCTAssertEqual(actions, ["pause", "resume", "stop", "exit:0"])
	}

	func testConcurrentTerminationRequestsExitOnlyOnce() {
		var exitCodes: [Int32] = []
		let coordinator = CaptureProcessExitCoordinator { exitCodes.append($0) }

		DispatchQueue.concurrentPerform(iterations: 10) { index in
			coordinator.terminate(after: index.isMultiple(of: 2) ? .finalized : .failed)
		}

		XCTAssertEqual(exitCodes.count, 1)
	}
}
