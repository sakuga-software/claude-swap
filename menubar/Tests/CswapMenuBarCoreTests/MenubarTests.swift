// Port of tests/test_menubar.py. Each test keeps the Python test name.
import Foundation
import Testing
@testable import CswapMenuBarCore

private let NOW = 1_000_000.0

private func iso(_ delta: Double) -> String {
    ISODate.string(NOW + delta)
}

private func w(_ pct: Double? = nil, resets delta: Double? = nil, clock: String? = nil, name: String? = nil) -> UsageWindow {
    UsageWindow(pct: pct, resetsAt: delta.map { NOW + $0 }, clock: clock, name: name)
}

private let USAGE = Usage(
    fiveHour: UsageWindow(pct: 42.0),
    sevenDay: UsageWindow(pct: 18.0),
    spend: UsageWindow(pct: 30.0)
)

private func u(_ usage: Usage) -> DisplayUsage { .usage(usage) }

private func withScoped(_ base: Usage, _ scoped: [UsageWindow]) -> Usage {
    var copy = base
    copy.scoped = scoped
    return copy
}

private func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("cswap-menubar-tests-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}


@Test(.disabled("rumps glue: the .app bundle of scripts/bundle.sh gives the bundle identifier"))
func test_notification_identity_creates_and_preserves_info_plist() {}

@Test(.disabled("rumps glue: the .app bundle of scripts/bundle.sh gives the bundle identifier"))
func test_notification_identity_heals_corrupt_info_plist() {}

@Test(.disabled("rumps glue: the .app bundle of scripts/bundle.sh gives the bundle identifier"))
func test_notification_identity_is_noop_off_macos() {}


@Test func test_settings_defaults_when_file_missing() {
    let s = MenuBarSettings.load(tempDir().appendingPathComponent("nope.json"))
    #expect(s.showAccountName == true)
    #expect(s.titlePct == "both")
    #expect(s.refreshInterval == 60)
    #expect(s.autoSwitchEnabled == false)
}

@Test func test_settings_round_trip() throws {
    let path = tempDir().appendingPathComponent("menubar_settings.json")
    let original = MenuBarSettings(
        showAccountName: false, titlePct: "5h", refreshInterval: 300, autoSwitchEnabled: true
    )
    try original.save(path)
    #expect(MenuBarSettings.load(path) == original)
}

@Test func test_settings_corrupt_file_falls_back_to_defaults() throws {
    let path = tempDir().appendingPathComponent("menubar_settings.json")
    try "{ this is not json".write(to: path, atomically: true, encoding: .utf8)
    #expect(MenuBarSettings.load(path) == MenuBarSettings())
}

@Test func test_settings_ignores_unknown_and_bad_types() throws {
    let path = tempDir().appendingPathComponent("menubar_settings.json")
    try #"{"refresh_interval": "fast", "bogus": 1, "show_account_name": false}"#
        .write(to: path, atomically: true, encoding: .utf8)
    let s = MenuBarSettings.load(path)
    #expect(s.refreshInterval == 60)
    #expect(s.showAccountName == false)
}


@Test func test_tightest_pct_uses_max_window() {
    #expect(Formatting.tightestPct(u(USAGE)) == 42.0)
}

@Test func test_tightest_pct_none_for_non_dict_or_empty() {
    #expect(Formatting.tightestPct(.note("no credentials")) == nil)
    #expect(Formatting.tightestPct(.unavailable) == nil)
    #expect(Formatting.tightestPct(u(Usage(spend: UsageWindow(pct: 90.0)))) == nil)
}

@Test func test_usage_summary_dict() {
    #expect(Formatting.usageSummary(u(USAGE)) == "5h 42% · 7d 18% · $ 30%")
}

@Test func test_usage_summary_partial_windows() {
    #expect(Formatting.usageSummary(u(Usage(fiveHour: UsageWindow(pct: 5.0)))) == "5h 5%")
}

@Test func test_usage_summary_includes_scoped_model_limits() {
    let usage = Usage(
        fiveHour: UsageWindow(pct: 82.0), sevenDay: UsageWindow(pct: 12.0),
        spend: UsageWindow(pct: 30.0), scoped: [UsageWindow(pct: 4.0, name: "Fable")]
    )
    #expect(Formatting.usageSummary(u(usage)) == "5h 82% · 7d 12% · Fable 4% · $ 30%")
}

@Test func test_usage_summary_scoped_over_limit_marker() {
    let usage = Usage(scoped: [UsageWindow(pct: 100.0, name: "Fable")])
    #expect(Formatting.usageSummary(u(usage)) == "Fable 100% (!)")
}

@Test func test_usage_summary_scoped_multiple_and_countdown() {
    let usage = Usage(scoped: [
        UsageWindow(pct: 4.0, resetsAtISO: iso(2 * 3600), name: "Fable"),
        UsageWindow(pct: 55.0, name: "Opus"),
    ])
    #expect(Formatting.usageSummary(u(usage), now: NOW) == "Fable 4% (2h 0m) · Opus 55%")
}

@Test func test_usage_summary_string_sentinel_passthrough() {
    #expect(Formatting.usageSummary(.note("no credentials")) == "no credentials")
}

@Test func test_usage_summary_none() {
    #expect(Formatting.usageSummary(.unavailable) == "usage unavailable")
}

@Test func test_usage_summary_seven_day_ahead_of_pace_marker() {
    let usage = Usage(sevenDay: w(50.0, resets: 6 * 86400))
    #expect(Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW) == "7d 50% (ahead) (6d 0h)")
}

@Test func test_usage_summary_five_hour_never_shows_pace_marker() {
    let usage = Usage(fiveHour: w(90.0, resets: 4 * 3600))
    #expect(!Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW).contains("ahead"))
}

@Test func test_usage_summary_scoped_ahead_of_pace_marker() {
    let usage = Usage(scoped: [w(50.0, resets: 6 * 86400, name: "Fable")])
    #expect(Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW) == "Fable 50% (ahead) (6d 0h)")
}

@Test func test_usage_summary_maxed_scoped_marker_wins_over_pace() {
    let usage = Usage(scoped: [w(100.0, resets: 6 * 86400, name: "Fable")])
    let out = Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW)
    #expect(out.contains("(!)"))
    #expect(!out.contains("ahead"))
}

@Test func test_usage_summary_no_pace_marker_without_fetched_at() {
    let usage = Usage(sevenDay: w(50.0, resets: 6 * 86400))
    #expect(!Formatting.usageSummary(u(usage), now: NOW).contains("ahead"))
}

@Test func test_usage_summary_no_pace_marker_on_window_rolled_to_zero() {
    let usage = Usage(sevenDay: w(95.0, resets: -3 * 86400))
    let out = Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW - 4 * 86400)
    #expect(!out.contains("ahead"))
    #expect(out.contains("7d 0%"))
}

@Test func test_usage_summary_scoped_no_pace_marker_on_window_rolled_to_zero() {
    let usage = Usage(scoped: [w(95.0, resets: -3 * 86400, name: "Fable")])
    let out = Formatting.usageSummary(u(usage), now: NOW, fetchedAt: NOW - 4 * 86400)
    #expect(!out.contains("ahead"))
    #expect(out.contains("Fable 0%"))
}

@Test func test_format_account_label() {
    #expect(Formatting.formatAccountLabel(2, "loc@papaya.asia", u(USAGE))
        == "2  loc@papaya.asia  5h 42% · 7d 18% · $ 30%")
}

@Test func test_format_account_label_with_alias() {
    #expect(Formatting.formatAccountLabel(2, "loc@papaya.asia", u(USAGE), alias: "dev")
        == "2  dev  (loc@papaya.asia)  5h 42% · 7d 18% · $ 30%")
}

@Test func test_format_account_label_disabled_marker() {
    #expect(Formatting.formatAccountLabel(2, "loc@papaya.asia", u(USAGE), disabled: true)
        == "2  loc@papaya.asia  (disabled)  5h 42% · 7d 18% · $ 30%")
}


@Test func test_format_usage_log_full() {
    let usage = Usage(fiveHour: w(35.0, clock: "06:59"), sevenDay: w(55.0, clock: "Jun 29 21:59"))
    #expect(Formatting.formatUsageLog("a@x.com", u(usage))
        == "usage a@x.com: 5h 35% (resets 06:59) · 7d 55% (resets Jun 29 21:59)")
}

@Test func test_format_usage_log_without_clock() {
    let usage = Usage(fiveHour: w(0.0), sevenDay: w(12.0))
    #expect(Formatting.formatUsageLog("a@x.com", u(usage)) == "usage a@x.com: 5h 0% · 7d 12%")
}

@Test func test_format_usage_log_partial_window() {
    let usage = Usage(sevenDay: w(12.0, clock: "Jul 3"))
    #expect(Formatting.formatUsageLog("a@x.com", u(usage)) == "usage a@x.com: 7d 12% (resets Jul 3)")
}

@Test func test_format_usage_log_none_when_no_numeric_window() {
    #expect(Formatting.formatUsageLog("a@x.com", .unavailable) == nil)
    #expect(Formatting.formatUsageLog("a@x.com", .note("rate limited")) == nil)
    #expect(Formatting.formatUsageLog("a@x.com", u(Usage(spend: w(5.0)))) == nil)
}

@Test func test_usage_log_key_ignores_clock_tracks_pct() {
    let u1 = u(Usage(fiveHour: w(35.0, clock: "06:59"), sevenDay: w(55.0)))
    let u2 = u(Usage(fiveHour: w(35.0, clock: "07:59"), sevenDay: w(55.0)))
    let u3 = u(Usage(fiveHour: w(36.0), sevenDay: w(55.0)))
    #expect(Formatting.usageLogKey(u1) == Formatting.usageLogKey(u2))
    #expect(Formatting.usageLogKey(u1) != Formatting.usageLogKey(u3))
    #expect(Formatting.usageLogKey(.unavailable) == Formatting.UsageLogKey(fiveHour: nil, sevenDay: nil))
}


@Test func test_format_title_name_and_5h() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "5h")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ loc · 42%")
}

@Test func test_format_title_prefers_alias_over_local_part() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "off")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s, alias: "dev") == "⇄ dev")
}

@Test func test_format_title_name_only_when_pct_off() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "off")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ loc")
}

@Test func test_format_title_5h_only() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "5h")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ 42%")
}

@Test func test_format_title_7d_only() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "7d")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ 18%")
}

@Test func test_format_title_both_windows() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "both")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ 42% · 18%")
}

@Test func test_format_title_both_windows_with_name() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "both")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄ loc · 42% · 18%")
}

@Test func test_format_title_icon_only_when_off() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "off")
    #expect(Formatting.formatTitle("loc@papaya.asia", u(USAGE), s) == "⇄")
}

@Test func test_format_title_scoped_appends_model_limits() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "off", titleScoped: true)
    let usage = withScoped(USAGE, [UsageWindow(pct: 55.0, name: "Fable")])
    #expect(Formatting.formatTitle("loc@papaya.asia", u(usage), s) == "⇄ loc · Fable 55%")
}

@Test func test_format_title_scoped_after_windows_multiple_models() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "both", titleScoped: true)
    let usage = withScoped(USAGE, [UsageWindow(pct: 55.0, name: "Fable"), UsageWindow(pct: 7.0, name: "Opus")])
    #expect(Formatting.formatTitle("loc@papaya.asia", u(usage), s) == "⇄ 42% · 18% · Fable 55% · Opus 7%")
}

@Test func test_format_title_scoped_off_by_default() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "off")
    let usage = withScoped(USAGE, [UsageWindow(pct: 55.0, name: "Fable")])
    #expect(!s.titleScoped)
    #expect(Formatting.formatTitle("loc@papaya.asia", u(usage), s) == "⇄")
}

@Test func test_format_title_icon_only_when_no_active_account() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "both")
    #expect(Formatting.formatTitle(nil, .unavailable, s) == "⇄")
}

@Test func test_format_title_truncates_long_local_part() {
    let s = MenuBarSettings(showAccountName: true, titlePct: "off")
    #expect(Formatting.formatTitle("averylonglocalpart@example.com", .unavailable, s) == "⇄ averylonglo*")
}

@Test func test_format_title_both_drops_unavailable_windows() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "both")
    #expect(Formatting.formatTitle("loc@x.com", .note("no credentials"), s) == "⇄")
}

@Test func test_format_title_both_keeps_available_window() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "both")
    #expect(Formatting.formatTitle("loc@x.com", u(Usage(fiveHour: w(9.0))), s) == "⇄ 9%")
}


@Test func test_resets_at_ts_orders_and_handles_missing() {
    let early = UsageWindow(resetsAtISO: "2026-06-24T07:00:00+00:00")
    let late = UsageWindow(resetsAtISO: "2026-06-26T07:00:00+00:00")
    #expect(Formatting.resetsAtTs(early) < Formatting.resetsAtTs(late))
    #expect(Formatting.resetsAtTs(UsageWindow(pct: 5.0)) == .infinity)
    #expect(Formatting.resetsAtTs(UsageWindow(resetsAtISO: "garbage")) == .infinity)
    #expect(Formatting.resetsAtTs(nil) == .infinity)
}

@Test func test_live_countdown_formats_from_resets_at() {
    #expect(Formatting.liveCountdown(UsageWindow(resetsAtISO: iso(9 * 3600 + 5 * 60)), now: NOW) == "9h 5m")
    #expect(Formatting.liveCountdown(UsageWindow(resetsAtISO: iso(86400 + 19 * 3600)), now: NOW) == "1d 19h")
    #expect(Formatting.liveCountdown(UsageWindow(resetsAtISO: iso(34 * 60)), now: NOW) == "34m")
}

@Test func test_live_countdown_none_when_passed_or_missing() {
    #expect(Formatting.liveCountdown(UsageWindow(resetsAtISO: iso(-60)), now: NOW) == nil)
    #expect(Formatting.liveCountdown(UsageWindow(pct: 5.0), now: NOW) == nil)
    #expect(Formatting.liveCountdown(nil, now: NOW) == nil)
}

@Test func test_usage_summary_live_countdown_from_resets_at() {
    let usage = Usage(
        fiveHour: UsageWindow(pct: 42.0, resetsAtISO: iso(2 * 3600 + 33 * 60)),
        sevenDay: UsageWindow(pct: 18.0, resetsAtISO: iso(86400 + 19 * 3600)),
        spend: UsageWindow(pct: 30.0)
    )
    #expect(Formatting.usageSummary(u(usage), now: NOW) == "5h 42% (2h 33m) · 7d 18% (1d 19h) · $ 30%")
}

@Test func test_usage_summary_omits_countdown_when_passed_or_missing() {
    let usage = Usage(fiveHour: UsageWindow(pct: 53.0, resetsAtISO: iso(-60)), sevenDay: UsageWindow(pct: 8.0))
    #expect(Formatting.usageSummary(u(usage), now: NOW) == "5h 53% · 7d 8%")
}


private let SWITCH_LOG = """
    2026-06-27 00:57:50,178 - INFO - Switched from account 1 to 3
    2026-06-27 02:06:21,302 - INFO - usage a@x.com: 5h 10%
    2026-06-27 02:10:00,000 - INFO - Switched from account 3 to 1

    """

@Test func test_parse_switch_history_most_recent_first() {
    #expect(Formatting.parseSwitchHistory(SWITCH_LOG) == [
        "3 → 1   2026-06-27 02:10",
        "1 → 3   2026-06-27 00:57",
    ])
}

@Test func test_parse_switch_history_respects_limit() {
    let lines = (1...5)
        .map { "2026-06-27 0\($0):00:00,000 - INFO - Switched from account 1 to 2" }
        .joined(separator: "\n")
    let out = Formatting.parseSwitchHistory(lines, limit: 2)
    #expect(out.count == 2)
    #expect(out[0] == "1 → 2   2026-06-27 05:00")
}

@Test func test_parse_switch_history_empty_or_no_matches() {
    #expect(Formatting.parseSwitchHistory("") == [])
    #expect(Formatting.parseSwitchHistory("nothing relevant here") == [])
}

// The Python tests use fakes of AccountsSnapshot. These tests use rows of
// `cswap list --json`, which is the input of the Swift adapter.

@Test func test_account_display_usage_sentinel_note_last_good_or_none() {
    let lg = Usage(fiveHour: w(5.0))
    #expect(SnapshotAdapter.accountDisplayUsage(AccountRow(number: 1, email: "a@x.com", usageStatus: "api_key"))
        == .note("API key (no quota)"))
    #expect(SnapshotAdapter.accountDisplayUsage(AccountRow(number: 1, email: "a@x.com", usageStatus: "ok", usage: lg))
        == .usage(lg))
    #expect(SnapshotAdapter.accountDisplayUsage(
        AccountRow(number: 1, email: "a@x.com", usageStatus: "unavailable", lastGoodUsage: lg)) == .usage(lg))
    #expect(SnapshotAdapter.accountDisplayUsage(AccountRow(number: 1, email: "a@x.com", usageStatus: "unavailable"))
        == .unavailable)
}

@Test func test_adapt_snapshot_shape_and_active_selection() {
    let lg = Usage(fiveHour: w(10.0), sevenDay: w(20.0))
    let payload = ListPayload(activeAccountNumber: 1, accounts: [
        AccountRow(number: 1, email: "a@x.com", active: true, usageStatus: "ok", usage: lg,
                   usageFetchedAt: "1970-01-01T00:02:03Z"),
        AccountRow(number: 2, email: "b@x.com", usageStatus: "api_key", disabled: true),
    ])
    let snap = SnapshotAdapter.adaptSnapshot(payload)
    #expect(snap.activeEmail == "a@x.com")
    #expect(snap.activeUsage == .usage(lg))
    #expect(snap.activeAlias == "")
    #expect(snap.accounts[0] == MenuAccount(
        number: 1, email: "a@x.com", isActive: true, display: .usage(lg), lastGood: lg,
        alias: "", disabled: false, fetchedAt: 123.0))
    #expect(snap.accounts[1] == MenuAccount(
        number: 2, email: "b@x.com", isActive: false, display: .note("API key (no quota)"), lastGood: nil,
        alias: "", disabled: true, fetchedAt: nil))
}

@Test func test_adapt_snapshot_empty() {
    #expect(SnapshotAdapter.adaptSnapshot(ListPayload(accounts: [])) == MenuSnapshot.EMPTY_SNAPSHOT)
}


@Test func test_rolled_weekly_window_advances_passed_reset() throws {
    let window = UsageWindow(pct: 95.0, resetsAtISO: iso(-3 * 86400), countdown: "stale", clock: "old")
    let rolled = try #require(Formatting.rolledWeeklyWindow(window, now: NOW))
    #expect(rolled.pct == 0.0)
    #expect(abs(Formatting.resetsAtTs(rolled) - (NOW + 4 * 86400)) < 1)
    #expect(rolled.countdown == nil && rolled.clock == nil)
}

@Test func test_rolled_weekly_window_advances_multiple_missed_weeks() throws {
    let window = UsageWindow(pct: 80.0, resetsAtISO: iso(-10 * 86400))
    let rolled = try #require(Formatting.rolledWeeklyWindow(window, now: NOW))
    #expect(abs(Formatting.resetsAtTs(rolled) - (NOW + 4 * 86400)) < 1)
}

@Test func test_rolled_weekly_window_leaves_future_or_unknown_untouched() {
    let future = UsageWindow(pct: 42.0, resetsAtISO: iso(2 * 86400))
    #expect(Formatting.rolledWeeklyWindow(future, now: NOW) == future)
    let noReset = UsageWindow(pct: 42.0)
    #expect(Formatting.rolledWeeklyWindow(noReset, now: NOW) == noReset)
    #expect(Formatting.rolledWeeklyWindow(nil, now: NOW) == nil)
}

@Test func test_usage_summary_reflects_passed_weekly_reset() {
    let usage = Usage(fiveHour: w(10.0), sevenDay: UsageWindow(pct: 95.0, resetsAtISO: iso(-86400)))
    #expect(Formatting.usageSummary(u(usage), now: NOW) == "5h 10% · 7d 0% (6d 0h)")
}

@Test func test_usage_summary_scoped_reflects_passed_weekly_reset() {
    let usage = Usage(scoped: [UsageWindow(pct: 100.0, resetsAtISO: iso(-86400), name: "Fable")])
    #expect(Formatting.usageSummary(u(usage), now: NOW) == "Fable 0% (6d 0h)")
}

@Test func test_format_title_reflects_passed_weekly_reset() {
    let s = MenuBarSettings(showAccountName: false, titlePct: "7d")
    let usage = Usage(sevenDay: UsageWindow(pct: 95.0, resetsAtISO: iso(-86400)))
    #expect(Formatting.formatTitle("a@x.com", u(usage), s, now: NOW) == "⇄ 0%")
}


@Test(.disabled("rumps glue: the Swift app has no optional rumps dependency"))
func test_run_without_rumps_raises_clean_error() {}

@Suite struct TestFrameworkBuildWarning {
    // A CPython framework build does not draw a status item on macOS 26.
    // A native Swift app has no such build, so these tests do not apply.
    @Test(.disabled("CPython framework build only")) func test_silent_on_a_build_that_draws() {}
    @Test(.disabled("CPython framework build only")) func test_silent_on_macos_where_framework_builds_still_draw() {}
    @Test(.disabled("CPython framework build only")) func test_warns_from_macos_26_onwards() {}
    @Test(.disabled("CPython framework build only")) func test_unreadable_macos_version_stays_quiet() {}
    @Test(.disabled("CPython framework build only")) func test_the_wording_does_not_overclaim() {}
    @Test(.disabled("CPython framework build only")) func test_warns_on_a_framework_build() {}
    @Test(.disabled("CPython framework build only")) func test_the_version_is_not_the_gate() {}
    @Test(.disabled("CPython framework build only")) func test_uv_gets_a_uv_remedy() {}
    @Test(.disabled("CPython framework build only")) func test_pipx_is_not_handed_a_uv_command() {}
    @Test(.disabled("CPython framework build only")) func test_unknown_install_method_still_says_what_to_aim_for() {}
    @Test(.disabled("CPython framework build only")) func test_the_warning_names_the_silence() {}
}
