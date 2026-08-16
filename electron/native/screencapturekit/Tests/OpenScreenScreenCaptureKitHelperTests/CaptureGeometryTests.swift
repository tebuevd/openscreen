import CoreGraphics
import XCTest

@testable import OpenScreenScreenCaptureKitHelper

final class CaptureGeometryTests: XCTestCase {
	func testRetinaPointSizeUsesBackingPixels() {
		let sourceSize = CaptureGeometry.pixelSize(
			for: CGSize(width: 1440, height: 932),
			pointPixelScale: 2
		)

		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: sourceSize),
			CaptureDimensions(width: 2880, height: 1864, scale: 1)
		)
	}

	func testOneTimesDisplayRemainsUnchanged() {
		let sourceSize = CaptureGeometry.pixelSize(
			for: CGSize(width: 1920, height: 1080),
			pointPixelScale: 1
		)

		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: sourceSize),
			CaptureDimensions(width: 1920, height: 1080, scale: 1)
		)
	}

	func testSourceBelowCaptureLimitRemainsUnchanged() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: CGSize(width: 2560, height: 1440)),
			CaptureDimensions(width: 2560, height: 1440, scale: 1)
		)
	}

	func testFiveKSourceFitsInsideFourK() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: CGSize(width: 5120, height: 2880)),
			CaptureDimensions(width: 3840, height: 2160, scale: 0.75)
		)
	}

	func testUltrawideSourcePreservesAspectRatio() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: CGSize(width: 5120, height: 1440)),
			CaptureDimensions(width: 3840, height: 1080, scale: 0.75)
		)
	}

	func testPortraitSourcePreservesAspectRatio() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: CGSize(width: 2160, height: 3840)),
			CaptureDimensions(width: 1214, height: 2160, scale: 0.5625)
		)
	}

	func testFractionalPointSizesAreScaledBeforeRounding() {
		let sourceSize = CaptureGeometry.pixelSize(
			for: CGSize(width: 101.9, height: 53.9),
			pointPixelScale: 1.5
		)

		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: sourceSize),
			CaptureDimensions(width: 152, height: 80, scale: 1)
		)
	}

	func testOutputsArePositiveEvenAndWithinLimits() {
		let sourceSizes = [
			CGSize.zero,
			CGSize(width: -100, height: 100),
			CGSize(width: 1, height: 1),
			CGSize(width: 3839, height: 2159),
			CGSize(width: 10_000, height: 1),
			CGSize(width: 1, height: 10_000),
			CGSize(width: CGFloat.nan, height: 1080),
		]

		for sourceSize in sourceSizes {
			let dimensions = CaptureGeometry.fittedDimensions(for: sourceSize)
			XCTAssertGreaterThan(dimensions.width, 0)
			XCTAssertGreaterThan(dimensions.height, 0)
			XCTAssertEqual(dimensions.width % 2, 0)
			XCTAssertEqual(dimensions.height % 2, 0)
			XCTAssertLessThanOrEqual(dimensions.width, CaptureGeometry.maximumWidth)
			XCTAssertLessThanOrEqual(dimensions.height, CaptureGeometry.maximumHeight)
			XCTAssertTrue(dimensions.scale.isFinite)
			XCTAssertGreaterThan(dimensions.scale, 0)
			XCTAssertLessThanOrEqual(dimensions.scale, 1)
		}
	}

	func testWindowDisplaySelectionPrefersDisplayContainingCenter() {
		let displays = [
			CGRect(x: 0, y: 0, width: 1920, height: 1080),
			CGRect(x: 1920, y: 0, width: 1440, height: 932),
		]
		let window = CGRect(x: 1800, y: 100, width: 600, height: 500)

		XCTAssertEqual(CaptureGeometry.displayIndex(for: window, displayFrames: displays), 1)
	}

	func testWindowDisplaySelectionUsesLargestIntersectionWhenCenterIsInGap() {
		let displays = [
			CGRect(x: 0, y: 0, width: 1000, height: 1000),
			CGRect(x: 1300, y: 0, width: 1000, height: 1000),
		]
		let window = CGRect(x: 600, y: 100, width: 1000, height: 500)

		XCTAssertEqual(CaptureGeometry.displayIndex(for: window, displayFrames: displays), 0)
	}

	func testDisplayPixelsFollowCurrentOrientation() {
		XCTAssertEqual(
			CaptureGeometry.orientedPixelSize(
				CGSize(width: 5120, height: 2880),
				rotationDegrees: 90
			),
			CGSize(width: 2880, height: 5120)
		)
	}
}
