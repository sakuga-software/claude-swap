/**
 * Snapshot source: the supported read path for dashboards and GUI shells.
 *
 * The usage store paces the network: its poll plans and its gates give every
 * surface the same cadence per account. Each `take()` runs the same on-demand
 * pass as `cswap list`, and the store decides which accounts it can fetch.
 * `storeOnly` is for a shell that runs an auto engine, which collects on its own schedule.
 */
import { USAGE_TOKEN_EXPIRED } from "./json_output.js";
import type { AccountSnapshot, AccountsSnapshot } from "./models.js";
import type { ClaudeAccountSwitcher } from "./switcher.js";
import { UsageEntry, withSentinel } from "./usage_store.js";

/** The part of `ClaudeAccountSwitcher` that `SnapshotSource` uses. */
export type SnapshotHost = Pick<ClaudeAccountSwitcher, "accountsSnapshot">;

export interface TakeOptions {
  /** The explicit refresh of the user. Kept for API stability: the store caps it like a normal pass. */
  full?: boolean;
  /** Read the store with no network fetch. */
  storeOnly?: boolean;
}

/** Takes one coherent snapshot per call. The store paces the network. */
export class SnapshotSource {
  switcher: SnapshotHost;
  last: AccountsSnapshot | null = null;

  constructor(switcher: SnapshotHost) {
    this.switcher = switcher;
  }

  async take({ storeOnly = false }: TakeOptions = {}): Promise<AccountsSnapshot> {
    const fetch: Set<string> | null = storeOnly ? new Set() : null;
    const snap = this.reconcile(await this.switcher.accountsSnapshot(fetch));
    this.last = snap;
    return snap;
  }

  reconcile(snap: AccountsSnapshot): AccountsSnapshot {
    if (this.last === null) return snap;
    const previous = new Map(this.last.accounts.map((acc) => [acc.number, acc]));
    const accounts = snap.accounts.map((acc) => this.reconcileAccount(acc, previous.get(acc.number), snap.takenAt));
    return Object.freeze({ ...snap, accounts: Object.freeze(accounts) });
  }

  reconcileAccount(acc: AccountSnapshot, prev: AccountSnapshot | undefined, takenAt: number): AccountSnapshot {
    if (prev === undefined || !sameIdentity(accountIdentity(acc), accountIdentity(prev))) return acc;

    const prevFetched = prev.usage.fetchedAt;
    const fetched = acc.usage.fetchedAt;
    if (prevFetched !== null && (fetched === null || fetched < prevFetched)) {
      return Object.freeze({ ...acc, usage: withCurrentAge(prev.usage, takenAt) });
    }
    if (acc.usage.sentinel !== null) return acc;

    if (prev.usage.sentinel === USAGE_TOKEN_EXPIRED && fetched === prevFetched) {
      return Object.freeze({ ...acc, usage: withSentinel(acc.usage, USAGE_TOKEN_EXPIRED) });
    }
    return acc;
  }
}

/**
 * The identity of a slot across snapshots: `[email, orgUuid, kind]`.
 *
 * The snapshot reconciliation and the TUI snapshot merge must both use this
 * one definition. Otherwise one of them can miss a slot that another login took.
 */
export function accountIdentity(acc: AccountSnapshot): readonly [string, string, string] {
  return [acc.email, acc.orgUuid, acc.kind];
}

/** Elementwise equality of two `accountIdentity` tuples. */
export function sameIdentity(a: readonly [string, string, string], b: readonly [string, string, string]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function withCurrentAge(usage: UsageEntry, takenAt: number): UsageEntry {
  const fetched = usage.fetchedAt;
  if (fetched === null) return usage;
  return new UsageEntry({ ...usage, ageS: Math.max(0.0, takenAt - fetched) });
}
