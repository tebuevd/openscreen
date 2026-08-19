import CoreGraphics

struct CaptureDimensions: Equatable {
	let width: Int
	let height: Int
}

enum CaptureGeometry {
	static func pixelSize(for pointSize: CGSize, pointPixelScale: CGFloat) -> CGSize {
		let scale = pointPixelScale.isFinite && pointPixelScale > 0 ? pointPixelScale : 1
		return CGSize(width: pointSize.width * scale, height: pointSize.height * scale)
	}

	static func fittedDimensions(
		for sourceSize: CGSize,
		maximum: CaptureDimensions
	) -> CaptureDimensions {
		let maximumWidth = positiveEvenFloor(Double(maximum.width))
		let maximumHeight = positiveEvenFloor(Double(maximum.height))
		let sourceWidth = Double(sourceSize.width)
		let sourceHeight = Double(sourceSize.height)

		guard sourceWidth.isFinite, sourceHeight.isFinite, sourceWidth > 0, sourceHeight > 0 else {
			return CaptureDimensions(width: maximumWidth, height: maximumHeight)
		}

		let scale = min(
			1,
			Double(maximumWidth) / sourceWidth,
			Double(maximumHeight) / sourceHeight
		)
		return CaptureDimensions(
			width: positiveEvenFloor(sourceWidth * scale),
			height: positiveEvenFloor(sourceHeight * scale)
		)
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
