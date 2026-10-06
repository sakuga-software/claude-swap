import Foundation

/// One usage window of the `--json` output (`fiveHour`, `sevenDay`, `spend`,
/// or one `scoped` entry). Every field is optional, so a partial or changed
/// window still decodes.
public struct UsageWindow: Sendable, Equatable, Decodable {
    public var pct: Double?
    /// The reset time as a POSIX timestamp. Nil if `resetsAt` is missing or not ISO-8601.
    public var resetsAt: Double?
    public var countdown: String?
    public var clock: String?
    public var name: String?

    public init(
        pct: Double? = nil, resetsAt: Double? = nil, countdown: String? = nil,
        clock: String? = nil, name: String? = nil
    ) {
        self.pct = pct
        self.resetsAt = resetsAt
        self.countdown = countdown
        self.clock = clock
        self.name = name
    }

    public init(
        pct: Double? = nil, resetsAtISO: String, countdown: String? = nil,
        clock: String? = nil, name: String? = nil
    ) {
        self.init(
            pct: pct, resetsAt: ISODate.timestamp(resetsAtISO), countdown: countdown,
            clock: clock, name: name
        )
    }

    enum CodingKeys: String, CodingKey {
        case pct, resetsAt, countdown, clock, name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pct = try? c.decodeIfPresent(Double.self, forKey: .pct)
        resetsAt = (try? c.decodeIfPresent(String.self, forKey: .resetsAt)).flatMap { $0 }
            .flatMap(ISODate.timestamp)
        countdown = (try? c.decodeIfPresent(String.self, forKey: .countdown)) ?? nil
        clock = (try? c.decodeIfPresent(String.self, forKey: .clock)) ?? nil
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
    }
}

/// The `usage` object of `cswap list --json` and `cswap status --json`.
public struct Usage: Sendable, Equatable, Decodable {
    public var fiveHour: UsageWindow?
    public var sevenDay: UsageWindow?
    public var spend: UsageWindow?
    public var scoped: [UsageWindow]?

    public init(
        fiveHour: UsageWindow? = nil, sevenDay: UsageWindow? = nil,
        spend: UsageWindow? = nil, scoped: [UsageWindow]? = nil
    ) {
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
        self.spend = spend
        self.scoped = scoped
    }

    enum CodingKeys: String, CodingKey {
        case fiveHour, sevenDay, spend, scoped
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fiveHour = (try? c.decodeIfPresent(UsageWindow.self, forKey: .fiveHour)) ?? nil
        sevenDay = (try? c.decodeIfPresent(UsageWindow.self, forKey: .sevenDay)) ?? nil
        spend = (try? c.decodeIfPresent(UsageWindow.self, forKey: .spend)) ?? nil
        scoped = (try? c.decodeIfPresent([UsageWindow].self, forKey: .scoped)) ?? nil
    }
}

/// What an account row shows: usage, a note for a sentinel state, or nothing.
/// It replaces the `dict | str | None` value of menubar.py.
public enum DisplayUsage: Sendable, Equatable {
    case unavailable
    case note(String)
    case usage(Usage)

    public init(_ usage: Usage?) {
        self = usage.map(DisplayUsage.usage) ?? .unavailable
    }

    public var usage: Usage? {
        if case .usage(let u) = self { return u }
        return nil
    }
}

/// One row of `cswap list --json`.
public struct AccountRow: Sendable, Equatable, Decodable {
    public var number: Int
    public var email: String
    public var organizationName: String?
    public var organizationUuid: String?
    public var active: Bool
    public var usageStatus: String
    public var usage: Usage?
    public var alias: String?
    public var disabled: Bool
    public var usageFetchedAt: String?
    public var lastGoodUsage: Usage?
    public var lastGoodFetchedAt: String?
    public var usageError: String?

    public init(
        number: Int, email: String, active: Bool = false, usageStatus: String = "ok",
        usage: Usage? = nil, alias: String? = nil, disabled: Bool = false,
        usageFetchedAt: String? = nil, lastGoodUsage: Usage? = nil,
        lastGoodFetchedAt: String? = nil
    ) {
        self.number = number
        self.email = email
        self.active = active
        self.usageStatus = usageStatus
        self.usage = usage
        self.alias = alias
        self.disabled = disabled
        self.usageFetchedAt = usageFetchedAt
        self.lastGoodUsage = lastGoodUsage
        self.lastGoodFetchedAt = lastGoodFetchedAt
    }

    enum CodingKeys: String, CodingKey {
        case number, email, organizationName, organizationUuid, active, usageStatus, usage
        case alias, disabled, usageFetchedAt, lastGoodUsage, lastGoodFetchedAt, usageError
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(FlexibleInt.self, forKey: .number).value
        email = try c.decode(String.self, forKey: .email)
        organizationName = (try? c.decodeIfPresent(String.self, forKey: .organizationName)) ?? nil
        organizationUuid = (try? c.decodeIfPresent(String.self, forKey: .organizationUuid)) ?? nil
        active = ((try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? nil) ?? false
        usageStatus = ((try? c.decodeIfPresent(String.self, forKey: .usageStatus)) ?? nil) ?? "unavailable"
        usage = (try? c.decodeIfPresent(Usage.self, forKey: .usage)) ?? nil
        alias = (try? c.decodeIfPresent(String.self, forKey: .alias)) ?? nil
        disabled = ((try? c.decodeIfPresent(Bool.self, forKey: .disabled)) ?? nil) ?? false
        usageFetchedAt = (try? c.decodeIfPresent(String.self, forKey: .usageFetchedAt)) ?? nil
        lastGoodUsage = (try? c.decodeIfPresent(Usage.self, forKey: .lastGoodUsage)) ?? nil
        lastGoodFetchedAt = (try? c.decodeIfPresent(String.self, forKey: .lastGoodFetchedAt)) ?? nil
        usageError = (try? c.decodeIfPresent(String.self, forKey: .usageError)) ?? nil
    }
}

/// The payload of `cswap list --json`.
public struct ListPayload: Sendable, Equatable, Decodable {
    public var activeAccountNumber: Int?
    public var accounts: [AccountRow]

    public init(activeAccountNumber: Int? = nil, accounts: [AccountRow]) {
        self.activeAccountNumber = activeAccountNumber
        self.accounts = accounts
    }

    enum CodingKeys: String, CodingKey {
        case activeAccountNumber, accounts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activeAccountNumber = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .activeAccountNumber))??.value
        accounts = try c.decode([AccountRow].self, forKey: .accounts)
    }
}

/// The payload of `cswap status --json`.
public struct StatusPayload: Sendable, Equatable, Decodable {
    public struct Active: Sendable, Equatable, Decodable {
        public var email: String
        public var managed: Bool?
        public var number: Int?

        enum CodingKeys: String, CodingKey { case email, managed, number }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            email = try c.decode(String.self, forKey: .email)
            managed = (try? c.decodeIfPresent(Bool.self, forKey: .managed)) ?? nil
            number = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .number))??.value
        }
    }

    public var active: Active?
}

/// The `from` / `to` reference of a switch result or a switch event.
public struct AccountRef: Sendable, Equatable, Decodable {
    public var number: String?
    public var email: String?

    public init(number: String?, email: String?) {
        self.number = number
        self.email = email
    }

    enum CodingKeys: String, CodingKey { case number, email }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .number))??.text
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? nil
    }
}

/// The payload of `cswap switch ... --json`.
public struct SwitchResult: Sendable, Equatable, Decodable {
    public var switched: Bool
    public var from: AccountRef?
    public var to: AccountRef?
    public var strategy: String?
    public var reason: String?
    public var message: String?
    public var warnings: [String]?

    public init(switched: Bool, message: String? = nil) {
        self.switched = switched
        self.message = message
    }
}

/// The error envelope that a `--json` command writes to stdout on failure.
public struct ErrorEnvelope: Sendable, Equatable, Decodable {
    public struct Body: Sendable, Equatable, Decodable {
        public var type: String?
        public var message: String
    }

    public var error: Body
}

/// The payload of `cswap config get <key> --json`.
public struct ConfigValuePayload: Sendable, Decodable {
    public var key: String?
    public var value: Double?

    enum CodingKeys: String, CodingKey { case key, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? nil
        value = (try? c.decodeIfPresent(Double.self, forKey: .value)) ?? nil
    }
}

/// An integer that the JSON can carry as a number or as a string.
struct FlexibleInt: Decodable {
    var text: String
    var value: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) {
            value = i
            text = String(i)
        } else {
            let s = try c.decode(String.self)
            guard let i = Int(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an integer: \(s)")
            }
            value = i
            text = s
        }
    }
}
