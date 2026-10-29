import fs from "node:fs";
import { OAuth2Client, type Credentials } from "google-auth-library";
import {
  type Account,
  loadAccounts,
  loadClientSecret,
  tokenPath,
  ensureDirs,
} from "./config.js";

const clients = new Map<string, OAuth2Client>();

export function readToken(email: string): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(email), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

export function writeToken(email: string, creds: Credentials): void {
  ensureDirs();
  fs.writeFileSync(tokenPath(email), JSON.stringify(creds, null, 2), { mode: 0o600 });
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
