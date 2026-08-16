import Foundation

enum CaptureCommandLoop {
	static func run(
		nextLine: () -> String?,
		pause: () -> Void,
		resume: () -> Void,
		stopAndFinalize: () async -> Void
	) async {
		while let line = nextLine() {
			switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
			case "pause":
				pause()
			case "resume":
				resume()
			case "stop":
				await stopAndFinalize()
				return
			default:
				break
			}
		}

		// A closed parent command pipe is equivalent to an explicit stop once capture is active.
		await stopAndFinalize()
	}
}
