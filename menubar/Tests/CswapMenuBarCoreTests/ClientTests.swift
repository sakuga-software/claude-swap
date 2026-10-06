// Tests of the CLI boundary. They have no Python counterpart.
// They run only Tests/Fixtures/fake-cswap.sh, never a real `cswap`.
import Foundation
import Testing
@testable import CswapMenuBarCore

private let fakeCswap = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/fake-cswap.sh")

private func fakeClient(_ extra: [String: String] = [:]) -> ProcessCswapClient {
    var env = ["HOME": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin"]
    env.merge(extra) { $1 }
    return ProcessCswapClient(executable: fakeCswap, environment: env, timeout: 20)
}

private func tempFile(_ name: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("cswap-\(UUID().uuidString)-\(name)")
}

@Suite struct JSONDecoding {
    @Test func list_payload_decodes_documented_shape_and_ignores_unknown_fields() async throws {
        let payload = try await fakeClient().list()
        #expect(payload.activeAccountNumber == 1)
        #expect(payload.accounts.map(\.number) == [1, 2, 3])
        let first = payload.accounts[0]
        #expect(first.alias == "work")
        #expect(first.usage?.fiveHour?.pct == 42.0)
        #expect(first.usage?.scoped?.first?.name == "Fable")
        #expect(first.usage?.sevenDay?.resetsAt != nil)
        #expect(payload.accounts[1].disabled)
        #expect(payload.accounts[2].usageError == "http-429")

        let snap = SnapshotAdapter.adaptSnapshot(payload)
        #expect(snap.activeEmail == "alice@example.com")
        #expect(snap.activeAlias == "work")
        #expect(snap.accounts[1].display == .note(SENTINEL_NOTES["token_expired"]!))
        #expect(snap.accounts[1].lastGood?.fiveHour?.pct == 90.0)
        #expect(snap.accounts[2].display == .unavailable)
    }

    @Test func iso_parser_accepts_python_and_z_forms() {
        #expect(ISODate.timestamp("1970-01-01T00:00:10Z") == 10)
        #expect(ISODate.timestamp("1970-01-01T00:00:10+00:00") == 10)
        #expect(ISODate.timestamp("1970-01-01T01:00:10+01:00") == 10)
        #expect(ISODate.timestamp("1970-01-01T00:00:10.500000+00:00") == 10.5)
        #expect(ISODate.timestamp("garbage") == nil)
        #expect(ISODate.timestamp(ISODate.string(1_000_000)) == 1_000_000)
    }

    @Test func settings_file_matches_python_json_dumps() {
        #expect(MenuBarSettings().jsonText() == """
            {
              "show_account_name": true,
              "title_pct": "both",
              "title_scoped": false,
              "refresh_interval": 60,
              "auto_switch_enabled": false
            }
            """)
    }

    @Test func settings_reject_float_interval_like_python_isinstance_int() throws {
        let path = tempFile("s.json")
        try #"{"refresh_interval": 30.0, "title_scoped": 1}"#.write(to: path, atomically: true, encoding: .utf8)
        let s = MenuBarSettings.load(path)
        #expect(s.refreshInterval == 60)
        #expect(s.titleScoped == false)
    }
}

@Suite struct ProcessClient {
    @Test func switch_commands_pass_the_documented_arguments() async throws {
        let log = tempFile("log.txt")
        let client = fakeClient(["FAKE_CSWAP_LOG": log.path])
        let direct = try await client.switchTo(2)
        #expect(direct.switched && direct.to?.number == "2")
        _ = try await client.switchRotate(strategy: "best")
        _ = try await client.switchRotate(strategy: nil)
        try await client.setDisabled(2, disabled: true)
        try await client.setDisabled(2, disabled: false)
        try await client.setAutoSwitchThreshold(95)
        #expect(try await client.autoSwitchThreshold() == 90.0)
        let lines = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(lines == [
            "switch 2 --json",
            "switch --strategy best --json",
            "switch --json",
            "disable 2",
            "enable 2",
            "config set autoswitch.threshold 95",
            "config get autoswitch.threshold --json",
        ])
    }

    @Test func remove_confirms_on_stdin() async throws {
        let log = tempFile("log.txt")
        try await fakeClient(["FAKE_CSWAP_LOG": log.path]).remove(3)
        let text = try String(contentsOf: log, encoding: .utf8)
        #expect(text == "remove 3\nstdin: y\n")
    }

    @Test func add_token_sends_the_token_on_stdin_not_argv() async throws {
        let log = tempFile("log.txt")
        try await fakeClient(["FAKE_CSWAP_LOG": log.path]).addFromToken(token: "sk-ant-oat01-secret", email: "t@x.com")
        let text = try String(contentsOf: log, encoding: .utf8)
        #expect(text == "add-token - --email t@x.com\nstdin-token-length: 19\n")
        #expect(!text.contains("secret"))
    }

    @Test func json_error_envelope_becomes_cswap_error() async {
        await #expect(throws: CswapError(type: "AccountNotFoundError", message: "fake failure of switch")) {
            _ = try await fakeClient(["FAKE_CSWAP_FAIL": "switch"]).switchTo(9)
        }
    }

    @Test func plain_command_error_comes_from_stderr() async {
        await #expect(throws: CswapError(message: "fake failure of disable")) {
            try await fakeClient(["FAKE_CSWAP_FAIL": "disable"]).setDisabled(1, disabled: true)
        }
    }

    @Test func auto_process_streams_events_and_stops_on_sigterm() async throws {
        let events = EventBox()
        let handle = try fakeClient(["FAKE_CSWAP_AUTO_PERIOD": "0.2"]).startAuto(
            onEvent: { events.append($0) },
            onExit: { _, _ in events.markExited() }
        )
        for _ in 0..<100 where events.kinds.count < 2 {
            try await Task.sleep(for: .milliseconds(50))
        }
        handle.stopAndWait()
        #expect(Array(events.kinds.prefix(2)) == ["poll", "switch"])
        #expect(!events.exited, "a requested stop must not report an exit")
        #expect((handle as? AutoSwitchProcess)?.isRunning == false)
    }
}

private final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _kinds: [String] = []
    private var _exited = false
    var kinds: [String] { lock.withLock { _kinds } }
    var exited: Bool { lock.withLock { _exited } }
    func append(_ e: AutoEvent) { lock.withLock { _kinds.append(e.event ?? "?") } }
    func markExited() { lock.withLock { _exited = true } }
}

@Suite struct Helpers {
    @Test func error_message_takes_last_error_line_without_color() {
        let stderr = "\u{1B}[33mWarning: x\u{1B}[0m\n\u{1B}[31mError: No account found with identifier: 9\u{1B}[0m\n"
        #expect(CswapOutput.errorMessage(stderr: stderr, status: 1) == "No account found with identifier: 9")
        #expect(CswapOutput.errorMessage(stderr: "usage: cswap\ncswap: error: bad flag\n", status: 2) == "cswap: error: bad flag")
        #expect(CswapOutput.errorMessage(stderr: "", status: 3) == "cswap exited with status 3")
    }

    @Test func locator_prefers_argument_then_env_then_path() {
        let env = ["CSWAP_BIN": "/env/cswap", "PATH": "/a:/b", "HOME": "/h"]
        #expect(CswapLocator.resolve(arguments: ["app", "--cswap", "/arg/cswap"], environment: env, isExecutable: { _ in false })?.path == "/arg/cswap")
        #expect(CswapLocator.resolve(arguments: ["app", "--cswap=/eq/cswap"], environment: env, isExecutable: { _ in false })?.path == "/eq/cswap")
        #expect(CswapLocator.resolve(arguments: ["app"], environment: env, isExecutable: { _ in false })?.path == "/env/cswap")
        let pathEnv = ["PATH": "/a:/b", "HOME": "/h"]
        #expect(CswapLocator.resolve(arguments: ["app"], environment: pathEnv, isExecutable: { $0 == "/b/cswap" })?.path == "/b/cswap")
        #expect(CswapLocator.resolve(arguments: ["app"], environment: pathEnv, isExecutable: { $0 == "/h/.local/bin/cswap" })?.path == "/h/.local/bin/cswap")
        #expect(CswapLocator.resolve(arguments: ["app"], environment: pathEnv, isExecutable: { _ in false }) == nil)
    }

    @Test func paths_default_to_legacy_backup_root_on_macos() {
        let p = CswapPaths.resolve(arguments: ["app"], environment: ["HOME": "/h"])
        #expect(p.settingsFile.path == "/h/.claude-swap-backup/menubar_settings.json")
        #expect(p.logFile.path == "/h/.claude-swap-backup/claude-swap.log")
        #expect(CswapPaths.resolve(arguments: ["app", "--backup-dir", "/x"], environment: ["HOME": "/h"]).backupDir.path == "/x")
        #expect(CswapPaths.resolve(arguments: ["app"], environment: ["HOME": "/h", "CSWAP_BACKUP_DIR": "/y"]).backupDir.path == "/y")
    }

    @Test func line_splitter_keeps_partial_lines() {
        var s = LineSplitter()
        #expect(s.feed(Data("{\"a\":1}\n{\"b\"".utf8)) == ["{\"a\":1}"])
        #expect(s.feed(Data(":2}\n\n".utf8)) == ["{\"b\":2}"])
        #expect(s.feed(Data("tail".utf8)) == [])
        #expect(s.finish() == ["tail"])
    }

    @Test func auto_event_human_matches_autoswitch_py() throws {
        let sw = try #require(AutoEvent.parse(line: #"{"schemaVersion":1,"event":"switch","ts":"t","trigger":"proactive","from":{"number":1,"email":"a@x.com"},"to":{"number":3,"email":"c@x.com"},"warnings":[],"dryRun":false}"#))
        #expect(sw.human() == "Switched Account-1 -> Account-3 (c@x.com) (proactive)")
        #expect(sw.notification() == .init(title: "claude-swap", subtitle: "Auto-switched account", body: sw.human()))
        #expect(sw.changesActiveAccount)

        let dry = try #require(AutoEvent.parse(line: #"{"event":"switch","trigger":"at-limit","from":null,"to":{"number":2,"email":"b@x.com"},"dryRun":true}"#))
        #expect(dry.human() == "[dry-run] would switch (none) -> Account-2 (b@x.com) (at-limit)")
        #expect(dry.notification() == nil)

        let q = try #require(AutoEvent.parse(line: #"{"event":"account-quarantined","number":"2","email":"b@x.com","reason":"invalid_grant"}"#))
        #expect(q.human() == "Account-2 (b@x.com) quarantined: invalid_grant. Log in with it and run 'cswap --add-account --slot 2' to recover.")
        #expect(q.notification()?.subtitle == "Account quarantined")

        let ex = try #require(AutoEvent.parse(line: #"{"event":"all-exhausted","earliestResetAt":null}"#))
        #expect(ex.human() == "all accounts exhausted; no reset time known")
        #expect(ex.notification()?.subtitle == "All accounts exhausted")

        let cw = try #require(AutoEvent.parse(line: #"{"event":"config-warning","message":"no account reports Fable"}"#))
        #expect(cw.notification() == .init(title: "claude-swap", subtitle: "Configuration warning", body: "warning: no account reports Fable"))

        let err = try #require(AutoEvent.parse(line: #"{"schemaVersion":1,"error":{"type":"ConfigError","message":"boom"}}"#))
        #expect(err.notification() == .init(title: "claude-swap", subtitle: "Auto-switch failed to start", body: "boom"))

        #expect(try #require(AutoEvent.parse(line: #"{"event":"poll","headroomPct":{"1":50}}"#)).notification() == nil)
        #expect(try #require(AutoEvent.parse(line: #"{"event":"some-future-kind","x":1}"#)).notification() == nil)
        #expect(AutoEvent.parse(line: "not json") == nil)
    }
}
