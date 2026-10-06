/**
 * A small equivalent of `rich.text.Text`: plain text with style spans.
 *
 * A style is a string in the Rich vocabulary: space-separated words, where
 * `bold` and `dim` are attributes and any other word is a color
 * (for example `"bold #d7875f"` or `"#d75f5f dim"`).
 */

export interface Span {
  readonly text: string;
  readonly style: string;
}

export interface ParsedStyle {
  color?: string;
  bold: boolean;
  dim: boolean;
}

export class Text {
  readonly spans: Span[] = [];

  constructor(text = "", style = "") {
    if (text) this.spans.push({ text, style });
  }

  /** Append a string with a style, or the spans of another `Text`. Returns `this`. */
  append(text: string | Text, style = ""): this {
    if (text instanceof Text) {
      this.spans.push(...text.spans);
    } else if (text) {
      this.spans.push({ text, style });
    }
    return this;
  }

  get plain(): string {
    return this.spans.map((span) => span.text).join("");
  }

  /** The spans cut at each newline, one array of spans for each line. */
  lines(): Span[][] {
    const out: Span[][] = [[]];
    for (const span of this.spans) {
      const parts = span.text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) out.push([]);
        if (part) out[out.length - 1]!.push({ text: part, style: span.style });
      });
    }
    return out;
  }
}

export function parseStyle(style: string): ParsedStyle {
  const parsed: ParsedStyle = { bold: false, dim: false };
  for (const word of style.split(/\s+/)) {
    if (!word) continue;
    if (word === "bold") parsed.bold = true;
    else if (word === "dim") parsed.dim = true;
    else parsed.color = word;
  }
  return parsed;
}
