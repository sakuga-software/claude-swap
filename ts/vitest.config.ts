import { defineConfig } from "vitest/config";
import { realStoreRoots } from "./test/helpers/real-store-roots.js";

// The roots are resolved here, in the main process, before any test changes
// HOME. The guard in test/setup.ts compares every write against this frozen list.
const roots = realStoreRoots(process.env);

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    env: { CSWAP_TEST_REAL_STORE_ROOTS: JSON.stringify(roots) },
    unstubEnvs: true,
    restoreMocks: true,
    pool: "forks",
  },
});
