import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ValidationError } from "../src/exceptions.js";
import {
  internals as oauthInternals,
  type AccountIdentity,
} from "../src/oauth.js";
import { ClaudeAccountSwitcher } from "../src/switcher.js";
import { captureOutput } from "./helpers/capture.js";
import { mockClaudeConfig } from "./helpers/fixtures.js";

const CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-THEIRS",
    refreshToken: "rt-theirs",
    expiresAt: 99999999999000,
  },
});

let capsys: ReturnType<typeof captureOutput>;

beforeEach(() => {
  mockClaudeConfig();
  capsys = captureOutput();
});

function switcher(email: string, org = ""): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.initSequenceFile();
  fs.writeFileSync(
    s.getClaudeConfigPath(),
    JSON.stringify({
      oauthAccount: { emailAddress: email, organizationUuid: org },
    }),
  );
  return s;
}

function bareSwitcher(
  oauthAccount: Record<string, unknown>,
): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.initSequenceFile();
  fs.writeFileSync(s.getClaudeConfigPath(), JSON.stringify({ oauthAccount }));
  return s;
}

function captureCreds(
  s: ClaudeAccountSwitcher,
  creds: string | (() => string),
) {
  return vi
    .spyOn(s, "readCaptureCredentials")
    .mockImplementation(typeof creds === "function" ? creds : () => creds);
}

function profile(
  value: AccountIdentity | null | ((token: string) => AccountIdentity | null),
) {
  const fn = vi.fn(async (token: string) =>
    typeof value === "function" ? value(token) : value,
  );
  oauthInternals.fetchOauthProfile = fn;
  return fn;
}

function identity(
  uuid: string,
  email: string,
  organizationUuid: string | null,
): AccountIdentity {
  return { uuid, email, organizationUuid } as AccountIdentity;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error instanceof ConfigError || error instanceof ValidationError).toBe(
    true,
  );
  return error as Error;
}

function accounts(
  s: ClaudeAccountSwitcher,
): Record<string, Record<string, unknown>> {
  return (s.getSequenceData()?.accounts ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
}

const FOREIGN_ORGS: Array<[string, string | null]> = [
  ["org-empty", ""],
  ["org-none", null],
];

it.each(FOREIGN_ORGS)(
  "test_add_refuses_a_credential_whose_owner_is_a_different_account[%s]",
  async (_id, foreignOrg) => {
    const s = switcher("ax@example.com");
    captureCreds(s, CREDS);
    profile(identity("u-other", "other@example.com", foreignOrg));

    const e = await refusal(s.addAccount(7));

    const msg = e.message.toLowerCase();
    expect(
      msg.includes("other@example.com") ||
        msg.includes("does not") ||
        msg.includes("mismatch"),
    ).toBe(true);
    expect("7" in accounts(s)).toBe(false);
  },
);

it.each(FOREIGN_ORGS)(
  "test_add_refuses_a_foreign_credential_on_refresh_in_place[%s]",
  async (_id, foreignOrg) => {
    const s = switcher("ax@example.com");
    const own = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-MINE",
        refreshToken: "rt-mine",
        expiresAt: 99999999999000,
      },
    });
    const spy = captureCreds(s, own);
    profile(identity("u-ax", "ax@example.com", ""));
    await s.addAccount(7, true);

    spy.mockImplementation(() => CREDS);
    profile(identity("u-other", "other@example.com", foreignOrg));
    await refusal(s.addAccount());

    expect(s.readAccountCredentials("7", "ax@example.com")).not.toContain(
      "THEIRS",
    );
  },
);

it("test_CONTROL_add_accepts_when_the_token_is_the_claimed_account", async () => {
  const s = switcher("ax@example.com");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", ""));

  await s.addAccount(7, true);

  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_CONTROL_unresolvable_profile_still_registers", async () => {
  const s = switcher("ax@example.com");
  captureCreds(s, CREDS);
  profile(null);

  await s.addAccount(7, true);

  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_expired_token_with_no_refresh_token_skips_the_profile_fetch", async () => {
  const s = switcher("ax@example.com");
  captureCreds(
    s,
    JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-EXPIRED", expiresAt: 1 },
    }),
  );
  const fetch = profile(null);

  await s.addAccount(7, true);

  expect(fetch).not.toHaveBeenCalled();
  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_CONTROL_expired_credential_whose_refresh_fails_still_registers", async () => {
  const s = switcher("ax@example.com");
  captureCreds(
    s,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-STALE",
        refreshToken: "rt-dead",
        expiresAt: 1,
      },
    }),
  );
  oauthInternals.refreshOauthCredentials = vi.fn(async () => null);
  const fetch = profile(null);

  await s.addAccount(7, true);

  expect(fetch).not.toHaveBeenCalled();
  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_same_email_different_org_is_still_a_mismatch", async () => {
  const s = switcher("ax@example.com", "org-A");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", "org-B"));

  await refusal(s.addAccount(8));

  expect("8" in accounts(s)).toBe(false);
});

it("test_CONTROL_refresh_in_place_still_accepts_the_owning_token", async () => {
  const s = switcher("ax@example.com");
  const own = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-MINE",
      refreshToken: "rt-mine",
      expiresAt: 99999999999000,
    },
  });
  const spy = captureCreds(s, own);
  profile(identity("u-ax", "ax@example.com", ""));
  await s.addAccount(7, true);

  const rotated = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-MINE-ROTATED",
      refreshToken: "rt-mine-2",
      expiresAt: 99999999999000,
    },
  });
  spy.mockImplementation(() => rotated);
  await s.addAccount();

  expect(s.readAccountCredentials("7", "ax@example.com")).toContain(
    "MINE-ROTATED",
  );
});

it("test_org_slot_registers_when_the_resolved_profile_has_no_org", async () => {
  const s = switcher("ax@example.com", "org-A");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", null));

  await s.addAccount(7, true);

  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_CONTROL_org_slot_still_registers_when_the_org_matches", async () => {
  const s = switcher("ax@example.com", "org-A");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", "org-A"));

  await s.addAccount(7, true);

  expect(accounts(s)["7"]!.email).toBe("ax@example.com");
});

it("test_CONTROL_org_slot_still_refuses_a_different_email", async () => {
  const s = switcher("ax@example.com", "org-A");
  captureCreds(s, CREDS);
  profile(identity("u-o", "other@example.com", "org-A"));

  await refusal(s.addAccount(7, true));

  expect("7" in accounts(s)).toBe(false);
});

it("test_org_mismatch_message_names_both_organizations", async () => {
  const s = switcher("ax@example.com", "org-A");
  captureCreds(s, CREDS);
  profile(identity("u-ax2", "ax@example.com", "org-B"));

  const e = await refusal(s.addAccount(7, true));

  expect(e.message).toContain("org-A");
  expect(e.message).toContain("org-B");
});

it("test_email_mismatch_message_still_names_both_addresses", async () => {
  const s = switcher("ax@example.com");
  captureCreds(s, CREDS);
  profile(identity("u-other", "other@example.com", ""));

  const e = await refusal(s.addAccount(7, true));

  expect(e.message).toContain("ax@example.com");
  expect(e.message).toContain("other@example.com");
});

it("test_CONTROL_personal_account_empty_org_still_registers", async () => {
  const s = switcher("ax@example.com", "");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", null));

  await s.addAccount(8, true);

  expect(accounts(s)["8"]!.email).toBe("ax@example.com");
});

it("test_an_expired_credential_is_unresolvable_and_never_consumes_a_grant", async () => {
  const s = switcher("ax@example.com");
  captureCreds(
    s,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-STALE",
        refreshToken: "rt-live",
        expiresAt: 1,
      },
    }),
  );
  const refresh = vi.fn(async () => null);
  oauthInternals.refreshOauthCredentials = refresh;
  const fetch = profile(null);

  await s.addAccount(7, true);

  expect(refresh).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect("7" in accounts(s)).toBe(true);
});

it("test_a_matching_uuid_accepts_even_when_the_email_changed", async () => {
  const s = bareSwitcher({
    emailAddress: "old@example.com",
    organizationUuid: "",
    accountUuid: "u-same",
  });
  captureCreds(s, CREDS);
  profile(identity("u-same", "new@example.com", ""));

  await s.addAccount(7, true);

  expect("7" in accounts(s)).toBe(true);
});

it("test_a_recycled_email_under_a_different_uuid_is_refused", async () => {
  const s = bareSwitcher({
    emailAddress: "ax@example.com",
    organizationUuid: "",
    accountUuid: "u-registered",
  });
  captureCreds(s, CREDS);
  profile(identity("u-recreated", "ax@example.com", ""));

  await refusal(s.addAccount(7, true));

  expect("7" in accounts(s)).toBe(false);
});

it("test_an_expired_FOREIGN_credential_registers_and_that_is_deliberate", async () => {
  const s = switcher("ax@example.com");
  captureCreds(
    s,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-THEIRS-STALE",
        refreshToken: "rt-theirs",
        expiresAt: 1,
      },
    }),
  );
  const refresh = vi.fn(async () => null);
  oauthInternals.refreshOauthCredentials = refresh;
  const fetch = profile(null);

  await s.addAccount(7, true);

  expect(refresh).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect("7" in accounts(s)).toBe(true);
});

it("test_an_unverifiable_ownership_check_says_so_out_loud", async () => {
  const s = switcher("ax@example.com");
  captureCreds(s, CREDS);
  profile(null);

  await s.addAccount(7, true);

  const out = capsys.readouterr().out.toLowerCase();
  expect("7" in accounts(s)).toBe(true);
  expect(out.includes("could not") || out.includes("unverified")).toBe(true);
});

it("test_a_login_landing_during_the_guards_network_window_is_refused", async () => {
  const s = switcher("ax@example.com");
  const cfg = s.getClaudeConfigPath();
  captureCreds(s, CREDS);
  profile(() => {
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        oauthAccount: {
          emailAddress: "someone-else@example.com",
          organizationUuid: "",
          accountUuid: "u-someone-else",
        },
      }),
    );
    return identity("u-ax", "ax@example.com", "");
  });

  await refusal(s.addAccount(7, true));

  expect("7" in accounts(s)).toBe(false);
});

it("test_a_refresh_landing_in_the_guards_window_is_refused", async () => {
  const s = switcher("ax@example.com");
  const creds = (tag: string): string =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-${tag}`,
        refreshToken: `sk-ant-ort01-${tag}`,
        expiresAt: 9999999999999,
      },
    });
  let live = creds("OLD");
  captureCreds(s, () => live);
  profile(() => {
    live = creds("NEW");
    return identity("u-ax", "ax@example.com", "");
  });

  await refusal(s.addAccount(7, true));

  expect("7" in accounts(s)).toBe(false);
});

it("test_a_matching_uuid_does_not_excuse_a_different_org", async () => {
  const s = bareSwitcher({
    emailAddress: "ax@example.com",
    organizationUuid: "",
    accountUuid: "u-ax",
  });
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", "org-X"));

  await refusal(s.addAccount(7, true));

  expect("7" in accounts(s)).toBe(false);
});

it("test_a_null_account_uuid_does_not_trip_the_commit_time_recheck", async () => {
  const s = bareSwitcher({
    emailAddress: "ax@example.com",
    organizationUuid: "",
    accountUuid: null,
  });
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", ""));

  await s.addAccount(7, true);

  const acct = accounts(s)["7"];
  expect(acct).toBeDefined();
  expect(acct!.uuid).toBe("");
});

it("test_the_refresh_in_place_path_also_refuses_a_login_in_the_window", async () => {
  const s = switcher("ax@example.com");
  captureCreds(s, CREDS);
  profile(identity("u-ax", "ax@example.com", ""));
  await s.addAccount(7, true);
  expect("7" in accounts(s)).toBe(true);

  const cfg = s.getClaudeConfigPath();
  profile(() => {
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        oauthAccount: {
          emailAddress: "someone-else@example.com",
          organizationUuid: "",
          accountUuid: "u-other",
        },
      }),
    );
    return identity("u-ax", "ax@example.com", "");
  });

  await refusal(s.addAccount(null, true));

  const blob = path.join(s.configsDir, ".claude-config-7-ax@example.com.json");
  const stored = JSON.parse(fs.readFileSync(blob, "utf8")) as {
    oauthAccount: { emailAddress: string };
  };
  expect(stored.oauthAccount.emailAddress).toBe("ax@example.com");
});

it("test_the_guard_receives_the_triple_THAT_WAS_READ_not_a_rebuild", async () => {
  const s = switcher("a@e.com");
  const read = s.getCurrentIdentityTriple();
  expect(read).not.toBeNull();

  const got: Array<readonly [string, string, string]> = [];
  vi.spyOn(s, "rejectIdentityDriftSinceVerify").mockImplementation(
    (verified) => {
      got.push(verified);
    },
  );
  vi.spyOn(s, "getCurrentIdentityTriple").mockImplementation(() => read);
  captureCreds(s, CREDS);
  profile(identity(read![2], read![0], read![1]));
  try {
    await s.addAccount(7, true);
  } catch {
    // The test checks only the argument of the guard.
  }

  expect(got.length).toBeGreaterThan(0);
  expect(got[0]).toBe(read);
});
