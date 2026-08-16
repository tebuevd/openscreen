import CoreGraphics

enum SourceGeometryMethod: String, Equatable {
	case screenCaptureKitContentRect = "screen-capture-kit-content-rect"
	case displayModeFallback = "display-mode-fallback"
}

struct SourcePointGeometry: Equatable {
	let contentRectPoints: CGRect
	let pixelsPerPoint: CGFloat
	let method: SourceGeometryMethod
}

struct CaptureDimensions: Equatable {
	let width: Int
	let height: Int
	let scale: Double
}

enum CaptureGeometry {
	static let maximumWidth = 3840
	static let maximumHeight = 2160
	static let maximumSafeJSONNumber = 9_007_199_254_740_991.0
	static let maximumSensiblePixelsPerPoint = 16.0

	static func pixelSize(for pointSize: CGSize, pointPixelScale: CGFloat) -> CGSize {
		return CGSize(
			width: pointSize.width * pointPixelScale,
			height: pointSize.height * pointPixelScale
		)
	}

	static func validatedPixelSize(_ sourceSize: CGSize) -> CGSize? {
		let width = Double(sourceSize.width)
		let height = Double(sourceSize.height)
		guard width.isFinite, height.isFinite,
			width > 0, height > 0,
			width <= maximumSafeJSONNumber, height <= maximumSafeJSONNumber
		else {
			return nil
		}

		let roundedWidth = width.rounded()
		let roundedHeight = height.rounded()
		guard roundedWidth >= 1, roundedHeight >= 1,
			roundedWidth <= maximumSafeJSONNumber, roundedHeight <= maximumSafeJSONNumber
		else {
			return nil
		}
		return CGSize(width: roundedWidth, height: roundedHeight)
	}

	static func jsonSafeNumber(_ value: CGFloat) -> Double {
		let number = Double(value)
		return number.isFinite && abs(number) <= maximumSafeJSONNumber ? number : 0
	}

	static func derivedPixelsPerPoint(pointSize: CGSize, pixelSize: CGSize) -> CGFloat? {
		let pointWidth = Double(pointSize.width)
		let pixelWidth = Double(pixelSize.width)
		guard pointWidth.isFinite, pixelWidth.isFinite, pointWidth > 0, pixelWidth > 0 else {
			return nil
		}
		let scale = pixelWidth / pointWidth
		return scale.isFinite && scale >= 1 && scale <= maximumSensiblePixelsPerPoint
			? CGFloat(scale)
			: nil
	}

	static func displayModePixelsPerPoint(pixelWidth: Int?, pointWidth: Int?) -> CGFloat? {
		guard let pixelWidth, let pointWidth, pixelWidth > 0, pointWidth > 0 else {
			return nil
		}
		let scale = Double(pixelWidth) / Double(pointWidth)
		return scale.isFinite && scale >= 1 && scale <= maximumSensiblePixelsPerPoint
			? CGFloat(scale)
			: nil
	}

	static func displayModePixelSize(_ pixelSize: CGSize?, rotationDegrees: Double) -> CGSize? {
		guard let pixelSize, let validatedSize = validatedPixelSize(pixelSize) else {
			return nil
		}
		return orientedPixelSize(validatedSize, rotationDegrees: rotationDegrees)
	}

	static func sourcePointGeometry(
		contentRectPoints: CGRect,
		pixelsPerPoint: CGFloat,
		sourcePixelSize: CGSize,
		method: SourceGeometryMethod
	) -> SourcePointGeometry? {
		let x = Double(contentRectPoints.origin.x)
		let y = Double(contentRectPoints.origin.y)
		let pointWidth = Double(contentRectPoints.size.width)
		let pointHeight = Double(contentRectPoints.size.height)
		let scale = Double(pixelsPerPoint)
		let sourceWidth = Double(sourcePixelSize.width)
		let sourceHeight = Double(sourcePixelSize.height)
		let hasSafeRect = [x, y, pointWidth, pointHeight].allSatisfy {
			$0.isFinite && abs($0) <= maximumSafeJSONNumber
		} && pointWidth > 0 && pointHeight > 0
			&& (x + pointWidth).isFinite && abs(x + pointWidth) <= maximumSafeJSONNumber
			&& (y + pointHeight).isFinite && abs(y + pointHeight) <= maximumSafeJSONNumber
		let hasSafeScale = scale.isFinite && scale >= 1 && scale <= maximumSensiblePixelsPerPoint
		let expectedWidth = pointWidth * scale
		let expectedHeight = pointHeight * scale
		let hasConsistentPixels = sourceWidth.isFinite && sourceHeight.isFinite
			&& sourceWidth >= 1 && sourceHeight >= 1
			&& sourceWidth <= maximumSafeJSONNumber && sourceHeight <= maximumSafeJSONNumber
			&& sourceWidth.rounded() == sourceWidth && sourceHeight.rounded() == sourceHeight
			&& expectedWidth >= 1 && expectedHeight >= 1
			&& expectedWidth.rounded() == sourceWidth
			&& expectedHeight.rounded() == sourceHeight

		guard hasSafeRect, hasSafeScale, hasConsistentPixels else {
			return nil
		}
		return SourcePointGeometry(
			contentRectPoints: contentRectPoints,
			pixelsPerPoint: pixelsPerPoint,
			method: method
		)
	}

	static func fittedDimensions(for sourceSize: CGSize) -> CaptureDimensions? {
		guard let sourceSize = validatedPixelSize(sourceSize) else {
			return nil
		}
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
