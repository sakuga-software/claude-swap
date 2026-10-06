// Child process for the stash manifest concurrency tests.
// Usage: node --import tsx stash-churn.ts <credentialsDir> <role> <rows> [gateLockPath]
// <role> is "stash:<tag>" or "churn". With a gate path, each mutation runs under that FileLock.
import { CredentialStore } from "../../src/credentials.js";
import { FileLock } from "../../src/locking.js";
import { getLogger } from "../../src/logging_config.js";
import { Platform } from "../../src/models.js";

const [credentialsDir = "", role = "", rowsArg = "0", gatePath = ""] = process.argv.slice(2);
const rows = Number(rowsArg);
const store = new CredentialStore({ platform: Platform.LINUX, credentialsDir, logger: getLogger("claude-swap") });

function gate<T>(fn: () => T): T {
  if (!gatePath) return fn();
  return new FileLock(gatePath).withLock(fn);
}

if (role.startsWith("stash:")) {
  const tag = role.slice("stash:".length);
  for (let i = 0; i < rows; i++) {
    gate(() =>
      store.writeUnclaimedCredential(`creds-${tag}${i}`, {
        reason: "consume-gate-persist-lock-failed",
        configSlot: "1",
        consumedFp: "fp",
        probe: `${tag}${i}`,
      }),
    );
  }
} else if (role === "churn") {
  for (let i = 0; i < rows; i++) {
    const entryId = gate(() => store.writeUnclaimedCredential(`retire-${i}`, { configSlot: "1", consumedFp: "other" }));
    gate(() => store.removeUnclaimedCredential(entryId));
  }
} else {
  throw new Error(`unknown role: ${role}`);
}
