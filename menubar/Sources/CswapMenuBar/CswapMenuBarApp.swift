import AppKit
import CswapMenuBarCore
import SwiftUI

@main
struct CswapMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: MenuBarModel

    init() {
        let environment = ProcessInfo.processInfo.environment
        let arguments = CommandLine.arguments
        let services = AppServices.shared
        let model = MenuBarModel(
            client: ProcessCswapClient.located(arguments: arguments, environment: environment),
            paths: CswapPaths.resolve(arguments: arguments, environment: environment),
            prompter: services.prompter,
            notifier: services.notifier,
            claudeConfigFile: CswapPaths.claudeConfigFile(environment: environment)
        )
        services.model = model
        _model = State(initialValue: model)
        model.start()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Text(model.title)
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Objects that live for the whole process.
@MainActor
final class AppServices {
    static let shared = AppServices()

    let prompter = AlertPrompter()
    let notifier = SystemNotifier()
    var model: MenuBarModel?
    private var signalSources: [DispatchSourceSignal] = []

    /// Stops the `cswap auto` child before the process exits.
    func quit() {
        model?.shutdown()
        NSApp.terminate(nil)
    }

    /// launchd and `kill` send SIGTERM. Without this handler, the
    /// `cswap auto` child lives on after the app.
    func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.model?.shutdown()
                    exit(0)
                }
            }
            source.resume()
            signalSources.append(source)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            NSApp.setActivationPolicy(.accessory)
            AppServices.shared.installSignalHandlers()
            AppServices.shared.notifier.requestAuthorization()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            AppServices.shared.model?.shutdown()
        }
    }
}
