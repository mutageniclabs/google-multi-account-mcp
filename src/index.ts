#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAccounts, CONFIG_DIR, DEFAULT_TZ } from "./config.js";
import { readToken } from "./auth.js";
import { text } from "./util.js";
import { registerGmail } from "./tools/gmail.js";
import { registerCalendar } from "./tools/calendar.js";
import { registerDrive } from "./tools/drive.js";

const server = new McpServer(
  { name: "google-multi-account", version: "0.1.0" },
  {
    instructions:
      "Gmail, Google Calendar and Google Drive for ALL of the user's Google accounts at once. " +
      "Call google_list_accounts first to see account emails and aliases. Read/search tools default to every account " +
      "and tag each result with its account; write tools (send, draft, create event, RSVP, create file) need an explicit `account`. " +
      "Always act from the account that owns the item (use the account shown next to a search result). " +
      "Confirm the sending account and recipients with the user before gmail_send.",
  },
);

server.registerTool(
  "google_list_accounts",
  {
    title: "List connected Google accounts",
    description: "Show every Google account this connector can use, with its alias and login status.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const accounts = loadAccounts();
    if (!accounts.length)
      return text(`No accounts connected. In the project folder run: npm run add-account -- --alias <name>\n(Config dir: ${CONFIG_DIR})`);
    const lines = accounts.map((a) => {
      const t = readToken(a.email);
      const status = t?.refresh_token ? "ready" : "needs sign-in (run npm run add-account)";
      return `- ${a.alias ? `**${a.alias}** — ` : ""}${a.email} (${status})`;
    });
    return text(`${accounts.length} account(s); times shown in ${DEFAULT_TZ}:\n${lines.join("\n")}`);
  },
);

registerGmail(server);
registerCalendar(server);
registerDrive(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`google-multi-account MCP running (${loadAccounts().length} account(s))`);
