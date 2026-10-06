/// Weekly usage pace, ported from `claude_swap.pace` (issue #125).
public enum Pace {
    public static let WEEKLY_PERIOD_S = 7 * 86400.0
    public static let SUPPRESS_AFTER_RESET_S = 24 * 3600.0
    public static let AHEAD_THRESHOLD_PCT = 15.0

    public struct Result: Sendable, Equatable {
        public var expectedPct: Double
        public var actualPct: Double
        public var elapsedS: Double
        public var periodS: Double
        public var ahead: Bool
    }

    /// The pace of one weekly window at `fetchedAt`, or nil if pace is not
    /// computable or falls inside the quiet time after a reset.
    public static func computePace(
        _ window: UsageWindow?,
        fetchedAt: Double?,
        periodS: Double = WEEKLY_PERIOD_S,
        suppressAfterResetS: Double = SUPPRESS_AFTER_RESET_S,
        aheadThresholdPct: Double = AHEAD_THRESHOLD_PCT
    ) -> Result? {
        guard let window, let fetchedAt, let pct = window.pct, let nextReset = window.resetsAt else {
            return nil
        }
        let remaining = pythonMod(nextReset - fetchedAt, periodS)
        let elapsed = remaining == 0 ? 0.0 : periodS - remaining
        if elapsed < suppressAfterResetS {
            return nil
        }
        let expected = min(100.0, (elapsed / periodS) * 100.0)
        return Result(
            expectedPct: expected,
            actualPct: pct,
            elapsedS: elapsed,
            periodS: periodS,
            ahead: (pct - expected) >= aheadThresholdPct
        )
    }

    /// Python float `%`: the result has the sign of the divisor.
    static func pythonMod(_ a: Double, _ b: Double) -> Double {
        let r = a.truncatingRemainder(dividingBy: b)
        return (r != 0 && (r < 0) != (b < 0)) ? r + b : r
    }
}
