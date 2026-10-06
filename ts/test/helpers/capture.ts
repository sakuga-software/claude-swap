import { vi } from "vitest";

export interface Captured {
  out: string;
  err: string;
}

/**
 * The equivalent of pytest `capsys`. Call it in a test (or in `beforeEach`)
 * to record `process.stdout.write` and `process.stderr.write`. `readouterr()`
 * returns the text since the last call and clears it.
 */
export function captureOutput(): { readouterr(): Captured } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  return {
    readouterr(): Captured {
      const result = { out, err };
      out = "";
      err = "";
      return result;
    },
  };
}
