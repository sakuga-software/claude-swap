// Child process for the locking tests: hold a FileLock for a number of seconds.
// Usage: node --import tsx hold-lock.ts <lockPath> <seconds>
import { FileLock } from "../../src/locking.js";
import { sleepSync } from "../../src/support/sleep.js";

const [lockPath = "", seconds = "0"] = process.argv.slice(2);
const lock = new FileLock(lockPath);
if (lock.acquire(5.0)) {
  process.stdout.write("ready\n");
  sleepSync(Number(seconds) * 1000);
  lock.release();
}
