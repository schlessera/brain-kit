import { describe, expect, test } from "bun:test";
import {
  composeHandoffText,
  parseHandoffText,
} from "../src/protocol.js";
import { parseClientMessage, parseServerMessage } from "../src/schemas.js";

const SUMMARY = "Odysseus is sailing home.\n\nPenelope keeps the house.";

describe("handoff text (#61)", () => {
  test("the destination's first message is exactly the summary plus a references block, and splits back", () => {
    const text = composeHandoffText(SUMMARY, ["plans/ithaca.md", "people/penelope.md"]);
    expect(text).toBe(`${SUMMARY}\n\nReferences:\n- plans/ithaca.md\n- people/penelope.md`);
    expect(parseHandoffText(text)).toEqual({ summary: SUMMARY, references: ["plans/ithaca.md", "people/penelope.md"] });
  });

  test("no references means the summary alone, unchanged", () => {
    expect(composeHandoffText(SUMMARY, [])).toBe(SUMMARY);
    expect(parseHandoffText(SUMMARY)).toEqual({ summary: SUMMARY, references: [] });
  });

  test("a summary that merely mentions the heading keeps all of its text", () => {
    const text = `${SUMMARY}\n\nReferences:\nsee the harbour log`;
    expect(parseHandoffText(text)).toEqual({ summary: text, references: [] });
  });
});

describe("handoff frames at the boundary", () => {
  const chat = (handoff: unknown) => JSON.stringify({ type: "chat_message", text: SUMMARY, providerId: "pi", handoff });

  test("a handoff chat_message keeps its key, source and references", () => {
    const parsed = parseClientMessage(chat({ handoffId: "h-ithaca-0001", sourceSessionId: "s1", references: ["plans/ithaca.md"] }));
    expect(parsed.ok && parsed.message.type === "chat_message" && parsed.message.handoff).toEqual({
      handoffId: "h-ithaca-0001", sourceSessionId: "s1", references: ["plans/ithaca.md"],
    });
  });

  test("refuses a key that could break out of an id, and more references than the limit", () => {
    expect(parseClientMessage(chat({ handoffId: "h ithaca", sourceSessionId: "s1", references: [] })).ok).toBe(false);
    expect(parseClientMessage(chat({ handoffId: "short", sourceSessionId: "s1", references: [] })).ok).toBe(false);
    const many = Array.from({ length: 9 }, (_, i) => `notes/${i}.md`);
    expect(parseClientMessage(chat({ handoffId: "h-ithaca-0001", sourceSessionId: "s1", references: many })).ok).toBe(false);
  });

  test("prepare, cancel and status parse; an older source value from a newer peer reads as absent", () => {
    for (const frame of [
      { type: "handoff_prepare", handoffId: "h-ithaca-0001-p1", sourceSessionId: "s1", turns: 3 },
      { type: "handoff_prepare_cancel", handoffId: "h-ithaca-0001-p1" },
      { type: "handoff_status", handoffId: "h-ithaca-0001" },
    ]) expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(true);
    const parsed = parseClientMessage(JSON.stringify({ type: "chat_message", text: "x", source: "carrier-pigeon" }));
    expect(parsed.ok && parsed.message.type === "chat_message" && parsed.message.source).toBeUndefined();
  });

  test("a draft longer than the limit is refused rather than truncated silently", () => {
    expect(parseServerMessage(JSON.stringify({ type: "handoff_draft", handoffId: "h1", state: "ready", text: "x".repeat(4001) })).ok).toBe(false);
  });
});
