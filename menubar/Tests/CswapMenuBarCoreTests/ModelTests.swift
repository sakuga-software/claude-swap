// Tests of MenuBarModel with a fake CswapClient. They have no Python
// counterpart: the Python tests do not cover the rumps glue.
import Foundation
import Testing
@testable import CswapMenuBarCore

private final class FakeClient: CswapClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    var calls: [String] { lock.withLock { _calls } }
    var failing: Set<String> = []
    var listPayload = ListPayload(activeAccountNumber: 1, accounts: [
        AccountRow(number: 1, email: "a@x.com", active: true, usageStatus: "ok",
                   usage: Usage(fiveHour: UsageWindow(pct: 42.0), sevenDay: UsageWindow(pct: 18.0))),
        AccountRow(number: 2, email: "b@x.com", usageStatus: "api_key", disabled: true),
    ])
    var statusPayload = StatusPayload(active: nil)
    let handle = FakeHandle()
    var onEvent: (@Sendable (AutoEvent) -> Void)?

    private func record(_ call: String) throws {
        lock.withLock { _calls.append(call) }
        if failing.contains(call.split(separator: " ").first.map(String.init) ?? call) {
            throw CswapError(message: "\(call) failed")
        }
    }

    func list() async throws -> ListPayload { try record("list"); return listPayload }
    func status() async throws -> StatusPayload { try record("status"); return statusPayload }
    func switchTo(_ number: Int) async throws -> SwitchResult {
        try record("switch \(number)"); return SwitchResult(switched: true)
    }
    func switchRotate(strategy: String?) async throws -> SwitchResult {
        try record("switch \(strategy ?? "rotate")"); return SwitchResult(switched: false, message: "Already on Account-1")
    }
    func setDisabled(_ number: Int, disabled: Bool) async throws { try record("\(disabled ? "disable" : "enable") \(number)") }
    func remove(_ number: Int) async throws { try record("remove \(number)") }
    func addFromLogin() async throws { try record("add") }
    func addFromToken(token: String, email: String) async throws { try record("add-token \(email) \(token.count)") }
    func autoSwitchThreshold() async throws -> Double? { try record("config-get"); return 90.0 }
    func setAutoSwitchThreshold(_ pct: Int) async throws { try record("config-set \(pct)") }
    func startAuto(
        onEvent: @escaping @Sendable (AutoEvent) -> Void,
        onExit: @escaping @Sendable (Int32, String) -> Void
    ) throws -> AutoSwitchHandle {
        try record("auto")
        self.onEvent = onEvent
        return handle
    }
}

private final class FakeHandle: AutoSwitchHandle, @unchecked Sendable {
    private let lock = NSLock()
    private var _stops = 0
    var stops: Int { lock.withLock { _stops } }
    func stop() { lock.withLock { _stops += 1 } }
    func stopAndWait() { stop() }
}

@MainActor
private final class FakeUI: Prompter, Notifier {
    var alerts: [String] = []
    var notifications: [String] = []
    var confirmAnswer = true
    var answers: [String?] = []

    func alert(title: String, message: String) { alerts.append(message) }
    func confirm(title: String, message: String, ok: String, cancel: String) -> Bool {
        alerts.append("confirm: \(message)")
        return confirmAnswer
    }
    func askText(title: String, message: String, ok: String, cancel: String, secure: Bool) -> String? {
        answers.isEmpty ? nil : answers.removeFirst()
    }
    func notify(title: String, subtitle: String, body: String) { notifications.append("\(subtitle): \(body)") }
}

@MainActor
private func makeModel(_ client: FakeClient, _ ui: FakeUI) -> (MenuBarModel, CswapPaths) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cswap-model-\(UUID().uuidString)")
    let paths = CswapPaths(backupDir: dir)
    return (MenuBarModel(client: client, paths: paths, prompter: ui, notifier: ui, clock: { 1_000_000 }), paths)
}

@MainActor
@Suite struct MenuBarModelTests {
    @Test func refresh_builds_title_rows_and_history() async throws {
        let client = FakeClient()
        let ui = FakeUI()
        let (model, paths) = makeModel(client, ui)
        try FileManager.default.createDirectory(at: paths.backupDir, withIntermediateDirectories: true)
        try "2026-06-27 00:57:50,178 - INFO - Switched from account 1 to 2\n"
            .write(to: paths.logFile, atomically: true, encoding: .utf8)
        #expect(model.title == ICON)
        await model.refreshNow()
        #expect(model.title == "⇄ a · 42% · 18%")
        #expect(model.accountLabel(model.snapshot.accounts[0]) == "1  a@x.com  5h 42% · 7d 18%")
        #expect(model.accountLabel(model.snapshot.accounts[1]) == "2  b@x.com  (disabled)  API key (no quota)")
        #expect(model.history == ["1 → 2   2026-06-27 00:57"])
    }

    @Test func failed_refresh_keeps_last_snapshot() async {
        let client = FakeClient()
        let (model, _) = makeModel(client, FakeUI())
        await model.refreshNow()
        client.failing = ["list"]
        await model.refreshNow()
        #expect(model.snapshot.activeEmail == "a@x.com")
    }

    @Test func switch_notifies_and_refreshes() async {
        let client = FakeClient()
        let ui = FakeUI()
        let (model, _) = makeModel(client, ui)
        await model.switchTo(2)
        #expect(client.calls == ["switch 2", "list", "config-get"])
        #expect(ui.notifications == ["Account switched: \(SWITCHED_NOTIFICATION_BODY)"])
        await model.switchWith(strategy: "best")
        #expect(ui.notifications.last == "No switch: Already on Account-1")
    }

    @Test func failed_action_shows_alert_and_skips_refresh() async {
        let client = FakeClient()
        client.failing = ["switch"]
        let ui = FakeUI()
        let (model, _) = makeModel(client, ui)
        await model.switchTo(9)
        #expect(ui.alerts == ["switch 9 failed"])
        #expect(client.calls == ["switch 9"])
        #expect(ui.notifications.isEmpty)
    }

    @Test func remove_asks_first() async {
        let client = FakeClient()
        let ui = FakeUI()
        let (model, _) = makeModel(client, ui)
        ui.confirmAnswer = false
        await model.remove(2)
        #expect(client.calls.isEmpty)
        ui.confirmAnswer = true
        await model.remove(2)
        #expect(client.calls == ["remove 2", "list", "config-get"])
        #expect(ui.alerts.first == "confirm: Remove account 2?")
    }

    @Test func toggle_disabled_flips_the_row_state() async {
        let client = FakeClient()
        let (model, _) = makeModel(client, FakeUI())
        await model.refreshNow()
        await model.toggleDisabled(model.snapshot.accounts[1])
        await model.toggleDisabled(model.snapshot.accounts[0])
        #expect(client.calls == ["list", "config-get", "enable 2", "list", "config-get", "disable 1", "list", "config-get"])
    }

    @Test func add_token_needs_both_answers() async {
        let client = FakeClient()
        let ui = FakeUI()
        let (model, _) = makeModel(client, ui)
        ui.answers = ["  t@x.com ", nil]
        await model.addFromToken()
        #expect(client.calls.isEmpty)
        ui.answers = ["t@x.com", " sk-ant-oat01-abc "]
        await model.addFromToken()
        #expect(client.calls == ["add-token t@x.com 16", "list", "config-get"])
    }

    @Test func refresh_credentials_needs_an_active_login() async {
        let client = FakeClient()
        let ui = FakeUI()
        let (model, _) = makeModel(client, ui)
        await model.refreshCredentials()
        #expect(ui.alerts == ["No active Claude Code login detected. Log in first."])
        #expect(client.calls == ["status"])
    }

    @Test func refresh_credentials_points_at_keychain_block() {
        let e = CswapError(message: "Failed to read credentials for current account")
        #expect(MenuBarModel.refreshCredentialsMessage(e) == KEYCHAIN_BLOCKED_MESSAGE)
        #expect(MenuBarModel.refreshCredentialsMessage(CswapError(message: "other")) == "other")
    }

    @Test func settings_changes_persist_to_the_python_file() {
        let (model, paths) = makeModel(FakeClient(), FakeUI())
        model.toggleShowAccountName()
        model.setTitlePct("7d")
        model.toggleTitleScoped()
        model.setRefreshInterval(300)
        #expect(MenuBarSettings.load(paths.settingsFile) == MenuBarSettings(
            showAccountName: false, titlePct: "7d", titleScoped: true, refreshInterval: 300))
    }

    @Test func autoswitch_toggle_starts_and_stops_the_child() {
        let client = FakeClient()
        let (model, paths) = makeModel(client, FakeUI())
        model.toggleAutoSwitch()
        #expect(model.autoRunning)
        #expect(client.calls == ["auto"])
        #expect(MenuBarSettings.load(paths.settingsFile).autoSwitchEnabled)
        model.toggleAutoSwitch()
        #expect(!model.autoRunning)
        #expect(client.handle.stops == 1)
    }

    @Test func threshold_change_restarts_a_running_child() async {
        let client = FakeClient()
        let (model, _) = makeModel(client, FakeUI())
        await model.setThreshold(95)
        #expect(client.calls == ["config-set 95"])
        model.toggleAutoSwitch()
        await model.setThreshold(80)
        #expect(client.calls == ["config-set 95", "auto", "config-set 80", "auto"])
        #expect(client.handle.stops == 1)
        #expect(model.threshold == 80)
    }

    @Test func auto_events_notify_like_menubar_py() throws {
        let ui = FakeUI()
        let (model, _) = makeModel(FakeClient(), ui)
        model.handle(try #require(AutoEvent.parse(line: #"{"event":"poll"}"#)))
        model.handle(try #require(AutoEvent.parse(line: #"{"event":"all-exhausted","earliestResetAt":"2026-07-01T00:00:00Z"}"#)))
        #expect(ui.notifications == ["All accounts exhausted: all accounts exhausted; earliest reset 2026-07-01T00:00:00Z"])
    }

    @Test func unexpected_auto_exit_notifies_once() throws {
        let ui = FakeUI()
        let (model, _) = makeModel(FakeClient(), ui)
        model.toggleAutoSwitch()
        model.handle(try #require(AutoEvent.parse(line: #"{"schemaVersion":1,"error":{"type":"ConfigError","message":"boom"}}"#)))
        model.autoExited(status: 1, stderr: "")
        #expect(ui.notifications == ["Auto-switch failed to start: boom"])
        #expect(!model.autoRunning)
    }
}
