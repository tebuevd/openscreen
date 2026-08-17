import Foundation

enum CaptureStopOutcome: Equatable {
	case finalized
	case noRecording
	case failed

	var exitCode: Int32 {
		self == .failed ? 1 : 0
	}
}

final class CaptureProcessExitCoordinator {
	private let lock = NSLock()
	private var didRequestTermination = false
	private let terminateProcess: (Int32) -> Void

	init(terminateProcess: @escaping (Int32) -> Void) {
		self.terminateProcess = terminateProcess
	}

	func terminate(after outcome: CaptureStopOutcome) {
		let shouldTerminate = lock.withLock {
			guard !didRequestTermination else {
				return false
			}
			didRequestTermination = true
			return true
		}
		if shouldTerminate {
			terminateProcess(outcome.exitCode)
		}
	}
}

enum CaptureCommandLoop {
	static func run(
		nextLine: () -> String?,
		pause: () -> Void,
		resume: () -> Void,
		stopAndFinalize: () async -> CaptureStopOutcome,
		terminate: (CaptureStopOutcome) -> Void
	) async {
		while let line = nextLine() {
			switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
			case "pause":
				pause()
			case "resume":
				resume()
			case "stop":
				let outcome = await stopAndFinalize()
				terminate(outcome)
				return
			default:
				break
			}
		}

		// A closed parent command pipe is equivalent to an explicit stop once capture is active.
		let outcome = await stopAndFinalize()
		terminate(outcome)
	}
}
