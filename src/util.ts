import { DEFAULT_TZ } from "./config.js";
import { explainError, resolveAccounts } from "./auth.js";
import type { Account } from "./config.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function fail(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

/** Wrap a tool handler so thrown errors come back as readable tool errors. */
export function safe<A>(
  fn: (args: A) => Promise<ToolResult>,
  account?: (args: A) => Account | undefined,
) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const e = err as { response?: unknown; code?: unknown };
      if (e && (e.response || typeof e.code === "number")) {
        let acct: Account | undefined;
        try {
          const sel = (args as { account?: string } | undefined)?.account;
          acct = account ? account(args) : sel && sel !== "all" ? resolveAccounts(sel, false)[0] : undefined;
        } catch { /* ignore */ }
        return fail(explainError(err, acct));
      }
      return fail((err as Error)?.message ?? String(err));
    }
  };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated ${s.length - max} more characters; raise max_chars to see more]`;
}

export function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function fmtDateTime(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "?";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso; // all-day
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function fmtTime(iso: string, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Accept "2026-09-22", "2026-09-22T10:00", or full RFC3339; return RFC3339. */
export function toRfc3339(input: string, tz = DEFAULT_TZ): string {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(input)) return new Date(input).toISOString();
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error(`Could not parse date/time "${input}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
    return d.toISOString();
  }
  const [, y, mo, da, h = "00", mi = "00", s = "00"] = m;
  // Interpret wall-clock time in tz.
  const asUtc = Date.UTC(+y, +mo - 1, +da, +h, +mi, +s);
  const offset = tzOffsetMinutes(new Date(asUtc), tz);
  return new Date(asUtc - offset * 60_000).toISOString();
}

function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function startOfDay(tz = DEFAULT_TZ, addDays = 0): string {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const d = new Date(toRfc3339(ymd, tz));
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString();
}

export const accountParam =
  "Which account: an email address or alias from google_list_accounts.";
export const accountOrAllParam =
  'Which account: email, alias, or "all" (default "all" searches every connected account).';
