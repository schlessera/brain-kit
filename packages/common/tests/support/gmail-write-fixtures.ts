/** Odysseus-only fake answers. Write shapes: gog 44364d31,
 * internal/cmd/gmail_batch.go:130-137, gmail_drafts.go:682-698. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FakeGogScenario } from "./fake-gog.js";
export const FIRST = "19a0c3d2e4f50601", SECOND = "19a0c3d2e4f50602", DRAFT = "r-1234567890123456789";
export const fixture = (file: string) => JSON.parse(readFileSync(resolve(import.meta.dir, "../fixtures/gog", file + ".json"), "utf8"));
export function message(id = FIRST, labels = ["INBOX"]) {
  const value = fixture("message-get");
  value.message.id = id; value.message.threadId = FIRST; value.message.labelIds = labels;
  return value;
}
export function rawDraft(body = "The ship is ready.", subject = "Ithaca", to = "penelope@example.com") {
  const value = fixture("draft-raw");
  value.draft.message.raw = Buffer.from(`From: odysseus@example.com\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n`).toString("base64url");
  return value;
}
export function writesScenario(): FakeGogScenario {
  return { "auth.alias.list": { stdout: { aliases: { ithaca: "odysseus@example.com" } } },
    [`gmail.get ${FIRST}`]: { stdout: message(FIRST) }, [`gmail.get ${SECOND}`]: { stdout: message(SECOND, []) },
    [`gmail.thread.get ${FIRST}`]: { stdout: fixture("thread-hall") },
    "gmail.search": { stdout: { threads: [{ id: FIRST }], nextPageToken: "", count: 1, has_more: false } },
    "gmail.labels.list": { stdout: fixture("labels-list") },
    "gmail.batch.modify": { stdout: fixture("modify") },
    "gmail.drafts.create": { stdout: fixture("draft-save") }, "gmail.drafts.update": { stdout: fixture("draft-save") },
    [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft() } };
}
