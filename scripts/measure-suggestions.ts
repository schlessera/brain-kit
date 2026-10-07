/** Keyless instruments for #550; both live harnesses use these prompts and rules. */
import {
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  type Block,
} from "@schlessera/brain-ui-sdk/server";
import { calibrate, shareDefinitions, variantsOf, type JsonObject } from "./attribute-show-block-schema.ts";

export const SUGGESTION_ARMS = ["rule", "no-rule"] as const;
export type SuggestionArm = (typeof SUGGESTION_ARMS)[number];
export const SUGGESTION_PROMPTS = [
  { id: "note-approaches", group: "answer", text: "Compare daily journal entries, topic notes and project notes for organizing a personal knowledge base. Give the strengths and trade-offs of each." },
  { id: "raft-plan", group: "answer", text: "Summarise the raft project in this brain and identify its next concrete step." },
  { id: "journal-pattern", group: "answer", text: "Read the journal in this brain and explain one recurring theme, with evidence from the entries." },
  { id: "note-choice", group: "question", text: "Help me choose between daily journal entries and topic notes. Explain the trade-off, then end your answer by asking me one question to decide between them." },
  { id: "raft-question", group: "question", text: "Read the raft project in this brain. Explain the next decision, then end your answer by asking me one question about it." },
  { id: "journal-question", group: "question", text: "Read the journal in this brain. Explain one recurring theme, then end your answer by asking me one question to reflect on it." },
] as const;

export function suggestionDescription(arm: SuggestionArm): string {
  const lines = SHOW_BLOCK_DESCRIPTION.split("\n");
  if (lines.filter((line) => line.startsWith("suggestions:")).length !== 1) {
    throw new Error("Expected exactly one suggestions: description line; the measurement needs updating.");
  }
  return (arm === "rule" ? lines : lines.filter((line) => !line.startsWith("suggestions:"))).join("\n");
}

export type SuggestionBlock = Extract<Block, { kind: "suggestions" }>;
export type DropReason = "empty" | "duplicate" | "user-prompt" | "filler";
export interface SuggestionObservation {
  block: SuggestionBlock;
  kept: SuggestionBlock["items"];
  dropped: Array<{ label: string; reason: DropReason }>;
}

function fold(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}
const FILLER = new Set(["Tell me more", "Anything else?", "Can you elaborate?", "What else?"].map(fold));

/** Parse first, then apply #40's client drop rules in the client's order. */
export function observeSuggestions(input: unknown, userPrompt: string): SuggestionObservation | null {
  const parsed = SHOW_BLOCK_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success || parsed.data.block.kind !== "suggestions") return null;
  const block = parsed.data.block;
  const kept: SuggestionBlock["items"] = [];
  const dropped: SuggestionObservation["dropped"] = [];
  const seen = new Set<string>();
  for (const item of block.items) {
    const key = fold(item.label);
    let reason: DropReason | undefined;
    if (!key) reason = "empty";
    else if (seen.has(key)) reason = "duplicate";
    else {
      seen.add(key);
      if (key === fold(userPrompt)) reason = "user-prompt";
      else if (FILLER.has(key)) reason = "filler";
    }
    if (reason) dropped.push({ label: item.label, reason });
    else kept.push(item);
  }
  return { block, kept, dropped };
}

export function answerEndsInQuestion(parts: readonly string[]): boolean {
  const last = parts.findLast((text) => text.trim());
  return last !== undefined && /\?[\s"'”’)\]*_`]*$/u.test(last);
}

export interface SuggestionTurn {
  arm: SuggestionArm;
  prompt: string;
  group: "answer" | "question";
  answerParts: string[];
  suggestions: SuggestionObservation[];
  completed: boolean;
}

/** Complete turns only; a call counts only after a successful schema parse. */
export function suggestionSummary(turns: readonly SuggestionTurn[]) {
  return SUGGESTION_ARMS.map((arm) => {
    const all = turns.filter((turn) => turn.arm === arm);
    const counted = all.filter((turn) => turn.completed);
    const rate = (list: SuggestionTurn[]) => ({
      turns: list.length,
      called: list.filter((turn) => turn.suggestions.length > 0).length,
    });
    const observations = counted.flatMap((turn) => turn.suggestions);
    const emitted = observations.reduce((sum, call) => sum + call.block.items.length, 0);
    const drops = { empty: 0, duplicate: 0, "user-prompt": 0, filler: 0 };
    for (const call of observations) for (const item of call.dropped) drops[item.reason]++;
    return {
      arm, excluded: all.length - counted.length,
      answers: rate(counted.filter((turn) => turn.group === "answer")),
      questionPrompts: rate(counted.filter((turn) => turn.group === "question")),
      questionEndings: rate(counted.filter((turn) => answerEndsInQuestion(turn.answerParts))),
      emitted, drops,
    };
  });
}

export function suggestionReport(turns: readonly SuggestionTurn[]): string {
  const rate = ({ called, turns }: { called: number; turns: number }) =>
    `${called}/${turns} (${turns ? (100 * called / turns).toFixed(1) + "%" : "not measured"})`;
  const rows = suggestionSummary(turns);
  const lines = [
    "## Suggestions (#550)", "",
    "Calls count only after parsing. Failed/incomplete turns and server turns that left the corpus are excluded. Rates are per turn, including a valid call whose items all drop. Question-ending rate uses the actual last non-empty text part; question-prompt rate separately shows whether the prompted condition occurred.", "",
    "| arm | answer prompts | question prompts | answers ending in a question | excluded |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.arm} | ${rate(row.answers)} | ${rate(row.questionPrompts)} | ${rate(row.questionEndings)} | ${row.excluded} |`), "",
    "Drops are per emitted item across every accepted suggestions call, in client order. Empty normalized labels take precedence, then duplicates, a repeated user prompt, and filler. Only the last accepted call can supply the closing row.", "",
    "| arm | emitted items | empty label | duplicate | user prompt | filler | total dropped |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const dropped = Object.values(row.drops).reduce((sum, n) => sum + n, 0);
      return `| ${row.arm} | ${row.emitted} | ${row.drops.empty} | ${row.drops.duplicate} | ${row.drops["user-prompt"]} | ${row.drops.filler} | ${dropped}/${row.emitted} (${row.emitted ? (100 * dropped / row.emitted).toFixed(1) + "%" : "not measured"}) |`;
    }), "",
    "### Transcripts for quality review", "",
    "Review each kept item as a concrete answer-grounded next step or filler. These are the last accepted call's survivors before other visibility suppression; an answer ending in a question hides the row. No automatic quality verdict is inferred.", "",
  ];
  for (const [index, turn] of turns.entries()) {
    if (!turn.completed) continue;
    const kept = turn.suggestions.at(-1)?.kept ?? [];
    if (!kept.length) continue;
    lines.push(`#### ${index + 1}: ${turn.arm}`, "", `Prompt: ${turn.prompt}`, "", turn.answerParts.join("\n\n"), "",
      `Row suppressed by question ending: ${answerEndsInQuestion(turn.answerParts) ? "yes" : "no"}`, "",
      ...kept.map((item) => `- ${item.label}`), "");
  }
  return lines.join("\n");
}

/** D47 arithmetic over the listed schema, with and without the suggestions variant. */
export function suggestionSchemaCost(schema: JsonObject) {
  const variants = variantsOf(schema);
  const without = variants.filter((variant) =>
    (variant as { properties?: { kind?: { const?: string } } }).properties?.kind?.const !== "suggestions");
  if (variants.length - without.length !== 1) throw new Error("Expected exactly one suggestions schema variant.");
  const baseline = structuredClone(schema);
  (baseline.properties as JsonObject).block = {
    ...((baseline.properties as JsonObject).block as JsonObject), oneOf: without,
  };
  const chars = (value: unknown) => JSON.stringify(value).length;
  const calibration = calibrate();
  const range = (n: number) => [Math.round(n * calibration.low), Math.round(n * calibration.high)];
  const descriptionChars = chars(suggestionDescription("rule")) - chars(suggestionDescription("no-rule"));
  const flatChars = chars(schema) - chars(baseline);
  const sharedChars = chars(shareDefinitions(schema)) - chars(shareDefinitions(baseline));
  return { descriptionChars, flatChars, sharedChars,
    estimatedDescriptionTokens: range(descriptionChars),
    estimatedFlatTokens: range(flatChars), estimatedSharedTokens: range(sharedChars) };
}
