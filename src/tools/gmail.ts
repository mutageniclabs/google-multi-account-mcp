import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fanOut, getClient, label, resolveAccounts } from "../auth.js";
import type { Account } from "../config.js";
import {
  accountOrAllParam,
  accountParam,
  b64urlDecode,
  b64urlEncode,
  fmtDateTime,
  htmlToText,
  safe,
  text,
  truncate,
} from "../util.js";

const api = (a: Account) => gmail({ version: "v1", auth: getClient(a.email) });
const one = (sel: string) => resolveAccounts(sel, false)[0];

type Headers = gmail_v1.Schema$MessagePartHeader[] | undefined;
const hdr = (h: Headers, name: string) =>
  h?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

function extractBody(part: gmail_v1.Schema$MessagePart | undefined): { plain: string; html: string } {
  let plain = "";
  let html = "";
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    if (p.filename) return; // attachment
    if (p.mimeType === "text/plain" && p.body?.data) plain += b64urlDecode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) html += b64urlDecode(p.body.data);
    p.parts?.forEach(walk);
  };
  walk(part);
  return { plain, html };
}

function listAttachments(part: gmail_v1.Schema$MessagePart | undefined): { filename: string; id: string; size: number; mimeType: string }[] {
  const out: { filename: string; id: string; size: number; mimeType: string }[] = [];
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId)
      out.push({ filename: p.filename, id: p.body.attachmentId, size: p.body.size ?? 0, mimeType: p.mimeType ?? "" });
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

function renderMessage(a: Account, m: gmail_v1.Schema$Message, maxChars: number): string {
  const h = m.payload?.headers;
  const { plain, html } = extractBody(m.payload);
  const body = plain.trim() || htmlToText(html) || m.snippet || "";
  const atts = listAttachments(m.payload);
  const lines = [
    `### ${hdr(h, "Subject") || "(no subject)"}`,
    `Account: ${label(a)}`,
    `From: ${hdr(h, "From")}`,
    `To: ${hdr(h, "To")}`,
    hdr(h, "Cc") ? `Cc: ${hdr(h, "Cc")}` : null,
    `Date: ${hdr(h, "Date")}`,
    `Message ID: ${m.id} | Thread ID: ${m.threadId} | Labels: ${(m.labelIds ?? []).join(", ")}`,
    atts.length
      ? `Attachments: ${atts.map((x) => `${x.filename} (${Math.round(x.size / 1024)} KB, attachment_id=${x.id})`).join("; ")}`
      : null,
    "",
    truncate(body, maxChars),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`;
}

async function buildRaw(opts: {
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: string[];
}): Promise<string> {
  const headers = [
    `From: ${opts.from}`,
    opts.to ? `To: ${opts.to}` : "",
    opts.cc ? `Cc: ${opts.cc}` : "",
    opts.bcc ? `Bcc: ${opts.bcc}` : "",
    `Subject: ${encodeHeader(opts.subject)}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : "",
    opts.references ? `References: ${opts.references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const bodyB64 = Buffer.from(opts.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  let mime: string;
  if (!opts.attachments?.length) {
    mime = [...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", bodyB64].join("\r\n");
  } else {
    const boundary = `gmx_${Date.now().toString(36)}`;
    const parts = [
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${bodyB64}`,
    ];
    for (const p of opts.attachments) {
      const full = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
      if (!fs.existsSync(full)) throw new Error(`Attachment not found: ${full}`);
      const name = path.basename(full);
      const data = fs.readFileSync(full).toString("base64").replace(/.{76}/g, "$&\r\n");
      parts.push(
        `--${boundary}\r\nContent-Type: application/octet-stream; name="${encodeHeader(name)}"\r\n` +
          `Content-Disposition: attachment; filename="${encodeHeader(name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}`,
      );
    }
    mime = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", parts.join("\r\n") + `\r\n--${boundary}--`].join("\r\n");
  }
  return b64urlEncode(mime);
}

const composeShape = {
  account: z.string().describe(accountParam + " The message is sent from this account."),
  from: z.string().optional().describe(
    "Send as this address instead of the account's own. Must be a verified alias under that account's Gmail settings " +
      "(Accounts > Send mail as), e.g. a custom-domain address. When replying and this is omitted, the alias the original " +
      "message was addressed to is used automatically.",
  ),
  to: z.string().optional().describe("Comma-separated recipients. Optional when replying (defaults to the original sender)."),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional().describe('Subject. When replying, defaults to "Re: <original subject>".'),
  body: z.string().describe("Plain-text body."),
  reply_to_message_id: z.string().optional().describe("Gmail message ID to reply to; threads the reply correctly."),
  reply_all: z.boolean().default(false).describe("When replying, also include the original To/Cc recipients."),
  attachments: z.array(z.string()).optional().describe("Absolute paths of local files on this Mac to attach."),
};
type ComposeArgs = {
  account: string; from?: string; to?: string; cc?: string; bcc?: string; subject?: string; body: string;
  reply_to_message_id?: string; reply_all: boolean; attachments?: string[];
};

/** Verified send-as addresses on the account, primary included. Gmail rejects or rewrites any other From. */
async function sendAsAliases(g: gmail_v1.Gmail): Promise<{ email: string; name: string; primary: boolean }[]> {
  const r = await g.users.settings.sendAs.list({ userId: "me" });
  return (r.data.sendAs ?? [])
    .filter((x) => x.sendAsEmail && (x.isPrimary || x.verificationStatus === "accepted"))
    .map((x) => ({ email: x.sendAsEmail!, name: x.displayName ?? "", primary: !!x.isPrimary }));
}

function fromHeader(x: { email: string; name: string }): string {
  return x.name ? `${encodeHeader(x.name)} <${x.email}>` : x.email;
}

async function prepareCompose(args: ComposeArgs) {
  const a = one(args.account);
  const g = api(a);
  let from = a.email;
  let fromEmail = a.email;
  let aliases: Awaited<ReturnType<typeof sendAsAliases>> = [];
  if (args.from || args.reply_to_message_id) {
    try {
      aliases = await sendAsAliases(g);
    } catch (e) {
      // an explicit alias we can't verify must not go out under the wrong address; a reply just falls back to the account
      if (args.from) throw new Error(`Could not read send-as aliases for ${a.email}: ${(e as Error).message}`);
    }
  }
  if (args.from) {
    const want = args.from.trim().toLowerCase();
    const hit = aliases.find((x) => x.email.toLowerCase() === want);
    if (!hit) {
      throw new Error(
        `${args.from} is not a verified send-as alias on ${a.email}. Available: ${aliases.map((x) => x.email).join(", ") || "none"}.`,
      );
    }
    from = fromHeader(hit);
    fromEmail = hit.email;
  }
  let { to, cc, subject } = args;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (args.reply_to_message_id) {
    const orig = await g.users.messages.get({
      userId: "me",
      id: args.reply_to_message_id,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "To", "Cc", "Reply-To", "Message-ID", "References"],
    });
    const h = orig.data.payload?.headers;
    threadId = orig.data.threadId ?? undefined;
    inReplyTo = hdr(h, "Message-ID");
    references = [hdr(h, "References"), inReplyTo].filter(Boolean).join(" ");
    const origSubject = hdr(h, "Subject");
    subject ??= /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    to ??= hdr(h, "Reply-To") || hdr(h, "From");
    if (!args.from) {
      // reply from the address the message was sent to, so the thread keeps one identity
      const addressed = `${hdr(h, "To")},${hdr(h, "Cc")}`.toLowerCase();
      const hit = aliases.find((x) => !x.primary && addressed.includes(x.email.toLowerCase()));
      if (hit) {
        from = fromHeader(hit);
        fromEmail = hit.email;
      }
    }
    if (args.reply_all) {
      const selves = [a.email.toLowerCase(), fromEmail.toLowerCase()];
      const others = [hdr(h, "To"), hdr(h, "Cc")]
        .join(",")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !selves.some((self) => s.toLowerCase().includes(self)));
      cc = [cc, ...others].filter(Boolean).join(", ");
    }
  }
  if (!to) throw new Error("`to` is required unless reply_to_message_id is given.");
  const raw = await buildRaw({
    from, to, cc, bcc: args.bcc, subject: subject ?? "", body: args.body,
    inReplyTo, references, attachments: args.attachments,
  });
  return { a, g, raw, threadId, to, subject, fromEmail };
}

export function registerGmail(server: McpServer): void {
  server.registerTool(
    "gmail_search",
    {
      title: "Search Gmail (one or all accounts)",
      description:
        "Search mail using Gmail query syntax (e.g. 'from:bob is:unread newer_than:7d', 'has:attachment subject:invoice'). " +
        "Searches every connected account by default and labels each result with its account. Returns message IDs for gmail_read_message.",
      inputSchema: {
        query: z.string().default("in:inbox").describe("Gmail search query. Default: in:inbox"),
        account: z.string().optional().describe(accountOrAllParam),
        max_results: z.number().int().min(1).max(100).default(15).describe("Max results per account."),
        page_token: z.string().optional().describe("Pagination token from a previous single-account search."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ query, account, max_results, page_token }) => {
      const accounts = resolveAccounts(account, true);
      const { ok, errors } = await fanOut(accounts, async (a) => {
        const g = api(a);
        const list = await g.users.messages.list({ userId: "me", q: query, maxResults: max_results, pageToken: page_token });
        const msgs = await Promise.all(
          (list.data.messages ?? []).map((m) =>
            g.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }),
          ),
        );
        return { msgs: msgs.map((r) => r.data), next: list.data.nextPageToken, estimate: list.data.resultSizeEstimate };
      });
      const rows = ok.flatMap(({ account: a, value }) =>
        value.msgs.map((m) => ({ a, m, ts: Number(m.internalDate ?? 0) })),
      );
      rows.sort((x, y) => y.ts - x.ts);
      const out: string[] = [`Query: \`${query}\` — ${rows.length} message(s) across ${ok.length} account(s)`];
      for (const { a, m } of rows) {
        const h = m.payload?.headers;
        const unread = m.labelIds?.includes("UNREAD") ? "● " : "";
        out.push(
          `- ${unread}[${a.alias ?? a.email}] ${fmtDateTime(new Date(Number(m.internalDate)).toISOString())} — **${hdr(h, "Subject") || "(no subject)"}**` +
            `\n  From: ${hdr(h, "From")} | id=${m.id} thread=${m.threadId}\n  ${m.snippet ?? ""}`,
        );
      }
      for (const { account: a, value } of ok)
        if (value.next) out.push(`\nMore results in ${label(a)}: page_token=${value.next} (pass account=${a.alias ?? a.email})`);
      if (errors.length) out.push("", "Errors:", ...errors.map((e) => `- ${e}`));
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "gmail_read_message",
    {
      title: "Read a Gmail message",
      description: "Read one message's headers, plain-text body and attachment list.",
      inputSchema: {
        account: z.string().describe(accountParam),
        message_id: z.string(),
        max_chars: z.number().int().min(500).max(200000).default(20000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account, message_id, max_chars }) => {
      const a = one(account);
      const m = await api(a).users.messages.get({ userId: "me", id: message_id, format: "full" });
      return text(renderMessage(a, m.data, max_chars));
    }),
  );

  server.registerTool(
    "gmail_read_thread",
    {
      title: "Read a Gmail thread",
      description: "Read every message in a conversation, oldest first.",
      inputSchema: {
        account: z.string().describe(accountParam),
        thread_id: z.string(),
        max_chars_per_message: z.number().int().min(500).max(100000).default(8000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account, thread_id, max_chars_per_message }) => {
      const a = one(account);
      const t = await api(a).users.threads.get({ userId: "me", id: thread_id, format: "full" });
      const msgs = t.data.messages ?? [];
      return text(
        `Thread ${thread_id} (${msgs.length} messages) in ${label(a)}\n\n` +
          msgs.map((m) => renderMessage(a, m, max_chars_per_message)).join("\n\n---\n\n"),
      );
    }),
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create a Gmail draft",
      description: "Create a draft (new message or threaded reply) in a specific account. Nothing is sent.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args: ComposeArgs) => {
      const { a, g, raw, threadId, to, subject, fromEmail } = await prepareCompose(args);
      const d = await g.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } });
      return text(`Draft created in ${label(a)} — From: ${fromEmail} | To: ${to} | Subject: ${subject}\ndraft_id=${d.data.id} message_id=${d.data.message?.id}`);
    }),
  );

  server.registerTool(
    "gmail_send",
    {
      title: "Send an email",
      description:
        "Send an email (new or threaded reply) from a specific account. This sends immediately — confirm recipients and account with the user first.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async (args: ComposeArgs) => {
      const { a, g, raw, threadId, to, subject, fromEmail } = await prepareCompose(args);
      const s = await g.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
      return text(`Sent from ${label(a)} — From: ${fromEmail} | To: ${to} | Subject: ${subject}\nmessage_id=${s.data.id} thread=${s.data.threadId}`);
    }),
  );

  server.registerTool(
    "gmail_list_drafts",
    {
      title: "List Gmail drafts",
      description: "List drafts in one or all accounts.",
      inputSchema: {
        account: z.string().optional().describe(accountOrAllParam),
        max_results: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account, max_results }) => {
      const { ok, errors } = await fanOut(resolveAccounts(account, true), async (a) => {
        const g = api(a);
        const list = await g.users.drafts.list({ userId: "me", maxResults: max_results });
        return Promise.all(
          (list.data.drafts ?? []).map((d) => g.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" }).then((r) => r.data)),
        );
      });
      const out: string[] = [];
      for (const { account: a, value } of ok) {
        out.push(`## ${label(a)} — ${value.length} draft(s)`);
        for (const d of value) {
          const h = d.message?.payload?.headers;
          out.push(`- **${hdr(h, "Subject") || "(no subject)"}** → ${hdr(h, "To")} | draft_id=${d.id}\n  ${d.message?.snippet ?? ""}`);
        }
      }
      if (errors.length) out.push("", "Errors:", ...errors.map((e) => `- ${e}`));
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send an existing draft",
      description: "Send a draft by draft_id. Sends immediately.",
      inputSchema: { account: z.string().describe(accountParam), draft_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ account, draft_id }) => {
      const a = one(account);
      const s = await api(a).users.drafts.send({ userId: "me", requestBody: { id: draft_id } });
      return text(`Draft sent from ${label(a)}. message_id=${s.data.id}`);
    }),
  );

  server.registerTool(
    "gmail_modify",
    {
      title: "Archive / mark read / star / label messages",
      description:
        "Change labels on messages in one account. Shortcuts: action='archive' | 'mark_read' | 'mark_unread' | 'star' | 'unstar' | 'trash' | 'untrash'. " +
        "Or pass add_labels/remove_labels with label IDs or names (see gmail_list_labels).",
      inputSchema: {
        account: z.string().describe(accountParam),
        message_ids: z.array(z.string()).min(1).max(1000),
        action: z.enum(["archive", "mark_read", "mark_unread", "star", "unstar", "trash", "untrash"]).optional(),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ account, message_ids, action, add_labels = [], remove_labels = [] }) => {
      const a = one(account);
      const g = api(a);
      if (action === "trash" || action === "untrash") {
        await Promise.all(
          message_ids.map((id) => (action === "trash" ? g.users.messages.trash({ userId: "me", id }) : g.users.messages.untrash({ userId: "me", id }))),
        );
        return text(`${action === "trash" ? "Trashed" : "Restored"} ${message_ids.length} message(s) in ${label(a)}.`);
      }
      const add = [...add_labels];
      const remove = [...remove_labels];
      if (action === "archive") remove.push("INBOX");
      if (action === "mark_read") remove.push("UNREAD");
      if (action === "mark_unread") add.push("UNREAD");
      if (action === "star") add.push("STARRED");
      if (action === "unstar") remove.push("STARRED");
      // Resolve label names to IDs.
      const labels = (await g.users.labels.list({ userId: "me" })).data.labels ?? [];
      const toId = (n: string) =>
        labels.find((l) => l.id === n || l.name?.toLowerCase() === n.toLowerCase())?.id ??
        (() => { throw new Error(`Label "${n}" not found in ${label(a)}.`); })();
      await g.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: message_ids, addLabelIds: add.map(toId), removeLabelIds: remove.map(toId) },
      });
      return text(`Updated ${message_ids.length} message(s) in ${label(a)} (+[${add.join(", ")}] −[${remove.join(", ")}]).`);
    }),
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "List Gmail labels",
      description: "List labels (system and user) for one or all accounts, with unread counts for user labels.",
      inputSchema: { account: z.string().optional().describe(accountOrAllParam) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account }) => {
      const { ok, errors } = await fanOut(resolveAccounts(account, true), async (a) =>
        (await api(a).users.labels.list({ userId: "me" })).data.labels ?? [],
      );
      const out = ok.map(
        ({ account: a, value }) =>
          `## ${label(a)}\n` +
          value
            .sort((x, y) => (x.type ?? "").localeCompare(y.type ?? "") || (x.name ?? "").localeCompare(y.name ?? ""))
            .map((l) => `- ${l.name} (id=${l.id}, ${l.type})`)
            .join("\n"),
      );
      if (errors.length) out.push("Errors:\n" + errors.map((e) => `- ${e}`).join("\n"));
      return text(out.join("\n\n"));
    }),
  );

  server.registerTool(
    "gmail_save_attachment",
    {
      title: "Save a Gmail attachment to disk",
      description: "Download an attachment (IDs come from gmail_read_message) into a folder on this Mac. Returns the saved path.",
      inputSchema: {
        account: z.string().describe(accountParam),
        message_id: z.string(),
        attachment_id: z.string(),
        filename: z.string().describe("File name to save as (use the name shown by gmail_read_message)."),
        directory: z.string().default("~/Downloads").describe("Destination folder. Default ~/Downloads."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ account, message_id, attachment_id, filename, directory }) => {
      const a = one(account);
      const r = await api(a).users.messages.attachments.get({ userId: "me", messageId: message_id, id: attachment_id });
      const dir = directory.startsWith("~") ? path.join(os.homedir(), directory.slice(1)) : directory;
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, path.basename(filename));
      for (let i = 1; fs.existsSync(dest); i++) {
        const ext = path.extname(filename);
        dest = path.join(dir, `${path.basename(filename, ext)} (${i})${ext}`);
      }
      fs.writeFileSync(dest, Buffer.from(r.data.data!.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      return text(`Saved ${dest}`);
    }),
  );
}
