import Foundation

public struct CswapError: Error, Sendable, Equatable, LocalizedError {
    /// The exception class name from a JSON error envelope, if known.
    public var type: String?
    public var message: String

    public init(type: String? = nil, message: String) {
        self.type = type
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// A running `cswap auto --json` process.
public protocol AutoSwitchHandle: AnyObject, Sendable {
    /// Stops the process. It is safe to call more than one time.
    func stop()
    /// Stops the process and waits a short time until it exits.
    func stopAndWait()
}

/// The `cswap` commands that the menu bar uses. The app has no account,
/// usage or switch logic of its own. Each call is one CLI command.
public protocol CswapClient: Sendable {
    /// `cswap list --json`
    func list() async throws -> ListPayload
    /// `cswap status --json`
    func status() async throws -> StatusPayload
    /// `cswap switch <num> --json`
    func switchTo(_ number: Int) async throws -> SwitchResult
    /// `cswap switch [--strategy best|next-available] --json`
    func switchRotate(strategy: String?) async throws -> SwitchResult
    /// `cswap disable <num>` or `cswap enable <num>`
    func setDisabled(_ number: Int, disabled: Bool) async throws
    /// `cswap remove <num>`, confirmed on stdin
    func remove(_ number: Int) async throws
    /// `cswap add`
    func addFromLogin() async throws
    /// `cswap add-token - --email <email>`, token on stdin
    func addFromToken(token: String, email: String) async throws
    /// `cswap config get autoswitch.threshold --json`
    func autoSwitchThreshold() async throws -> Double?
    /// `cswap config set autoswitch.threshold <pct>`
    func setAutoSwitchThreshold(_ pct: Int) async throws
    /// Starts `cswap auto --json`. The callbacks run on a background queue.
    func startAuto(
        onEvent: @escaping @Sendable (AutoEvent) -> Void,
        onExit: @escaping @Sendable (_ status: Int32, _ stderr: String) -> Void
    ) throws -> AutoSwitchHandle
}

public enum CswapOutput {
    /// Decodes the stdout of a `--json` command. An error envelope becomes a
    /// `CswapError`. If stdout has no JSON, the error comes from stderr.
    public static func decode<T: Decodable>(
        _ type: T.Type, stdout: Data, stderr: String, status: Int32
    ) throws -> T {
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: stdout) {
            throw CswapError(type: envelope.error.type, message: envelope.error.message)
        }
        if status != 0 {
            throw CswapError(message: errorMessage(stderr: stderr, status: status))
        }
        do {
            return try JSONDecoder().decode(T.self, from: stdout)
        } catch {
            throw CswapError(message: "Unexpected output from cswap: \(error)")
        }
    }

    /// The error message of a failed command without `--json`: the last
    /// "Error: ..." line of stderr, else the last line of stderr.
    public static func errorMessage(stderr: String, status: Int32) -> String {
        let lines = stripANSI(stderr)
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if let line = lines.last(where: { $0.hasPrefix("Error: ") }) {
            return String(line.dropFirst("Error: ".count))
        }
        if let line = lines.last {
            return line
        }
        return "cswap exited with status \(status)"
    }

    public static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: #"\u001B\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
    }
}

/// Finds the `cswap` executable.
public enum CswapLocator {
    public static let ARGUMENT = "--cswap"
    public static let ENVIRONMENT = "CSWAP_BIN"

    /// The search order:
    /// 1. the `--cswap <path>` or `--cswap=<path>` argument,
    /// 2. the `CSWAP_BIN` environment variable,
    /// 3. `cswap` in `PATH`, then in the usual install directories.
    ///
    /// An app that Finder or launchd starts gets a short `PATH`. Thus the
    /// fallback directories are necessary.
    public static func resolve(
        arguments: [String],
        environment: [String: String],
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> URL? {
        if let explicit = argumentValue(arguments) ?? environment[ENVIRONMENT], !explicit.isEmpty {
            return URL(fileURLWithPath: (explicit as NSString).expandingTildeInPath)
        }
        for dir in searchPath(environment) {
            let candidate = (dir as NSString).appendingPathComponent("cswap")
            if isExecutable(candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }

    static func argumentValue(_ arguments: [String]) -> String? {
        for (i, arg) in arguments.enumerated() {
            if arg == ARGUMENT, i + 1 < arguments.count { return arguments[i + 1] }
            if arg.hasPrefix(ARGUMENT + "=") { return String(arg.dropFirst(ARGUMENT.count + 1)) }
        }
        return nil
    }

    public static func searchPath(_ environment: [String: String]) -> [String] {
        let home = environment["HOME"] ?? NSHomeDirectory()
        var dirs = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for extra in ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"] where !dirs.contains(extra) {
            dirs.append(extra)
        }
        return dirs.filter { !$0.isEmpty }
    }
}

/// Files of the cswap backup root that the menu bar reads or writes.
public struct CswapPaths: Sendable, Equatable {
    public static let ARGUMENT = "--backup-dir"
    public static let ENVIRONMENT = "CSWAP_BACKUP_DIR"

    public var backupDir: URL

    public init(backupDir: URL) {
        self.backupDir = backupDir
    }

    /// The backup root: the `--backup-dir` argument, else `CSWAP_BACKUP_DIR`,
    /// else `~/.claude-swap-backup`, as `get_backup_root()` gives on macOS.
    public static func resolve(arguments: [String], environment: [String: String]) -> CswapPaths {
        var explicit: String?
        for (i, arg) in arguments.enumerated() {
            if arg == ARGUMENT, i + 1 < arguments.count { explicit = arguments[i + 1] }
            if arg.hasPrefix(ARGUMENT + "=") { explicit = String(arg.dropFirst(ARGUMENT.count + 1)) }
        }
        explicit = explicit ?? environment[ENVIRONMENT]
        if let explicit, !explicit.isEmpty {
            return CswapPaths(backupDir: URL(fileURLWithPath: (explicit as NSString).expandingTildeInPath))
        }
        let home = environment["HOME"] ?? NSHomeDirectory()
        return CswapPaths(backupDir: URL(fileURLWithPath: home).appendingPathComponent(".claude-swap-backup"))
    }

    public var settingsFile: URL { backupDir.appendingPathComponent(MenuBarSettings.FILENAME) }
    public var logFile: URL { backupDir.appendingPathComponent("claude-swap.log") }

    /// The Claude Code global config, as `get_global_config_path()` gives it.
    /// The app only reads its modification time, to see a switch from another tool.
    public static func claudeConfigFile(environment: [String: String]) -> URL {
        let home = environment["HOME"] ?? NSHomeDirectory()
        let configDir = environment["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let configHome = configDir ?? "\(home)/.claude"
        let legacy = URL(fileURLWithPath: configHome).appendingPathComponent(".config.json")
        if FileManager.default.fileExists(atPath: legacy.path) {
            return legacy
        }
        return URL(fileURLWithPath: configDir ?? home).appendingPathComponent(".claude.json")
    }
}
