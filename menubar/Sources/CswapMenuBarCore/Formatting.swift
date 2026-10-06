import Foundation

/// Display helpers ported from the pure functions of menubar.py. The names
/// keep the Python names in camelCase.
public enum Formatting {
    public static let WEEKLY_PERIOD_S = 7 * 86400.0

    /// Python `f"{value:.0f}"`. Both round half to even.
    static func pct0(_ value: Double) -> String {
        String(format: "%.0f", value)
    }

    /// The highest 5h/7d utilization, or nil if unknown. Spend is not a rate-limit window.
    public static func tightestPct(_ usage: DisplayUsage) -> Double? {
        guard let u = usage.usage else { return nil }
        return [u.fiveHour?.pct, u.sevenDay?.pct].compactMap { $0 }.max()
    }

    static func windowPct(_ usage: DisplayUsage, _ key: WindowKey) -> Double? {
        guard let u = usage.usage else { return nil }
        return window(u, key)?.pct
    }

    enum WindowKey { case fiveHour, sevenDay }

    static func window(_ u: Usage, _ key: WindowKey) -> UsageWindow? {
        key == .fiveHour ? u.fiveHour : u.sevenDay
    }

    /// The POSIX timestamp of a window's reset, or infinity if it is missing or not valid.
    public static func resetsAtTs(_ window: UsageWindow?) -> Double {
        window?.resetsAt ?? .infinity
    }

    /// The time until a window resets, from its absolute reset time. Nil if
    /// the reset time is missing or passed.
    public static func liveCountdown(_ window: UsageWindow?, now: Double) -> String? {
        let ts = resetsAtTs(window)
        if ts == .infinity { return nil }
        let remaining = Int(ts - now)
        if remaining <= 0 { return nil }
        let days = remaining / 86400
        let hours = (remaining % 86400) / 3600
        let minutes = (remaining % 3600) / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }

    /// A weekly window whose reset is in the past, moved to its next 7-day
    /// boundary with `pct` 0. A missing, future or unknown reset gives the
    /// window back unchanged.
    public static func rolledWeeklyWindow(_ window: UsageWindow?, now: Double) -> UsageWindow? {
        guard let window else { return nil }
        let ts = resetsAtTs(window)
        if ts == .infinity || ts > now { return window }
        let missed = Int(((now - ts) / WEEKLY_PERIOD_S).rounded(.down)) + 1
        var rolled = window
        rolled.pct = 0.0
        rolled.resetsAt = ts + Double(missed) * WEEKLY_PERIOD_S
        rolled.countdown = nil
        rolled.clock = nil
        return rolled
    }

    /// The one-line usage summary of an account row. `fetchedAt` is the fetch
    /// time of the measurement. Only the weekly windows use it, for the
    /// "(ahead)" marker.
    public static func usageSummary(
        _ usage: DisplayUsage, now: Double? = nil, fetchedAt: Double? = nil
    ) -> String {
        let u: Usage
        switch usage {
        case .note(let text): return text
        case .unavailable: return "usage unavailable"
        case .usage(let value): u = value
        }
        let now = now ?? Date().timeIntervalSince1970
        var parts: [String] = []

        if let w = u.fiveHour, let pct = w.pct {
            var seg = "5h \(pct0(pct))%"
            if let cd = liveCountdown(w, now: now) { seg += " (\(cd))" }
            parts.append(seg)
        }
        let seven = rolledWeeklyWindow(u.sevenDay, now: now)
        let sevenPace = Pace.computePace(seven, fetchedAt: fetchedAt)
        if let w = seven, let pct = w.pct {
            var seg = "7d \(pct0(pct))%"
            if sevenPace?.ahead == true { seg += " (ahead)" }
            if let cd = liveCountdown(w, now: now) { seg += " (\(cd))" }
            parts.append(seg)
        }
        for raw in u.scoped ?? [] {
            let w = rolledWeeklyWindow(raw, now: now)
            let pace = Pace.computePace(w, fetchedAt: fetchedAt)
            guard let w, let pct = w.pct, let name = w.name, !name.isEmpty else { continue }
            var seg = "\(name) \(pct0(pct))%"
            if pct >= 100 {
                seg += " (!)"
            } else if pace?.ahead == true {
                seg += " (ahead)"
            }
            if let cd = liveCountdown(w, now: now) { seg += " (\(cd))" }
            parts.append(seg)
        }
        if let pct = u.spend?.pct {
            parts.append("$ \(pct0(pct))%")
        }
        return parts.isEmpty ? "usage unavailable" : parts.joined(separator: " · ")
    }

    public static func formatAccountLabel(
        _ num: Int, _ email: String, _ usage: DisplayUsage, now: Double? = nil,
        alias: String? = nil, disabled: Bool = false, fetchedAt: Double? = nil
    ) -> String {
        let label = nonEmpty(alias).map { "\($0)  (\(email))" } ?? email
        let marker = disabled ? "  (disabled)" : ""
        return "\(num)  \(label)\(marker)  \(usageSummary(usage, now: now, fetchedAt: fetchedAt))"
    }

    /// The text of `email` before "@". If it is longer than `limit`, it ends with "*".
    static func localPart(_ email: String, limit: Int = 12) -> String {
        let local = email.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
            .first.map(String.init) ?? ""
        if local.count > limit {
            return String(local.prefix(limit - 1)) + "*"
        }
        return local
    }

    public static func formatTitle(
        _ activeEmail: String?, _ activeUsage: DisplayUsage, _ settings: MenuBarSettings,
        now: Double? = nil, alias: String? = nil
    ) -> String {
        guard let activeEmail else { return ICON }
        let now = now ?? Date().timeIntervalSince1970
        var segments: [String] = []
        if settings.showAccountName {
            segments.append(nonEmpty(alias) ?? localPart(activeEmail))
        }
        if settings.titlePct == "5h" || settings.titlePct == "both",
           let p = windowPct(activeUsage, .fiveHour) {
            segments.append("\(pct0(p))%")
        }
        if settings.titlePct == "7d" || settings.titlePct == "both",
           let p = rolledWeeklyWindow(activeUsage.usage?.sevenDay, now: now)?.pct {
            segments.append("\(pct0(p))%")
        }
        if settings.titleScoped, let u = activeUsage.usage {
            for raw in u.scoped ?? [] {
                if let w = rolledWeeklyWindow(raw, now: now), let pct = w.pct,
                   let name = w.name, !name.isEmpty {
                    segments.append("\(name) \(pct0(pct))%")
                }
            }
        }
        if segments.isEmpty { return ICON }
        return "\(ICON) " + segments.joined(separator: " · ")
    }

    /// A log line of the 5h and 7d limits of an account, with the absolute
    /// reset clocks. Nil if no window has a numeric `pct`.
    public static func formatUsageLog(_ email: String, _ usage: DisplayUsage) -> String? {
        guard let u = usage.usage else { return nil }
        var parts: [String] = []
        for (key, label) in [(WindowKey.fiveHour, "5h"), (.sevenDay, "7d")] {
            guard let w = window(u, key), let pct = w.pct else { continue }
            var seg = "\(label) \(pct0(pct))%"
            if let clock = w.clock, !clock.isEmpty { seg += " (resets \(clock))" }
            parts.append(seg)
        }
        if parts.isEmpty { return nil }
        return "usage \(email): " + parts.joined(separator: " · ")
    }

    public struct UsageLogKey: Equatable, Sendable {
        public var fiveHour: Double?
        public var sevenDay: Double?
    }

    /// The de-duplication key for usage logs: the 5h and 7d percentages only.
    public static func usageLogKey(_ usage: DisplayUsage) -> UsageLogKey {
        UsageLogKey(fiveHour: windowPct(usage, .fiveHour), sevenDay: windowPct(usage, .sevenDay))
    }

    private static let switchLogRegex =
        try! NSRegularExpression(pattern: #"Switched from account (\d+) to (\d+)"#)

    /// The recent account switches in the cswap log, most recent first, as
    /// "3 → 1   2026-06-27 02:06".
    public static func parseSwitchHistory(_ logText: String, limit: Int = SWITCH_HISTORY_LIMIT) -> [String] {
        var out: [String] = []
        for line in logText.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            let s = String(line)
            let ns = s as NSString
            guard let m = switchLogRegex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else {
                continue
            }
            let head = s.components(separatedBy: " - ").first ?? s
            let stamp = String(head.trimmingCharacters(in: .whitespaces).prefix(16))
            out.append("\(ns.substring(with: m.range(at: 1))) → \(ns.substring(with: m.range(at: 2)))   \(stamp)")
        }
        let tail = limit == 0 ? out : Array(out.suffix(limit))
        return tail.reversed()
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
