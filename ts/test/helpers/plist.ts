export type PlistValue = string | boolean | number | PlistValue[] | { [key: string]: PlistValue };

/**
 * Parse an XML property list, like `plistlib.loads`. It reads only the
 * types that `launch_agent.buildPlist` writes: dict, array, string, integer, true and false.
 */
export function parsePlist(xml: string): PlistValue {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  let index = tokens.findIndex((token) => /^<plist\b/.test(token)) + 1;
  if (index === 0) throw new Error("no <plist> element");

  const next = (): string => {
    while (index < tokens.length && /^\s*$/.test(tokens[index] ?? "")) index++;
    const token = tokens[index++];
    if (token === undefined) throw new Error("unexpected end of plist");
    return token;
  };

  const text = (close: string): string => {
    let value = "";
    while (tokens[index] !== close) {
      const token = tokens[index++];
      if (token === undefined) throw new Error(`missing ${close}`);
      value += token;
    }
    index++;
    return unescape(value);
  };

  const value = (open: string): PlistValue => {
    switch (open) {
      case "<string>":
        return text("</string>");
      case "<string/>":
        return "";
      case "<integer>":
        return Number(text("</integer>"));
      case "<true/>":
        return true;
      case "<false/>":
        return false;
      case "<array>": {
        const items: PlistValue[] = [];
        for (let token = next(); token !== "</array>"; token = next()) items.push(value(token));
        return items;
      }
      case "<dict>": {
        const dict: Record<string, PlistValue> = {};
        for (let token = next(); token !== "</dict>"; token = next()) {
          if (token !== "<key>") throw new Error(`expected <key>, got ${token}`);
          const key = text("</key>");
          dict[key] = value(next());
        }
        return dict;
      }
      default:
        throw new Error(`unsupported plist token ${open}`);
    }
  };

  return value(next());
}

function unescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
