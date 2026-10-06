/** Logging configuration for Claude Swap, with a small subset of the Python `logging` module. */

import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export const NOTSET = 0;
export const DEBUG = 10;
export const INFO = 20;
export const WARNING = 30;
export const ERROR = 40;
export const CRITICAL = 50;

const LEVEL_NAMES: Record<number, string> = {
  [DEBUG]: "DEBUG",
  [INFO]: "INFO",
  [WARNING]: "WARNING",
  [ERROR]: "ERROR",
  [CRITICAL]: "CRITICAL",
};

/**
 * Put this object as the last argument of a log call to add the stack of an
 * error, like `exc_info=True` in Python: `logger.debug("failed", { excInfo: e })`.
 */
export interface LogOptions {
  excInfo: unknown;
}

export interface LogRecord {
  name: string;
  levelno: number;
  levelname: string;
  message: string;
  created: Date;
  excText: string | undefined;
}

export type Formatter = (record: LogRecord) => string;

/** `%(asctime)s - %(levelname)s - %(message)s` */
export const fileFormatter: Formatter = (r) => `${asctime(r.created)} - ${r.levelname} - ${r.message}`;

/** `%(levelname)s: %(message)s` */
export const consoleFormatter: Formatter = (r) => `${r.levelname}: ${r.message}`;

export abstract class Handler {
  level = NOTSET;
  formatter: Formatter = (r) => r.message;

  setLevel(level: number): void {
    this.level = level;
  }

  setFormatter(formatter: Formatter): void {
    this.formatter = formatter;
  }

  format(record: LogRecord): string {
    const text = this.formatter(record);
    return record.excText ? `${text}\n${record.excText}` : text;
  }

  /** Write the record. An error goes to stderr and never to the caller, as in Python. */
  handle(record: LogRecord): void {
    if (record.levelno < this.level) return;
    try {
      this.emit(record);
    } catch (e) {
      process.stderr.write(`--- Logging error ---\n${inspect(e)}\n`);
    }
  }

  protected abstract emit(record: LogRecord): void;

  flush(): void {}

  close(): void {}
}

export class StreamHandler extends Handler {
  constructor(public stream: NodeJS.WritableStream = process.stderr) {
    super();
  }

  protected emit(record: LogRecord): void {
    this.stream.write(`${this.format(record)}\n`);
  }
}

export class FileHandler extends StreamHandler {
  readonly baseFilename: string;
  protected fd: number | undefined;

  /** If `delay` is true, the file opens on the first emit. */
  constructor(filename: string, delay = false) {
    super();
    this.baseFilename = path.resolve(filename);
    if (!delay) this.fd = this.open();
  }

  protected open(): number {
    return fs.openSync(this.baseFilename, "a");
  }

  protected override emit(record: LogRecord): void {
    this.fd ??= this.open();
    fs.writeSync(this.fd, `${this.format(record)}\n`);
  }

  override close(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

/** Rotates to `<file>.1` … `<file>.<backupCount>` before a write makes the file reach `maxBytes`. */
export class RotatingFileHandler extends FileHandler {
  constructor(
    filename: string,
    readonly maxBytes = 0,
    readonly backupCount = 0,
    delay = false,
  ) {
    super(filename, delay);
  }

  protected override emit(record: LogRecord): void {
    if (this.shouldRollover(record)) this.doRollover();
    super.emit(record);
  }

  shouldRollover(record: LogRecord): boolean {
    if (this.maxBytes <= 0) return false;
    if (fs.existsSync(this.baseFilename) && !fs.statSync(this.baseFilename).isFile()) return false;
    this.fd ??= this.open();
    const size = fs.fstatSync(this.fd).size;
    return size + Buffer.byteLength(`${this.format(record)}\n`) >= this.maxBytes;
  }

  doRollover(): void {
    this.close();
    if (this.backupCount > 0) {
      for (let i = this.backupCount - 1; i > 0; i -= 1) {
        const sfn = `${this.baseFilename}.${i}`;
        const dfn = `${this.baseFilename}.${i + 1}`;
        if (fs.existsSync(sfn)) {
          fs.rmSync(dfn, { force: true });
          fs.renameSync(sfn, dfn);
        }
      }
      const dfn = `${this.baseFilename}.1`;
      fs.rmSync(dfn, { force: true });
      if (fs.existsSync(this.baseFilename)) fs.renameSync(this.baseFilename, dfn);
    }
  }
}

/**
 * Creates its parent directory on the first emit. Thus a run that logs
 * nothing does not create the log directory in the backup root. A new
 * directory there can later break the legacy to XDG migration check.
 */
class LazyDirRotatingFileHandler extends RotatingFileHandler {
  protected override open(): number {
    fs.mkdirSync(path.dirname(this.baseFilename), { recursive: true });
    return super.open();
  }
}

export class Logger {
  level = NOTSET;
  handlers: Handler[] = [];

  constructor(readonly name: string) {}

  setLevel(level: number): void {
    this.level = level;
  }

  addHandler(handler: Handler): void {
    if (!this.handlers.includes(handler)) this.handlers.push(handler);
  }

  removeHandler(handler: Handler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** A logger with level `NOTSET` uses `WARNING`, the level of the Python root logger. */
  getEffectiveLevel(): number {
    return this.level === NOTSET ? WARNING : this.level;
  }

  isEnabledFor(level: number): boolean {
    return level >= this.getEffectiveLevel();
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log(DEBUG, msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log(INFO, msg, ...args);
  }

  warning(msg: string, ...args: unknown[]): void {
    this.log(WARNING, msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log(ERROR, msg, ...args);
  }

  critical(msg: string, ...args: unknown[]): void {
    this.log(CRITICAL, msg, ...args);
  }

  /** Log at `ERROR`. Give the caught error as `{ excInfo: e }` to add its stack. */
  exception(msg: string, ...args: unknown[]): void {
    this.log(ERROR, msg, ...args);
  }

  log(level: number, msg: string, ...args: unknown[]): void {
    if (!this.isEnabledFor(level)) return;
    const last = args.at(-1);
    let excText: string | undefined;
    if (isLogOptions(last)) {
      args = args.slice(0, -1);
      excText = formatException(last.excInfo);
    }
    const record: LogRecord = {
      name: this.name,
      levelno: level,
      levelname: LEVEL_NAMES[level] ?? `Level ${level}`,
      message: args.length > 0 ? percentFormat(msg, args) : msg,
      created: new Date(),
      excText,
    };
    if (this.handlers.length === 0) {
      if (level >= WARNING) process.stderr.write(`${record.message}\n`);
      return;
    }
    for (const handler of this.handlers) handler.handle(record);
  }
}

const loggers = new Map<string, Logger>();

/** Return the one logger with this name. Every module that asks for `claude-swap` gets the same instance. */
export function getLogger(name = "claude-swap"): Logger {
  let logger = loggers.get(name);
  if (!logger) {
    logger = new Logger(name);
    loggers.set(name, logger);
  }
  return logger;
}

/**
 * Set up logging to `<logDir>/claude-swap.log` (1 MiB, 3 backups) and, if
 * `debug` is true, to stderr. The log directory is created on the first
 * record that the file handler writes.
 */
export function setupLogging(logDir: string, debug = false): Logger {
  const logger = getLogger("claude-swap");
  logger.setLevel(debug ? DEBUG : INFO);

  for (const handler of logger.handlers) handler.close();
  logger.handlers = [];

  const fileHandler = new LazyDirRotatingFileHandler(path.join(logDir, "claude-swap.log"), 1024 * 1024, 3, true);
  fileHandler.setLevel(DEBUG);
  fileHandler.setFormatter(fileFormatter);
  logger.addHandler(fileHandler);

  if (debug) {
    const consoleHandler = new StreamHandler();
    consoleHandler.setLevel(DEBUG);
    consoleHandler.setFormatter(consoleFormatter);
    logger.addHandler(consoleHandler);
  }

  return logger;
}

function isLogOptions(value: unknown): value is LogOptions {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype && "excInfo" in value;
}

function formatException(exc: unknown): string | undefined {
  if (exc === undefined || exc === null || exc === false || exc === true) return undefined;
  if (exc instanceof Error) return exc.stack ?? `${exc.name}: ${exc.message}`;
  return String(exc);
}

/** `msg % args` for the `%s`, `%r`, `%d`, `%i`, `%f` and `%%` conversions. */
export function percentFormat(msg: string, args: readonly unknown[]): string {
  let index = 0;
  return msg.replace(/%([%srdif])/g, (match, conv: string) => {
    if (conv === "%") return "%";
    if (index >= args.length) return match;
    const arg = args[index++];
    switch (conv) {
      case "s":
        return pyStr(arg);
      case "r":
        return typeof arg === "string" ? `'${arg}'` : pyStr(arg);
      case "f":
        return Number(arg).toFixed(6);
      default:
        return String(Math.trunc(Number(arg)));
    }
  });
}

function pyStr(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "object") return inspect(value);
  return String(value);
}

function asctime(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())},${p(date.getMilliseconds(), 3)}`
  );
}
