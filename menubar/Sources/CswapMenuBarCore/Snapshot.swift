import Foundation

/// One account row of the menu.
public struct MenuAccount: Sendable, Equatable {
    public var number: Int
    public var email: String
    public var isActive: Bool
    public var display: DisplayUsage
    /// The last good measurement, for the usage log. Sentinel states keep it.
    public var lastGood: Usage?
    public var alias: String
    public var disabled: Bool
    /// The fetch time of the measurement, for the "(ahead)" marker.
    public var fetchedAt: Double?

    public init(
        number: Int, email: String, isActive: Bool, display: DisplayUsage, lastGood: Usage?,
        alias: String, disabled: Bool, fetchedAt: Double?
    ) {
        self.number = number
        self.email = email
        self.isActive = isActive
        self.display = display
        self.lastGood = lastGood
        self.alias = alias
        self.disabled = disabled
        self.fetchedAt = fetchedAt
    }
}

/// The data that the menu shows. It replaces the render dict of menubar.py.
public struct MenuSnapshot: Sendable, Equatable {
    public var accounts: [MenuAccount]
    public var activeEmail: String?
    public var activeUsage: DisplayUsage
    public var activeAlias: String?

    public init(
        accounts: [MenuAccount] = [], activeEmail: String? = nil,
        activeUsage: DisplayUsage = .unavailable, activeAlias: String? = nil
    ) {
        self.accounts = accounts
        self.activeEmail = activeEmail
        self.activeUsage = activeUsage
        self.activeAlias = activeAlias
    }

    public static let EMPTY_SNAPSHOT = MenuSnapshot()
}

public enum SnapshotAdapter {
    /// The menu display of a `list --json` row: the note of a sentinel state,
    /// else the usage, else the last good usage, else nothing.
    public static func accountDisplayUsage(_ row: AccountRow) -> DisplayUsage {
        if let note = SENTINEL_NOTES[row.usageStatus] {
            return .note(note)
        }
        return DisplayUsage(row.usage ?? row.lastGoodUsage)
    }

    public static func adaptSnapshot(_ payload: ListPayload) -> MenuSnapshot {
        var snap = MenuSnapshot()
        for row in payload.accounts {
            let display = accountDisplayUsage(row)
            let fetchedAt = (row.usageFetchedAt ?? row.lastGoodFetchedAt).flatMap(ISODate.timestamp)
            snap.accounts.append(
                MenuAccount(
                    number: row.number, email: row.email, isActive: row.active, display: display,
                    lastGood: row.usage ?? row.lastGoodUsage, alias: row.alias ?? "",
                    disabled: row.disabled, fetchedAt: fetchedAt
                )
            )
            if row.active {
                snap.activeEmail = row.email
                snap.activeUsage = display
                snap.activeAlias = row.alias ?? ""
            }
        }
        return snap
    }
}
