/**
 * The read codecs (#4205): Odysseus fixtures shaped like gog v0.48.1's JSON
 * decode into the records of #4203, strictly; anything else is a shape error.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentGmailThread, gmailLabelDirectory, structuredGmailDraft, structuredGmailLabels, structuredGmailMessageResult,
} from "@schlessera/brain-common/internal/google-operations";
import {
  decodeGogDraft, decodeGogLabels, decodeGogMessage, decodeGogSearchIds, decodeGogThread, GogShapeError, searchHitFromThread,
} from "../src/google/gog/codecs.ts";
import { decodeBase64Url, decodeHtmlEntities, htmlToText, unwrapGogUntrusted } from "../src/google/gog/payload.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/gog", name), "utf8"));
const shapeError = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof GogShapeError) return error.path;
    throw error;
  }
};
const clone = <T>(value: T): T => structuredClone(value);

describe("thread", () => {
  test("decodes every message, headers, text bodies, attachments and dates", () => {
    const hall = decodeGogThread(fixture("thread-hall.json"));
    expect(hall.id).toBe("19a0c3d2e4f50601");
    expect(hall.messages.map(message => message.id)).toEqual(["19a0c3d2e4f50601", "19a0c3d2e4f50602"]);
    expect(hall.messages[0]).toEqual({
      id: "19a0c3d2e4f50601", thread_id: "19a0c3d2e4f50601", label_ids: ["INBOX", "CATEGORY_PERSONAL"],
      internal_date: "2026-07-12T08:15:00.000Z", size_estimate: 4521,
      from: "Penelope <penelope@example.com>", to: "Odysseus <odysseus@example.com>", cc: null, bcc: null, reply_to: null,
      subject: "Suitors at the hall", date: "Sun, 12 Jul 2026 08:15:00 +0000",
      snippet: "Dearest, the suitors feast again in the hall. I unravel the shroud each night & wait.",
      body_text: "Dearest, the suitors feast again in the hall.\nI unravel the shroud each night & wait.\n",
      attachments: [],
    });
    expect(hall.messages[1]).toMatchObject({ cc: "Odysseus <odysseus@example.com>", label_ids: ["INBOX", "UNREAD", "Label_12"], body_text: "Mother, I will sail to Pylos for news of him.\n" });
  });

  test("an HTML-only body becomes text, an encoded-word subject is decoded, an attachment is metadata only", () => {
    const [swine] = decodeGogThread(fixture("thread-swine.json")).messages;
    expect(swine!.subject).toBe("Swine count — July");
    expect(swine!.body_text).toBe("Master,\nThe herd counts 360 boars & 600 sows.");
    expect(swine!.attachments).toEqual([{ filename: "herd.csv", mime_type: "text/csv", size: 2048 }]);
  });

  test("a search hit is the union of the thread's labels and its newest message's headers", () => {
    const hit = searchHitFromThread(decodeGogThread(fixture("thread-hall.json")));
    expect(hit).toEqual({
      thread_id: "19a0c3d2e4f50601", message_count: 2, label_ids: ["INBOX", "CATEGORY_PERSONAL", "UNREAD", "Label_12"],
      latest_internal_date: "2026-07-12T09:40:00.000Z", size_estimate: 6731, has_attachment: false,
      from: "Telemachus <telemachus@example.com>", to: "Penelope <penelope@example.com>", cc: "Odysseus <odysseus@example.com>",
      subject: "Re: Suitors at the hall", snippet: "Mother, I will sail to Pylos for news of him.",
    });
  });

  test("its records project through #4203's content view unchanged", () => {
    const projected = contentGmailThread(decodeGogThread(fixture("thread-hall.json")), { labels: gmailLabelDirectory(decodeGogLabels(fixture("labels-list.json"))) });
    expect(projected?.messages.map(message => message.message_id)).toEqual(["19a0c3d2e4f50601", "19a0c3d2e4f50602"]);
    expect(projected?.messages[1]!.labels).toContainEqual({ id: "Label_12", name: "Ithaca/Household" });
    expect(projected?.messages[1]!.untrusted.from).toBe("Telemachus <telemachus@example.com>");
  });
});

describe("message, labels, search and raw draft", () => {
  test("a message read decodes from gog's message, and checks gog's flattened copies", () => {
    const message = decodeGogMessage(fixture("message-get.json"));
    expect(message).toMatchObject({ id: "19a0c3d2e4f50602", subject: "Re: Suitors at the hall", label_ids: ["INBOX", "UNREAD", "Label_12"] });
    expect(structuredGmailMessageResult(message)?.message).toMatchObject({ message_id: "19a0c3d2e4f50602", unread: true, starred: false });
  });

  test("the label list, with counts absent from a list call", () => {
    const labels = decodeGogLabels(fixture("labels-list.json"));
    expect(labels.map(label => [label.id, label.name])).toEqual([
      ["INBOX", "INBOX"], ["UNREAD", "UNREAD"], ["STARRED", "STARRED"], ["CATEGORY_PERSONAL", "CATEGORY_PERSONAL"], ["Label_12", "Ithaca/Household"],
    ]);
    expect(labels[4]).toMatchObject({ messages_total: null, threads_unread: null });
    expect(structuredGmailLabels(labels).labels).toHaveLength(5);
    expect(decodeGogLabels({ labels: null })).toEqual([]);
  });

  test("a search page is its thread ids and next page token", () => {
    expect(decodeGogSearchIds(fixture("search-ids.json"))).toEqual({ thread_ids: ["19a0c3d2e4f50601", "19a0c3d2e4f50700"], next_page_token: "09876543210987654321" });
    expect(decodeGogSearchIds(fixture("search-empty.json"))).toEqual({ thread_ids: [], next_page_token: null });
  });

  test("a raw draft keeps its exact bytes, which the send card's parser reads", async () => {
    const json = fixture("draft-raw.json");
    const read = await decodeGogDraft(json);
    expect(read.raw).toEqual(decodeBase64Url(json.draft.message.raw));
    expect(read.parsed).toMatchObject({ html_part: false, attachment: false, unreadable_headers: false, unreadable_body: false, problems: [] });
    expect(read.parsed?.to.map(mailbox => mailbox.address)).toEqual(["penelope@example.com"]);
    expect(read.draft).toMatchObject({
      id: "r-1234567890123456789",
      message: { id: "19a0c3d2e4f50800", thread_id: "19a0c3d2e4f50601", from: "Odysseus <odysseus@example.com>", to: "Penelope <penelope@example.com>",
        subject: "Re: Suitors at the hall", body_text: "I am on my way home. Keep weaving.\n", attachments: [], label_ids: ["DRAFT"] },
    });
    expect(structuredGmailDraft(read.draft)?.message).toMatchObject({ message_id: "19a0c3d2e4f50800", has_attachment: false });
    expect(await decodeGogDraft({ draft: { id: "r-1234567890123456789" } })).toEqual({ draft: { id: "r-1234567890123456789", message: null }, raw: null, parsed: null });
  });
});

describe("strictness", () => {
  test("gog's envelopes have exactly their keys", () => {
    expect(shapeError(() => decodeGogThread({ ...fixture("thread-hall.json"), attachments: [] }))).toBe("$.attachments");
    expect(shapeError(() => decodeGogThread({ thread: fixture("thread-hall.json").thread }))).toBe("$.downloaded");
    expect(shapeError(() => decodeGogMessage({ message: fixture("message-get.json").message }))).toBe("$.headers");
    expect(shapeError(() => decodeGogLabels({ labels: [], nextPageToken: "" }))).toBe("$.nextPageToken");
    expect(shapeError(() => decodeGogSearchIds({ threads: [{ id: "19a0c3d2e4f50601", snippet: "x" }], nextPageToken: "" }))).toBe("$.threads[0].snippet");
    expect(shapeError(() => decodeGogSearchIds({ threads: [] }))).toBe("$.nextPageToken");
    expect(shapeError(() => decodeGogThread([]))).toBe("$");
  });

  test("every field read has its type", () => {
    const cases: [string, (thread: { thread: { messages: Record<string, unknown>[] } }) => void][] = [
      ["$.thread.messages[0].id", thread => { thread.thread.messages[0]!.id = 7; }],
      ["$.thread.messages[0].labelIds[0]", thread => { thread.thread.messages[0]!.labelIds = [null]; }],
      ["$.thread.messages[0].internalDate", thread => { thread.thread.messages[0]!.internalDate = 1783844100000; }],
      ["$.thread.messages[0].sizeEstimate", thread => { thread.thread.messages[0]!.sizeEstimate = "4521"; }],
      ["$.thread.messages[0].payload.headers[0].value", thread => { (thread.thread.messages[0]!.payload as { headers: { value: unknown }[] }).headers[0]!.value = ["Penelope"]; }],
      ["$.thread.messages[0].payload.parts[0].body.data", thread => { (thread.thread.messages[0]!.payload as { parts: { body: { data: string } }[] }).parts[0]!.body.data = "not base64url!"; }],
      ["$.thread.messages[0].threadId", thread => { delete thread.thread.messages[0]!.threadId; }],
    ];
    for (const [path, edit] of cases) {
      const json = clone(fixture("thread-hall.json"));
      edit(json);
      expect(shapeError(() => decodeGogThread(json)), path).toBe(path);
    }
  });

  test("a field Google adds to its own resources is ignored", () => {
    const json = clone(fixture("thread-hall.json"));
    json.thread.messages[0].classificationLabelValues = [{ labelId: "x" }];
    json.thread.messages[0].payload.partHint = "new";
    expect(decodeGogThread(json).messages[0]!.id).toBe("19a0c3d2e4f50601");
  });

  test("a part tree too deep is refused rather than walked", () => {
    const json = clone(fixture("thread-hall.json"));
    let part: Record<string, unknown> = { mimeType: "text/plain", body: { size: 0 } };
    for (let depth = 0; depth < 40; depth++) part = { mimeType: "multipart/mixed", parts: [part] };
    json.thread.messages[0].payload = part;
    expect(shapeError(() => decodeGogThread(json))).toStartWith("$.thread.messages[0].payload");
  });

  test("a raw draft whose raw is not base64url, or absent, is a shape error", async () => {
    const json = clone(fixture("draft-raw.json"));
    json.draft.message.raw = "%%%";
    await expect(decodeGogDraft(json)).rejects.toThrow(GogShapeError);
    delete json.draft.message.raw;
    await expect(decodeGogDraft(json)).rejects.toThrow(GogShapeError);
  });
});

describe("text helpers", () => {
  test("gog's untrusted-content markers are removed if a later default adds them", () => {
    const wrapped = "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>\nSource: google_api\n---\nSuitors at the hall\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>";
    expect(unwrapGogUntrusted(wrapped)).toBe("Suitors at the hall");
    expect(unwrapGogUntrusted("<<<EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>\nSource: x\n---\nA\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"fedcba9876543210\">>>")).toStartWith("<<<");
    const json = clone(fixture("thread-hall.json"));
    json.thread.messages[0].payload.headers[2].value = wrapped;
    expect(decodeGogThread(json).messages[0]!.subject).toBe("Suitors at the hall");
  });

  test("entities, HTML and base64url", () => {
    expect(decodeHtmlEntities("Ithaca &amp; Pylos &#39;72&#x21; &unknown;")).toBe("Ithaca & Pylos '72! &unknown;");
    expect(htmlToText("<style>p{}</style><p>One<br>two</p><div>three &lt;3</div><!-- x -->")).toBe("One\ntwo\nthree <3");
    expect(new TextDecoder().decode(decodeBase64Url("SXRoYWNh")!)).toBe("Ithaca");
    expect(decodeBase64Url("SXRoYWNh-_")).not.toBeNull();
    expect(decodeBase64Url("SXRoYWNh+/")).toBeNull();
  });
});
