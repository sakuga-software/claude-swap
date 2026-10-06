/** Python format-spec and type-name behavior for text that tests compare. */

/**
 * `format(x, ".{digits}f")`. An exact tie rounds half to even, as Python
 * does. `Number.prototype.toFixed` rounds a tie up.
 */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const scale = 10 ** digits;
  const scaled = x * scale;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5 && Number.isSafeInteger(floor)) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    return (even / scale).toFixed(digits);
  }
  return x.toFixed(digits);
}

/** `format(x, ",.{digits}f")`: fixed point with a comma between each group of three digits. */
export function pyGroupedFixed(x: number, digits: number): string {
  const text = pyFixed(x, digits);
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole = "", fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** The number of code points in `text`, like Python `len()`. */
export function pyLen(text: string): number {
  return [...text].length;
}

/** `str.ljust(width)` with code-point width. */
export function ljust(text: string, width: number): string {
  const pad = width - pyLen(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** `str.rjust(width)` with code-point width. */
export function rjust(text: string, width: number): string {
  const pad = width - pyLen(text);
  return pad > 0 ? " ".repeat(pad) + text : text;
}

/** `type(value).__name__` for a value that `json.loads` returns. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "object") return "dict";
  return typeof value;
}

/** `repr(text)` for a `str`: single quotes, unless the text holds a single quote and no double quote. */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replaceAll(quote, `\\${quote}`);
  return `${quote}${body}${quote}`;
}
