import { afterEach, beforeEach } from "vitest";
import { internals, realImplementations } from "../../src/macos_keychain.js";

/** An in-memory `(service, account) -> secret` map that replaces the macOS Keychain in tests. */
export class KeychainStore {
  readonly data = new Map<string, string>();

  static key(service: string, account: string): string {
    return JSON.stringify([service, account]);
  }

  getPassword = (service: string, account: string): string | null =>
    this.data.get(KeychainStore.key(service, account)) ?? null;

  itemExists = (service: string, account: string): boolean => this.data.has(KeychainStore.key(service, account));

  setPassword = (service: string, account: string, password: string): void => {
    this.data.set(KeychainStore.key(service, account), password);
  };

  deletePassword = (service: string, account: string): void => {
    this.data.delete(KeychainStore.key(service, account));
  };
}

let current: KeychainStore | undefined;
const realSpawnSync = internals.spawnSync;

/** The fake Keychain of the running test. Throws if the test called `useRealKeychain()`. */
export function keychainStore(): KeychainStore {
  if (!current) throw new Error("keychainStore() called without the Keychain fake");
  return current;
}

/** Install a new fake Keychain. The setup file calls it before each test. */
export function installKeychainFake(): KeychainStore {
  current = new KeychainStore();
  internals.getPassword = current.getPassword;
  internals.itemExists = current.itemExists;
  internals.setPassword = current.setPassword;
  internals.deletePassword = current.deletePassword;
  return current;
}

/** Put back the real implementations. The setup file calls it after each test. */
export function restoreKeychain(): void {
  current = undefined;
  Object.assign(internals, realImplementations);
  internals.spawnSync = realSpawnSync;
}

export interface UseRealKeychainOptions {
  /** Let the real `security` binary run. Only the CI tests with a temporary keychain set it. */
  allowSecurityCli?: boolean;
}

/**
 * Opt the enclosing `describe` (or file) out of the Keychain fake, like the
 * pytest marker `no_keychain_fake`. By default, `internals.spawnSync` throws,
 * so a test must replace it with `vi.spyOn(internals, "spawnSync")`.
 */
export function useRealKeychain({ allowSecurityCli = false }: UseRealKeychainOptions = {}): void {
  beforeEach(() => {
    restoreKeychain();
    if (!allowSecurityCli) {
      internals.spawnSync = () => {
        throw new Error("A test tried to run the real security CLI. Mock internals.spawnSync.");
      };
    }
  });
  afterEach(() => {
    internals.spawnSync = realSpawnSync;
  });
}
