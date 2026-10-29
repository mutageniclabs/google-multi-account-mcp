import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { drive, type drive_v3 } from "@googleapis/drive";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fanOut, getClient, label, resolveAccounts } from "../auth.js";
import type { Account } from "../config.js";
import { accountOrAllParam, accountParam, fmtDateTime, safe, text, truncate } from "../util.js";

const api = (a: Account) => drive({ version: "v3", auth: getClient(a.email) });
const one = (sel: string) => resolveAccounts(sel, false)[0];
const FIELDS = "id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink,parents";

const EXPORTS: Record<string, { mime: string; ext: string; fallback?: string }> = {
  "application/vnd.google-apps.document": { mime: "text/markdown", ext: ".md", fallback: "text/plain" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
};
const DOWNLOAD_EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
};

const kind = (m?: string | null) =>
  m?.startsWith("application/vnd.google-apps.") ? m.split(".").pop() : m ?? "?";

function row(a: Account, f: drive_v3.Schema$File): string {
  const size = f.size ? ` · ${Math.round(Number(f.size) / 1024)} KB` : "";
  return `- [${a.alias ?? a.email}] **${f.name}** (${kind(f.mimeType)}${size}) · modified ${fmtDateTime(f.modifiedTime)}\n  file_id=${f.id} | ${f.webViewLink ?? ""}`;
}

function escapeQ(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function registerDrive(server: McpServer): void {
  server.registerTool(
    "drive_search",
    {
      title: "Search Drive (one or all accounts)",
      description:
        "Find files across every connected Google Drive. Plain words search names and content; set raw_query=true to pass Drive query syntax " +
        "(e.g. \"mimeType='application/pdf' and modifiedTime > '2026-01-01'\"). Empty query lists recently modified files.",
      inputSchema: {
        query: z.string().default(""),
        raw_query: z.boolean().default(false),
        account: z.string().optional().describe(accountOrAllParam),
        max_results: z.number().int().min(1).max(100).default(15).describe("Max per account."),
        page_token: z.string().optional().describe("Pagination token (single account)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, raw_query, account, max_results, page_token }) => {
      const q = [
        "trashed = false",
        query && (raw_query ? `(${query})` : `(name contains '${escapeQ(query)}' or fullText contains '${escapeQ(query)}')`),
      ]
        .filter(Boolean)
        .join(" and ");
      const { ok, errors } = await fanOut(resolveAccounts(account, true), async (a) => {
        const r = await api(a).files.list({
          q, pageSize: max_results, pageToken: page_token, fields: `nextPageToken,files(${FIELDS})`,
          orderBy: query && !raw_query ? undefined : "modifiedTime desc",
          includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: "allDrives",
        });
        return r.data;
      });
      const out: string[] = [`Drive search ${query ? `\`${query}\`` : "(recent files)"}`, ""];
      for (const { account: a, value } of ok) {
        out.push(`## ${label(a)} — ${value.files?.length ?? 0} result(s)`);
        (value.files ?? []).forEach((f) => out.push(row(a, f)));
        if (value.nextPageToken) out.push(`  More: page_token=${value.nextPageToken} (with account=${a.alias ?? a.email})`);
      }
      if (errors.length) out.push("", "Errors:", ...errors.map((e) => `- ${e}`));
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "drive_read_file",
    {
      title: "Read a Drive file's text",
      description:
        "Return a file's contents as text: Google Docs as Markdown, Sheets as CSV (first sheet), Slides as plain text, and any text/JSON/CSV file directly. " +
        "For PDFs, images and Office files use drive_download_file instead.",
      inputSchema: {
        account: z.string().describe(accountParam),
        file_id: z.string(),
        max_chars: z.number().int().min(500).max(500000).default(40000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account, file_id, max_chars }) => {
      const a = one(account);
      const d = api(a);
      const meta = (await d.files.get({ fileId: file_id, fields: FIELDS, supportsAllDrives: true })).data;
      const head = `${meta.name} (${kind(meta.mimeType)}) in ${label(a)}\n${meta.webViewLink ?? ""}\n\n`;
      const exp = EXPORTS[meta.mimeType ?? ""];
      let body: string;
      if (exp && !exp.mime.startsWith("image/")) {
        try {
          body = String((await d.files.export({ fileId: file_id, mimeType: exp.mime }, { responseType: "text" })).data);
        } catch (err) {
          if (!exp.fallback) throw err;
          body = String((await d.files.export({ fileId: file_id, mimeType: exp.fallback }, { responseType: "text" })).data);
        }
      } else if (
        meta.mimeType?.startsWith("text/") ||
        /json|xml|javascript|csv|yaml|x-sh|markdown/.test(meta.mimeType ?? "")
      ) {
        body = String((await d.files.get({ fileId: file_id, alt: "media", supportsAllDrives: true }, { responseType: "text" })).data);
      } else {
        return text(head + `This is a ${meta.mimeType} file, which can't be shown as text. Use drive_download_file to save it locally, then open it.`);
      }
      return text(head + truncate(body, max_chars));
    }),
  );

  server.registerTool(
    "drive_download_file",
    {
      title: "Download a Drive file to this Mac",
      description:
        "Save a Drive file into a local folder (Google Docs/Sheets/Slides are converted to .docx/.xlsx/.pptx, or pass export_as='pdf'). Returns the local path.",
      inputSchema: {
        account: z.string().describe(accountParam),
        file_id: z.string(),
        directory: z.string().default("~/Downloads"),
        export_as: z.enum(["office", "pdf"]).default("office").describe("For Google-native files only."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ account, file_id, directory, export_as }) => {
      const a = one(account);
      const d = api(a);
      const meta = (await d.files.get({ fileId: file_id, fields: FIELDS, supportsAllDrives: true })).data;
      const dir = directory.startsWith("~") ? path.join(os.homedir(), directory.slice(1)) : directory;
      fs.mkdirSync(dir, { recursive: true });
      let name = meta.name ?? file_id;
      let stream: Readable;
      if (meta.mimeType?.startsWith("application/vnd.google-apps.")) {
        const exp = export_as === "pdf" ? { mime: "application/pdf", ext: ".pdf" } : DOWNLOAD_EXPORTS[meta.mimeType];
        if (!exp) throw new Error(`${meta.mimeType} can't be downloaded (folders, forms, etc.).`);
        if (!name.endsWith(exp.ext)) name += exp.ext;
        stream = (await d.files.export({ fileId: file_id, mimeType: exp.mime }, { responseType: "stream" })).data as unknown as Readable;
      } else {
        stream = (await d.files.get({ fileId: file_id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })).data as unknown as Readable;
      }
      let dest = path.join(dir, name.replace(/[/\\]/g, "_"));
      for (let i = 1; fs.existsSync(dest); i++) {
        const ext = path.extname(name);
        dest = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
      }
      await new Promise<void>((res, rej) => {
        const w = fs.createWriteStream(dest);
        stream.on("error", rej).pipe(w).on("finish", () => res()).on("error", rej);
      });
      return text(`Saved ${dest}`);
    }),
  );

  server.registerTool(
    "drive_create_file",
    {
      title: "Create a Drive file",
      description:
        "Create a new file in a specific account's Drive from text, or upload a local file. Set convert_to_google_doc=true to turn text/markdown into a Google Doc.",
      inputSchema: {
        account: z.string().describe(accountParam),
        name: z.string(),
        content: z.string().optional().describe("Text content. Omit when using local_path."),
        local_path: z.string().optional().describe("Absolute path of a local file to upload instead of content."),
        mime_type: z.string().default("text/plain").describe("MIME type of content (e.g. text/markdown, text/csv)."),
        convert_to_google_doc: z.boolean().default(false).describe("Convert to Google Docs (or Sheets for CSV)."),
        folder_id: z.string().optional().describe("Parent folder ID. Must be a folder this app created or you have write access to."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      const a = one(args.account);
      if (!args.content && !args.local_path) throw new Error("Pass either content or local_path.");
      let body: Readable;
      let mime = args.mime_type;
      if (args.local_path) {
        const p = args.local_path.startsWith("~") ? path.join(os.homedir(), args.local_path.slice(1)) : args.local_path;
        if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
        body = fs.createReadStream(p);
        if (args.mime_type === "text/plain") mime = "application/octet-stream";
      } else {
        body = Readable.from([Buffer.from(args.content!, "utf8")]);
      }
      const target = args.convert_to_google_doc
        ? mime === "text/csv" ? "application/vnd.google-apps.spreadsheet" : "application/vnd.google-apps.document"
        : undefined;
      const r = await api(a).files.create({
        requestBody: { name: args.name, mimeType: target, parents: args.folder_id ? [args.folder_id] : undefined },
        media: { mimeType: mime, body },
        fields: FIELDS,
        supportsAllDrives: true,
      });
      return text(`Created in ${label(a)}:\n${row(a, r.data)}`);
    }),
  );
}
