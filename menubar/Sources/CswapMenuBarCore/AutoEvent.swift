import Foundation

/// One line of the `cswap auto --json` event stream. The stream is additive,
/// so every field is optional and an unknown `event` kind decodes too.
public struct AutoEvent: Sendable, Equatable, Decodable {
    public var event: String?
    public var ts: String?
    public var trigger: String?
    public var from: AccountRef?
    public var to: AccountRef?
    public var dryRun: Bool?
    public var number: String?
    public var email: String?
    public var reason: String?
    public var earliestResetAt: String?
    public var message: String?
    /// Set if the line is the error envelope of a failed start.
    public var error: ErrorEnvelope.Body?

    enum CodingKeys: String, CodingKey {
        case event, ts, trigger, from, to, dryRun, number, email, reason, earliestResetAt, message, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func str(_ k: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: k)) ?? nil }
        event = str(.event)
        ts = str(.ts)
        trigger = str(.trigger)
        from = (try? c.decodeIfPresent(AccountRef.self, forKey: .from)) ?? nil
        to = (try? c.decodeIfPresent(AccountRef.self, forKey: .to)) ?? nil
        dryRun = (try? c.decodeIfPresent(Bool.self, forKey: .dryRun)) ?? nil
        number = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .number))??.text
        email = str(.email)
        reason = str(.reason)
        earliestResetAt = str(.earliestResetAt)
        message = str(.message)
        error = (try? c.decodeIfPresent(ErrorEnvelope.Body.self, forKey: .error)) ?? nil
    }

    /// Decodes one JSONL line. Nil if the line is not a JSON object.
    public static func parse(line: String) -> AutoEvent? {
        guard let data = line.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AutoEvent.self, from: data)
    }

    /// The text of `AutoSwitchEvent.human()` in autoswitch.py for the kinds
    /// that the menu bar shows.
    public func human() -> String {
        switch event {
        case "switch":
            let src = from.map { "Account-\($0.number ?? "None")" } ?? "(none)"
            let dst = to.map { "Account-\($0.number ?? "None") (\($0.email ?? "None"))" } ?? "?"
            let prefix = dryRun == true ? "[dry-run] would switch" : "Switched"
            return "\(prefix) \(src) -> \(dst) (\(trigger ?? ""))"
        case "account-quarantined":
            let num = number ?? "None"
            return "Account-\(num) (\(email ?? "")) quarantined: \(reason ?? ""). "
                + "Log in with it and run 'cswap --add-account --slot \(num)' to recover."
        case "all-exhausted":
            if let at = earliestResetAt, !at.isEmpty {
                return "all accounts exhausted; earliest reset \(at)"
            }
            return "all accounts exhausted; no reset time known"
        case "config-warning":
            return "warning: \(message ?? "")"
        default:
            return event ?? "event"
        }
    }

    public struct Notification: Sendable, Equatable {
        public var title: String
        public var subtitle: String
        public var body: String
    }

    /// The notification that menubar.py shows for this event, or nil.
    public func notification() -> Notification? {
        let subtitle: String
        switch event {
        case "switch":
            if dryRun == true { return nil }
            subtitle = "Auto-switched account"
        case "account-quarantined": subtitle = "Account quarantined"
        case "all-exhausted": subtitle = "All accounts exhausted"
        case "config-warning": subtitle = "Configuration warning"
        default:
            if event == nil, let error {
                return Notification(title: "claude-swap", subtitle: "Auto-switch failed to start", body: error.message)
            }
            return nil
        }
        return Notification(title: "claude-swap", subtitle: subtitle, body: human())
    }

    /// True if the menu must refresh after this event.
    public var changesActiveAccount: Bool {
        event == "switch" && dryRun != true
    }
}

/// Splits a byte stream into lines. It keeps an incomplete last line until more bytes come.
public struct LineSplitter: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func feed(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let idx = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<idx]
            buffer.removeSubrange(buffer.startIndex...idx)
            let line = String(decoding: lineData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { lines.append(line) }
        }
        return lines
    }

    /// The rest of the stream after the end of input.
    public mutating func finish() -> [String] {
        let line = String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        buffer.removeAll()
        return line.isEmpty ? [] : [line]
    }
}
