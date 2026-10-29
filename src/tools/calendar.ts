import { z } from "zod";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fanOut, getClient, label, resolveAccounts } from "../auth.js";
import { DEFAULT_TZ, type Account } from "../config.js";
import { accountOrAllParam, accountParam, fmtDateTime, fmtTime, safe, startOfDay, text, toRfc3339 } from "../util.js";

const api = (a: Account) => calendar({ version: "v3", auth: getClient(a.email) });
const one = (sel: string) => resolveAccounts(sel, false)[0];

type Ev = calendar_v3.Schema$Event;
const evStart = (e: Ev) => e.start?.dateTime ?? e.start?.date ?? "";
const evEnd = (e: Ev) => e.end?.dateTime ?? e.end?.date ?? "";

function myStatus(e: Ev, email: string): string {
  const me = e.attendees?.find((x) => x.self || x.email?.toLowerCase() === email.toLowerCase());
  return me?.responseStatus && me.responseStatus !== "accepted" ? ` [${me.responseStatus}]` : "";
}

function renderEvent(a: Account, e: Ev, calName?: string, verbose = false): string {
  const allDay = !e.start?.dateTime;
  const when = allDay
    ? `${evStart(e)} (all day)`
    : `${fmtDateTime(evStart(e))} – ${fmtTime(evEnd(e))}`;
  const lines = [
    `- [${a.alias ?? a.email}${calName ? ` / ${calName}` : ""}] ${when} — **${e.summary ?? "(no title)"}**${myStatus(e, a.email)}`,
  ];
  const meet = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const meta = [e.location && `📍 ${e.location}`, meet && `video: ${meet}`, `event_id=${e.id}`].filter(Boolean);
  lines.push(`  ${meta.join(" | ")}`);
  if (verbose) {
    if (e.organizer?.email) lines.push(`  Organizer: ${e.organizer.displayName ?? ""} <${e.organizer.email}>`);
    if (e.attendees?.length)
      lines.push(`  Attendees: ${e.attendees.map((x) => `${x.displayName ?? x.email} (${x.responseStatus})`).join(", ")}`);
    if (e.description) lines.push(`  Notes: ${e.description.replace(/\s+/g, " ").slice(0, 1500)}`);
  }
  return lines.join("\n");
}

function timeInput(v: string, allDay: boolean, tz: string): calendar_v3.Schema$EventDateTime {
  if (allDay) return { date: v.slice(0, 10) };
  return { dateTime: toRfc3339(v, tz), timeZone: tz };
}

export function registerCalendar(server: McpServer): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List calendars",
      description: "List the calendars each account can see (IDs usable as calendar_id).",
      inputSchema: { account: z.string().optional().describe(accountOrAllParam) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account }) => {
      const { ok, errors } = await fanOut(resolveAccounts(account, true), async (a) =>
        (await api(a).calendarList.list({ maxResults: 250 })).data.items ?? [],
      );
      const out = ok.map(
        ({ account: a, value }) =>
          `## ${label(a)}\n` +
          value
            .map((c) => `- ${c.summaryOverride ?? c.summary}${c.primary ? " (primary)" : ""} — id=${c.id}, role=${c.accessRole}${c.selected ? "" : ", hidden"}`)
            .join("\n"),
      );
      if (errors.length) out.push("Errors:\n" + errors.map((e) => `- ${e}`).join("\n"));
      return text(out.join("\n\n"));
    }),
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "List events across accounts",
      description:
        "Unified agenda: events from every connected account merged and sorted by start time. " +
        "Defaults to today through 7 days out on each account's primary calendar. Set all_calendars=true to include every visible calendar.",
      inputSchema: {
        account: z.string().optional().describe(accountOrAllParam),
        time_min: z.string().optional().describe("Start (YYYY-MM-DD, YYYY-MM-DDTHH:MM, or RFC3339). Default: start of today."),
        time_max: z.string().optional().describe("End. Default: 7 days after time_min."),
        query: z.string().optional().describe("Free-text filter on title/description/location/attendees."),
        calendar_id: z.string().optional().describe('Specific calendar ID (single account only). Default "primary".'),
        all_calendars: z.boolean().default(false).describe("Include all visible (selected) calendars, not just primary."),
        verbose: z.boolean().default(false).describe("Include attendees, organizer and notes."),
        max_results: z.number().int().min(1).max(500).default(100).describe("Max events per calendar."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const tz = DEFAULT_TZ;
      const timeMin = args.time_min ? toRfc3339(args.time_min, tz) : startOfDay(tz);
      const timeMax = args.time_max
        ? toRfc3339(args.time_max, tz)
        : new Date(new Date(timeMin).getTime() + 7 * 86400_000).toISOString();
      const accounts = resolveAccounts(args.account, true);
      if (args.calendar_id && accounts.length > 1)
        throw new Error("calendar_id only works with a single account; pass `account` too.");

      const { ok, errors } = await fanOut(accounts, async (a) => {
        const c = api(a);
        let cals: { id: string; name?: string }[] = [{ id: args.calendar_id ?? "primary" }];
        if (args.all_calendars && !args.calendar_id) {
          const list = (await c.calendarList.list({ maxResults: 250 })).data.items ?? [];
          cals = list.filter((x) => x.selected || x.primary).map((x) => ({ id: x.id!, name: x.primary ? undefined : x.summaryOverride ?? x.summary ?? undefined }));
        }
        const per = await Promise.all(
          cals.map(async (cal) => {
            const r = await c.events.list({
              calendarId: cal.id, timeMin, timeMax, q: args.query, singleEvents: true,
              orderBy: "startTime", maxResults: args.max_results, timeZone: tz,
            });
            return (r.data.items ?? [])
              .filter((e) => e.status !== "cancelled")
              .map((e) => ({ e, cal: cal.name }));
          }),
        );
        return per.flat();
      });

      const rows = ok.flatMap(({ account: a, value }) => value.map((v) => ({ a, ...v })));
      // De-dupe the same meeting appearing on several of your accounts' calendars.
      const seen = new Map<string, number>();
      rows.sort((x, y) => new Date(evStart(x.e)).getTime() - new Date(evStart(y.e)).getTime());
      const out: string[] = [
        `Events ${fmtDateTime(timeMin)} → ${fmtDateTime(timeMax)} (${tz}) — ${rows.length} across ${ok.length} account(s)`,
        "",
      ];
      let day = "";
      for (const r of rows) {
        const key = r.e.iCalUID ? `${r.e.iCalUID}|${evStart(r.e)}` : "";
        if (key && seen.has(key)) {
          out[seen.get(key)!] += `\n  (also on ${r.a.alias ?? r.a.email})`;
          continue;
        }
        const d = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(
          new Date(r.e.start?.dateTime ?? `${r.e.start?.date}T12:00:00Z`),
        );
        if (d !== day) {
          out.push(`\n**${d}**`);
          day = d;
        }
        out.push(renderEvent(r.a, r.e, r.cal, args.verbose));
        if (key) seen.set(key, out.length - 1);
      }
      if (errors.length) out.push("", "Errors:", ...errors.map((e) => `- ${e}`));
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get event details",
      description: "Full details for one event (attendees, notes, conferencing).",
      inputSchema: {
        account: z.string().describe(accountParam),
        event_id: z.string(),
        calendar_id: z.string().default("primary"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account, event_id, calendar_id }) => {
      const a = one(account);
      const e = (await api(a).events.get({ calendarId: calendar_id, eventId: event_id })).data;
      return text(renderEvent(a, e, undefined, true) + (e.htmlLink ? `\n  Link: ${e.htmlLink}` : ""));
    }),
  );

  server.registerTool(
    "calendar_find_free_time",
    {
      title: "Find free time across all accounts",
      description:
        "Combine busy time from every connected account (and optionally other people's emails) and return open slots during working hours. " +
        "Use this before proposing meeting times so nothing on any account is double-booked.",
      inputSchema: {
        time_min: z.string().optional().describe("Start of window. Default: now."),
        time_max: z.string().optional().describe("End of window. Default: 5 days after start."),
        duration_minutes: z.number().int().min(5).max(600).default(30),
        work_start_hour: z.number().int().min(0).max(23).default(9),
        work_end_hour: z.number().int().min(1).max(24).default(18),
        include_weekends: z.boolean().default(false),
        also_check: z.array(z.string()).optional().describe("Other people's emails whose calendars your accounts can see."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const tz = DEFAULT_TZ;
      const start = args.time_min ? toRfc3339(args.time_min, tz) : new Date().toISOString();
      const end = args.time_max ? toRfc3339(args.time_max, tz) : new Date(new Date(start).getTime() + 5 * 86400_000).toISOString();
      const accounts = resolveAccounts(undefined, true);
      const { ok, errors } = await fanOut(accounts, async (a) => {
        const items = [{ id: "primary" }, ...(args.also_check ?? []).map((id) => ({ id }))];
        const r = await api(a).freebusy.query({ requestBody: { timeMin: start, timeMax: end, timeZone: tz, items } });
        return Object.values(r.data.calendars ?? {}).flatMap((c) => c.busy ?? []);
      });
      if (!ok.length) throw new Error("Couldn't read any account's calendar:\n" + errors.map((e) => `- ${e}`).join("\n"));
      const busy = ok
        .flatMap((x) => x.value)
        .map((b) => [new Date(b.start!).getTime(), new Date(b.end!).getTime()] as [number, number])
        .sort((x, y) => x[0] - y[0]);
      const merged: [number, number][] = [];
      for (const b of busy) {
        const last = merged[merged.length - 1];
        if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
        else merged.push([...b]);
      }
      // Walk each day's working window and subtract busy blocks.
      const dur = args.duration_minutes * 60_000;
      const slots: [number, number][] = [];
      const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
      const endMs = new Date(end).getTime();
      const days = new Set<string>();
      for (let t = new Date(start).getTime(); t < endMs; t += 3600_000) days.add(dayFmt.format(new Date(t)));
      for (const d of days) {
        const wd = wdFmt.format(new Date(toRfc3339(`${d}T12:00`, tz)));
        if (!args.include_weekends && (wd === "Sat" || wd === "Sun")) continue;
        let ws = new Date(toRfc3339(`${d}T${String(args.work_start_hour).padStart(2, "0")}:00`, tz)).getTime();
        const we = args.work_end_hour === 24
          ? new Date(toRfc3339(d, tz)).getTime() + 86400_000
          : new Date(toRfc3339(`${d}T${String(args.work_end_hour).padStart(2, "0")}:00`, tz)).getTime();
        ws = Math.max(ws, new Date(start).getTime());
        const winEnd = Math.min(we, endMs);
        let cursor = ws;
        for (const [bs, be] of merged) {
          if (be <= cursor || bs >= winEnd) continue;
          if (bs - cursor >= dur) slots.push([cursor, bs]);
          cursor = Math.max(cursor, be);
        }
        if (winEnd - cursor >= dur) slots.push([cursor, winEnd]);
      }
      const out = [
        `Open slots ≥ ${args.duration_minutes} min, ${args.work_start_hour}:00–${args.work_end_hour}:00 ${tz}, checking ${ok.map((x) => x.account.alias ?? x.account.email).join(", ")}${args.also_check?.length ? ` + ${args.also_check.join(", ")}` : ""}:`,
        "",
        ...(slots.length
          ? slots.map(([s, e]) => `- ${fmtDateTime(new Date(s).toISOString())} – ${fmtTime(new Date(e).toISOString())}`)
          : ["(no open slots in this window)"]),
      ];
      if (errors.length) out.push("", "Errors (these accounts were NOT checked):", ...errors.map((e) => `- ${e}`));
      return text(out.join("\n"));
    }),
  );

  const eventFields = {
    summary: z.string().optional().describe("Title."),
    start: z.string().optional().describe("YYYY-MM-DDTHH:MM (local to time_zone) or YYYY-MM-DD for all-day."),
    end: z.string().optional().describe("Same format as start. For all-day events, the day AFTER the last day."),
    all_day: z.boolean().optional(),
    time_zone: z.string().optional().describe(`IANA time zone. Default ${DEFAULT_TZ}.`),
    location: z.string().optional(),
    description: z.string().optional(),
    attendees: z.array(z.string()).optional().describe("Attendee emails (replaces the list when updating)."),
    add_video_call: z.boolean().optional().describe("Attach a Google Meet link."),
    send_updates: z.enum(["all", "externalOnly", "none"]).default("none").describe("Email invitations/updates to attendees."),
  };

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create an event",
      description: "Create an event on a specific account's calendar.",
      inputSchema: {
        account: z.string().describe(accountParam + " The event is created on this account's calendar."),
        calendar_id: z.string().default("primary"),
        ...eventFields,
        summary: z.string().describe("Title."),
        start: z.string().describe(eventFields.start.description!),
        end: z.string().describe(eventFields.end.description!),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      const a = one(args.account);
      const tz = args.time_zone ?? DEFAULT_TZ;
      const allDay = args.all_day ?? /^\d{4}-\d{2}-\d{2}$/.test(args.start);
      const body: calendar_v3.Schema$Event = {
        summary: args.summary,
        location: args.location,
        description: args.description,
        start: timeInput(args.start, allDay, tz),
        end: timeInput(args.end, allDay, tz),
        attendees: args.attendees?.map((email) => ({ email })),
      };
      if (args.add_video_call)
        body.conferenceData = { createRequest: { requestId: `gmx-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      const r = await api(a).events.insert({
        calendarId: args.calendar_id, requestBody: body, sendUpdates: args.send_updates,
        conferenceDataVersion: args.add_video_call ? 1 : 0,
      });
      return text(`Created in ${label(a)}:\n${renderEvent(a, r.data, undefined, true)}\n  Link: ${r.data.htmlLink}`);
    }),
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update an event",
      description: "Change fields on an existing event. Only the fields you pass are changed.",
      inputSchema: {
        account: z.string().describe(accountParam),
        event_id: z.string(),
        calendar_id: z.string().default("primary"),
        ...eventFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const a = one(args.account);
      const tz = args.time_zone ?? DEFAULT_TZ;
      const patch: calendar_v3.Schema$Event = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.location !== undefined) patch.location = args.location;
      if (args.description !== undefined) patch.description = args.description;
      const allDay = args.all_day ?? (args.start ? /^\d{4}-\d{2}-\d{2}$/.test(args.start) : false);
      if (args.start) patch.start = timeInput(args.start, allDay, tz);
      if (args.end) patch.end = timeInput(args.end, allDay, tz);
      if (args.attendees) patch.attendees = args.attendees.map((email) => ({ email }));
      if (args.add_video_call)
        patch.conferenceData = { createRequest: { requestId: `gmx-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      const r = await api(a).events.patch({
        calendarId: args.calendar_id, eventId: args.event_id, requestBody: patch,
        sendUpdates: args.send_updates, conferenceDataVersion: args.add_video_call ? 1 : 0,
      });
      return text(`Updated in ${label(a)}:\n${renderEvent(a, r.data, undefined, true)}`);
    }),
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete an event",
      description: "Delete (or, if you're only a guest, remove from your calendar) an event. Confirm with the user first.",
      inputSchema: {
        account: z.string().describe(accountParam),
        event_id: z.string(),
        calendar_id: z.string().default("primary"),
        send_updates: z.enum(["all", "externalOnly", "none"]).default("none"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ account, event_id, calendar_id, send_updates }) => {
      const a = one(account);
      await api(a).events.delete({ calendarId: calendar_id, eventId: event_id, sendUpdates: send_updates });
      return text(`Deleted event ${event_id} from ${label(a)}.`);
    }),
  );

  server.registerTool(
    "calendar_respond",
    {
      title: "RSVP to an invitation",
      description: "Accept, decline or tentatively accept an invitation on a specific account.",
      inputSchema: {
        account: z.string().describe(accountParam + " Must be the account that was invited."),
        event_id: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
        calendar_id: z.string().default("primary"),
        notify_organizer: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ account, event_id, response, calendar_id, notify_organizer }) => {
      const a = one(account);
      const c = api(a);
      const e = (await c.events.get({ calendarId: calendar_id, eventId: event_id })).data;
      const attendees = e.attendees ?? [];
      const me = attendees.find((x) => x.self || x.email?.toLowerCase() === a.email.toLowerCase());
      if (!me) throw new Error(`${a.email} is not on the guest list for this event; use the account that was invited.`);
      me.responseStatus = response;
      await c.events.patch({
        calendarId: calendar_id, eventId: event_id, requestBody: { attendees },
        sendUpdates: notify_organizer ? "all" : "none",
      });
      return text(`${label(a)} → ${response}: ${e.summary}`);
    }),
  );
}
