import { afterEach, beforeEach } from "vitest";
import { deterministicColour, resetColour } from "./helpers/colour.js";
import { isolateHome, releaseHome } from "./helpers/home.js";
import { installKeychainFake, restoreKeychain } from "./helpers/keychain.js";
import { blockNetwork, installOauthProfileFake, restoreOauth } from "./helpers/oauth.js";
import { installRealStoreGuard } from "./helpers/real-store-guard.js";
import { internals as pollPolicy } from "../src/poll_policy.js";

installRealStoreGuard(JSON.parse(process.env.CSWAP_TEST_REAL_STORE_ROOTS ?? "[]"));
blockNetwork();

beforeEach(() => {
  pollPolicy.JITTER_FRAC = 0;
  isolateHome();
  deterministicColour();
  installKeychainFake();
  blockNetwork();
  installOauthProfileFake();
});

afterEach(() => {
  releaseHome();
  resetColour();
  restoreKeychain();
  restoreOauth();
});
