import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { OAuth2Client, type Credentials } from "google-auth-library";
import {
  type Account,
  loadAccounts,
  loadClientSecret,
  tokenPath,
  ensureDirs,
} from "./config.js";

const clients = new Map<string, OAuth2Client>();

// On macOS tokens live in the login Keychain; elsewhere in 0600 files under TOKENS_DIR.
const USE_KEYCHAIN = process.platform === "darwin" && process.env.GMX_TOKEN_STORE !== "file";
const KEYCHAIN_SERVICE = "google-multi-mcp";

function security(args: string[], input?: string): string {
  return execFileSync("/usr/bin/security", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
}

function readFileToken(email: string): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(email), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

export function readToken(email: string): Credentials | null {
  const key = email.toLowerCase();
  if (!USE_KEYCHAIN) return readFileToken(key);
  try {
    return JSON.parse(security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w"])) as Credentials;
  } catch {
    // Not in the Keychain yet: migrate a token file left by an older version.
    const legacy = readFileToken(key);
    if (legacy) {
      writeToken(key, legacy);
      fs.rmSync(tokenPath(key), { force: true });
    }
    return legacy;
  }
}

export function writeToken(email: string, creds: Credentials): void {
  const key = email.toLowerCase();
  if (!USE_KEYCHAIN) {
    ensureDirs();
    fs.writeFileSync(tokenPath(key), JSON.stringify(creds, null, 2), { mode: 0o600 });
    return;
  }
  // Fed through `security -i` on stdin, hex-encoded, so the secret never appears in argv / `ps`.
  const hex = Buffer.from(JSON.stringify(creds), "utf8").toString("hex");
  security(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${key} -l "Google Multi-Account MCP (${key})" -X ${hex}\n`);
  if (readToken(key)?.refresh_token !== creds.refresh_token) {
    throw new Error(`Could not save the login for ${key} to the macOS Keychain.`);
  }
}

export function deleteToken(email: string): void {
  const key = email.toLowerCase();
  fs.rmSync(tokenPath(key), { force: true });
  if (USE_KEYCHAIN) {
    try {
      security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key]);
    } catch {
      // already gone
    }
  }
}

/** Authorized OAuth client for one account; refreshed tokens are persisted automatically. */
export function getClient(email: string): OAuth2Client {
  const key = email.toLowerCase();
  const cached = clients.get(key);
  if (cached) return cached;

  const creds = readToken(key);
  if (!creds?.refresh_token) {
    throw new Error(
      `No saved login for ${email}. Run \`npm run add-account\` in the project folder to connect it.`,
    );
  }
  const { clientId, clientSecret } = loadClientSecret();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(creds);
  client.on("tokens", (t) => {
    const merged = { ...(readToken(key) ?? {}), ...t };
    writeToken(key, merged);
  });
  clients.set(key, client);
  return client;
}

export function dropClient(email: string): void {
  clients.delete(email.toLowerCase());
}

/**
 * Resolve the `account` tool argument into concrete accounts.
 * Accepts an email, an alias, "all", or nothing.
 */
export function resolveAccounts(selector: string | undefined, allowAll: boolean): Account[] {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No Google accounts are connected yet. In the project folder run `npm run add-account -- --alias <name>` once per account.",
    );
  }
  const names = accounts.map((a) => (a.alias ? `${a.alias} (${a.email})` : a.email)).join(", ");
  const sel = selector?.trim().toLowerCase();

  if (!sel || sel === "all" || sel === "*") {
    if (allowAll) return accounts;
    if (!sel && accounts.length === 1) return accounts;
    throw new Error(
      `This action needs one specific account. Pass \`account\` as one of: ${names}.`,
    );
  }
  const hit = accounts.find(
    (a) => a.email.toLowerCase() === sel || a.alias?.toLowerCase() === sel,
  );
  if (!hit) throw new Error(`Unknown account "${selector}". Connected accounts: ${names}.`);
  return [hit];
}

export function label(a: Account): string {
  return a.alias ? `${a.alias} <${a.email}>` : a.email;
}

/** Turn Google API errors into actionable messages. */
export function explainError(err: unknown, account?: Account): string {
  const e = err as { code?: number | string; status?: number; message?: string; response?: { status?: number; data?: any } };
  const status = e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  const msg: string = e.response?.data?.error?.message ?? e.response?.data?.error_description ?? e.message ?? String(err);
  const who = account ? label(account) : "this account";
  if (/invalid_grant|Token has been expired or revoked/i.test(msg) || status === 401) {
    return `Login for ${who} has expired or was revoked. Re-run \`npm run add-account -- --alias ${account?.alias ?? "<name>"}\` and sign in as ${account?.email ?? "that account"}. (If this happens every ~7 days, set the OAuth consent screen's publishing status to "In production".)`;
  }
  if (status === 403 && /insufficient|scope/i.test(msg)) {
    return `${who} did not grant the needed permission (${msg}). Re-add the account and tick every checkbox on Google's consent screen.`;
  }
  if (status === 403 && /has not been used|is disabled/i.test(msg)) {
    return `${msg} — enable that API in the Google Cloud project that owns your OAuth client.`;
  }
  if (status === 404) return `Not found in ${who}: ${msg}. Check the ID and that you're using the account that owns it.`;
  if (status === 429) return `Google rate limit hit for ${who}; wait a moment and retry.`;
  return `Google API error for ${who}${status ? ` (HTTP ${status})` : ""}: ${msg}`;
}

/** Run fn across accounts in parallel; failures are reported per account instead of failing the call. */
export async function fanOut<T>(
  accounts: Account[],
  fn: (a: Account) => Promise<T>,
): Promise<{ ok: { account: Account; value: T }[]; errors: string[] }> {
  const results = await Promise.allSettled(accounts.map((a) => fn(a)));
  const ok: { account: Account; value: T }[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push({ account: accounts[i], value: r.value });
    else errors.push(explainError(r.reason, accounts[i]));
  });
  return { ok, errors };
}
