/**
 * Export and import account data for claude-swap.
 *
 * Moves the OAuth credentials and config across machines in a portable JSON
 * envelope. No encryption is built in: users add their own
 * (for example `cswap --export - | gpg -c > out.gpg`).
 */

import fs from "node:fs";
import path from "node:path";
import { looksLikeApiKey } from "./credentials.js";
import { ConfigError, CredentialReadError, TransferError } from "./exceptions.js";
import { replaceWithRetry } from "./fsutil.js";
import { SCHEMA_VERSION as JSON_SCHEMA_VERSION, usageFromJson } from "./json_output.js";
import { Platform, getTimestamp, normalizeAlias } from "./models.js";
import { type UsageDict, credentialFingerprint } from "./oauth.js";
import { internals as settingsInternals } from "./settings.js";
import { expandUser } from "./support/pathlib.js";
import { jsonDumps } from "./support/py.js";
import { pyFixed, pyStrRepr, pyTypeName } from "./support/pyformat.js";
import { type AccountRecord, ClaudeAccountSwitcher, type SequenceData } from "./switcher.js";
import { VERSION } from "./version.js";

export const FORMAT_VERSION = 1;

type JsonObject = Record<string, unknown>;
type Identity = [email: string, orgUuid: string];

const PLATFORM_TAG: Record<Platform, string> = {
  MACOS: "macos",
  LINUX: "linux",
  WSL: "wsl",
  WINDOWS: "windows",
  UNKNOWN: "unknown",
};

/** Seams that the tests replace. */
export const internals = {
  /** `sys.stdin.read()`. */
  readStdin: (): string => fs.readFileSync(0, "utf8"),
};

/** Print to stderr, so stdout stays pure JSON in pipe mode. */
function eprint(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `dict.get(key, default)`: the default applies only if the key is absent. */
function get(obj: JsonObject, key: string, dflt: unknown): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : dflt;
}

/** Python `repr()` for a value that `json.loads` returns. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return pyStrRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function parsePayload(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new TransferError(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new TransferError(`${label} must be a JSON object`);
  return parsed;
}

/**
 * Validate the fields of one account before a file name uses them.
 * The email and the slot number go into file names, so they must not allow a path traversal.
 */
function validateImportedAccount(switcher: ClaudeAccountSwitcher, account: unknown): [string, string] {
  if (!isObject(account)) throw new TransferError("account entry must be a JSON object");

  const email = account.email;
  if (typeof email !== "string" || !switcher.validateEmail(email)) {
    throw new TransferError(`invalid or missing email in imported account: ${pyRepr(email)}`);
  }

  const rawNumber = account.number;
  if (typeof rawNumber !== "number" || !Number.isInteger(rawNumber) || rawNumber < 1) {
    throw new TransferError(`invalid slot number in imported account (${email}): ${pyRepr(rawNumber)}`);
  }

  for (const field of ["organizationUuid", "organizationName", "uuid", "added", "alias"]) {
    const value = account[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TransferError(`${field} for ${email} must be a string, got ${pyTypeName(value)}`);
    }
  }

  const alias = account.alias;
  if (typeof alias === "string") {
    try {
      normalizeAlias(alias);
    } catch (e) {
      if (e instanceof RangeError) throw new TransferError(`invalid alias for ${email}: ${e.message}`);
      throw e;
    }
  }

  return [email, String(rawNumber)];
}

/** `str(Path(p).expanduser())`. */
function displayPath(p: string): string {
  const normalized = path.normalize(expandUser(p));
  return normalized.length > 1 && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

/**
 * Write text atomically with mode 0600.
 * WARNING: The payload holds live OAuth refresh tokens. The temporary file
 * must have mode 0600 from its creation, so do not write and then chmod.
 */
function atomicWriteFile(target: string, content: string): void {
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) throw new TransferError(`export destination must be a file path, not a directory: ${target}`);
  const [fd, tmpPath] = settingsInternals.mkstemp(path.dirname(target), ".tmp");
  let openFd = fd;
  try {
    fs.writeSync(openFd, Buffer.from(content, "utf8"));
    fs.closeSync(openFd);
    openFd = -1;
    replaceWithRetry(tmpPath, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } catch (e) {
    if (openFd >= 0) fs.closeSync(openFd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The replace can already have moved the file.
    }
    throw e;
  }
}

/**
 * Keep only the keys of `~/.claude.json` that a switch reads (`oauthAccount`).
 * The other keys identify the source machine and have no use on another machine.
 */
function slimConfig(configObj: JsonObject, label: string): JsonObject {
  const oauth = configObj.oauthAccount;
  if (!isObject(oauth)) throw new TransferError(`${label} is missing oauthAccount — cannot export`);
  return { oauthAccount: oauth };
}

/**
 * Keep only the login of the account (`claudeAiOauth`). The other keys are
 * machine-shared or device-bound secrets. A legacy shape exports as it is.
 */
function slimCredentials(credsObj: JsonObject): JsonObject {
  if (!Object.hasOwn(credsObj, "claudeAiOauth")) return credsObj;
  return { claudeAiOauth: credsObj.claudeAiOauth };
}

function accountsOf(data: SequenceData | null | undefined): Record<string, AccountRecord> {
  return isObject(data?.accounts) ? (data.accounts as Record<string, AccountRecord>) : {};
}

/**
 * Export accounts to a JSON file, or to stdout if `destination` is `-`.
 *
 * `account` (NUM|EMAIL) limits the export to one account. With `full`, the
 * export holds the full `~/.claude.json` snapshot and the full credential
 * object of each account (same-PC backup).
 *
 * Throws `TransferError` for malformed or missing data and an unknown account,
 * and `CredentialReadError` if a credential read fails.
 */
export function exportAccounts(
  switcher: ClaudeAccountSwitcher,
  destination: string,
  account: string | null = null,
  full = false,
): void {
  const sequenceData = switcher.getSequenceDataMigrated();
  if (!sequenceData || Object.keys(accountsOf(sequenceData)).length === 0) {
    throw new TransferError("no accounts to export — run cswap --add-account first");
  }

  const accountsMap = accountsOf(sequenceData);

  // An account that the user names must fail hard if its backup is missing.
  // In the all-accounts case, a broken slot gets a warning and the export continues.
  const explicitAccount = account !== null;
  let targetNums: string[];
  if (explicitAccount) {
    const resolved = switcher.resolveAccountIdentifier(account);
    if (resolved === null || !Object.hasOwn(accountsMap, resolved)) {
      throw new TransferError(`account not found: ${account}`);
    }
    targetNums = [resolved];
  } else {
    targetNums = Object.keys(accountsMap).sort((a, b) => Number(a) - Number(b));
  }

  // The live credential of the active account is fresher than its backup.
  const currentIdentity = switcher.getCurrentAccount();

  const accountsPayload: JsonObject[] = [];
  for (const num of targetNums) {
    const record = accountsMap[num]! as JsonObject;
    const email = get(record, "email", "") as string;
    const orgUuid = (record.organizationUuid || "") as string;

    const isActive = currentIdentity !== null && currentIdentity[0] === email && currentIdentity[1] === orgUuid;

    let credsText: string;
    let configText: string;
    if (isActive) {
      const live = switcher.readCredentials();
      if (!live) throw new CredentialReadError(`failed to read live credentials for active account ${email}`);
      credsText = live;
      const configPath = switcher.getClaudeConfigPath();
      if (!fs.existsSync(configPath)) throw new ConfigError("Claude config file not found");
      configText = fs.readFileSync(configPath, "utf8");
    } else {
      credsText = switcher.readAccountCredentials(num, email);
      configText = switcher.readAccountConfig(num, email);
      if (!credsText || !configText) {
        if (explicitAccount) {
          if (!credsText) throw new CredentialReadError(`no backup credentials found for account ${num} (${email})`);
          throw new ConfigError(`no backup config found for account ${num} (${email})`);
        }
        eprint(
          `Skipping Account-${num} (${email}): no stored ` +
            `credentials/config — re-add with: ` +
            `cswap --add-account --slot ${num}`,
        );
        continue;
      }
    }

    let configObj = parsePayload(configText, `config for ${email}`);
    if (!full) configObj = slimConfig(configObj, `config for ${email}`);

    // An API-key account stores a raw `sk-ant-api…` string, not OAuth JSON.
    const isApiKey = looksLikeApiKey(credsText);
    let credsPayload: unknown;
    if (isApiKey) {
      credsPayload = credsText.trim();
    } else {
      let parsed = parsePayload(credsText, `credentials for ${email}`);
      if (!full) parsed = slimCredentials(parsed);
      credsPayload = parsed;
    }
    const entry: JsonObject = {
      number: Number(num),
      email,
      uuid: get(record, "uuid", ""),
      organizationUuid: orgUuid,
      organizationName: record.organizationName || "",
      added: get(record, "added", ""),
      credentials: credsPayload,
      config: configObj,
    };
    if (isApiKey) entry.kind = "api_key";
    if (record.alias) entry.alias = record.alias;
    accountsPayload.push(entry);
  }

  if (accountsPayload.length === 0) {
    throw new TransferError(
      "no exportable accounts — all managed slots are missing stored " +
        "credentials/config. Re-add with: cswap --add-account --slot <number>",
    );
  }

  // Carry activeAccountNumber only if the payload holds that slot. Else the import refers to a missing account.
  const recordedActive = sequenceData.activeAccountNumber;
  const exportedNums = new Set(accountsPayload.map((a) => a.number));
  const activeInPayload = typeof recordedActive === "number" && exportedNums.has(recordedActive) ? recordedActive : null;

  const envelope = {
    version: FORMAT_VERSION,
    exportedAt: getTimestamp(),
    exportedFrom: PLATFORM_TAG[switcher.platform] ?? "unknown",
    swapVersion: VERSION,
    encrypted: false,
    activeAccountNumber: activeInPayload,
    accounts: accountsPayload,
  };

  const serialized = jsonDumps(envelope, 2);

  if (destination === "-") {
    process.stdout.write(serialized);
    process.stdout.write("\n");
    return;
  }

  const outPath = displayPath(destination);
  atomicWriteFile(outPath, `${serialized}\n`);
  eprint(`Exported ${accountsPayload.length} account(s) to ${outPath}`);
}

interface NormalizedAccount {
  email: string;
  exportedNum: string;
  orgUuid: string;
  orgName: string;
  uuid: string;
  added: string;
  kind: "api_key" | "oauth";
  alias: string | null;
  credsText: string;
  configText: string;
}

function readSource(source: string, missingLabel: string): string {
  if (source === "-") return internals.readStdin();
  const inPath = displayPath(source);
  if (!fs.existsSync(inPath)) throw new TransferError(`${missingLabel} not found: ${inPath}`);
  return fs.readFileSync(inPath, "utf8");
}

/**
 * Import accounts from a JSON file, or from stdin if `source` is `-`.
 *
 * With `force`, the import overwrites the matching local slot in place. Without
 * it, the import skips an existing account, but it replaces a slot that is
 * quarantined as refresh-token-dead (auto-heal, issue #136).
 *
 * Throws `TransferError` for a malformed file, a version mismatch or an encrypted payload.
 */
export function importAccounts(switcher: ClaudeAccountSwitcher, source: string, force = false): void {
  const text = readSource(source, "import file");

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch (e) {
    throw new TransferError(`export file is not valid JSON: ${(e as Error).message}`);
  }

  if (!isObject(envelope)) throw new TransferError("export file must be a JSON object");

  const version = envelope.version;
  if (version !== FORMAT_VERSION) {
    throw new TransferError(`unsupported export version: ${pyRepr(version)} (expected ${FORMAT_VERSION})`);
  }

  if (envelope.encrypted === true) {
    throw new TransferError(
      "encrypted exports are not supported in this version — " +
        "decrypt before piping (e.g. gpg -d backup.gpg | cswap --import -)",
    );
  }

  const accounts = envelope.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TransferError("export file has no accounts to import");
  }

  // Pass 1: validate every account before the first write, so a bad account
  // later in the list cannot leave the earlier ones half-imported.
  const localData = switcher.getSequenceDataMigrated() ?? {};
  const localAliases = new Map<string, Identity>();
  for (const acc of Object.values(accountsOf(localData))) {
    if (!acc.alias) continue;
    localAliases.set(String(acc.alias).toLowerCase(), [
      (get(acc, "email", "") as string) ?? "",
      (acc.organizationUuid || "") as string,
    ]);
  }
  const normalized: NormalizedAccount[] = [];
  const seenKeys = new Set<string>();
  const seenAliases = new Set<string>();
  for (const raw of accounts as unknown[]) {
    const [email, exportedNum] = validateImportedAccount(switcher, raw);
    const rawObj = raw as JsonObject;
    const orgUuid = (rawObj.organizationUuid || "") as string;
    const credsObj = rawObj.credentials;
    const configObj = rawObj.config;
    if (!isObject(configObj)) throw new TransferError(`config for ${email} must be a JSON object`);
    // An API-key account carries a raw string. An OAuth account carries a JSON object.
    const isApiKey = rawObj.kind === "api_key" || typeof credsObj === "string";
    let credsText: string;
    if (isApiKey) {
      if (!(typeof credsObj === "string" && looksLikeApiKey(credsObj))) {
        throw new TransferError(`API-key credentials for ${email} must be a raw sk-ant-api… string`);
      }
      credsText = credsObj.trim();
    } else {
      if (!isObject(credsObj)) throw new TransferError(`credentials for ${email} must be a JSON object`);
      credsText = jsonDumps(credsObj);
    }
    const key = JSON.stringify([email, orgUuid]);
    if (seenKeys.has(key)) {
      throw new TransferError(`duplicate account in export: ${email} (org=${orgUuid || "personal"})`);
    }
    seenKeys.add(key);

    let alias = (rawObj.alias || null) as string | null;
    if (alias) {
      const aliasKey = normalizeAlias(alias);
      if (seenAliases.has(aliasKey)) throw new TransferError(`duplicate alias in export: ${aliasKey}`);
      seenAliases.add(aliasKey);
      const owner = localAliases.get(aliasKey);
      if (owner !== undefined && (owner[0] !== email || owner[1] !== orgUuid)) {
        eprint(`Warning: alias '${aliasKey}' for ${email} already used by an existing account, dropping the imported alias`);
        alias = null;
      } else {
        alias = aliasKey;
      }
    }

    normalized.push({
      email,
      exportedNum,
      orgUuid,
      orgName: (rawObj.organizationName || "") as string,
      uuid: (rawObj.uuid || "") as string,
      added: (rawObj.added || getTimestamp()) as string,
      kind: isApiKey ? "api_key" : "oauth",
      alias,
      credsText,
      configText: jsonDumps(configObj, 2),
    });
  }

  // Pass 2: writes. A failure from here on is environmental (disk, keyring), not a bad file.
  switcher.setupDirectories();
  switcher.initSequenceFile();

  let imported = 0;
  let skipped = 0;
  let overwritten = 0;
  let replaced = 0;
  const writtenSlots = new Set<string>();

  // Record the local slot of the envelope's active account. The envelope's
  // slot number can belong to an unrelated local account.
  const envelopeActive = envelope.activeAccountNumber;
  const envelopeActiveStr =
    typeof envelopeActive === "number" && Number.isInteger(envelopeActive) ? String(envelopeActive) : null;
  let resolvedActiveSlot: string | null = null;

  for (const entry of normalized) {
    const isEnvelopeActive = envelopeActiveStr !== null && entry.exportedNum === envelopeActiveStr;

    // Read the sequence again for each account, so each write sees the previous ones.
    const current = switcher.getSequenceDataMigrated();
    const data: SequenceData =
      current && Object.keys(current).length > 0
        ? current
        : { activeAccountNumber: null, lastUpdated: getTimestamp(), sequence: [], accounts: {} };
    const existingSlot = ClaudeAccountSwitcher.findAccountSlot(data, entry.email, entry.orgUuid);

    let outcome: "overwrote" | "replaced" | "imported";
    let targetNum: string;
    let hadStrike = false;
    let sameGeneration = false;
    if (existingSlot !== null) {
      if (force) {
        outcome = "overwrote";
        // Read the row before `clearDeadToken` wipes it, so the output can say that the strike was lifted (issue #218).
        const row = switcher.usageStore.entries({ [existingSlot]: [entry.email, entry.orgUuid] })[existingSlot]!;
        hadStrike = row.authDeadStrikes > 0;
        sameGeneration =
          row.struckFingerprint !== null && credentialFingerprint(entry.credsText) === row.struckFingerprint;
      } else if (switcher.slotTokenDead(existingSlot, entry.email)) {
        // Narrow auto-heal (issue #136): a plain import replaces a slot only if
        // its identity-matched usage row is quarantined as refresh-token-dead.
        outcome = "replaced";
      } else {
        eprint(`Skipped ${entry.email} (already exists, use --force)`);
        skipped += 1;
        if (isEnvelopeActive) resolvedActiveSlot = existingSlot;
        continue;
      }
      targetNum = existingSlot;
      // The credential write invalidates a session profile that is not live. A live one keeps its own copy.
      const livePids = switcher.liveSessionPids(targetNum, entry.email);
      if (livePids.length > 0) {
        eprint(
          `Warning: ${entry.email} (slot ${targetNum}) has a live ` +
            `session-mode instance (PID ${livePids.join(", ")}); ` +
            "its session profile keeps the pre-import credentials until " +
            "it is restarted via 'cswap run'.",
        );
      }
    } else {
      targetNum = Object.hasOwn(accountsOf(data), entry.exportedNum)
        ? String(switcher.getNextAccountNumber())
        : entry.exportedNum;
      outcome = "imported";
    }

    switcher.writeAccountCredentials(targetNum, entry.email, entry.credsText);
    switcher.writeAccountConfig(targetNum, entry.email, entry.configText);
    // New credential material makes the previous auth verdict obsolete. Removal
    // does not prune usage.json, so an "imported" slot can also hold an old strike (issue #138).
    switcher.usageStore.clearDeadToken([targetNum], { [targetNum]: [entry.email, entry.orgUuid] });

    if (!isObject(data.accounts)) data.accounts = {};
    if (!Array.isArray(data.sequence)) data.sequence = [];
    const newRecord: AccountRecord = {
      email: entry.email,
      uuid: entry.uuid,
      organizationUuid: entry.orgUuid,
      organizationName: entry.orgName,
      added: entry.added,
    };
    if (entry.kind === "api_key") newRecord.kind = "api_key";
    if (entry.alias) newRecord.alias = entry.alias;
    data.accounts[targetNum] = newRecord;
    if (!data.sequence.includes(Number(targetNum))) {
      data.sequence.push(Number(targetNum));
      data.sequence.sort((a, b) => a - b);
    }
    data.lastUpdated = getTimestamp();
    switcher.writeJson(switcher.sequenceFile, data);

    if (isEnvelopeActive) resolvedActiveSlot = targetNum;
    writtenSlots.add(targetNum);

    if (outcome === "overwrote") {
      eprint(`Overwrote ${entry.email} (slot ${targetNum})`);
      if (hadStrike) {
        eprint("  └ cleared this slot's stored dead-token strike");
        if (sameGeneration) {
          eprint(
            "  └ this import holds the same credential " +
              "generation the strike condemned; another permanent " +
              "auth failure will quarantine it again — recover " +
              "with a newer export or a re-login",
          );
        }
      }
      overwritten += 1;
    } else if (outcome === "replaced") {
      eprint(`Replaced ${entry.email} (slot ${targetNum} was quarantined: refresh token dead)`);
      replaced += 1;
    } else {
      eprint(`Imported ${entry.email} → slot ${targetNum}`);
      imported += 1;
    }
  }

  // On a destination with no active selection, seed it from the resolved slot
  // of the envelope's active account. A local selection stays as it is.
  const final = switcher.getSequenceData();
  const finalActive = final?.activeAccountNumber;
  if (
    final !== null &&
    (finalActive === undefined || finalActive === null || finalActive === 0 || (finalActive as unknown) === false) &&
    resolvedActiveSlot !== null
  ) {
    final.activeAccountNumber = Number(resolvedActiveSlot);
    final.lastUpdated = getTimestamp();
    switcher.writeJson(switcher.sequenceFile, final);
  }

  let summary = `Done: ${imported} imported, ${overwritten} overwritten, ${skipped} skipped`;
  if (replaced) summary += `, ${replaced} replaced (dead token)`;
  eprint(summary);

  // A plain switch would back up the live credentials over the imported
  // backup of the live login (issue #79), so show the explicit activation.
  const identity = switcher.getCurrentAccount();
  if (identity !== null && final !== null) {
    const liveSlot = ClaudeAccountSwitcher.findAccountSlot(final, identity[0], identity[1]);
    if (liveSlot !== null && writtenSlots.has(liveSlot)) {
      eprint(
        `Note: ${identity[0]} is your current live login — activate the ` +
          `imported credentials with: cswap --switch-to ${liveSlot} --force`,
      );
    }
  }
}

/**
 * Adopt the usage readings that another machine took, from its `cswap list --json`.
 *
 * Each row with `usageStatus` "ok" matches a local slot by `(email,
 * organizationUuid)` and goes to `UsageStore.adopt` with `usageAgeSeconds` as
 * its age. Rows without usage, and accounts that this machine does not manage,
 * are skipped. With `holdS`, no local collector fetches the matched accounts
 * for that long (bounded, see `adopt`). 0 lifts an earlier hold, `null` keeps it.
 *
 * Throws `TransferError` for a malformed document or an unsupported schema version.
 */
export function importUsage(switcher: ClaudeAccountSwitcher, source: string, holdS: number | null = null): void {
  const text = readSource(source, "usage file");

  const document = parsePayload(text, "usage document");
  const version = document.schemaVersion;
  if (version !== JSON_SCHEMA_VERSION) {
    throw new TransferError(
      `unsupported usage document schemaVersion: ${pyRepr(version)} ` +
        `(expected ${JSON_SCHEMA_VERSION}, as printed by 'cswap list --json')`,
    );
  }
  const rows = document.accounts;
  if (!Array.isArray(rows)) throw new TransferError("usage document has no accounts list");

  // Validate every row before the first write, as `importAccounts` does.
  // A Map keeps the document order: an object puts integer-like keys first.
  const localData = switcher.getSequenceDataMigrated() ?? {};
  const readings = new Map<string, readonly [UsageDict, number]>();
  const identities = new Map<string, Identity>();
  let skipped = 0;
  for (const row of rows as unknown[]) {
    if (!isObject(row)) throw new TransferError("each account row must be a JSON object");
    const email = row.email;
    const orgUuid = row.organizationUuid || "";
    if (typeof email !== "string" || !email || typeof orgUuid !== "string") {
      throw new TransferError("each account row needs an email and an organizationUuid");
    }
    if (row.usageStatus !== "ok") {
      skipped += 1;
      continue;
    }
    const ageS = row.usageAgeSeconds;
    if (typeof ageS !== "number" || !Number.isFinite(ageS) || ageS < 0) {
      throw new TransferError(`usageAgeSeconds for ${email} must be a non-negative number`);
    }
    let usage: UsageDict;
    try {
      usage = usageFromJson(row.usage);
    } catch (e) {
      if (e instanceof RangeError) throw new TransferError(`usage for ${email}: ${e.message}`);
      throw e;
    }
    const num = ClaudeAccountSwitcher.findAccountSlot(localData, email, orgUuid);
    if (num === null) {
      skipped += 1;
      continue;
    }
    if (readings.has(num)) {
      throw new TransferError(`duplicate account in usage document: ${email} (org=${orgUuid || "personal"})`);
    }
    readings.set(num, [usage, ageS]);
    identities.set(num, [email, orgUuid]);
  }

  const adopted = switcher.usageStore.adopt(Object.fromEntries(readings), Object.fromEntries(identities), holdS);
  for (const [num, [email]] of identities) {
    if (adopted.has(num)) eprint(`Adopted usage for ${email} → slot ${num}`);
    else eprint(`Kept slot ${num}'s own reading for ${email}: it is newer`);
  }
  let summary = `Done: ${adopted.size} adopted, ${readings.size - adopted.size} kept, ${skipped} skipped`;
  if (holdS !== null && readings.size > 0) {
    summary += holdS > 0 ? `; fetching held for up to ${pyFixed(holdS, 0)}s` : "; holds lifted";
  }
  eprint(summary);
}
