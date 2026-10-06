import { main } from "./cli.js";
import { SystemExit } from "./support/exit.js";

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

let code = 0;
try {
  await main();
} catch (e) {
  if (!(e instanceof SystemExit)) throw e;
  code = e.code;
}
// A pipe on macOS writes asynchronously: exit only after stdout and stderr drain, or the JSON output is cut.
await Promise.all([flush(process.stdout), flush(process.stderr)]);
process.exit(code);
