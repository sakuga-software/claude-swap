import Foundation

/// The display preferences of the menu bar, in `<backup root>/menubar_settings.json`.
/// The keys and the JSON format are the same as `MenuBarSettings` in menubar.py,
/// so the Python and Swift apps share the file.
public struct MenuBarSettings: Sendable, Equatable {
    public var showAccountName: Bool = true
    /// One of `TITLE_PCT_CHOICES`.
    public var titlePct: String = "both"
    /// If true, the title also shows the per-model weekly limits.
    public var titleScoped: Bool = false
    public var refreshInterval: Int = 60
    public var autoSwitchEnabled: Bool = false

    public init(
        showAccountName: Bool = true, titlePct: String = "both", titleScoped: Bool = false,
        refreshInterval: Int = 60, autoSwitchEnabled: Bool = false
    ) {
        self.showAccountName = showAccountName
        self.titlePct = titlePct
        self.titleScoped = titleScoped
        self.refreshInterval = refreshInterval
        self.autoSwitchEnabled = autoSwitchEnabled
    }

    public static let FILENAME = "menubar_settings.json"

    /// Loads the settings. A missing or unreadable file gives the defaults.
    /// The loader ignores unknown keys, and a field with a value of the wrong
    /// type keeps its default.
    public static func load(_ url: URL) -> MenuBarSettings {
        var s = MenuBarSettings()
        guard let data = try? Data(contentsOf: url),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return s }
        if let v = boolValue(raw["show_account_name"]) { s.showAccountName = v }
        if let v = raw["title_pct"] as? String { s.titlePct = v }
        if let v = boolValue(raw["title_scoped"]) { s.titleScoped = v }
        if let v = intValue(raw["refresh_interval"]) { s.refreshInterval = v }
        if let v = boolValue(raw["auto_switch_enabled"]) { s.autoSwitchEnabled = v }
        return s
    }

    /// Writes the settings as Python `json.dumps(..., indent=2)` does, and
    /// makes the parent directories.
    public func save(_ url: URL) throws {
        try FileManager.default.createDirectories(for: url)
        try Data(jsonText().utf8).write(to: url, options: .atomic)
    }

    public func jsonText() -> String {
        """
        {
          "show_account_name": \(showAccountName),
          "title_pct": \(pythonJSONString(titlePct)),
          "title_scoped": \(titleScoped),
          "refresh_interval": \(refreshInterval),
          "auto_switch_enabled": \(autoSwitchEnabled)
        }
        """
    }

    private static func isBool(_ n: NSNumber) -> Bool {
        CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    private static func boolValue(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber, isBool(n) else { return nil }
        return n.boolValue
    }

    private static func intValue(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, !isBool(n), !CFNumberIsFloatType(n) else { return nil }
        return n.intValue
    }
}

/// A JSON string literal with non-ASCII characters escaped, as Python `json.dumps` writes it.
func pythonJSONString(_ s: String) -> String {
    var out = "\""
    for unit in s.utf16 {
        switch unit {
        case 0x22: out += "\\\""
        case 0x5C: out += "\\\\"
        case 0x0A: out += "\\n"
        case 0x0D: out += "\\r"
        case 0x09: out += "\\t"
        case 0x08: out += "\\b"
        case 0x0C: out += "\\f"
        case 0x20...0x7E: out.unicodeScalars.append(Unicode.Scalar(unit)!)
        default: out += String(format: "\\u%04x", unit)
        }
    }
    return out + "\""
}

extension FileManager {
    func createDirectories(for file: URL) throws {
        try createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
}
