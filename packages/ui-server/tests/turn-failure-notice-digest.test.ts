/**
 * A runtime stop notice (#3356) used to replay as the closing text of its
 * assistant message. Failure and turn records keyed by a transcript-prefix
 * digest before then must still join, so the digest hashes the notice where
 * its text used to be.
 */
import { describe, expect, test } from "bun:test";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { prefixDigest } from "../src/ws/turn-failures";

const user: SessionHistoryMessage = { role: "user", content: "Plan the voyage", toolCalls: [] };

describe("prefix digests across the runtime notice change", () => {
  test("a notice after a partial answer hashes as the text it replaced", () => {
    const before: SessionHistoryMessage[] = [user, { role: "assistant", content: "Before we sail: \n\nNo response requested.", toolCalls: [] }];
    const after: SessionHistoryMessage[] = [user, { role: "assistant", content: "Before we sail: ", toolCalls: [], runtimeNotice: { cause: "unspecified", message: "No response requested." } }];
    expect(prefixDigest(after, 1)).toBe(prefixDigest(before, 1));
  });

  test("a notice-only message hashes as the text it replaced", () => {
    const before: SessionHistoryMessage[] = [user, { role: "assistant", content: "API Error: Request was aborted.", toolCalls: [] }];
    const after: SessionHistoryMessage[] = [user, { role: "assistant", content: "", toolCalls: [], runtimeNotice: { cause: "aborted", message: "API Error: Request was aborted." } }];
    expect(prefixDigest(after, 1)).toBe(prefixDigest(before, 1));
  });

  test("a message without a notice hashes as before", () => {
    const messages: SessionHistoryMessage[] = [user, { role: "assistant", content: "Ithaca first.", toolCalls: [] }];
    expect(prefixDigest(messages, 1)).not.toBe(prefixDigest([user, { ...messages[1]!, content: "Ithaca first.\n\nNo response requested." }], 1));
  });
});
