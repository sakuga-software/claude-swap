import Foundation
import Observation

/// Dialogs that the model needs from the UI.
@MainActor
public protocol Prompter: AnyObject {
    func alert(title: String, message: String)
    /// Returns true if the user selects `ok`.
    func confirm(title: String, message: String, ok: String, cancel: String) -> Bool
    /// Returns the text, or nil if the user cancels.
    func askText(title: String, message: String, ok: String, cancel: String, secure: Bool) -> String?
}

@MainActor
public protocol Notifier: AnyObject {
    func notify(title: String, subtitle: String, body: String)
}

/// The state and the actions of the menu bar. It holds no account logic:
/// each action runs one `cswap` command through `CswapClient`.
@MainActor
@Observable
public final class MenuBarModel {
    public private(set) var settings: MenuBarSettings
    public private(set) var snapshot = MenuSnapshot.EMPTY_SNAPSHOT
    public private(set) var history: [String] = []
    /// The `autoswitch.threshold` setting, as an integer. 0 if unknown.
    public private(set) var threshold = 0
    public private(set) var now: Double
    public private(set) var autoRunning = false
    public private(set) var refreshing = false

    @ObservationIgnored public let paths: CswapPaths
    @ObservationIgnored private let client: CswapClient
    @ObservationIgnored private weak var prompter: Prompter?
    @ObservationIgnored private weak var notifier: Notifier?
    @ObservationIgnored private let claudeConfigFile: URL?
    @ObservationIgnored private let clock: @Sendable () -> Double
    @ObservationIgnored private var auto: AutoSwitchHandle?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var configMtime: Date?
    @ObservationIgnored private var checkingActive = false
    @ObservationIgnored private var autoReportedStartError = false

    public init(
        client: CswapClient,
        paths: CswapPaths,
        prompter: Prompter?,
        notifier: Notifier?,
        claudeConfigFile: URL? = nil,
        clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
    ) {
        self.client = client
        self.paths = paths
        self.prompter = prompter
        self.notifier = notifier
        self.claudeConfigFile = claudeConfigFile
        self.clock = clock
        self.settings = MenuBarSettings.load(paths.settingsFile)
        self.now = clock()
    }


    public var title: String {
        Formatting.formatTitle(
            snapshot.activeEmail, snapshot.activeUsage, settings, now: now, alias: snapshot.activeAlias
        )
    }

    public func accountLabel(_ account: MenuAccount) -> String {
        Formatting.formatAccountLabel(
            account.number, account.email, account.display, now: now,
            alias: account.alias, disabled: account.disabled, fetchedAt: account.fetchedAt
        )
    }

    /// The label of a row in the "Remove account" and "Disable / enable" submenus.
    public func shortLabel(_ account: MenuAccount) -> String {
        account.alias.isEmpty
            ? "\(account.number)  \(account.email)"
            : "\(account.number)  \(account.alias)  (\(account.email))"
    }


    /// Starts the first refresh, the timers and, if enabled, the auto-switch process.
    public func start() {
        refresh()
        restartRefreshLoop()
        syncTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.syncTick()
            }
        }
        if settings.autoSwitchEnabled {
            startAuto()
        }
    }

    /// Stops the timers and the auto-switch process. Call it before the app exits.
    public func shutdown() {
        refreshTask?.cancel()
        syncTask?.cancel()
        stopAuto(wait: true)
    }

    private func restartRefreshLoop() {
        refreshTask?.cancel()
        let interval = settings.refreshInterval
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(max(interval, 1)))
                if Task.isCancelled { return }
                self?.refresh()
            }
        }
    }

    func syncTick() {
        now = clock()
        detectActiveChange()
    }


    /// Runs `cswap list --json` in the background. One refresh runs at a time.
    /// If it fails, the menu keeps the last good snapshot.
    public func refresh() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            await refreshNow()
        }
    }

    /// The body of `refresh()`, which tests can wait for.
    public func refreshNow() async {
        refreshing = true
        defer {
            refreshing = false
            now = clock()
            history = Formatting.parseSwitchHistory(readLog())
        }
        if let payload = try? await client.list() {
            snapshot = SnapshotAdapter.adaptSnapshot(payload)
        }
        await loadThreshold()
    }

    private func readLog() -> String {
        (try? String(contentsOf: paths.logFile, encoding: .utf8)) ?? ""
    }

    /// Sees a switch from another tool within about one second. A change of
    /// the Claude Code config file is cheap to see, but Claude Code writes
    /// the file often. Thus the model refreshes only if the active email changes.
    func detectActiveChange() {
        guard let file = claudeConfigFile, !refreshing, !checkingActive else { return }
        guard let mtime = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
        else { return }
        if mtime == configMtime { return }
        let first = configMtime == nil
        configMtime = mtime
        if first { return }
        checkingActive = true
        Task {
            defer { checkingActive = false }
            guard let status = try? await client.status(), let email = status.active?.email else { return }
            if email != snapshot.activeEmail {
                refresh()
            }
        }
    }


    /// Runs `body`. If it throws, the user sees the error in an alert.
    @discardableResult
    private func guarded(_ body: () async throws -> Void) async -> Bool {
        do {
            try await body()
            return true
        } catch {
            prompter?.alert(title: "claude-swap", message: error.localizedDescription)
            return false
        }
    }

    private func notifySwitched(_ result: SwitchResult) {
        if result.switched {
            notifier?.notify(title: "claude-swap", subtitle: "Account switched", body: SWITCHED_NOTIFICATION_BODY)
        } else {
            notifier?.notify(title: "claude-swap", subtitle: "No switch", body: result.message ?? "")
        }
    }

    public func switchTo(_ number: Int) async {
        var result: SwitchResult?
        if await guarded({ result = try await client.switchTo(number) }), let result {
            notifySwitched(result)
            await refreshNow()
        }
    }

    /// `strategy` is nil to rotate, "best" or "next-available".
    public func switchWith(strategy: String?) async {
        var result: SwitchResult?
        if await guarded({ result = try await client.switchRotate(strategy: strategy) }), let result {
            notifySwitched(result)
            await refreshNow()
        }
    }

    public func toggleDisabled(_ account: MenuAccount) async {
        if await guarded({ try await client.setDisabled(account.number, disabled: !account.disabled) }) {
            await refreshNow()
        }
    }

    public func remove(_ number: Int) async {
        guard prompter?.confirm(
            title: "Remove account", message: "Remove account \(number)?", ok: "Remove", cancel: "Cancel"
        ) == true else { return }
        if await guarded({ try await client.remove(number) }) {
            await refreshNow()
        }
    }

    public func addFromLogin() async {
        if await guarded({ try await client.addFromLogin() }) {
            await refreshNow()
        }
    }

    public func addFromToken() async {
        guard let prompter else { return }
        guard let email = prompter.askText(
            title: "Add account from setup-token", message: "Email for this token:",
            ok: "Next", cancel: "Cancel", secure: false
        )?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty else { return }
        guard let token = prompter.askText(
            title: "Add account from setup-token", message: "Setup token (sk-ant-oat01-…):",
            ok: "Add", cancel: "Cancel", secure: true
        )?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else { return }
        if await guarded({ try await client.addFromToken(token: token, email: email) }) {
            await refreshNow()
        }
    }

    /// Captures the credentials of the current login again (`cswap add`).
    public func refreshCredentials() async {
        let status = try? await client.status()
        if let status, status.active == nil {
            prompter?.alert(title: "claude-swap", message: "No active Claude Code login detected. Log in first.")
            return
        }
        do {
            try await client.addFromLogin()
        } catch {
            prompter?.alert(title: "claude-swap", message: Self.refreshCredentialsMessage(error))
            return
        }
        await refreshNow()
    }

    /// The alert text of a failed `cswap add`. A credential that the app
    /// cannot read is almost always a Keychain block of a background agent.
    static func refreshCredentialsMessage(_ error: Error) -> String {
        let text = error.localizedDescription
        let type = (error as? CswapError)?.type
        if type == "CredentialReadError"
            || text.contains("Failed to read credentials for current account")
            || text.contains("Keychain is unreadable")
        {
            return KEYCHAIN_BLOCKED_MESSAGE
        }
        return text
    }

    public func revealLog(open: (URL) -> Void) {
        let exists = FileManager.default.fileExists(atPath: paths.logFile.path)
        open(exists ? paths.logFile : paths.backupDir)
    }


    private func saveSettings() {
        try? settings.save(paths.settingsFile)
    }

    public func toggleShowAccountName() {
        settings.showAccountName.toggle()
        saveSettings()
    }

    public func toggleTitleScoped() {
        settings.titleScoped.toggle()
        saveSettings()
    }

    public func setTitlePct(_ mode: String) {
        settings.titlePct = mode
        saveSettings()
    }

    public func setRefreshInterval(_ seconds: Int) {
        settings.refreshInterval = seconds
        saveSettings()
        if refreshTask != nil {
            restartRefreshLoop()
        }
    }

    public func toggleAutoSwitch() {
        settings.autoSwitchEnabled.toggle()
        saveSettings()
        if settings.autoSwitchEnabled {
            startAuto()
        } else {
            stopAuto(wait: false)
        }
    }

    /// Reads the threshold on each refresh, as menubar.py does on each menu
    /// rebuild. Thus a `cswap config set` in a terminal shows in the menu.
    func loadThreshold() async {
        let value = try? await client.autoSwitchThreshold()
        threshold = value.flatMap { $0 }.map { Int($0) } ?? 0
    }

    public func setThreshold(_ pct: Int) async {
        do {
            try await client.setAutoSwitchThreshold(pct)
        } catch {
            prompter?.alert(title: "claude-swap", message: "Couldn't set threshold: \(error.localizedDescription)")
            return
        }
        threshold = pct
        if auto != nil {
            stopAuto(wait: true)
            startAuto()
        }
    }


    func startAuto() {
        guard auto == nil else { return }
        autoReportedStartError = false
        do {
            auto = try client.startAuto(
                onEvent: { [weak self] event in
                    Task { @MainActor in self?.handle(event) }
                },
                onExit: { [weak self] status, stderr in
                    Task { @MainActor in self?.autoExited(status: status, stderr: stderr) }
                }
            )
            autoRunning = true
        } catch {
            notifier?.notify(title: "claude-swap", subtitle: "Auto-switch failed to start", body: error.localizedDescription)
        }
    }

    func stopAuto(wait: Bool) {
        guard let handle = auto else { return }
        auto = nil
        autoRunning = false
        if wait { handle.stopAndWait() } else { handle.stop() }
    }

    /// Reacts to one event of `cswap auto --json`.
    public func handle(_ event: AutoEvent) {
        if event.event == nil, event.error != nil {
            autoReportedStartError = true
        }
        if let n = event.notification() {
            notifier?.notify(title: n.title, subtitle: n.subtitle, body: n.body)
        }
        if event.changesActiveAccount {
            refresh()
        }
    }

    /// The auto-switch process stopped without a request. The setting stays
    /// on, as in menubar.py. Toggle it to start the process again.
    func autoExited(status: Int32, stderr: String) {
        auto = nil
        autoRunning = false
        guard status != 0, !autoReportedStartError else { return }
        let detail = CswapOutput.errorMessage(stderr: stderr, status: status)
        notifier?.notify(title: "claude-swap", subtitle: "Auto-switch stopped", body: detail)
    }
}
