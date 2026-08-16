/// Maximum caller-supplied MP4 bitrate, in bits per second. This includes the UI policy's
/// 80 Mbps maximum and the legacy DCI-8K fallback (~136.5 Mbps), while rejecting unit mistakes.
pub const MAX_MP4_EXPORT_BITRATE: i64 = 200_000_000;

const MIN_FALLBACK_BITRATE: i64 = 2_000_000;
const REFERENCE_BITRATE: u128 = 8_000_000;
const REFERENCE_PIXEL_AREA: u128 = 1920 * 1080;
const JAVASCRIPT_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Validates a raw JavaScript number before it is converted to the integer native contract.
pub fn validate_requested_mp4_bitrate(bitrate: f64) -> Option<i64> {
    if !bitrate.is_finite()
        || bitrate.fract() != 0.0
        || bitrate <= 0.0
        || bitrate > JAVASCRIPT_MAX_SAFE_INTEGER
        || bitrate > MAX_MP4_EXPORT_BITRATE as f64
    {
        return None;
    }

    Some(bitrate as i64)
}

/// Resolves the encoder bitrate in bits per second. Omitted values retain the historical
/// 8 Mbps-per-1080p-area formula with a 2 Mbps floor. u128 intermediates preserve the ordinary
/// integer-floor behavior without overflowing for any u32 dimensions; impossible results
/// saturate at the encoder contract's i64 maximum instead of wrapping.
pub fn resolve_mp4_bitrate(width: u32, height: u32, supplied: Option<i64>) -> i64 {
    supplied.unwrap_or_else(|| {
        let scaled =
            u128::from(width) * u128::from(height) * REFERENCE_BITRATE / REFERENCE_PIXEL_AREA;
        (scaled.min(i64::MAX as u128) as i64).max(MIN_FALLBACK_BITRATE)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supplied_bitrate_wins_for_representative_dimensions() {
        for (width, height) in [(1920, 1080), (2880, 1864), (7680, 4320)] {
            assert_eq!(
                resolve_mp4_bitrate(width, height, Some(80_000_000)),
                80_000_000
            );
        }
    }

    #[test]
    fn fallback_bitrate_matches_the_historical_area_policy() {
        for (width, height, expected) in [
            (640, 360, 2_000_000),
            (1920, 1080, 8_000_000),
            (2880, 1864, 20_711_111),
            (7680, 4320, 128_000_000),
            (8192, 4320, 136_533_333),
        ] {
            assert_eq!(resolve_mp4_bitrate(width, height, None), expected);
        }
    }

    #[test]
    fn fallback_bitrate_saturates_instead_of_overflowing() {
        assert_eq!(resolve_mp4_bitrate(u32::MAX, u32::MAX, None), i64::MAX);
    }

    #[test]
    fn raw_bitrate_validation_accepts_the_policy_and_rejects_malformed_values() {
        assert_eq!(
            validate_requested_mp4_bitrate(80_000_000.0),
            Some(80_000_000)
        );
        for invalid in [
            0.0,
            -1.0,
            1.5,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            9_007_199_254_740_992.0,
            (MAX_MP4_EXPORT_BITRATE + 1) as f64,
        ] {
            assert_eq!(validate_requested_mp4_bitrate(invalid), None, "{invalid}");
        }
    }
}
