import Foundation

/// The result of one finished `cswap` command.
public struct CommandResult: Sendable {
    public var status: Int32
    public var stdout: Data
    public var stderr: String
}

/// A `CswapClient` that runs the `cswap` executable as a child process.
public final class ProcessCswapClient: CswapClient {
    public let executable: URL
    /// Arguments before the subcommand. `["cswap"]` if `executable` is `/usr/bin/env`.
    public let prefixArguments: [String]
    public let environment: [String: String]
    public let timeout: TimeInterval

    public init(
        executable: URL,
        prefixArguments: [String] = [],
        environment: [String: String] = ProcessInfo.processInfo.environment,
        timeout: TimeInterval = 180
    ) {
        self.executable = executable
        self.prefixArguments = prefixArguments
        self.environment = Self.childEnvironment(environment, executable: executable)
        self.timeout = timeout
    }

    /// A client for the `cswap` that `CswapLocator` finds. If it finds none,
    /// the client runs `/usr/bin/env cswap`, and each command reports the error.
    public static func located(
        arguments: [String] = CommandLine.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ProcessCswapClient {
        if let url = CswapLocator.resolve(arguments: arguments, environment: environment) {
            return ProcessCswapClient(executable: url, environment: environment)
        }
        return ProcessCswapClient(
            executable: URL(fileURLWithPath: "/usr/bin/env"), prefixArguments: ["cswap"], environment: environment
        )
    }

    /// The environment of each child. `NO_COLOR` keeps stderr free of color
    /// codes. The directory of `cswap` goes first in `PATH`, because a script
    /// with `#!/usr/bin/env node` must find its interpreter there.
    static func childEnvironment(_ base: [String: String], executable: URL) -> [String: String] {
        var env = base
        env["NO_COLOR"] = "1"
        var dirs = [executable.deletingLastPathComponent().path]
        for dir in CswapLocator.searchPath(base) where !dirs.contains(dir) {
            dirs.append(dir)
        }
        for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] where !dirs.contains(dir) {
            dirs.append(dir)
        }
        env["PATH"] = dirs.joined(separator: ":")
        return env
    }

    public func run(_ arguments: [String], stdin: Data? = nil) async throws -> CommandResult {
        let executable = executable
        let environment = environment
        let timeout = timeout
        let arguments = prefixArguments + arguments
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let result = try Self.runBlocking(
                        executable: executable, arguments: arguments, environment: environment,
                        stdin: stdin, timeout: timeout
                    )
                    continuation.resume(returning: result)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func runBlocking(
        executable: URL, arguments: [String], environment: [String: String],
        stdin: Data?, timeout: TimeInterval
    ) throws -> CommandResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        let outPipe = Pipe()
        let errPipe = Pipe()
        let inPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = inPipe
        do {
            try process.run()
        } catch {
            throw CswapError(message: "Could not start \(executable.path): \(error.localizedDescription)")
        }
        if let stdin {
            try? inPipe.fileHandleForWriting.write(contentsOf: stdin)
        }
        try? inPipe.fileHandleForWriting.close()

        let timer = DispatchWorkItem { [process] in
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)

        let group = DispatchGroup()
        nonisolated(unsafe) var errData = Data()
        group.enter()
        DispatchQueue.global().async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        process.waitUntilExit()
        timer.cancel()
        return CommandResult(
            status: process.terminationStatus,
            stdout: outData,
            stderr: String(decoding: errData, as: UTF8.self)
        )
    }

    private func json<T: Decodable>(_ type: T.Type, _ arguments: [String]) async throws -> T {
        let r = try await run(arguments)
        return try CswapOutput.decode(type, stdout: r.stdout, stderr: r.stderr, status: r.status)
    }

    private func plain(_ arguments: [String], stdin: Data? = nil) async throws {
        let r = try await run(arguments, stdin: stdin)
        if r.status != 0 {
            throw CswapError(message: CswapOutput.errorMessage(stderr: r.stderr, status: r.status))
        }
    }

    public func list() async throws -> ListPayload {
        try await json(ListPayload.self, ["list", "--json"])
    }

    public func status() async throws -> StatusPayload {
        try await json(StatusPayload.self, ["status", "--json"])
    }

    public func switchTo(_ number: Int) async throws -> SwitchResult {
        try await json(SwitchResult.self, ["switch", String(number), "--json"])
    }

    public func switchRotate(strategy: String?) async throws -> SwitchResult {
        var args = ["switch"]
        if let strategy { args += ["--strategy", strategy] }
        return try await json(SwitchResult.self, args + ["--json"])
    }

    public func setDisabled(_ number: Int, disabled: Bool) async throws {
        try await plain([disabled ? "disable" : "enable", String(number)])
    }

    public func remove(_ number: Int) async throws {
        // `cswap remove` asks "[y/N]" on stdin. The app asks the user first.
        try await plain(["remove", String(number)], stdin: Data("y\n".utf8))
    }

    public func addFromLogin() async throws {
        try await plain(["add"])
    }

    public func addFromToken(token: String, email: String) async throws {
        // The token goes on stdin, because `ps` shows the arguments of a process.
        try await plain(["add-token", "-", "--email", email], stdin: Data((token + "\n").utf8))
    }

    public func autoSwitchThreshold() async throws -> Double? {
        try await json(ConfigValuePayload.self, ["config", "get", "autoswitch.threshold", "--json"]).value
    }

    public func setAutoSwitchThreshold(_ pct: Int) async throws {
        try await plain(["config", "set", "autoswitch.threshold", String(pct)])
    }

    public func startAuto(
        onEvent: @escaping @Sendable (AutoEvent) -> Void,
        onExit: @escaping @Sendable (Int32, String) -> Void
    ) throws -> AutoSwitchHandle {
        try AutoSwitchProcess(
            executable: executable, arguments: prefixArguments + ["auto", "--json"],
            environment: environment, onEvent: onEvent, onExit: onExit
        )
    }
}

/// A long-lived `cswap auto --json` child process.
public final class AutoSwitchProcess: AutoSwitchHandle, @unchecked Sendable {
    private let process = Process()
    private let lock = NSLock()
    private var stopped = false
    private var splitter = LineSplitter()
    private var stderrText = ""

    public static let STOP_GRACE_S: TimeInterval = 5

    init(
        executable: URL, arguments: [String], environment: [String: String],
        onEvent: @escaping @Sendable (AutoEvent) -> Void,
        onExit: @escaping @Sendable (Int32, String) -> Void
    ) throws {
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let lines = self.lock.withLock { self.splitter.feed(data) }
            for line in lines {
                if let event = AutoEvent.parse(line: line) { onEvent(event) }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            // Keep only the tail: the child can write warnings for days.
            self.lock.withLock {
                self.stderrText = String((self.stderrText + String(decoding: data, as: UTF8.self)).suffix(4000))
            }
        }
        process.terminationHandler = { [weak self] proc in
            guard let self else { return }
            let (wasStopped, tail, rest) = self.lock.withLock {
                (self.stopped, self.stderrText, self.splitter.finish())
            }
            for line in rest {
                if let event = AutoEvent.parse(line: line) { onEvent(event) }
            }
            if !wasStopped { onExit(proc.terminationStatus, tail) }
        }
        do {
            try process.run()
        } catch {
            throw CswapError(message: "Could not start \(executable.path): \(error.localizedDescription)")
        }
    }

    /// Sends SIGTERM, which stops the engine loop cleanly. If the process
    /// is still alive after `STOP_GRACE_S`, it gets SIGKILL.
    public func stop() {
        let alreadyStopped = lock.withLock { () -> Bool in
            defer { stopped = true }
            return stopped
        }
        guard !alreadyStopped, process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.STOP_GRACE_S) { [process] in
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }

    /// Stops the process and waits until it exits, for the quit path.
    public func stopAndWait() {
        stop()
        let deadline = Date().addingTimeInterval(Self.STOP_GRACE_S + 1)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    public var isRunning: Bool { process.isRunning }
}
