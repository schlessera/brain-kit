/**
 * Ithaca's Gmail, for the host Gmail tool tests (#4207): a fake gog scenario
 * built from the common gog fixtures (Odysseus mail on example.com, shaped
 * from gog 0.48's output, never copied from a real account).
 *
 * - The hall thread (`19a0c3d2e4f50601`): Penelope's message (INBOX,
 *   CATEGORY_PERSONAL) and its reply `19a0c3d2e4f50602` (INBOX, UNREAD and the
 *   owner's `Label_12`, "Ithaca/Household"). The draft `r-1234567890123456789`
 *   replies in it.
 * - The swine thread (`19a0c3d2e4f50700`): one message, INBOX and STARRED.
 * - A search for anything returns both threads and a next page token.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FakeGogScenario } from "../../../common/tests/support/fake-gog.ts";

const FIXTURES = resolve(import.meta.dir, "../../../common/tests/fixtures/gog");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

export const HALL = "19a0c3d2e4f50601";
export const HALL_REPLY = "19a0c3d2e4f50602";
export const SWINE = "19a0c3d2e4f50700";
export const DRAFT = "r-1234567890123456789";
export const MISSING = "19a0c3d2e4f5ffff";
/** Words only the hall thread's text holds: a structured result must never carry them. */
export const HALL_TEXT = ["Suitors at the hall", "penelope@example.com"];

export function ithacaMail(): FakeGogScenario {
  return {
    "gmail.search": { stdout: fixture("search-ids.json") },
    [`gmail.thread.get ${HALL}`]: { stdout: fixture("thread-hall.json") },
    [`gmail.thread.get ${SWINE}`]: { stdout: fixture("thread-swine.json") },
    [`gmail.thread.get ${MISSING}`]: { exit: 5 },
    [`gmail.get ${HALL_REPLY}`]: { stdout: fixture("message-get.json") },
    [`gmail.get ${MISSING}`]: { exit: 5 },
    [`gmail.drafts.get ${DRAFT}`]: { stdout: fixture("draft-raw.json") },
    "gmail.labels.list": { stdout: fixture("labels-list.json") },
  };
}

/** A governance policy file's front matter enabling Gmail for the alias `ithaca`, with optional extra keys. */
export function ithacaPolicy(options: { hidden?: string[]; extra?: string } = {}): string {
  return [
    "google:",
    "  enabled: true",
    "  account: ithaca",
    "  services: [gmail]",
    ...(options.hidden ? ["  gmail:", `    hidden_labels: [${options.hidden.join(", ")}]`] : []),
    ...(options.extra ? [options.extra] : []),
  ].join("\n");
}

/**
 * The reply `19a0c3d2e4f50602` with a text body of `chars` characters,
 * longer than the model's 32 KiB cap: Telemachus's account of the voyage,
 * one numbered line after another, the last one marked.
 */
export function longLetter(chars: number): { text: string; answer: { stdout: unknown } } {
  const lines: string[] = [];
  for (let line = 1; lines.join("\n").length < chars; line++) lines.push(`Day ${line}: the ship holds its course for Pylos.`);
  const text = `${lines.join("\n").slice(0, chars - 18)}\nThe end of Pylos.`;
  const message = fixture("message-get.json") as { body?: string; message: { sizeEstimate: number; payload: { body: { data: string; size: number } } } };
  const bytes = new TextEncoder().encode(text);
  message.message.payload.body = { data: Buffer.from(bytes).toString("base64url"), size: bytes.length };
  message.message.sizeEstimate = bytes.length + 1024;
  message.body = text;
  return { text, answer: { stdout: message } };
}
