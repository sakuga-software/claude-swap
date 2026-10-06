import Foundation

/// Parses the ISO-8601 forms that Python `datetime.fromisoformat` accepts in
/// the cswap JSON output.
public enum ISODate {
    private static let pattern = try! NSRegularExpression(
        pattern: #"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$"#
    )

    /// The POSIX timestamp of `text`, or nil if `text` is not an ISO-8601 time.
    /// A time without an offset is local time, as in Python.
    public static func timestamp(_ text: String) -> Double? {
        let ns = text as NSString
        guard let m = pattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        guard let year = Int(group(1)!), let month = Int(group(2)!), let day = Int(group(3)!) else {
            return nil
        }
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = day
        comps.hour = group(4).flatMap(Int.init) ?? 0
        comps.minute = group(5).flatMap(Int.init) ?? 0
        comps.second = group(6).flatMap(Int.init) ?? 0
        guard (1...12).contains(month), (1...31).contains(day),
              (0...23).contains(comps.hour!), (0...59).contains(comps.minute!),
              (0...59).contains(comps.second!)
        else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        if let offset = group(8) {
            guard let seconds = offsetSeconds(offset), let tz = TimeZone(secondsFromGMT: seconds) else {
                return nil
            }
            calendar.timeZone = tz
        } else {
            calendar.timeZone = .current
        }
        guard let date = calendar.date(from: comps),
              calendar.component(.day, from: date) == day
        else { return nil }
        var ts = date.timeIntervalSince1970
        if let frac = group(7), let value = Double("0." + frac) {
            ts += value
        }
        return ts
    }

    private static func offsetSeconds(_ text: String) -> Int? {
        if text == "Z" || text == "z" { return 0 }
        let sign = text.hasPrefix("-") ? -1 : 1
        let digits = text.dropFirst().filter(\.isNumber)
        guard digits.count >= 2 else { return nil }
        let chars = Array(digits)
        let hours = Int(String(chars[0..<2])) ?? 0
        let minutes = chars.count >= 4 ? Int(String(chars[2..<4])) ?? 0 : 0
        let seconds = chars.count >= 6 ? Int(String(chars[4..<6])) ?? 0 : 0
        return sign * (hours * 3600 + minutes * 60 + seconds)
    }

    /// The UTC ISO-8601 text for `timestamp`, in the Python `isoformat()` form.
    public static func string(_ timestamp: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date(timeIntervalSince1970: timestamp))
            .replacingOccurrences(of: "Z", with: "+00:00")
    }
}
