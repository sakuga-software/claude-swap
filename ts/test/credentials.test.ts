import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE,
  CredentialStore,
  type StoreHost,
} from "../src/credentials.js";
import { getLogger } from "../src/logging_config.js";
import { internals as keychain } from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import { keychainServiceName } from "../src/session.js";
import { testHome } from "./helpers/home.js";

function host(credentialsDir: string): StoreHost {
  return { platform: Platform.MACOS, credentialsDir, logger: getLogger("test") };
}

function oauth(token: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `sk-${token}`, refreshToken: `rt-${token}`, expiresAt: 9999999999000 },
  });
}

const DEFAULT_PROFILE_CREDS = oauth("default-profile");
const CUSTOM_PROFILE_CREDS = oauth("custom-profile");
const SECURE_PROFILE_CREDS = oauth("secure-profile");

/** A fake Keychain: only the listed services exist, and each probe is recorded. Others are absent (rc 44). */
function fakeKeychain(mapping: Record<string, string>, seen: string[]): void {
  keychain.getPassword = (service: string) => {
    seen.push(service);
    return mapping[service] ?? null;
  };
}

function customProfile(): string {
  const custom = path.join(testHome(), "custom-profile");
  fs.mkdirSync(custom);
  return custom;
}

describe("TestActiveReadStaysOnOneProfile", () => {
  it("test_custom_config_dir_does_not_return_the_default_keychain_item", () => {
    const custom = customProfile();
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    const seen: string[] = [];
    fakeKeychain(
      {
        [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS,
        [CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE]: "sk-ant-api-default",
      },
      seen,
    );

    const result = new CredentialStore(host(path.join(testHome(), "backups"))).readActiveCredentials();

    expect(seen, `read the default profile's OAuth item: ${seen}`).not.toContain(CLAUDE_CODE_KEYCHAIN_SERVICE);
    expect(seen, `read the default profile's managed-key item: ${seen}`).not.toContain(
      CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE,
    );
    expect(result.value).not.toBe(DEFAULT_PROFILE_CREDS);
    expect(result.value).toBeFalsy();
  });

  it("test_custom_config_dir_reads_its_own_hashed_keychain_item", () => {
    const custom = customProfile();
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    const seen: string[] = [];
    fakeKeychain(
      {
        [keychainServiceName(custom)]: CUSTOM_PROFILE_CREDS,
        [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS,
      },
      seen,
    );

    const result = new CredentialStore(host(path.join(testHome(), "backups"))).readActiveCredentials();

    expect(result.value).toBe(CUSTOM_PROFILE_CREDS);
    expect(seen).toEqual([keychainServiceName(custom)]);
  });

  it("test_custom_config_dir_falls_back_to_its_own_credentials_file", () => {
    const custom = customProfile();
    fs.writeFileSync(path.join(custom, ".credentials.json"), CUSTOM_PROFILE_CREDS, "utf8");
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    const seen: string[] = [];
    fakeKeychain({ [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS }, seen);

    const store = new CredentialStore(host(path.join(testHome(), "backups")));
    expect(store.readActiveCredentials().value).toBe(CUSTOM_PROFILE_CREDS);
    expect(seen).not.toContain(CLAUDE_CODE_KEYCHAIN_SERVICE);
  });

  it("test_default_profile_still_reads_the_unsuffixed_item", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    const seen: string[] = [];
    fakeKeychain({ [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS }, seen);

    const store = new CredentialStore(host(path.join(testHome(), "backups")));
    expect(store.readActiveCredentials().value).toBe(DEFAULT_PROFILE_CREDS);
    expect(seen).toEqual([CLAUDE_CODE_KEYCHAIN_SERVICE]);
  });

  it("test_config_dir_equal_to_the_default_falls_back_to_the_unsuffixed_item", () => {
    const defaultDir = path.join(testHome(), ".claude");
    fs.mkdirSync(defaultDir, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    const seen: string[] = [];
    fakeKeychain({ [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS }, seen);

    const store = new CredentialStore(host(path.join(testHome(), "backups")));
    expect(store.readActiveCredentials().value).toBe(DEFAULT_PROFILE_CREDS);
    expect(seen).toEqual([keychainServiceName(defaultDir), CLAUDE_CODE_KEYCHAIN_SERVICE]);
  });
});

describe("TestSecureStorageOverride", () => {
  it("test_defined_and_empty_selects_the_default_store", () => {
    const custom = customProfile();
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");

    const seen: string[] = [];
    fakeKeychain({ [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS }, seen);

    const store = new CredentialStore(host(path.join(testHome(), "backups")));
    expect(store.readActiveCredentials().value).toBe(DEFAULT_PROFILE_CREDS);
    expect(seen).toEqual([CLAUDE_CODE_KEYCHAIN_SERVICE]);
  });

  it("test_defined_and_set_selects_that_stores_hashed_item", () => {
    const custom = customProfile();
    const secure = path.join(testHome(), "secure-profile");
    fs.mkdirSync(secure);
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secure);

    const seen: string[] = [];
    fakeKeychain(
      {
        [keychainServiceName(secure)]: SECURE_PROFILE_CREDS,
        [keychainServiceName(custom)]: CUSTOM_PROFILE_CREDS,
        [CLAUDE_CODE_KEYCHAIN_SERVICE]: DEFAULT_PROFILE_CREDS,
      },
      seen,
    );

    const store = new CredentialStore(host(path.join(testHome(), "backups")));
    expect(store.readActiveCredentials().value).toBe(SECURE_PROFILE_CREDS);
    expect(seen).toEqual([keychainServiceName(secure)]);
  });
});
