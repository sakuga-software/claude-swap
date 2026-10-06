public let ICON = "⇄"
public let REFRESH_CHOICES: [Int] = [30, 60, 300]
public let AUTO_THRESHOLD_CHOICES: [Int] = [80, 90, 95, 98]
public let TITLE_PCT_CHOICES: [String] = ["off", "5h", "7d", "both"]
public let SWITCH_HISTORY_LIMIT = 10
public let NOTIFICATION_BUNDLE_ID = "com.claude-swap.menubar"

public let TITLE_PCT_LABELS: [String: String] = [
    "off": "None",
    "5h": "Session (5h)",
    "7d": "Weekly (7d)",
    "both": "Both (5h · 7d)",
]

public let REFRESH_LABELS: [Int: String] = [
    30: "30 seconds",
    60: "60 seconds",
    300: "5 minutes",
]

/// The `usageStatus` values of `cswap list --json` that carry a human note
/// instead of usage. The texts are `SENTINEL_NOTES` in switcher.py.
public let SENTINEL_NOTES: [String: String] = [
    "token_expired": "token expired — refresh deferred this pass; retries automatically",
    "foreign_credential": "live credential belongs to another account — a switch repairs it",
    "api_key": "API key (no quota)",
    "keychain_unavailable": "keychain unavailable — locked or in use; try again",
    "relogin_required": "re-login needed — refresh token dead; log in with Claude Code, then run: cswap add",
    "no_credentials": "no credentials",
]

public let SWITCHED_NOTIFICATION_BODY =
    "Switch takes effect within ~30s — restart Claude Code to apply immediately."

public let KEYCHAIN_BLOCKED_MESSAGE =
    "Couldn't read the active credential. If the menu bar is running "
    + "as a background/login agent, macOS blocks its Keychain access — "
    + "quit and relaunch it from a Terminal with: cswap --menubar"
