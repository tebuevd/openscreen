import CoreGraphics
import XCTest

@testable import OpenScreenScreenCaptureKitHelper

final class CaptureGeometryTests: XCTestCase {
	private let fourK = CaptureDimensions(width: 3840, height: 2160)

	func testRetinaPointSizeUsesBackingPixels() {
		let sourceSize = CaptureGeometry.pixelSize(
			for: CGSize(width: 1440, height: 932),
			pointPixelScale: 2
		)

		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: sourceSize, maximum: fourK),
			CaptureDimensions(width: 2880, height: 1864)
		)
	}

	func testOneTimesDisplayRemainsUnchanged() {
		let sourceSize = CaptureGeometry.pixelSize(
			for: CGSize(width: 1920, height: 1080),
			pointPixelScale: 1
		)

		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(for: sourceSize, maximum: fourK),
			CaptureDimensions(width: 1920, height: 1080)
		)
	}

	func testFiveKDisplayFitsInsideFourK() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(
				for: CGSize(width: 5120, height: 2880),
				maximum: fourK
			),
			CaptureDimensions(width: 3840, height: 2160)
		)
	}

	func testUltrawideDisplayPreservesAspectRatio() {
		XCTAssertEqual(
			CaptureGeometry.fittedDimensions(
				for: CGSize(width: 5120, height: 1440),
				maximum: fourK
			),
			CaptureDimensions(width: 3840, height: 1080)
		)
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
