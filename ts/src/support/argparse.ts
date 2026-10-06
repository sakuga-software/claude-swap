/**
 * The part of Python `argparse` that the CLI uses, with the same parse rules,
 * help layout and error text. Tests and users compare this text with the
 * Python version, so the algorithms follow CPython 3.14 `argparse.py` and
 * `textwrap.py`. Colored help (new in Python 3.14) is not ported.
 */

import { pyLen, pyStrRepr } from "./pyformat.js";
import { SystemExit } from "./exit.js";

export const SUPPRESS = "==SUPPRESS==";
const PARSER = "A...";
const UNRECOGNIZED_ARGS = "_unrecognized_args";

type Nargs = null | 0 | "?" | typeof PARSER;
type ActionKind = "store" | "store_true" | "help" | "version" | "boolean_optional" | "parsers";

export type Namespace = Record<string, unknown>;

export interface ArgumentOptions {
  action?: "store" | "store_true" | "version" | "boolean_optional";
  /** The key in the namespace. The default is the camelCase form of the long option or of the positional name. */
  dest?: string;
  metavar?: string;
  help?: string;
  choices?: readonly string[];
  type?: "int" | "float";
  nargs?: "?";
  const?: unknown;
  default?: unknown;
  version?: string;
}

interface Action {
  kind: ActionKind;
  optionStrings: string[];
  /** The key in the namespace, or SUPPRESS. */
  dest: string;
  /** The Python `dest`. Help and errors show it when no metavar exists. */
  pyDest: string;
  nargs: Nargs;
  const: unknown;
  default: unknown;
  type: "int" | "float" | undefined;
  choices: readonly string[] | undefined;
  required: boolean;
  help: string | undefined;
  metavar: string | undefined;
  version: string | undefined;
  parsers: Map<string, ArgumentParser> | undefined;
  choiceActions: Action[];
}

/** An error in the command line. `parseArgs` prints it with the usage and exits with status 2. */
export class ArgumentError extends Error {
  override name = "ArgumentError";

  constructor(action: Action | null, message: string) {
    super(action === null ? message : `argument ${actionName(action)}: ${message}`);
  }
}

export interface ParserOptions {
  prog: string;
  /** A custom usage line. `%(prog)s` expands. */
  usage?: string;
  description?: string;
  epilog?: string;
  /** `RawDescriptionHelpFormatter`: keep the line breaks of the description and the epilog. */
  rawDescription?: boolean;
}

interface MutuallyExclusiveGroup {
  addArgument(...args: [...names: string[], options: ArgumentOptions]): void;
}

interface Subparsers {
  addParser(name: string, options?: { help?: string }): ArgumentParser;
}

function camelCase(pyDest: string): string {
  return pyDest.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function actionName(action: Action): string | null {
  if (action.optionStrings.length > 0) return action.optionStrings.join("/");
  if (action.metavar !== undefined && action.metavar !== SUPPRESS) return action.metavar;
  if (action.pyDest !== SUPPRESS) return action.pyDest;
  return null;
}

/** The text width of help: `$COLUMNS`, else the terminal width, else 80; minus 2, as argparse does. */
function helpWidth(): number {
  const fromEnv = Number.parseInt(process.env.COLUMNS ?? "", 10);
  let columns = 80;
  if (Number.isInteger(fromEnv) && fromEnv > 0) columns = fromEnv;
  else if (process.stdout.isTTY && process.stdout.columns > 0) columns = process.stdout.columns;
  return columns - 2;
}

function out(text: string): void {
  process.stdout.write(text);
}

export class ArgumentParser {
  readonly prog: string;
  readonly usage: string | undefined;
  readonly description: string | undefined;
  readonly epilog: string | undefined;
  readonly rawDescription: boolean;
  private readonly actions: Action[] = [];
  private readonly optionStringActions = new Map<string, Action>();
  private readonly mutexGroups: Action[][] = [];

  constructor(options: ParserOptions) {
    this.prog = options.prog;
    this.usage = options.usage;
    this.description = options.description;
    this.epilog = options.epilog;
    this.rawDescription = options.rawDescription ?? false;
    this.addArgument("-h", "--help", { help: "show this help message and exit" });
    this.actions[0]!.kind = "help";
    this.actions[0]!.nargs = 0;
    this.actions[0]!.dest = SUPPRESS;
    this.actions[0]!.pyDest = SUPPRESS;
    this.actions[0]!.default = SUPPRESS;
  }

  addArgument(...args: [...names: string[], options: ArgumentOptions]): void {
    this.createAction(args.slice(0, -1) as string[], args[args.length - 1] as ArgumentOptions);
  }

  private createAction(names: string[], options: ArgumentOptions): Action {
    const isOptional = names[0]!.startsWith("-");
    let pyDest: string;
    if (isOptional) {
      const long = names.find((n) => n.startsWith("--")) ?? names[0]!;
      pyDest = long.replace(/^-+/, "").replaceAll("-", "_");
    } else {
      pyDest = names[0]!;
    }
    const kind = options.action ?? "store";
    const optionStrings = [...names];
    if (kind === "boolean_optional") {
      for (const name of names) optionStrings.push(`--no-${name.slice(2)}`);
    }
    const action: Action = {
      kind,
      optionStrings: isOptional ? optionStrings : [],
      dest: options.dest ?? camelCase(pyDest),
      pyDest,
      nargs: kind === "store" ? (options.nargs ?? null) : 0,
      const: options.const,
      default: options.default !== undefined ? options.default : kind === "store_true" ? false : null,
      type: options.type,
      choices: options.choices,
      required: !isOptional && options.nargs !== "?",
      help: options.help,
      metavar: options.metavar,
      version: options.version,
      parsers: undefined,
      choiceActions: [],
    };
    if (kind === "version") {
      action.dest = SUPPRESS;
      action.default = SUPPRESS;
      action.help ??= "show program's version number and exit";
    }
    this.actions.push(action);
    for (const name of action.optionStrings) this.optionStringActions.set(name, action);
    return action;
  }

  addMutuallyExclusiveGroup(): MutuallyExclusiveGroup {
    const group: Action[] = [];
    this.mutexGroups.push(group);
    return {
      addArgument: (...args) => {
        group.push(this.createAction(args.slice(0, -1) as string[], args[args.length - 1] as ArgumentOptions));
      },
    };
  }

  addSubparsers(options: { dest: string; metavar?: string }): Subparsers {
    const action = this.createAction([options.dest], { metavar: options.metavar, dest: options.dest });
    action.kind = "parsers";
    action.nargs = PARSER;
    action.required = false;
    action.parsers = new Map();
    action.choices = [];
    return {
      addParser: (name, parserOptions = {}) => {
        const parser = new ArgumentParser({ prog: `${this.prog} ${name}` });
        action.parsers!.set(name, parser);
        action.choices = [...action.parsers!.keys()];
        if (parserOptions.help !== undefined) {
          action.choiceActions.push({
            ...action,
            kind: "store",
            dest: name,
            pyDest: name,
            metavar: name,
            nargs: null,
            help: parserOptions.help,
            choices: undefined,
            parsers: undefined,
            choiceActions: [],
          });
        }
        return parser;
      },
    };
  }

  parseArgs<T extends Namespace = Namespace>(args: readonly string[]): T {
    const [namespace, extras] = this.parseKnownArgs(args);
    if (extras.length > 0) this.error(`unrecognized arguments: ${extras.join(" ")}`);
    return namespace as T;
  }

  parseKnownArgs(args: readonly string[]): [Namespace, string[]] {
    const namespace: Namespace = {};
    for (const action of this.actions) {
      if (action.dest !== SUPPRESS && !Object.hasOwn(namespace, action.dest) && action.default !== SUPPRESS) {
        namespace[action.dest] = action.default;
      }
    }
    let extras: string[];
    try {
      extras = this.parseKnownArgsInner([...args], namespace);
    } catch (e) {
      if (e instanceof ArgumentError) this.error(e.message);
      throw e;
    }
    const unrecognized = namespace[UNRECOGNIZED_ARGS];
    if (Array.isArray(unrecognized)) {
      extras.push(...(unrecognized as string[]));
      delete namespace[UNRECOGNIZED_ARGS];
    }
    return [namespace, extras];
  }

  private parseKnownArgsInner(argStrings: string[], namespace: Namespace): string[] {
    const actionConflicts = new Map<Action, Action[]>();
    for (const group of this.mutexGroups) {
      group.forEach((action, i) => {
        const conflicts = actionConflicts.get(action) ?? [];
        conflicts.push(...group.slice(0, i), ...group.slice(i + 1));
        actionConflicts.set(action, conflicts);
      });
    }

    type OptionTuple = [Action | null, string, string | null, string | null];
    const optionStringIndices = new Map<number, OptionTuple[]>();
    const patternParts: string[] = [];
    for (let i = 0; i < argStrings.length; i += 1) {
      const argString = argStrings[i]!;
      if (argString === "--") {
        patternParts.push("-");
        for (let j = i + 1; j < argStrings.length; j += 1) patternParts.push("A");
        break;
      }
      const tuples = this.parseOptional(argString);
      if (tuples === null) {
        patternParts.push("A");
      } else {
        optionStringIndices.set(i, tuples);
        patternParts.push("O");
      }
    }
    const argStringsPattern = patternParts.join("");

    const seenActions = new Set<Action>();
    const seenNonDefaultActions = new Set<Action>();

    const takeAction = (action: Action, argumentStrings: string[], optionString: string | null = null): void => {
      seenActions.add(action);
      const values = this.getValues(action, argumentStrings);
      if (action.optionStrings.length > 0 || argumentStrings.length > 0) {
        seenNonDefaultActions.add(action);
        for (const conflict of actionConflicts.get(action) ?? []) {
          if (seenNonDefaultActions.has(conflict)) {
            throw new ArgumentError(action, `not allowed with argument ${actionName(conflict)}`);
          }
        }
      }
      if (values !== SUPPRESS) this.callAction(action, namespace, values, optionString);
    };

    const extras: string[] = [];
    const consumeOptional = (startIndex: number): number => {
      const tuples = optionStringIndices.get(startIndex)!;
      if (tuples.length > 1) {
        const options = tuples.map((t) => t[1]).join(", ");
        throw new ArgumentError(null, `ambiguous option: ${argStrings[startIndex]} could match ${options}`);
      }
      let [action, optionString, sep, explicitArg] = tuples[0]!;
      const actionTuples: Array<[Action, string[], string]> = [];
      let stop: number;
      for (;;) {
        if (action === null) {
          extras.push(argStrings[startIndex]!);
          return startIndex + 1;
        }
        if (explicitArg !== null) {
          const argCount = this.matchArgument(action, "A");
          if (argCount === 0 && optionString[1] !== "-" && explicitArg !== "") {
            if (sep || explicitArg.startsWith("-")) {
              throw new ArgumentError(action, `ignored explicit argument ${pyStrRepr(explicitArg)}`);
            }
            actionTuples.push([action, [], optionString]);
            const char = optionString[0]!;
            optionString = char + explicitArg[0];
            const next = this.optionStringActions.get(optionString);
            if (next !== undefined) {
              action = next;
              explicitArg = explicitArg.slice(1);
              if (!explicitArg) {
                sep = explicitArg = null;
              } else if (explicitArg.startsWith("=")) {
                sep = "=";
                explicitArg = explicitArg.slice(1);
              } else {
                sep = "";
              }
            } else {
              extras.push(char + explicitArg);
              stop = startIndex + 1;
              break;
            }
          } else if (argCount === 1) {
            stop = startIndex + 1;
            actionTuples.push([action, [explicitArg], optionString]);
            break;
          } else {
            throw new ArgumentError(action, `ignored explicit argument ${pyStrRepr(explicitArg)}`);
          }
        } else {
          const start = startIndex + 1;
          const argCount = this.matchArgument(action, argStringsPattern.slice(start));
          stop = start + argCount;
          actionTuples.push([action, argStrings.slice(start, stop), optionString]);
          break;
        }
      }
      for (const [tupleAction, tupleArgs, tupleOption] of actionTuples) takeAction(tupleAction, tupleArgs, tupleOption);
      return stop;
    };

    let positionals = this.actions.filter((a) => a.optionStrings.length === 0);
    const consumePositionals = (startIndex: number): number => {
      const argCounts = this.matchArgumentsPartial(positionals, argStringsPattern.slice(startIndex));
      argCounts.forEach((argCount, i) => {
        const action = positionals[i]!;
        const args = argStrings.slice(startIndex, startIndex + argCount);
        if (action.nargs === PARSER) {
          if (argStringsPattern[startIndex] === "-") args.splice(args.indexOf("--"), 1);
        } else if (argStringsPattern.slice(startIndex, startIndex + argCount).includes("-")) {
          args.splice(args.indexOf("--"), 1);
        }
        startIndex += argCount;
        takeAction(action, args);
      });
      positionals = positionals.slice(argCounts.length);
      return startIndex;
    };

    let startIndex = 0;
    const maxOptionStringIndex = optionStringIndices.size > 0 ? Math.max(...optionStringIndices.keys()) : -1;
    while (startIndex <= maxOptionStringIndex) {
      let nextOptionStringIndex = startIndex;
      while (nextOptionStringIndex <= maxOptionStringIndex && !optionStringIndices.has(nextOptionStringIndex)) {
        nextOptionStringIndex += 1;
      }
      if (startIndex !== nextOptionStringIndex) {
        const positionalsEndIndex = consumePositionals(startIndex);
        if (positionalsEndIndex > startIndex) {
          startIndex = positionalsEndIndex;
          continue;
        }
        startIndex = positionalsEndIndex;
      }
      if (!optionStringIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOptionStringIndex));
        startIndex = nextOptionStringIndex;
      }
      startIndex = consumeOptional(startIndex);
    }
    const stopIndex = consumePositionals(startIndex);
    extras.push(...argStrings.slice(stopIndex));

    const requiredActions: string[] = [];
    for (const action of this.actions) {
      if (!seenActions.has(action) && action.required) requiredActions.push(actionName(action) ?? "");
    }
    if (requiredActions.length > 0) {
      throw new ArgumentError(null, `the following arguments are required: ${requiredActions.join(", ")}`);
    }
    return extras;
  }

  private parseOptional(argString: string): Array<[Action | null, string, string | null, string | null]> | null {
    if (!argString) return null;
    if (!argString.startsWith("-")) return null;
    const exact = this.optionStringActions.get(argString);
    if (exact !== undefined) return [[exact, argString, null, null]];
    if (argString.length === 1) return null;
    const eq = argString.indexOf("=");
    if (eq >= 0) {
      const optionString = argString.slice(0, eq);
      const action = this.optionStringActions.get(optionString);
      if (action !== undefined) return [[action, optionString, "=", argString.slice(eq + 1)]];
    }
    const tuples = this.getOptionTuples(argString);
    if (tuples.length > 0) return tuples;
    // No option of these parsers looks like a negative number, so a negative number is a positional.
    if (/^-\d+$|^-\d*\.\d+$/.test(argString)) return null;
    if (argString.includes(" ")) return null;
    return [[null, argString, null, null]];
  }

  private getOptionTuples(optionString: string): Array<[Action | null, string, string | null, string | null]> {
    const result: Array<[Action | null, string, string | null, string | null]> = [];
    const eq = optionString.indexOf("=");
    const optionPrefix = eq >= 0 ? optionString.slice(0, eq) : optionString;
    const sep = eq >= 0 ? "=" : null;
    const explicitArg = eq >= 0 ? optionString.slice(eq + 1) : null;
    if (optionString[1] === "-") {
      for (const [candidate, action] of this.optionStringActions) {
        if (candidate.startsWith(optionPrefix)) result.push([action, candidate, sep, explicitArg]);
      }
    } else {
      const shortPrefix = optionString.slice(0, 2);
      const shortExplicitArg = optionString.slice(2);
      for (const [candidate, action] of this.optionStringActions) {
        if (candidate === shortPrefix) result.push([action, candidate, "", shortExplicitArg]);
        else if (candidate.startsWith(optionPrefix)) result.push([action, candidate, sep, explicitArg]);
      }
    }
    return result;
  }

  private static nargsPattern(action: Action): string {
    const option = action.optionStrings.length > 0;
    switch (action.nargs) {
      case null:
        return option ? "([A])" : "(-*A-*)";
      case "?":
        return option ? "(A?)" : "(-*A?-*)";
      case PARSER:
        return option ? "(A[AO]*)" : "(-*A[-AO]*)";
      default:
        return option ? "([AO]{0})" : "((?:-*A){0}-*)";
    }
  }

  private matchArgument(action: Action, pattern: string): number {
    const match = new RegExp(`^${ArgumentParser.nargsPattern(action)}`).exec(pattern);
    if (match === null) {
      const message = action.nargs === null ? "expected one argument" : action.nargs === "?" ? "expected at most one argument" : `expected ${String(action.nargs)} argument`;
      throw new ArgumentError(action, message);
    }
    return match[1]!.length;
  }

  private matchArgumentsPartial(actions: Action[], pattern: string): number[] {
    for (let i = actions.length; i > 0; i -= 1) {
      const regex = new RegExp(`^${actions.slice(0, i).map((a) => ArgumentParser.nargsPattern(a)).join("")}`);
      const match = regex.exec(pattern);
      if (match !== null) {
        const result = match.slice(1).map((g) => (g ?? "").length);
        const end = match[0].length;
        if (end < pattern.length && pattern[end] === "O") {
          while (result.length > 0 && result[result.length - 1] === 0) result.pop();
        }
        return result;
      }
    }
    return [];
  }

  private getValues(action: Action, argStrings: string[]): unknown {
    if (argStrings.length === 0 && action.nargs === "?") {
      return action.optionStrings.length > 0 ? action.const : action.default;
    }
    if (argStrings.length === 1 && (action.nargs === null || action.nargs === "?")) {
      const value = this.getValue(action, argStrings[0]!);
      this.checkValue(action, value);
      return value;
    }
    if (action.nargs === PARSER) {
      const values = argStrings.map((s) => this.getValue(action, s));
      this.checkValue(action, values[0]);
      return values;
    }
    return argStrings.map((s) => this.getValue(action, s));
  }

  private getValue(action: Action, argString: string): unknown {
    if (action.type === "int") {
      const text = argString.trim();
      if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) {
        throw new ArgumentError(action, `invalid int value: ${pyStrRepr(argString)}`);
      }
      return Number.parseInt(text.replaceAll("_", ""), 10);
    }
    if (action.type === "float") {
      const value = pyFloat(argString);
      if (value === null) throw new ArgumentError(action, `invalid float value: ${pyStrRepr(argString)}`);
      return value;
    }
    return argString;
  }

  private checkValue(action: Action, value: unknown): void {
    if (action.choices === undefined) return;
    if (!action.choices.includes(value as string)) {
      const choices = action.choices.map((c) => pyStrRepr(c)).join(", ");
      throw new ArgumentError(action, `invalid choice: ${pyStrRepr(String(value))} (choose from ${choices})`);
    }
  }

  private callAction(action: Action, namespace: Namespace, values: unknown, optionString: string | null): void {
    switch (action.kind) {
      case "store":
        namespace[action.dest] = values;
        return;
      case "store_true":
        namespace[action.dest] = true;
        return;
      case "boolean_optional":
        namespace[action.dest] = !(optionString ?? "").startsWith("--no-");
        return;
      case "help":
        this.printHelp();
        this.exit(0);
        return;
      case "version":
        out(new HelpFormatter(this.prog, true).formatText(action.version ?? "").replace(/\n+$/, "\n"));
        this.exit(0);
        return;
      case "parsers": {
        const [parserName, ...argStrings] = values as string[];
        if (action.dest !== SUPPRESS) namespace[action.dest] = parserName;
        const parser = action.parsers!.get(parserName!)!;
        const [subNamespace, rest] = parser.parseKnownArgs(argStrings);
        Object.assign(namespace, subNamespace);
        if (rest.length > 0) {
          const previous = (namespace[UNRECOGNIZED_ARGS] as string[] | undefined) ?? [];
          namespace[UNRECOGNIZED_ARGS] = [...previous, ...rest];
        }
        return;
      }
    }
  }

  formatUsage(): string {
    return new HelpFormatter(this.prog, this.rawDescription).formatUsage(this.usage, this.actions).replace(/\n+$/, "\n");
  }

  formatHelp(): string {
    const formatter = new HelpFormatter(this.prog, this.rawDescription);
    const sections: Array<[string, Action[]]> = [
      ["positional arguments", this.actions.filter((a) => a.optionStrings.length === 0)],
      ["options", this.actions.filter((a) => a.optionStrings.length > 0)],
    ];
    for (const [, actions] of sections) formatter.measure(actions);
    let help = formatter.formatUsage(this.usage, this.actions);
    if (this.description) help += formatter.formatText(this.description);
    for (const [title, actions] of sections) help += formatter.formatSection(title, actions);
    if (this.epilog) help += formatter.formatText(this.epilog);
    help = help.replace(/\n\n\n+/g, "\n\n");
    return `${help.replace(/^\n+|\n+$/g, "")}\n`;
  }

  printUsage(stream: NodeJS.WritableStream = process.stdout): void {
    stream.write(this.formatUsage());
  }

  printHelp(): void {
    out(this.formatHelp());
  }

  exit(status = 0, message?: string): never {
    if (message) process.stderr.write(message);
    throw new SystemExit(status);
  }

  /** Print the usage and `<prog>: error: <message>` to stderr, then exit with status 2. */
  error(message: string): never {
    this.printUsage(process.stderr);
    this.exit(2, `${this.prog}: error: ${message}\n`);
  }
}

/** Python `float(text)`. Returns null where Python raises `ValueError`. */
function pyFloat(text: string): number | null {
  const s = text.trim().toLowerCase();
  const sign = s.startsWith("-") ? -1 : 1;
  const body = s.replace(/^[+-]/, "");
  if (body === "inf" || body === "infinity") return sign * Infinity;
  if (body === "nan") return Number.NaN;
  if (!/^(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/.test(body)) return null;
  return sign * Number(body.replaceAll("_", ""));
}

class HelpFormatter {
  private readonly width = helpWidth();
  private readonly maxHelpPosition = Math.min(24, Math.max(this.width - 20, 4));
  private actionMaxLength = 0;

  constructor(
    private readonly prog: string,
    private readonly raw: boolean,
  ) {}

  measure(actions: Action[]): void {
    for (const action of actions) {
      if (action.help === SUPPRESS) continue;
      this.actionMaxLength = Math.max(this.actionMaxLength, pyLen(invocation(action)) + 2);
      for (const sub of action.choiceActions) {
        this.actionMaxLength = Math.max(this.actionMaxLength, pyLen(invocation(sub)) + 4);
      }
    }
  }

  private expandProg(text: string): string {
    return text.includes("%(prog)") ? text.replaceAll("%(prog)s", this.prog).replaceAll("%%", "%") : text;
  }

  formatText(text: string): string {
    const expanded = this.expandProg(text);
    const width = Math.max(this.width, 11);
    const body = this.raw ? expanded : textwrapFill(expanded.replace(/[ \t\n\r\f\v]+/g, " ").trim(), width);
    return `${body}\n\n`;
  }

  formatUsage(usage: string | undefined, actions: Action[]): string {
    const prefix = "usage: ";
    let text: string;
    if (usage !== undefined) {
      text = this.expandProg(usage);
    } else {
      const visible = actions.filter((a) => a.help !== SUPPRESS);
      const optionals = visible.filter((a) => a.optionStrings.length > 0).map(usagePart);
      const positionals = visible.filter((a) => a.optionStrings.length === 0).map(usagePart);
      text = [this.prog, ...optionals, ...positionals].join(" ");
      const textWidth = this.width;
      if (pyLen(prefix) + pyLen(text) > textWidth) {
        const getLines = (parts: string[], indent: string, withPrefix = false): string[] => {
          const lines: string[] = [];
          let line: string[] = [];
          let lineLen = withPrefix ? pyLen(prefix) - 1 : indent.length - 1;
          for (const part of parts) {
            if (lineLen + 1 + pyLen(part) > textWidth && line.length > 0) {
              lines.push(indent + line.join(" "));
              line = [];
              lineLen = indent.length - 1;
            }
            line.push(part);
            lineLen += pyLen(part) + 1;
          }
          if (line.length > 0) lines.push(indent + line.join(" "));
          if (withPrefix) lines[0] = lines[0]!.slice(indent.length);
          return lines;
        };
        let lines: string[];
        if (pyLen(prefix) + pyLen(this.prog) <= 0.75 * textWidth) {
          const indent = " ".repeat(pyLen(prefix) + pyLen(this.prog) + 1);
          if (optionals.length > 0) {
            lines = getLines([this.prog, ...optionals], indent, true);
            lines.push(...getLines(positionals, indent));
          } else if (positionals.length > 0) {
            lines = getLines([this.prog, ...positionals], indent, true);
          } else {
            lines = [this.prog];
          }
        } else {
          const indent = " ".repeat(pyLen(prefix));
          lines = getLines([...optionals, ...positionals], indent);
          if (lines.length > 1) lines = [...getLines(optionals, indent), ...getLines(positionals, indent)];
          lines = [this.prog, ...lines];
        }
        text = lines.join("\n");
      }
    }
    return `${prefix}${text}\n\n`;
  }

  formatSection(title: string, actions: Action[]): string {
    const items = actions
      .filter((a) => a.help !== SUPPRESS)
      .map((a) => this.formatAction(a, 2))
      .join("");
    if (!items) return "";
    return `\n${title}:\n${items}\n`;
  }

  private formatAction(action: Action, indent: number): string {
    const helpPosition = Math.min(this.actionMaxLength + 2, this.maxHelpPosition);
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const actionWidth = helpPosition - indent - 2;
    const header = invocation(action);
    const pad = " ".repeat(indent);
    let first: string;
    let indentFirst = 0;
    if (!action.help) {
      first = `${pad}${header}\n`;
    } else if (pyLen(header) <= actionWidth) {
      first = `${pad}${header}${" ".repeat(actionWidth - pyLen(header))}  `;
    } else {
      first = `${pad}${header}\n`;
      indentFirst = helpPosition;
    }
    const parts = [first];
    if (action.help && action.help.trim()) {
      const lines = textwrap(action.help.replace(/[ \t\n\r\f\v]+/g, " ").trim(), helpWidth);
      if (lines.length > 0) {
        parts.push(`${" ".repeat(indentFirst)}${lines[0]}\n`);
        for (const line of lines.slice(1)) parts.push(`${" ".repeat(helpPosition)}${line}\n`);
      }
    } else if (!first.endsWith("\n")) {
      parts.push("\n");
    }
    for (const sub of action.choiceActions) parts.push(this.formatAction(sub, indent + 2));
    return parts.join("");
  }
}

function metavarOf(action: Action, fallback: string): string {
  if (action.metavar !== undefined) return action.metavar;
  if (action.choices !== undefined) return `{${action.choices.join(",")}}`;
  return fallback;
}

function formatArgs(action: Action, metavar: string): string {
  if (action.nargs === "?") return `[${metavar}]`;
  if (action.nargs === PARSER) return `${metavar} ...`;
  return metavar;
}

function invocation(action: Action): string {
  if (action.optionStrings.length === 0) return metavarOf(action, action.pyDest);
  if (action.nargs === 0) return action.optionStrings.join(", ");
  return `${action.optionStrings.join(", ")} ${formatArgs(action, metavarOf(action, action.pyDest.toUpperCase()))}`;
}

function usagePart(action: Action): string {
  if (action.optionStrings.length === 0) return formatArgs(action, metavarOf(action, action.pyDest));
  const part =
    action.nargs === 0
      ? action.kind === "boolean_optional"
        ? action.optionStrings.join(" | ")
        : action.optionStrings[0]!
      : `${action.optionStrings[0]} ${formatArgs(action, metavarOf(action, action.pyDest.toUpperCase()))}`;
  return `[${part}]`;
}

// textwrap.TextWrapper.wordsep_re: break at whitespace and after a hyphen between letters.
const WS = "[\\t\\n\\x0b\\x0c\\r ]";
const NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
const WORD = "[\\p{L}\\p{N}\\p{M}_]";
const WORD_PUNCT = "[\\p{L}\\p{N}\\p{M}_!\"'&.,?]";
const LETTER = "[\\p{L}\\p{M}_]";
const WORDSEP_RE = new RegExp(
  `(${WS}+` +
    `|(?<=${WORD_PUNCT})-{2,}(?=${WORD})` +
    `|${NWS}+?(?:-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})|(?=${WS}|$)|(?<=${WORD_PUNCT})(?=-{2,}${WORD})))`,
  "u",
);

/** `textwrap.wrap(text, width)` with the default options. */
export function textwrap(text: string, width: number): string[] {
  const chunks = text.split(WORDSEP_RE).filter((c) => c);
  chunks.reverse();
  const lines: string[] = [];
  while (chunks.length > 0) {
    const curLine: string[] = [];
    let curLen = 0;
    if (chunks[chunks.length - 1]!.trim() === "" && lines.length > 0) chunks.pop();
    while (chunks.length > 0) {
      const l = pyLen(chunks[chunks.length - 1]!);
      if (curLen + l <= width) {
        curLine.push(chunks.pop()!);
        curLen += l;
      } else {
        break;
      }
    }
    if (chunks.length > 0 && pyLen(chunks[chunks.length - 1]!) > width) {
      handleLongWord(chunks, curLine, curLen, width);
      curLen = curLine.reduce((n, c) => n + pyLen(c), 0);
    }
    if (curLine.length > 0 && curLine[curLine.length - 1]!.trim() === "") {
      curLen -= pyLen(curLine[curLine.length - 1]!);
      curLine.pop();
    }
    if (curLine.length > 0) lines.push(curLine.join(""));
  }
  return lines;
}

function handleLongWord(reversedChunks: string[], curLine: string[], curLen: number, width: number): void {
  const spaceLeft = width < 1 ? 1 : width - curLen;
  const chunk = [...reversedChunks[reversedChunks.length - 1]!];
  let end = spaceLeft;
  if (chunk.length > spaceLeft) {
    const hyphen = chunk.slice(0, spaceLeft).lastIndexOf("-");
    if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== "-")) end = hyphen + 1;
  }
  curLine.push(chunk.slice(0, end).join(""));
  reversedChunks[reversedChunks.length - 1] = chunk.slice(end).join("");
}

function textwrapFill(text: string, width: number): string {
  return textwrap(text, width).join("\n");
}
