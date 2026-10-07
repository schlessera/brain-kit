import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SHOW_BLOCK_DESCRIPTION } from "../packages/ui-sdk/src/tool-contracts/blocks.ts";
import { keptSuggestions, endsWithQuestion } from "../packages/ui-react/src/lib/answer-suggestions.ts";
import type { ChatMessage } from "../packages/ui-react/src/stores/chat-state.ts";
import { SUGGESTION_PROMPTS, observeSuggestions, suggestionDescription, suggestionReport, suggestionSummary, suggestionSchemaCost, answerEndsInQuestion, type SuggestionTurn } from "../scripts/measure-suggestions.ts";
import type { JsonObject } from "../scripts/attribute-show-block-schema.ts";

const input = (...labels: string[]) => ({ block: { kind: "suggestions", items: labels.map((label) => ({ label })) } });

function turn(overrides: Partial<SuggestionTurn> = {}): SuggestionTurn {
  return { arm: "rule", prompt: "Plan a raft", group: "answer", answerParts: ["Measure the space."], suggestions: [], completed: true, ...overrides };
}

describe("#550's shared prompt set", () => {
  test("pins three answer prompts and three question controls", () => {
    expect(SUGGESTION_PROMPTS.map(({ id, group }) => [id, group])).toEqual([
      ["note-approaches", "answer"], ["raft-plan", "answer"], ["journal-pattern", "answer"],
      ["note-choice", "question"], ["raft-question", "question"], ["journal-question", "question"],
    ]);
    expect(SUGGESTION_PROMPTS.map(({ text }) => text)).toEqual([
      "Compare daily journal entries, topic notes and project notes for organizing a personal knowledge base. Give the strengths and trade-offs of each.",
      "Summarise the raft project in this brain and identify its next concrete step.",
      "Read the journal in this brain and explain one recurring theme, with evidence from the entries.",
      "Help me choose between daily journal entries and topic notes. Explain the trade-off, then end your answer by asking me one question to decide between them.",
      "Read the raft project in this brain. Explain the next decision, then end your answer by asking me one question about it.",
      "Read the journal in this brain. Explain one recurring theme, then end your answer by asking me one question to reflect on it.",
    ]);
  });
});

describe("parsed calls and client drops", () => {
  test("invalid calls never count, including a third item and a line break", () => {
    for (const bad of [input("one"), input("First step", "Second step", "Third step"), input("First\nstep"), { block: { kind: "suggestions", items: [{ label: 42 }] } }]) {
      expect(observeSuggestions(bad, "question")).toBeNull();
    }
    expect(observeSuggestions(input("Plan the next step"), "question")?.block.items).toHaveLength(1);
  });

  test("counts each drop rule in client order, with populated survivors", () => {
    const cases = [
      { labels: ["Measure the shelf", "MEASURE the shelf!"], prompt: "question", reason: "duplicate" },
      { labels: ["Plan the shelf", "Choose the timber"], prompt: "Plan the shelf?", reason: "user-prompt" },
      { labels: ["Tell me more.", "Choose the timber"], prompt: "question", reason: "filler" },
    ] as const;
    for (const { labels, prompt, reason } of cases) {
      const observed = observeSuggestions(input(...labels), prompt)!;
      expect(observed.block.items).toHaveLength(2);
      expect(observed.dropped).toHaveLength(1);
      expect(observed.dropped[0].reason).toBe(reason);
      expect(observed.kept).toHaveLength(1);
      expect(observed.kept).toEqual(keptSuggestions(observed.block, prompt));
    }
    const allDropped = observeSuggestions(input("Tell me more", "TELL ME MORE!"), "Tell me more")!;
    expect(allDropped.dropped.map(({ reason }) => reason)).toEqual(["user-prompt", "duplicate"]);
    expect(allDropped.kept).toEqual(keptSuggestions(allDropped.block, "Tell me more"));
  });

  test("uses the client's actual final text-part question rule", () => {
    for (const parts of [["Do you agree?**", "  "], ["A question?", "The final answer."], ["Which step?\""], []]) {
      const message = { parts: parts.map((text) => ({ kind: "text", text })) } as ChatMessage;
      expect(answerEndsInQuestion(parts)).toBe(endsWithQuestion(message));
    }
    expect(answerEndsInQuestion(["A question?", "The final answer."])).toBe(false);
    expect(answerEndsInQuestion(["Which step?**", "  "])).toBe(true);
  });

  test("empty normalized labels drop before duplicate or user-prompt checks", () => {
    const observed = observeSuggestions(input("!!!!!!!!", "????????"), "Plan the raft")!;
    expect(observed.block.items).toHaveLength(2);
    expect(observed.kept).toEqual([]);
    expect(observed.kept).toEqual(keptSuggestions(observed.block, "Plan the raft"));
    expect(observed.dropped.map(({ reason }) => reason)).toEqual(["empty", "empty"]);
    expect(observeSuggestions(input("!!!!!!!!", "????????"), "!!!!!!!!")!.dropped.map(({ reason }) => reason)).toEqual(["empty", "empty"]);
    const summary = suggestionSummary([turn({ suggestions: [observed] })])[0];
    expect(summary.answers).toEqual({ called: 1, turns: 1 });
    expect(summary.emitted).toBe(2);
    expect(summary.drops).toEqual({ empty: 2, duplicate: 0, "user-prompt": 0, filler: 0 });
    expect(suggestionReport([turn({ suggestions: [observed] })])).toContain("2/2 (100.0%)");
  });

  test("reports rates only over completed turns and keeps question controls separate", () => {
    const parsed = observeSuggestions(input("Choose the timber"), "Plan a raft")!;
    const turns = [turn({ suggestions: [parsed] }), turn(),
      turn({ group: "question", answerParts: ["Which timber?"], suggestions: [parsed] }),
      turn({ group: "question", answerParts: ["Choose pine."] }),
      turn({ completed: false, suggestions: [parsed] }),
      turn({ arm: "no-rule" })];
    const [rule, noRule] = suggestionSummary(turns);
    expect(rule.answers).toEqual({ called: 1, turns: 2 });
    expect(rule.questionPrompts).toEqual({ called: 1, turns: 2 });
    expect(rule.questionEndings).toEqual({ called: 1, turns: 1 });
    expect(rule.excluded).toBe(1);
    expect(rule.emitted).toBe(2);
    expect(noRule.answers).toEqual({ called: 0, turns: 1 });
    const report = suggestionReport(turns);
    expect(report).toContain("1/2 (50.0%)");
    expect(report).toContain("Choose the timber");
    expect(report).toContain("Row suppressed by question ending: yes");
  });

  test("a call still counts when all its items drop; only the last call supplies the review row", () => {
    const filler = observeSuggestions(input("Anything else?"), "question")!;
    const earlier = observeSuggestions(input("Measure the shelf"), "question")!;
    const turns = [turn({ suggestions: [earlier, filler] })];
    expect(suggestionSummary(turns)[0].answers).toEqual({ called: 1, turns: 1 });
    expect(suggestionSummary(turns)[0].drops.filler).toBe(1);
    expect(suggestionSummary(turns)[0].emitted).toBe(2);
    expect(suggestionReport(turns)).not.toContain("- Measure the shelf");
  });
});

describe("the arms that the two backends actually load", () => {
  async function inspect(arm: "rule" | "no-rule") {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../scripts/measure-suggestions-preload.ts"),
      join(import.meta.dir, "../scripts/measure-show-block-server.ts"), "--inspect-suggestions"], {
      env: { ...process.env, BRAIN_MEASURE_SUGGESTIONS_ARM: arm }, stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, errors).toBe(0);
    return JSON.parse(output);
  }
  test("lists identical schemas and executes the real handlers with only one description line changed", async () => {
    const rule = await inspect("rule");
    const noRule = await inspect("no-rule");
    for (const backend of ["claude", "pi"]) {
      expect(rule[backend].description).toBe(SHOW_BLOCK_DESCRIPTION);
      expect(noRule[backend].description).toBe(suggestionDescription("no-rule"));
      expect(noRule[backend].description).not.toContain("\nsuggestions:");
      expect(rule[backend].inputSchema).toEqual(noRule[backend].inputSchema);
      expect(JSON.stringify(rule[backend].inputSchema)).toContain('"suggestions"');
    }
    expect(rule.claudeResult.isError).toBeUndefined();
    expect(JSON.parse(rule.claudeResult.content[0].text).block.kind).toBe("suggestions");
    expect(noRule.claudeResult).toEqual(rule.claudeResult);
    expect(noRule.piResult).toEqual(rule.piResult);
    expect(rule.piResult.details.block.kind).toBe("suggestions");
    const cost = suggestionSchemaCost(rule.claude.inputSchema as JsonObject);
    expect(cost.descriptionChars).toBe(336);
    expect(cost.flatChars).toBe(866);
    expect(cost.sharedChars).toBe(709);
  });
});

test("the server instrument counts parsed top-level calls over a real socket", async () => {
  const { runOnce, observedRuntimeVersions } = await import("../scripts/measure-show-block-server.ts");
  const { createApp } = await import("../packages/ui-server/src/app.ts");
  const { resolveServerConfig } = await import("../packages/ui-server/src/config/env.ts");
  const { createStaticBackendRegistry } = await import("../packages/ui-server/src/agent/backend.ts");
  const { makeFakeBackend } = await import("../packages/ui-server/tests/helpers/fake-backend.ts");
  const { createRecordingObservability } = await import("../packages/ui-server/src/observability/index.ts");
  const backend = makeFakeBackend({ id: "fake", startTurn: async (req) => {
    const sessionId = req.prompt.includes("fail") ? "failed" : "complete";
    const emit = req.bridge.emit;
    emit({ type: "session_info", sessionId, isNew: true, providerId: "fake" });
    req.bridge.activity?.({ kind: "runtime_observed", runtime: { name: "fixture-runtime", version: "1.2.3" }, sdk: { name: "fixture-sdk", version: "4.5.6" }, credential: { account: "fictional-private-account" }, billing: "unknown" });
    emit({ type: "text_delta", sessionId, text: "Measure the wall first." });
    for (const call of [
      { id: "valid", input: input("Plan the shelf", "Tell me more"), isError: false },
      { id: "subagent", input: input("Subagent suggestion"), isError: false, parentToolUseId: "agent" },
      { id: "unparsed", input: input("one"), isError: false },
      { id: "rejected", input: input("Rejected suggestion"), isError: true },
    ]) {
      emit({ type: "tool_use_complete", sessionId, toolUseId: call.id, toolName: "show_block", input: call.input,
        ...("parentToolUseId" in call ? { parentToolUseId: call.parentToolUseId } : {}) });
      emit({ type: "tool_result", sessionId, toolUseId: call.id, isError: call.isError, output: JSON.stringify(call.input) });
    }
    emit({ type: "result", sessionId, outcome: sessionId === "failed" ? "error" : "success", isError: sessionId === "failed", durationMs: 1, numTurns: 1 });
  } });
  const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: ":memory:", BRAIN_PATH: "/tmp/fictional-brain", BRAIN_UI_COASTLINE: "0", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" });
  const app = await createApp({ config, dbPath: ":memory:", registry: createStaticBackendRegistry([backend], "fake"), observability: createRecordingObservability() });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  try {
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const complete = await runOnce(url, "fake", "/tmp/fictional-brain", "show_block", 0, 0, "Plan the shelf", "rule");
    expect(complete.completed).toBe(true);
    const versions = observedRuntimeVersions(app.db, complete.result?.sessionId);
    expect(versions).toEqual({ "fixture-runtime": "1.2.3", "fixture-sdk": "4.5.6" });
    expect(JSON.stringify(versions)).not.toContain("account");
    expect(complete.suggestionTurn?.suggestions).toHaveLength(1);
    const observed = complete.suggestionTurn!.suggestions[0];
    expect(observed.block.items).toHaveLength(2);
    expect(observed.dropped.map(({ reason }) => reason)).toEqual(["user-prompt", "filler"]);
    expect(complete.suggestionTurn?.answerParts).toEqual(["Measure the wall first."]);
    const failed = await runOnce(url, "fake", "/tmp/fictional-brain", "show_block", 0, 1, "fail this turn", "rule");
    expect(failed.completed).toBe(false);
    expect(failed.suggestionTurn?.suggestions).toHaveLength(1);
    const [summary] = suggestionSummary([complete.suggestionTurn!, failed.suggestionTurn!]);
    expect(summary.answers).toEqual({ called: 1, turns: 1 });
    expect(summary.excluded).toBe(1);
  } finally {
    server.stop(true);
    await app.close();
  }
});
