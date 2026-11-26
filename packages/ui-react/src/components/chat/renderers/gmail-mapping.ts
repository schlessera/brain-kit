// Maps the host Gmail tools' payloads (#4207) onto the ui-kit Gmail
// components' props (#4209). Pure: no React, no fetch (#4210).
//
// The mapping is honest, as GitHub's is (#3795):
// - A `null` field maps to the component's absent state, never to zero or
//   `false`.
// - Every untrusted string stays under `untrusted`, exactly where the payload
//   puts it, and is passed on as written: the kit reveals and isolates it.
// - A structured item gets no `untrusted` at all, so no structured row can
//   show anything a sender wrote.
// - Times are the payload's RFC 3339 instants, formatted here in the reader's
//   time zone, because the kit never computes a time.

import type {
  GmailContentMessage,
  GmailContentThread,
  GmailDate,
  GmailDetailState,
  GmailStructuredMessage,
  GmailStructuredThread,
} from "@schlessera/brain-ui-kit";
import type {
  GmailContentMessagePayload,
  GmailMessageBody,
  GmailSearchPayload,
  GmailStructuredMessagePayload,
  GoogleErrorCode,
  GoogleToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";

type StructuredHit = Extract<GmailSearchPayload, { view: "structured" }>["threads"][number];
type ContentHit = Extract<GmailSearchPayload, { view: "content" }>["threads"][number];

interface DateOptions {
  /** A search row shows the day only; a message shows the time too. */
  time: boolean;
  /** Defaults to the reader's own. */
  timeZone?: string;
  /** The reader's now, for whether the short form needs the year. Defaults to the clock. */
  now?: number;
}

/**
 * A Gmail timestamp as the reader reads it: "Sat 11 Jul 18:02" and
 * "Saturday 11 July 2026, 18:02", in the reader's time zone. The short form
 * names the year only when it is not the reader's current year, so old mail
 * never passes for this year's. `null` when the payload gave no time.
 */
export function gmailDate(iso: string | null, options: DateOptions): GmailDate | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const parts = (ms: number) => {
    const format = new Intl.DateTimeFormat("en-GB", {
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const read = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
    return { weekday: read.weekday ?? "", day: read.day ?? "", month: read.month ?? "", year: read.year ?? "", clock: `${read.hour ?? ""}:${read.minute ?? ""}` };
  };
  const p = parts(at);
  const thisYear = parts(options.now ?? Date.now()).year;
  // Three letters of the long names: "Sep" stays "Sep", never a locale's "Sept".
  const short = `${p.weekday.slice(0, 3)} ${p.day} ${p.month.slice(0, 3)}${p.year === thisYear ? "" : ` ${p.year}`}${options.time ? ` ${p.clock}` : ""}`;
  return { short, full: `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.clock}`, iso };
}

export type DateFor = (iso: string | null) => GmailDate | null;

/** A search hit's structured facts, in the kit's terms. It copies no `untrusted` field, whatever the hit's view. */
export function structuredThread(hit: StructuredHit | ContentHit, dateFor: DateFor): GmailStructuredThread {
  return {
    threadId: hit.thread_id,
    date: dateFor(hit.latest_internal_date),
    messageCount: hit.message_count,
    labels: hit.labels,
    sizeBucket: hit.size_bucket,
    unread: hit.unread,
    starred: hit.starred,
    hasAttachment: hit.has_attachment,
  };
}

/**
 * A content search hit: the structured facts and, under `untrusted`, what
 * the thread's newest message's sender wrote. A hit carries no attachment
 * names, only whether there is one (the kit's flag).
 */
export function contentThread(hit: ContentHit, dateFor: DateFor): GmailContentThread {
  const u = hit.untrusted;
  return { ...structuredThread(hit, dateFor), untrusted: { from: u.from, to: u.to, cc: u.cc, subject: u.subject, snippet: u.snippet } };
}

/** One message's structured facts. It copies no `untrusted` field, whatever the message's view. */
export function structuredMessage(message: GmailStructuredMessagePayload | GmailContentMessagePayload, dateFor: DateFor): GmailStructuredMessage {
  return {
    messageId: message.message_id,
    date: dateFor(message.internal_date),
    labels: message.labels,
    sizeBucket: message.size_bucket,
    unread: message.unread,
    starred: message.starred,
    hasAttachment: message.has_attachment,
    attachmentCount: message.attachment_count,
  };
}

/**
 * One message with its untrusted text. `body_length` counts characters as
 * JavaScript does (UTF-16 code units), which is how the host counts and cuts
 * it, so the kit's "Brain read the first n of m characters" holds.
 */
export function contentMessage(message: GmailContentMessagePayload, dateFor: DateFor): GmailContentMessage {
  const u = message.untrusted;
  return {
    ...structuredMessage(message, dateFor),
    untrusted: {
      from: u.from,
      to: u.to,
      cc: u.cc,
      bcc: u.bcc,
      subject: u.subject,
      snippet: u.snippet,
      body: u.body_text,
      bodyTruncated: u.body_truncated,
      bodyLength: u.body_length,
      attachments: u.attachments.map((a) => ({ filename: a.filename, mimeType: a.mime_type, size: a.size })),
    },
  };
}

/**
 * The part of a full body after what Brain read, or `null` when the full body
 * does not begin with exactly what the tool result carried. Nothing is ever
 * spliced: a body that changed, came back shorter, or no longer starts with
 * the text Brain saw shows no rest at all.
 */
export function restOfBody(shown: string | null, body: GmailMessageBody): { rest: string; truncated: boolean } | null {
  const seen = shown ?? "";
  const full = body.body_text;
  if (full === null || full.length <= seen.length || !full.startsWith(seen)) return null;
  return { rest: full.slice(seen.length), truncated: body.body_truncated };
}

/** The kit's detail state for a refused or failed detail request. */
export function detailErrorState(code: GoogleErrorCode): Extract<GmailDetailState, "gone" | "unavailable" | "rate-limited" | "error"> {
  switch (code) {
    case "not_found":
      return "gone";
    case "unavailable":
    case "transport_incompatible":
    case "policy_denied":
      return "unavailable";
    case "rate_limited":
      return "rate-limited";
    default:
      return "error";
  }
}

/**
 * The tool row's meta: the call's effect class, then the view its result
 * carries. Search and read are read-only by catalog (no escalation applies to
 * them), so their class is `read` before any result. A call that returned
 * nothing has no view; the label list is always structured.
 */
export function gmailRowMeta(result: GoogleToolResult | null): string {
  if (result === null) return "read";
  if (!result.ok) return "read · no result";
  return `read · ${result.result.view} view`;
}
