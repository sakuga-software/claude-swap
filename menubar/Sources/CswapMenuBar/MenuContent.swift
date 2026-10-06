import AppKit
import CswapMenuBarCore
import SwiftUI

/// The menu. Its structure is the same as `rebuild_menu` in menubar.py.
struct MenuContent: View {
    let model: MenuBarModel

    var body: some View {
        let accounts = model.snapshot.accounts
        if accounts.isEmpty {
            Text("No managed accounts")
        }
        ForEach(accounts, id: \.number) { account in
            Toggle(model.accountLabel(account), isOn: action(account.isActive) {
                await model.switchTo(account.number)
            })
        }
        Divider()
        Button("Rotate to next") { run { await model.switchWith(strategy: nil) } }
        Button("Switch to best") { run { await model.switchWith(strategy: "best") } }
        Button("Next available") { run { await model.switchWith(strategy: "next-available") } }
        Divider()
        Menu("Add account") {
            Button("From current login") { run { await model.addFromLogin() } }
            Button("From setup-token…") { run { await model.addFromToken() } }
        }
        Menu("Disable / enable account") {
            if accounts.isEmpty { Text("No managed accounts") }
            ForEach(accounts, id: \.number) { account in
                Toggle(model.shortLabel(account), isOn: action(account.disabled) {
                    await model.toggleDisabled(account)
                })
            }
        }
        Menu("Remove account") {
            if accounts.isEmpty { Text("No managed accounts") }
            ForEach(accounts, id: \.number) { account in
                Button(model.shortLabel(account)) { run { await model.remove(account.number) } }
            }
        }
        Button("Refresh current credentials") { run { await model.refreshCredentials() } }
        Menu("Switch history") {
            if model.history.isEmpty {
                Text("No switches logged yet")
            }
            ForEach(Array(model.history.enumerated()), id: \.offset) { _, line in
                Text(line)
            }
            Divider()
            Button("Open full log…") { model.revealLog(open: reveal) }
        }
        Divider()
        SettingsMenu(model: model)
        Button("Refresh now") { model.refresh() }
        Button("Quit") { AppServices.shared.quit() }
    }

    /// A toggle binding that shows `state` and runs `body` on each click.
    private func action(_ state: Bool, _ body: @escaping @MainActor () async -> Void) -> Binding<Bool> {
        Binding(get: { state }, set: { _ in run(body) })
    }
}

struct SettingsMenu: View {
    let model: MenuBarModel

    var body: some View {
        Menu("Settings") {
            Toggle("Show account name in menu bar", isOn: Binding(
                get: { model.settings.showAccountName }, set: { _ in model.toggleShowAccountName() }
            ))
            Picker("Title percentage", selection: Binding(
                get: { model.settings.titlePct }, set: { model.setTitlePct($0) }
            )) {
                ForEach(TITLE_PCT_CHOICES, id: \.self) { mode in
                    Text(TITLE_PCT_LABELS[mode] ?? mode).tag(mode)
                }
            }
            .pickerStyle(.menu)
            Toggle("Show model limits in title", isOn: Binding(
                get: { model.settings.titleScoped }, set: { _ in model.toggleTitleScoped() }
            ))
            Picker("Refresh interval", selection: Binding(
                get: { model.settings.refreshInterval }, set: { model.setRefreshInterval($0) }
            )) {
                ForEach(REFRESH_CHOICES, id: \.self) { secs in
                    Text(REFRESH_LABELS[secs] ?? "\(secs) seconds").tag(secs)
                }
            }
            .pickerStyle(.menu)
            Toggle("Auto-switch accounts", isOn: Binding(
                get: { model.settings.autoSwitchEnabled }, set: { _ in model.toggleAutoSwitch() }
            ))
            Picker("Auto-switch threshold", selection: Binding(
                get: { model.threshold }, set: { pct in run { await model.setThreshold(pct) } }
            )) {
                ForEach(AUTO_THRESHOLD_CHOICES, id: \.self) { pct in
                    Text("\(pct)%").tag(pct)
                }
            }
            .pickerStyle(.menu)
        }
    }
}

/// Runs an action after the menu closes. A modal alert inside the menu
/// tracking loop does not get the keyboard focus.
@MainActor
func run(_ body: @escaping @MainActor () async -> Void) {
    DispatchQueue.main.async {
        Task { @MainActor in await body() }
    }
}

/// Shows the file in Finder, as `open -R` does.
@MainActor
func reveal(_ url: URL) {
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
        NSWorkspace.shared.open(url)
    } else {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
