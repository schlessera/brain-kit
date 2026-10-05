import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/stores/chat-state.js";
import { countTurns, deterministicDraft, markerPosition, mentionedPaths, snapshotSource, suggestedReferences } from "../src/lib/handoff.js";

let id = 0;
function msg(role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${++id}`, role, content, toolCalls: [], parts: [], isStreaming: false, timestamp: 0, ...extra };
}

describe("snapshot at the latest settled turn (#61 §3)", () => {
  test("a running reply and the ask that started it are left out, and keep running", () => {
    const messages = [msg("user", "Plan the return."), msg("assistant", "Sail past the Sirens."), msg("user", "And Scylla?"), msg("assistant", "Hug the", { isStreaming: true })];
    const snapshot = snapshotSource({ messages, isStreaming: true });
    expect(snapshot.running).toBe(true);
    expect(snapshot.messages.map((m) => m.content)).toEqual(["Plan the return.", "Sail past the Sirens."]);
  });

  test("after a history reload, the host's running state still excludes the running turn", () => {
    // Replayed messages are never marked streaming.
    const messages = [msg("user", "Plan the return."), msg("assistant", "Sirens first."), msg("user", "Chart the strait."), msg("assistant", "Reading the chart")];
    const snapshot = snapshotSource({ messages, isStreaming: false }, "streaming");
    expect(snapshot.running).toBe(true);
    expect(snapshot.messages.map((m) => m.content)).toEqual(["Plan the return.", "Sirens first."]);
    expect(snapshotSource({ messages, isStreaming: false }, "idle").messages).toHaveLength(4);
  });

  test("turns and marker positions count asks, not assistant steps", () => {
    const messages = [msg("user", "a"), msg("assistant", "b"), msg("assistant", "c"), msg("user", "d"), msg("assistant", "e")];
    expect(countTurns(messages)).toBe(2);
    expect(markerPosition(messages, 1)).toBe(3);
    expect(markerPosition(messages, 2)).toBe(5);
    expect(markerPosition(messages, undefined)).toBe(5);
  });

  test("pending approvals are counted where they stay", () => {
    const tool = { id: "t", name: "Write", input: {}, inputJson: "{}", status: "pending_approval" as const };
    const snapshot = snapshotSource({ messages: [msg("user", "Write it."), msg("assistant", "", { toolCalls: [tool] })], isStreaming: false });
    expect(snapshot.pendingApprovals).toBe(1);
    expect(snapshot.messages).toHaveLength(2);
  });
});

describe("the deterministic fallback draft (R1/R2)", () => {
  test("the last six settled messages: asks verbatim, each reply's first paragraph", () => {
    const messages = [
      msg("user", "Too old to include."),
      msg("assistant", "Also too old."),
      msg("user", "Plan the return to Ithaca."),
      msg("assistant", "Sail past the Sirens.\n\nThen Scylla, then the cattle of the sun."),
      msg("user", "Who keeps the house?"),
      msg("assistant", "Penelope."),
      msg("user", "And the suitors?"),
      msg("assistant", "They wait in the hall."),
    ];
    const draft = deterministicDraft(messages);
    expect(draft).toBe([
      "Asked: Plan the return to Ithaca.",
      "Answer: Sail past the Sirens.",
      "Asked: Who keeps the house?",
      "Answer: Penelope.",
      "Asked: And the suitors?",
      "Answer: They wait in the hall.",
    ].join("\n\n"));
    expect(draft).not.toContain("Too old");
    expect(draft).not.toContain("cattle");
  });

  test("is held to the 4000-character limit", () => {
    expect(deterministicDraft([msg("user", "x".repeat(5000))]).length).toBe(4000);
  });
});

describe("suggested references", () => {
  test("brain paths from text and tool inputs, newest first, never external links", () => {
    const tool = { id: "t", name: "Read", input: { path: "people/penelope.md" }, inputJson: "", status: "complete" as const };
    const messages = [
      msg("user", "See plans/ithaca.md and https://example.com/odyssey.md please."),
      msg("assistant", "Read it.", { toolCalls: [tool] }),
    ];
    expect(suggestedReferences(messages)).toEqual(["people/penelope.md", "plans/ithaca.md"]);
    expect(mentionedPaths("read notes about ithaca.md now")).toEqual(["ithaca.md"]);
  });

  test("at most eight", () => {
    const text = Array.from({ length: 12 }, (_, i) => `notes/n${i}.md`).join(" ");
    expect(suggestedReferences([msg("user", text)])).toHaveLength(8);
  });
});
