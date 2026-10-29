#!/usr/bin/env node
/**
 * Account manager.
 *   npm run add-account -- --alias work     sign in to one more Google account
 *   npm run accounts                         list accounts
 *   npm run remove-account -- <email|alias>  forget an account and revoke its token
 *   npm run check                            call each account's APIs once
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { drive } from "@googleapis/drive";
import {
  CLIENT_SECRET_PATH, CONFIG_DIR, SCOPES, loadAccounts, loadClientSecret, saveAccounts, tokenPath, ensureDirs,
} from "./config.js";
import { getClient, readToken, resolveAccounts, writeToken, explainError, label } from "./auth.js";

const [, , cmd, ...rest] = process.argv;
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function add(): Promise<void> {
  const alias = flag("alias");
  const hint = flag("email");
  const { clientId, clientSecret } = loadClientSecret();
  ensureDirs();

  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const state = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    login_hint: hint,
    include_granted_scopes: false,
  });

  console.log("\nOpening your browser to sign in. Pick the Google account you want to add.");
  console.log("If it doesn't open, paste this URL into a browser on this Mac:\n\n" + url + "\n");
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out after 5 minutes waiting for sign-in.")), 300_000);
    srv.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      const ok = !err && c && u.searchParams.get("state") === state;
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        ok
          ? "<h2>Account connected.</h2><p>You can close this tab and return to the terminal.</p>"
          : `<h2>Sign-in failed</h2><p>${err ?? "state mismatch"}</p>`,
      );
      clearTimeout(timer);
      if (ok) resolve(c!);
      else reject(new Error(`Sign-in failed: ${err ?? "state mismatch"}`));
    });
  }).finally(() => srv.close());

  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.id_token) throw new Error("Google did not return an ID token; cannot identify the account.");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const email = ticket.getPayload()?.email?.toLowerCase();
  if (!email) throw new Error("Could not read the account email from Google's response.");
  if (!tokens.refresh_token) {
    throw new Error(
      `Google didn't return a refresh token for ${email}. Remove this app at https://myaccount.google.com/permissions and run add-account again.`,
    );
  }
  const granted = new Set((tokens.scope ?? "").split(" "));
  const missing = SCOPES.filter((s) => s.startsWith("https://") && !granted.has(s));

  writeToken(email, tokens);
  const accounts = loadAccounts().filter((a) => a.email !== email);
  if (alias && accounts.some((a) => a.alias?.toLowerCase() === alias.toLowerCase()))
    throw new Error(`Alias "${alias}" is already used by another account.`);
  const prev = loadAccounts().find((a) => a.email === email);
  accounts.push({ email, alias: alias ?? prev?.alias, addedAt: new Date().toISOString() });
  saveAccounts(accounts);

  console.log(`\n✓ Connected ${alias ? `${alias} <${email}>` : email}. ${accounts.length} account(s) total.`);
  if (missing.length)
    console.log(`⚠ These permissions were not granted (some tools will fail for this account):\n  ${missing.join("\n  ")}`);
  console.log("Restart the Claude desktop app (or toggle the connector) to pick up new accounts.");
}

function list(): void {
  const accounts = loadAccounts();
  console.log(`Config: ${CONFIG_DIR}\nOAuth client: ${fs.existsSync(CLIENT_SECRET_PATH) ? CLIENT_SECRET_PATH : "MISSING — see README step 1"}\n`);
  if (!accounts.length) return console.log("No accounts yet. Run: npm run add-account -- --alias <name>");
  for (const a of accounts)
    console.log(`${a.alias ? a.alias.padEnd(12) : "".padEnd(12)} ${a.email.padEnd(40)} ${readToken(a.email)?.refresh_token ? "ready" : "NO TOKEN"}`);
}

async function remove(): Promise<void> {
  const sel = rest.find((r) => !r.startsWith("--"));
  if (!sel) throw new Error("Usage: npm run remove-account -- <email|alias>");
  const [a] = resolveAccounts(sel, false);
  const t = readToken(a.email);
  if (t?.refresh_token) {
    const { clientId, clientSecret } = loadClientSecret();
    await new OAuth2Client({ clientId, clientSecret }).revokeToken(t.refresh_token).catch(() => {});
  }
  fs.rmSync(tokenPath(a.email), { force: true });
  saveAccounts(loadAccounts().filter((x) => x.email !== a.email));
  console.log(`Removed ${label(a)} and revoked its access.`);
}

async function check(): Promise<void> {
  for (const a of loadAccounts()) {
    const auth = getClient(a.email);
    const results: string[] = [];
    for (const [name, fn] of [
      ["gmail", async () => (await gmail({ version: "v1", auth }).users.getProfile({ userId: "me" })).data.messagesTotal + " msgs"],
      ["calendar", async () => (await calendar({ version: "v3", auth }).calendarList.list({ maxResults: 50 })).data.items?.length + " calendars"],
      ["drive", async () => (await drive({ version: "v3", auth }).about.get({ fields: "user" })).data.user?.emailAddress ?? "ok"],
    ] as const) {
      try { results.push(`${name} ✓ (${await fn()})`); }
      catch (e) { results.push(`${name} ✗ ${explainError(e, a)}`); }
    }
    console.log(`${label(a)}\n  ${results.join("\n  ")}`);
  }
}

const cmds: Record<string, () => unknown> = { add, list, remove, check };
const run = cmds[cmd ?? ""];
if (!run) {
  console.log("Commands: add [--alias name] [--email hint] | list | remove <email|alias> | check");
  process.exit(1);
}
Promise.resolve(run()).catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
