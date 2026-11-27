/**
 * The Gmail payload mapping (#4210): every case of the pure pieces the cards
 * stand on. Dates in the reader's zone, structured items that carry nothing
 * a sender wrote, the prefix check on a full body, the route error each
 * detail state stands for, and the tool row's class and view.
 */
import { describe, expect, test } from "bun:test";
import { GMAIL_TOOL_NAMES, GOOGLE_ERROR_CODES, GOOGLE_RESULT_SCHEMAS, type GoogleErrorCode } from "@schlessera/brain-ui-sdk/tool-contracts";
import {
  contentMessage, contentThread, detailErrorState, gmailDate, gmailRowMeta, restOfBody, structuredMessage, structuredThread,
} from "../src/components/chat/renderers/gmail-mapping.js";
import {
  HIDDEN_ON_A_THREAD, HOSTILE_LINE, RAFT_FULL, RAFT_SHOWN, contentHits, draftRead, hostileMessageRead, labelsRead, messageRead, raftBody, raftMessages, refusal, searchPage, threadRead,
} from "./gmail-fixtures.js";

/** UTC+2, the fixtures' Ogygia. */
const OGYGIA = "Etc/GMT-2";
const MORNING = Date.parse("2026-07-12T04:40:00Z");

describe("recorded payloads", () => {
  test("every fixture parses against its tool's result schema unchanged", () => {
    const fixtures = [
      ["search", searchPage("structured")], ["search", searchPage("content")], ["search", searchPage("content", null)],
      ["read", threadRead("structured")], ["read", threadRead("content")], ["read", messageRead("structured")], ["read", messageRead("content")],
      ["read", labelsRead()], ["read", labelsRead(HIDDEN_ON_A_THREAD)], ["read", draftRead()], ["read", draftRead(HOSTILE_LINE)], ["read", hostileMessageRead()], ["read", refusal("read", "not_found", null, "No such Gmail thread, message or draft was found.")],
    ] as const;
    for (const [tool, fixture] of fixtures) {
      expect(GOOGLE_RESULT_SCHEMAS[GMAIL_TOOL_NAMES[tool]].parse(JSON.parse(JSON.stringify(fixture))), `${tool} ${JSON.stringify(fixture).slice(0, 60)}`).toEqual(fixture);
    }
  });
});

describe("gmailDate", () => {
  test.each([
    ["a message, with its time", "2026-07-11T16:02:00Z", true, { short: "Sat 11 Jul 18:02", full: "Saturday 11 July 2026, 18:02" }],
    ["a search row, the day only", "2026-07-11T16:02:00Z", false, { short: "Sat 11 Jul", full: "Saturday 11 July 2026, 18:02" }],
    ["late in UTC, the next day in the reader's zone", "2026-07-11T23:30:00Z", true, { short: "Sun 12 Jul 01:30", full: "Sunday 12 July 2026, 01:30" }],
    ["just after midnight reads 00, never 24", "2026-07-08T22:05:00Z", true, { short: "Thu 9 Jul 00:05", full: "Thursday 9 July 2026, 00:05" }],
    ["September in three letters", "2026-09-03T08:00:00Z", true, { short: "Thu 3 Sep 10:00", full: "Thursday 3 September 2026, 10:00" }],
    ["last year's mail names its year", "2025-07-11T16:02:00Z", true, { short: "Fri 11 Jul 2025 18:02", full: "Friday 11 July 2025, 18:02" }],
    ["an offset instant", "2026-07-11T18:02:00+02:00", false, { short: "Sat 11 Jul", full: "Saturday 11 July 2026, 18:02" }],
  ] as const)("%s", (_label, iso, time, expected) => {
    expect(gmailDate(iso, { time, timeZone: OGYGIA, now: MORNING })).toEqual({ ...expected, iso });
  });

  test("the year is the reader's: on New Year's Eve in UTC, the reader is already in the next year", () => {
    const now = Date.parse("2026-12-31T23:30:00Z");
    expect(gmailDate("2027-01-01T00:10:00Z", { time: true, timeZone: OGYGIA, now })?.short).toBe("Fri 1 Jan 02:10");
    expect(gmailDate("2026-12-31T20:00:00Z", { time: true, timeZone: OGYGIA, now })?.short).toBe("Thu 31 Dec 2026 22:00");
  });

  test("no time, or one that does not parse, is absent", () => {
    expect(gmailDate(null, { time: true, timeZone: OGYGIA, now: MORNING })).toBeNull();
    expect(gmailDate("the eleventh of July", { time: true, timeZone: OGYGIA, now: MORNING })).toBeNull();
  });
});

describe("structured items carry nothing a sender wrote", () => {
  const dateFor = (iso: string | null) => (iso ? { short: iso, full: iso, iso } : null);

  test("a content hit's structured facts have no untrusted part; its content form keeps exactly the five fields", () => {
    const hit = contentHits[2]!;
    const structured = structuredThread(hit, dateFor);
    expect(Object.keys(structured).sort()).toEqual(["date", "hasAttachment", "labels", "messageCount", "sizeBucket", "starred", "threadId", "unread"]);
    expect(structured).toMatchObject({ threadId: hit.thread_id, messageCount: 1, hasAttachment: true, starred: false });
    expect(contentThread(hit, dateFor).untrusted).toEqual(hit.untrusted);
  });

  test("a content message's structured facts have no untrusted part; its content form maps the body and attachments", () => {
    const message = { ...raftMessages[2]!, attachment_count: 1, has_attachment: true, untrusted: { ...raftMessages[2]!.untrusted, attachments: [{ filename: "raft.pdf", mime_type: "application/pdf", size: 2048 }] } };
    const structured = structuredMessage(message, dateFor);
    expect(Object.keys(structured).sort()).toEqual(["attachmentCount", "date", "hasAttachment", "labels", "messageId", "sizeBucket", "starred", "unread"]);
    expect(contentMessage(message, dateFor).untrusted).toEqual({
      from: "Calypso <calypso@example.com>", to: "Odysseus <odysseus@example.com>", cc: null, bcc: null, subject: "Re: The raft",
      snippet: "Log 1: cut on the point, dried, and lashed to the raft.", body: RAFT_SHOWN, bodyTruncated: true, bodyLength: RAFT_FULL.length,
      attachments: [{ filename: "raft.pdf", mimeType: "application/pdf", size: 2048 }],
    });
  });

  test("an absent flag or count stays absent, never false or zero", () => {
    const message = { ...raftMessages[0]!, unread: null, starred: null, has_attachment: null, attachment_count: null, size_bucket: null, internal_date: null };
    expect(structuredMessage(message, dateFor)).toMatchObject({ unread: null, starred: null, hasAttachment: null, attachmentCount: null, sizeBucket: null, date: null });
  });
});

describe("restOfBody", () => {
  test.each([
    ["the rest after what Brain read", RAFT_SHOWN, raftBody(), { rest: RAFT_FULL.slice(32_768), truncated: false }],
    ["the whole body when Brain read none of it", "", raftBody(), { rest: RAFT_FULL, truncated: false }],
    ["a null shown body counts as none", null, raftBody(), { rest: RAFT_FULL, truncated: false }],
    ["the display route's own cut is passed on", RAFT_SHOWN, raftBody({ body_truncated: true }), { rest: RAFT_FULL.slice(32_768), truncated: true }],
    ["a different first character", RAFT_SHOWN, raftBody({ body_text: `x${RAFT_FULL.slice(1)}` }), null],
    ["a different last character of what Brain read", RAFT_SHOWN, raftBody({ body_text: `${RAFT_SHOWN.slice(0, -1)}#${RAFT_FULL.slice(32_768)}` }), null],
    ["a shorter body", RAFT_SHOWN, raftBody({ body_text: RAFT_SHOWN.slice(0, 100) }), null],
    ["the same body: nothing is left to show", RAFT_SHOWN, raftBody({ body_text: RAFT_SHOWN }), null],
    ["no text body", RAFT_SHOWN, raftBody({ body_text: null }), null],
  ] as const)("%s", (_label, shown, body, expected) => {
    expect(restOfBody(shown, body)).toEqual(expected);
  });
});

describe("detailErrorState", () => {
  const expected: Record<GoogleErrorCode, ReturnType<typeof detailErrorState>> = {
    not_found: "gone",
    unavailable: "unavailable",
    transport_incompatible: "unavailable",
    policy_denied: "unavailable",
    rate_limited: "rate-limited",
    invalid_input: "error",
    approval_declined: "error",
    forbidden: "error",
    upstream_error: "error",
    draft_not_displayable: "error",
    draft_locked: "error",
    recording_unavailable: "error",
    outcome_unknown: "error",
    already_sent: "error",
  };

  test("every route code has its state", () => {
    expect(Object.keys(expected).sort()).toEqual([...GOOGLE_ERROR_CODES].sort());
    expect(Object.fromEntries(GOOGLE_ERROR_CODES.map((code) => [code, detailErrorState(code)]))).toEqual(expected);
  });
});

describe("gmailRowMeta", () => {
  test.each([
    ["no result yet", null, "read"],
    ["a structured search", searchPage("structured"), "read · structured view"],
    ["a content thread", threadRead("content"), "read · content view"],
    ["the label list", labelsRead(), "read · structured view"],
    ["a content draft", draftRead(), "read · content view"],
    ["a refusal", refusal("search", "unavailable", "not_connected", "Gmail is not connected."), "read · no result"],
    ["a refusal of input the host could not read, so never classified", refusal("read", "invalid_input", "id", "That is not a Gmail thread id."), "no result"],
  ] as const)("%s", (_label, result, meta) => {
    expect(gmailRowMeta(result)).toBe(meta);
  });
});
