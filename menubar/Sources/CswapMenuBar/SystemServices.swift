import AppKit
import CswapMenuBarCore
import UserNotifications

/// Dialogs with `NSAlert`.
@MainActor
final class AlertPrompter: Prompter {
    /// An accessory app is not the active app. Its alert windows can show
    /// black or blank until the app comes to the front.
    private func bringToFront() {
        NSApp.activate(ignoringOtherApps: true)
    }

    func alert(title: String, message: String) {
        bringToFront()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    func confirm(title: String, message: String, ok: String, cancel: String) -> Bool {
        bringToFront()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: cancel)
        return alert.runModal() == .alertFirstButtonReturn
    }

    func askText(title: String, message: String, ok: String, cancel: String, secure: Bool) -> String? {
        bringToFront()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: cancel)
        let field: NSTextField = secure
            ? NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
            : NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue
    }
}

/// Notifications with the UserNotifications framework.
///
/// UserNotifications stops the process if the app has no bundle identifier,
/// for example after `swift run`. Then the notifier writes to stderr.
@MainActor
final class SystemNotifier: NSObject, Notifier, UNUserNotificationCenterDelegate {
    private var hasBundle: Bool { Bundle.main.bundleIdentifier != nil }

    func requestAuthorization() {
        guard hasBundle else { return }
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func notify(title: String, subtitle: String, body: String) {
        guard hasBundle else {
            FileHandle.standardError.write(Data("[notification] \(title) — \(subtitle): \(body)\n".utf8))
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = subtitle
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    /// The app is active while an alert shows. Without this method, macOS
    /// does not show a banner for an active app.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }
}
