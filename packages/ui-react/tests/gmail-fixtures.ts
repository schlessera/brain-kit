// Gmail tool results in the Odyssey world (#4210): complete payloads the
// #4207 result schemas accept, in the shape the host sends them, so a test
// can only exercise what the host really sends. Odysseus's mailbox on Ogygia,
// the week before the pinned morning (2026-07-12). Every address is on
// example.com or a reserved `.example` domain, every instant is a literal,
// and every hidden character is spelled as an escape.

import {
  GMAIL_TOOL_NAMES,
  GOOGLE_RESULT_SCHEMAS,
  type GmailContentMessagePayload,
  type GmailMessageBody,
  type GmailStructuredMessagePayload,
  type GoogleToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";

export const SESSION = "session-odysseus";

const L = {
  inbox: { id: "INBOX", name: "INBOX" },
  unread: { id: "UNREAD", name: "UNREAD" },
  starred: { id: "STARRED", name: "STARRED" },
  important: { id: "IMPORTANT", name: "IMPORTANT" },
  family: { id: "Label_1", name: "Family" },
  raft: { id: "Label_5", name: "Raft" },
  voyage: { id: "Label_3", name: "Voyage" },
} as const;

export const PENELOPE = "Penelope <penelope@example.com>";
export const ODYSSEUS = "Odysseus <odysseus@example.com>";
export const CALYPSO = "Calypso <calypso@example.com>";
export const HERMES = "Hermes <hermes@olympus.example>";

// ---------------------------------------------------------------- the raft

/** Calypso's tally of the raft, one numbered line per log, exactly `length` characters. */
function tally(length: number): string {
  let out = "";
  for (let log = 1; out.length < length; log++) out += `Log ${log}: cut on the point, dried, and lashed to the raft.\n`;
  return out.slice(0, length);
}

/** Only in the part of the letter Brain did not read: if it shows up anywhere else, the rest leaked. */
export const REST_MARK = "The raft is finished. Calypso has turned away; the wind is fair for Scheria.";

/** The whole letter, as the display route returns it: 39,000 characters of tally and then the last line. */
export const RAFT_FULL = `${tally(39_000)}\n${REST_MARK}`;
/** What the model read: the host cuts a message at 32,768 characters. */
export const RAFT_SHOWN = RAFT_FULL.slice(0, 32_768);

export const THREAD = "19a1c0de0f2b4a01";
export const RAFT = "19a1c6f2a19c7c03";

const structured = (over: Partial<GmailStructuredMessagePayload> & Pick<GmailStructuredMessagePayload, "message_id" | "internal_date">): GmailStructuredMessagePayload => ({
  thread_id: THREAD,
  labels: [L.inbox, L.raft],
  size_bucket: "under_10kb",
  unread: false,
  starred: false,
  has_attachment: false,
  attachment_count: 0,
  ...over,
});

/** A message's untrusted part; an uncut body's length is its own, as the host counts it. */
const untrusted = (over: Partial<GmailContentMessagePayload["untrusted"]>): GmailContentMessagePayload["untrusted"] => ({
  body_length: over.body_text === undefined || over.body_text === null ? null : over.body_text.length,
  from: null,
  to: ODYSSEUS,
  cc: null,
  bcc: null,
  reply_to: null,
  subject: "The raft",
  date: null,
  snippet: null,
  body_text: null,
  body_truncated: false,
  attachments: [],
  ...over,
});

/** The raft thread, oldest first: Hermes's order, Calypso's answer, and her tally, which the host cut. */
export const raftMessages: GmailContentMessagePayload[] = [
  {
    ...structured({ message_id: THREAD, internal_date: "2026-07-05T07:30:00Z" }),
    untrusted: untrusted({
      from: HERMES,
      to: CALYPSO,
      cc: ODYSSEUS,
      date: "Sun, 5 Jul 2026 09:30:00 +0200",
      snippet: "Zeus says the man goes home. Let him build his raft.",
      body_text: "Zeus says the man goes home. Let him build his raft.\n\nHermes",
    }),
  },
  {
    ...structured({ message_id: "19a1c3a77d0e5b02", internal_date: "2026-07-06T18:15:00Z", labels: [L.inbox, L.important, L.raft] }),
    untrusted: untrusted({
      from: CALYPSO,
      to: ODYSSEUS,
      subject: "Re: The raft",
      date: "Mon, 6 Jul 2026 20:15:00 +0200",
      snippet: "The bronze axe is by the cave mouth. Take the poplars on the point; they are dry.",
      body_text: [
        "The bronze axe is by the cave mouth. Take the poplars on the point; they are dry.",
        '<img src="https://tracker.example/pixel.gif" onerror="window.__pwned = true">',
      ].join("\n"),
    }),
  },
  {
    ...structured({ message_id: RAFT, internal_date: "2026-07-11T16:02:00Z", labels: [L.inbox, L.unread, L.starred, L.raft, L.voyage], unread: true, starred: true, size_bucket: "under_100kb" }),
    untrusted: untrusted({
      from: CALYPSO,
      to: ODYSSEUS,
      subject: "Re: The raft",
      date: "Sat, 11 Jul 2026 18:02:00 +0200",
      snippet: "Log 1: cut on the point, dried, and lashed to the raft.",
      body_text: RAFT_SHOWN,
      body_truncated: true,
      body_length: RAFT_FULL.length,
    }),
  },
];

/** The same messages as the structured view carries them: no sender, no subject, no body. */
export const raftStructured: GmailStructuredMessagePayload[] = raftMessages.map(({ untrusted: _untrusted, ...message }) => message);

/** What the detail route answers for the cut tally. */
export const raftBody = (over: Partial<GmailMessageBody> = {}): GmailMessageBody => ({
  message_id: RAFT,
  body_text: RAFT_FULL,
  body_length: RAFT_FULL.length,
  body_truncated: false,
  ...over,
});

// ------------------------------------------------------------------ search

const hit = {
  thread_id: THREAD,
  message_count: 3,
  labels: [L.inbox, L.unread, L.raft, L.voyage],
  latest_internal_date: "2026-07-11T16:02:00Z",
  size_bucket: "under_1mb" as const,
  unread: true,
  starred: true,
  has_attachment: false,
};

export const structuredHits = [
  hit,
  { ...hit, thread_id: "19a1b97e44c0aa12", message_count: 2, labels: [L.inbox, L.family], latest_internal_date: "2026-07-09T19:40:00Z", size_bucket: "under_10kb" as const, unread: false, starred: false },
  { ...hit, thread_id: "19a1a4410d5ce803", message_count: 1, labels: [L.inbox, L.family], latest_internal_date: "2026-07-08T05:15:00Z", size_bucket: "under_10kb" as const, unread: false, starred: false, has_attachment: true },
];

/** A sender's subject with a right-to-left override in it, spelled as an escape. */
export const HIDDEN_SUBJECT = "Gifts for the queen\u{202E}txt.exe";

export const contentHits = [
  { ...structuredHits[0]!, untrusted: { from: CALYPSO, to: ODYSSEUS, cc: null, subject: "Re: The raft", snippet: "Log 1: cut on the point, dried, and lashed to the raft." } },
  { ...structuredHits[1]!, untrusted: { from: PENELOPE, to: ODYSSEUS, cc: null, subject: "The loom, again", snippet: "The suitors have noticed the shroud never grows." } },
  { ...structuredHits[2]!, untrusted: { from: "Antinous <antinous@example.com>", to: PENELOPE, cc: ODYSSEUS, subject: HIDDEN_SUBJECT, snippet: "A robe, twelve brooches and a necklace of amber." } },
];

export const CURSOR = "gc_Q2FseXBzbyBkb2VzIG5vdCB3ZWVw";

// ---------------------------------------------------------------- envelopes

type Tool = "search" | "read";

/** A tool result envelope, validated against the tool's real result schema. */
export function envelope(tool: Tool, result: unknown): GoogleToolResult {
  const name = GMAIL_TOOL_NAMES[tool];
  return GOOGLE_RESULT_SCHEMAS[name].parse({ ok: true, tool: name, result }) as GoogleToolResult;
}

export function refusal(tool: Tool, code: string, reason: string | null, message: string): GoogleToolResult {
  const name = GMAIL_TOOL_NAMES[tool];
  return GOOGLE_RESULT_SCHEMAS[name].parse({ ok: false, tool: name, error: { code, reason, message } }) as GoogleToolResult;
}

export const searchPage = (view: "structured" | "content", next: string | null = CURSOR) =>
  envelope("search", { kind: "search", view, threads: view === "structured" ? structuredHits : contentHits, next_cursor: next, result_size_estimate: 31 });

export const threadRead = (view: "structured" | "content") =>
  envelope("read", { kind: "thread", view, thread_id: THREAD, message_count: 3, messages: view === "structured" ? raftStructured : raftMessages });

export const messageRead = (view: "structured" | "content") =>
  envelope("read", { kind: "message", view, message: view === "structured" ? raftStructured[2] : raftMessages[2] });

export const labelsRead = () =>
  envelope("read", {
    kind: "labels",
    view: "structured",
    labels: [
      { id: "INBOX", name: "INBOX", type: "system", messages_total: 412, messages_unread: 9, threads_total: 300, threads_unread: 7 },
      { id: "Label_1", name: "Family", type: "user", messages_total: 88, messages_unread: 2, threads_total: 40, threads_unread: 1 },
      { id: "Label_5", name: "Raft", type: "user", messages_total: 12, messages_unread: 1, threads_total: 3, threads_unread: 1 },
    ],
  });

export const draftRead = () =>
  envelope("read", { kind: "draft", view: "content", draft_id: "r-1234567890123456789", message: { ...raftMessages[1]!, labels: [{ id: "DRAFT", name: "DRAFT" }] } });
