import CoreGraphics

struct CaptureDimensions: Equatable {
	let width: Int
	let height: Int
	let scale: Double
}

enum CaptureGeometry {
	static let maximumWidth = 3840
	static let maximumHeight = 2160
	static let maximumSafeJSONNumber = 9_007_199_254_740_991.0

	static func pixelSize(for pointSize: CGSize, pointPixelScale: CGFloat) -> CGSize {
		let scale = pointPixelScale.isFinite && pointPixelScale > 0 ? pointPixelScale : 1
		return CGSize(width: pointSize.width * scale, height: pointSize.height * scale)
	}

	static func sanitizedPixelSize(_ sourceSize: CGSize) -> CGSize {
		let width = Double(sourceSize.width)
		let height = Double(sourceSize.height)
		guard width.isFinite, height.isFinite,
			width > 0, height > 0,
			width <= maximumSafeJSONNumber, height <= maximumSafeJSONNumber
		else {
			return CGSize(width: 2, height: 2)
		}
		return sourceSize
	}

	static func jsonSafeNumber(_ value: CGFloat) -> Double {
		let number = Double(value)
		return number.isFinite && abs(number) <= maximumSafeJSONNumber ? number : 0
	}

	static func fittedDimensions(for sourceSize: CGSize) -> CaptureDimensions {
		let sourceSize = sanitizedPixelSize(sourceSize)
		let sourceWidth = Double(sourceSize.width)
		let sourceHeight = Double(sourceSize.height)

		let scale = min(
			1,
			Double(maximumWidth) / sourceWidth,
			Double(maximumHeight) / sourceHeight
		)
		return CaptureDimensions(
			width: positiveEvenFloor(sourceWidth * scale),
			height: positiveEvenFloor(sourceHeight * scale),
			scale: scale
		)
	}

	static func displayIndex(for windowFrame: CGRect, displayFrames: [CGRect]) -> Int? {
		let windowCenter = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
		if let centerDisplay = displayFrames.firstIndex(where: { $0.contains(windowCenter) }) {
			return centerDisplay
		}

		var selectedIndex: Int?
		var largestIntersection: CGFloat = 0
		for (index, displayFrame) in displayFrames.enumerated() {
			let intersection = displayFrame.intersection(windowFrame)
			guard !intersection.isNull, !intersection.isEmpty else {
				continue
			}

			let area = intersection.width * intersection.height
			if area > largestIntersection {
				largestIntersection = area
				selectedIndex = index
			}
		}
		return selectedIndex
	}

	static func orientedPixelSize(_ pixelSize: CGSize, rotationDegrees: Double) -> CGSize {
		let normalizedRotation = abs(Int(rotationDegrees.rounded())) % 360
		if normalizedRotation == 90 || normalizedRotation == 270 {
			return CGSize(width: pixelSize.height, height: pixelSize.width)
		}
		return pixelSize
	}

	private static func positiveEvenFloor(_ value: Double) -> Int {
		let floored = Int(value.rounded(.down))
		return max(2, floored - (floored % 2))
	}
}
