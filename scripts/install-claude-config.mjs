#!/usr/bin/env node
// Registers this server in the Claude desktop app's config (macOS), using this
// machine's real node binary and this folder's real path. Safe to re-run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}
const cfgPath = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
let cfg = {};
if (fs.existsSync(cfgPath)) {
  fs.copyFileSync(cfgPath, cfgPath + ".bak");
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8") || "{}");
}
cfg.mcpServers ??= {};
cfg.mcpServers["google-multi"] = {
  command: process.execPath,
  args: [entry],
  env: { GMX_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone },
};
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`Added "google-multi" to ${cfgPath}\n  command: ${process.execPath}\n  args:    ${entry}`);
console.log("Quit and reopen the Claude desktop app to load it.");
