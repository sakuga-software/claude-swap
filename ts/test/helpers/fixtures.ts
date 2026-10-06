import fs from "node:fs";
import path from "node:path";
import { testHome } from "./home.js";

/** The fixtures of `tests/conftest.py`. Each function writes into the isolated home of the test. */

export function mockClaudeConfig(): string {
  return writeHomeJson(".claude.json", {
    oauthAccount: { emailAddress: "test@example.com", accountUuid: "test-uuid-1234" },
  });
}

export function mockCredentialsFile(): string {
  const file = path.join(testHome(), ".claude", ".credentials.json");
  fs.writeFileSync(file, JSON.stringify({ accessToken: "test-token", refreshToken: "test-refresh" }));
  return file;
}

export function mockOrgClaudeConfig(): string {
  return writeHomeJson(".claude.json", {
    oauthAccount: {
      emailAddress: "user@example.com",
      accountUuid: "user-uuid-1234",
      organizationUuid: "org-uuid-5678",
      organizationName: "Acme Corp",
      organizationRole: "primary_owner",
      displayName: "Test User",
    },
  });
}

export function mockPersonalClaudeConfig(): string {
  return writeHomeJson(".claude.json", {
    oauthAccount: { emailAddress: "user@example.com", accountUuid: "user-uuid-1234" },
  });
}

export function sampleSequenceData() {
  return {
    activeAccountNumber: 1,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1, 2],
    accounts: {
      "1": { email: "account1@example.com", uuid: "uuid-1", added: "2024-01-01T00:00:00Z" },
      "2": { email: "account2@example.com", uuid: "uuid-2", added: "2024-01-02T00:00:00Z" },
    },
  };
}

export function sampleSequenceDataPreV06() {
  return {
    activeAccountNumber: 1,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1, 2],
    accounts: {
      "1": { email: "user@example.com", uuid: "user-uuid-1234", added: "2024-01-01T00:00:00Z" },
      "2": { email: "other@example.com", uuid: "other-uuid-5678", added: "2024-01-02T00:00:00Z" },
    },
  };
}

export function sampleSequenceDataWithOrg() {
  return {
    activeAccountNumber: 1,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1, 2],
    accounts: {
      "1": {
        email: "user@example.com",
        uuid: "user-uuid",
        organizationUuid: "org-uuid-5678",
        organizationName: "Acme Corp",
        added: "2024-01-01T00:00:00Z",
      },
      "2": {
        email: "user@example.com",
        uuid: "user-uuid",
        organizationUuid: "",
        organizationName: "",
        added: "2024-01-02T00:00:00Z",
      },
    },
  };
}

/** `tests/fixtures/<name>`, read from the Python tree. */
export function pythonFixturePath(name: string): string {
  return path.resolve(import.meta.dirname, "..", "..", "..", "tests", "fixtures", name);
}

function writeHomeJson(name: string, data: unknown): string {
  const file = path.join(testHome(), name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}
