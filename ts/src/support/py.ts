/** Python output formats that a file reader or a test can depend on. */

export interface IsoformatOptions {
  /** `auto` writes microseconds if they are not zero, as Python does. */
  timespec?: "auto" | "seconds" | "milliseconds" | "microseconds";
  /** `utc` writes `+00:00`, `local` writes the local offset, `naive` writes no offset. */
  zone?: "utc" | "local" | "naive";
}

/** `datetime.isoformat()`. A JavaScript `Date` has millisecond precision, so microseconds end in `000`. */
export function isoformat(date: Date, { timespec = "auto", zone = "utc" }: IsoformatOptions = {}): string {
  const utc = zone === "utc";
  const parts = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  const [y, mo, d, h, mi, s, ms] = parts as [number, number, number, number, number, number, number];
  let text = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
  if (timespec === "milliseconds") text += `.${pad(ms, 3)}`;
  else if (timespec === "microseconds" || (timespec === "auto" && ms !== 0)) text += `.${pad(ms, 3)}000`;
  if (zone === "utc") text += "+00:00";
  if (zone === "local") text += offset(date);
  return text;
}

/**
 * `datetime.fromisoformat()` for the formats that Python 3.11+ accepts in practice:
 * `Z` or `±HH:MM` offsets, a date only, or no offset (local time, as Python treats a naive value).
 */
export function fromisoformat(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim());
  if (!match) throw new RangeError(`Invalid isoformat string: '${text}'`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0", tz] = match;
  const ms = Math.floor(Number(frac.padEnd(6, "0")) / 1000);
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms] as const;
  if (tz === undefined) return new Date(...fields);
  const utcMs = Date.UTC(...fields);
  if (tz === "Z") return new Date(utcMs);
  const sign = tz.startsWith("-") ? -1 : 1;
  const digits = tz.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  return new Date(utcMs - sign * minutes * 60_000);
}

/**
 * `json.dumps(value, indent=indent)` with Python's default separators and
 * `ensure_ascii=True`. A float with no fraction prints as an integer, because
 * JavaScript has one number type.
 */
export function jsonDumps(value: unknown, indent?: number): string {
  const spaced =
    indent === undefined ? addPythonSeparators(JSON.stringify(value) ?? "null") : JSON.stringify(value, null, indent);
  return spaced.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function addPythonSeparators(compact: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < compact.length; i += 1) {
    const c = compact[i]!;
    out += c;
    if (inString) {
      if (c === "\\") out += compact[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "," || c === ":") out += " ";
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function offset(date: Date): string {
  const total = -date.getTimezoneOffset();
  const sign = total >= 0 ? "+" : "-";
  return `${sign}${pad(Math.floor(Math.abs(total) / 60))}:${pad(Math.abs(total) % 60)}`;
}
