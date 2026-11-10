# Google Multi-Account MCP

**Status:** v0.1.0, early. Works day to day with Claude Desktop on macOS; expect rough edges.

A local MCP server for Claude (Cowork and desktop chat) that holds **several Google accounts at once**: personal @gmail.com and Google Workspace. You no longer switch which account the built-in Gmail, Calendar or Drive connector points at. Every tool takes an `account` (email or alias). Read and search tools default to **all** accounts and label each result with its account.

## What it can do (23 tools)

| Area | Tools |
|---|---|
| Accounts | `google_list_accounts` |
| Gmail | `gmail_search` (all accounts, merged by date), `gmail_read_message`, `gmail_read_thread`, `gmail_create_draft`, `gmail_send` (new or threaded reply, reply-all, local attachments, verified send-as alias via `from`), `gmail_list_drafts`, `gmail_send_draft`, `gmail_modify` (archive / read / star / trash / labels), `gmail_list_labels`, `gmail_save_attachment` |
| Calendar | `calendar_list_events` (unified agenda, removes duplicate meetings), `calendar_find_free_time` (busy time from **every** account combined), `calendar_list_calendars`, `calendar_get_event`, `calendar_create_event` (optional Meet link), `calendar_update_event`, `calendar_delete_event`, `calendar_respond` |
| Drive | `drive_search` (all accounts), `drive_read_file` (Docs→Markdown, Sheets→CSV, Slides→text), `drive_download_file` (→ .docx/.xlsx/.pptx/.pdf), `drive_create_file` |

## How it works

```
Claude desktop app ──stdio──▶ dist/index.js ──▶ one OAuth2 client per account ──▶ Gmail / Calendar / Drive APIs
                                   │
                  ~/.config/google-multi-mcp/
                    client_secret.json      (your Google Cloud "Desktop app" OAuth client)
                    accounts.json           (email + alias registry)
                    (tokens: macOS Keychain, or tokens/<email>.token.json elsewhere)
```

Everything runs on your Mac. Tokens never leave it; they live in the macOS Keychain. Access tokens refresh automatically and are saved back to disk.

**Scopes requested:** `gmail.modify` (read, send, label and trash mail, but never delete it permanently), `calendar` (read and write), `drive.readonly` (read all files), `drive.file` (write only files this app creates), and `openid email`.

## Setup (one time, about 15 minutes)

### 1. Create the Google OAuth client
You create your own OAuth client, so your tokens and data never touch anyone else's app, and no Google verification is needed. Use a personal @gmail account to own it, so one "External" app works for both @gmail and Workspace accounts.

1. Go to https://console.cloud.google.com/projectcreate and create a project, e.g. **claude-multi-google**.
2. Enable these three APIs in that project:
   - https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - https://console.cloud.google.com/apis/library/drive.googleapis.com
3. Go to **Google Auth Platform**: https://console.cloud.google.com/auth/overview
   - **Branding:** app name "Claude Multi-Google", with your email as support and developer contact.
   - **Branding:** also fill in an application home page, privacy policy and terms of service link, and add that domain under *Authorized domains*, then **Save**. Google keeps **Publish app** greyed out until these are set. Any pages you control will do; Google only reviews them if you apply for verification.
   - **Audience:** User type **External**. Then click **Publish app** to set it to *In production*.
     > ⚠ Do not skip this. An app left in *Testing* has its refresh tokens expire every 7 days. Because you are the only user, Google does not require verification. You just see an "unverified app" warning when you sign in.
   - **Clients → Create client →** Application type **Desktop app**, then **Download JSON**.
4. Save that file:
   ```bash
   mkdir -p ~/.config/google-multi-mcp && mv ~/Downloads/client_secret_*.json ~/.config/google-multi-mcp/client_secret.json
   ```

### 2. Workspace accounts only
If a Workspace admin (you, for your own domains) restricts third-party apps, sign-in is blocked. Fix it here:
Admin console → **Security → Access and data control → API controls → Manage third-party app access → Add app → OAuth App Name or Client ID** → paste the client ID → **Trusted**.

### 3. Build
```bash
git clone https://github.com/mutageniclabs/google-multi-account-mcp.git
cd google-multi-account-mcp
npm install
npm run build
```

### 4. Add each account (repeat once per account)
```bash
npm run add-account -- --alias personal
npm run add-account -- --alias work
npm run add-account -- --alias side-project
```
Each command opens your browser. Pick the account, click **Advanced → Go to Claude Multi-Google (unsafe)**, and **tick every checkbox**. Aliases are optional but make prompts shorter ("check my work inbox").

Then check that every account works:
```bash
npm run accounts   # list
npm run check      # calls Gmail/Calendar/Drive once per account
```

### 5. Register with Claude
```bash
npm run install-claude
```
This adds a `google-multi` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`, using your real `node` path and this folder's real path, and backs up the old file to `.bak`. **Quit and reopen Claude.** The tools then show up in Cowork and in chat.

Optional: turn off the built-in single-account Gmail / Calendar / Drive connectors so Claude doesn't have two tools for the same job.

## Everyday use
- "What's unread across all my inboxes since yesterday?"
- "Show my week across every calendar and flag conflicts."
- "Find 45 minutes Thursday when I'm free on all accounts."
- "Reply from work to the latest email from Jane: …"
- "Find the lease draft in any Drive and summarize it."

## Managing accounts
| Command | Effect |
|---|---|
| `npm run add-account -- --alias X` | Add an account, or re-authorize one (same email → token replaced) |
| `npm run remove-account -- X` | Revoke the token at Google and forget the account |
| `npm run accounts` | List accounts and token status |
| `npm run check` | Run a live API check on every account |

After you add or remove an account, restart Claude (or toggle the connector) so the running server sees the change.

## Configuration
| Env var | Default |
|---|---|
| `GMX_CONFIG_DIR` | `~/.config/google-multi-mcp` |
| `GMX_CLIENT_SECRET` | `$GMX_CONFIG_DIR/client_secret.json` |
| `GMX_TIMEZONE` | system zone (installer sets it) |
| `GMX_TOKEN_STORE` | `keychain` on macOS; set `file` to use 0600 token files instead |

## Troubleshooting
- **"Login … expired or was revoked"**: run `add-account` again with the same alias. If it happens weekly, the app is still in *Testing* (see step 1.3).
- **"Access blocked: app not verified / admin_policy_enforced"** on a Workspace account: see step 2.
- **"… API has not been used in project …"**: enable that API (step 1.2).
- **No refresh token returned**: remove the app at https://myaccount.google.com/permissions and add the account again.
- **Tools don't appear in Claude**: check `~/Library/Logs/Claude/mcp-server-google-multi.log`.

## Security
- Runs locally over stdio; nothing is hosted and tokens never leave your machine.
- On macOS, tokens are stored in your login Keychain (service `google-multi-mcp`, one item per account) and are passed to `security` over stdin, never on the command line. Token files from older versions are moved into the Keychain automatically on first use. On other platforms, or with `GMX_TOKEN_STORE=file`, they are `chmod 600` JSON files under `~/.config/google-multi-mcp/tokens/`.
- `gmail.modify` cannot permanently delete mail; Drive writes are limited to files this app created.
- Write tools (send, draft, create/update/delete event, RSVP, create file) require an explicit `account`.

Report security issues privately via GitHub Security Advisories on this repo.

## License
MIT. See [LICENSE](LICENSE).
