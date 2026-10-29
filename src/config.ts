import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where account registry, OAuth client secret and per-account tokens live. */
export const CONFIG_DIR =
  process.env.GMX_CONFIG_DIR ?? path.join(os.homedir(), ".config", "google-multi-mcp");
export const CLIENT_SECRET_PATH =
  process.env.GMX_CLIENT_SECRET ?? path.join(CONFIG_DIR, "client_secret.json");
export const ACCOUNTS_PATH = path.join(CONFIG_DIR, "accounts.json");
export const TOKENS_DIR = path.join(CONFIG_DIR, "tokens");

export const DEFAULT_TZ =
  process.env.GMX_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

export const SCOPES = [
  "openid",
  "email",
  // Read, draft, send, label, archive, trash. Cannot permanently delete mail.
  "https://www.googleapis.com/auth/gmail.modify",
  // Full calendar read/write.
  "https://www.googleapis.com/auth/calendar",
  // Read every Drive file; write only files this app creates.
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

export interface Account {
  email: string;
  alias?: string;
  addedAt: string;
}

export function ensureDirs(): void {
  fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(TOKENS_DIR, 0o700);
  } catch {
    /* best effort */
  }
}

export function loadAccounts(): Account[] {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8")) as Account[];
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: Account[]): void {
  ensureDirs();
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export function tokenPath(email: string): string {
  return path.join(TOKENS_DIR, `${email.toLowerCase()}.token.json`);
}

export function loadClientSecret(): { clientId: string; clientSecret: string } {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(
      `OAuth client file not found at ${CLIENT_SECRET_PATH}. ` +
        `Create a "Desktop app" OAuth client in Google Cloud Console, download its JSON, ` +
        `and save it to that path (see README, step 1).`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error(`${CLIENT_SECRET_PATH} does not contain client_id/client_secret.`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}
