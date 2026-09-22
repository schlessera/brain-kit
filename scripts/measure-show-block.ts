/**
 * Measure the `show_block` call rate on the Claude backend, with and without
 * the tool's per-turn brief.
 *
 * Issue #45 asked whether the brief still earns its line budget now that the
 * classification pass (D42) catches the common case structurally. That is a
 * question about live model behaviour, so it is measured, not argued: this
 * harness runs the same prompts through the same Claude Agent SDK options the
 * backend builds, once with `tools.block` set — which is what puts the brief
 * in the system prompt — and once with it unset while the tool stays
 * registered and allowed. The only difference between the two arms is the
 * brief; the tool description the model reads is byte-identical in both.
 *
 * It needs `ANTHROPIC_API_KEY` and the network, so it is a script and not a
 * test: CI never runs it. Re-run it before changing the brief again.
 *
 *   bun scripts/measure-show-block.ts --reps 3 --out runs.json --md report.md
 *
 * Each turn's text parts are also run through `planClassification` — the same
 * entry point `ui-server` calls, keyless up to the classifier request — so the
 * report says how many of the turns that did NOT call the tool left a
 * candidate the pass would have asked about. Detection is necessary but not
 * sufficient: the pass still needs the classifier to clear its confidence
 * gate, so a candidate is an upper bound on what the pass would have swapped.
 * That pair of numbers is what the keep-or-retire decision rests on.
 */

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createSdkMcpServer, query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  buildSystemPromptAppend,
  planClassification,
  SHOW_BLOCK_CONTRACT,
  type ClientEnvironment,
} from "@schlessera/brain-ui-sdk/server";

// The backend's own tool factory and visible name, so the description the
// model reads here is the one it reads in production rather than a copy that
// can drift, and the name matched in the stream is the one the backend
// computes rather than a hand-spelled prefix.
import {
  createShowBlockTool,
  SHOW_BLOCK_TOOL_NAME as BLOCK_TOOL,
} from "../packages/ui-backend-claude/src/show-block-tool.js";

/**
 * Pinned rather than left to the CLI default, so a later re-run compares
 * against the same model this measurement was taken on.
 */
const MODEL = "claude-sonnet-5";

/**
 * The brain the turns run against: a COPY of the repo's keyless fixture
 * corpus, placed outside this checkout.
 *
 * The copy is not tidiness. `settingSources: ["project"]` walks up from the
 * cwd for project settings, so running in place puts brain-kit's own
 * `CLAUDE.md` / `AGENTS.md` in front of the model and the first pilot answers
 * came back reasoning about this repo's Bun conventions. A brain is a content
 * repo, not this source tree, and the measurement has to see the same thing a
 * reader's deployment does.
 */
function stageBrain(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "show-block-brain-")), "brain");
  cpSync(
    new URL("../packages/core/fixtures/corpus/", import.meta.url).pathname,
    dir,
    { recursive: true }
  );
  return dir;
}

const BRAIN_PATH = stageBrain();

/**
 * The device paragraph is part of every real turn and it says "a phone held
 * one-handed", which is exactly the pressure the brief's column advice is
 * about. Holding it fixed keeps the two arms comparable.
 */
const CLIENT: ClientEnvironment = {
  formFactor: "phone",
  standalone: true,
  touch: true,
  camera: true,
  microphone: true,
  geolocation: true,
  share: true,
  shareFiles: true,
  viewportWidth: 390,
  locale: "en-GB",
  timeZone: "Europe/Berlin",
};

const TURN_BUDGET_MS = 180_000;

/**
 * Which block kinds the classification pass can reach on its own, from
 * `packages/ui-sdk/src/classification/catalogue.ts`: a detected markdown
 * structure is transformed into one of these. The other three kinds in the
 * union — `trend`, `bars`, `contact` — have no markdown shape the detector
 * looks for, so the tool call is the only path to them. The prompt set below
 * covers both groups, because "what does the brief uniquely buy" is the whole
 * question.
 */
const CLASSIFIABLE_KINDS = [
  "comparison",
  "table",
  "steps",
  "timeline",
  "schedule",
  "quote",
  "receipt",
  "stats",
] as const;

/**
 * Prompts, each labelled with the block kind it is shaped to invite and
 * whether the classification pass could reach that kind without the tool. The
 * first four are wave 13's originals, kept verbatim so the two measurements
 * can be read side by side. The rest widen the sample to the kinds the pass
 * reaches and to the ones it cannot.
 */
const PROMPTS: readonly {
  id: string;
  invites: string;
  /** True when the pass can produce this kind from typed markdown. */
  classifiable: boolean;
  text: string;
}[] = [
  {
    id: "compare-short",
    invites: "comparison",
    classifiable: true,
    text: "Compare Bun and Node.js as a runtime for a small CLI tool. Keep it short.",
  },
  {
    id: "compare-long",
    invites: "comparison",
    classifiable: true,
    text: "Compare Bun and Node.js as a runtime for a small CLI tool.",
  },
  {
    id: "trend",
    invites: "trend",
    classifiable: false,
    text: "How did the number of notes in this brain trend over the months it covers?",
  },
  {
    id: "contact",
    invites: "contact",
    classifiable: false,
    text: "Who is the person this brain belongs to?",
  },
  {
    id: "recommend",
    invites: "comparison + recommended column",
    classifiable: true,
    text: "I have to pick one note-taking approach for the next year: daily journal entries, topic notes, or project notes. Compare them and tell me which one you recommend.",
  },
  {
    id: "table",
    invites: "table",
    classifiable: true,
    text: "List the projects in this brain with their status and what each one is waiting on.",
  },
  {
    id: "steps",
    invites: "steps",
    classifiable: true,
    text: "What are the steps to add a new note to this brain and get it indexed?",
  },
  {
    id: "quote",
    invites: "quote",
    classifiable: true,
    text: "Find the single sentence in this brain that best states what its owner cares about, and show me the exact words with where they came from.",
  },
  {
    id: "bars",
    invites: "bars",
    classifiable: false,
    text: "Across this whole brain, what share of the notes belongs to each top-level area?",
  },
];

type ArmName = "brief" | "no-brief";

const ARMS: readonly ArmName[] = ["brief", "no-brief"];

interface TurnResult {
  prompt: string;
  invites: string;
  classifiable: boolean;
  arm: ArmName;
  rep: number;
  /** How many times the model called `show_block`, and with which kinds. */
  calls: number;
  kinds: string[];
  /** Candidate kinds `planClassification` found across the turn's text parts. */
  candidates: string[];
  answerChars: number;
  durationMs: number;
  /** What this turn cost, as the SDK priced it. Summed into the report. */
  costUsd: number;
  /** The answer as the reader would have seen it, for the transcript. */
  answer: string;
  error?: string;
}

function optionsFor(arm: ArmName): Options {
  return {
    cwd: BRAIN_PATH,
    model: MODEL,
    settingSources: ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPromptAppend({
        client: CLIENT,
        turnBudgetMs: TURN_BUDGET_MS,
        // The one difference between the arms. `false` drops the brief from
        // the prompt; the tool below is registered and allowed either way,
        // which is exactly the "retire the brief, keep the tool" shape.
        tools: { block: arm === "brief" && BLOCK_TOOL },
      }),
    },
    // Read-only retrieval plus the block tool. Narrower than the real
    // backend's allowlist, which also carries writes and Bash — neither is
    // reachable by these prompts, and keeping them out bounds the run.
    allowedTools: ["Read", "Glob", "Grep", BLOCK_TOOL],
    // One answer, not an investigation: enough turns to read the corpus and
    // reply, few enough that a wandering run cannot stall the measurement.
    maxTurns: 14,
    disallowedTools: ["AskUserQuestion", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
    permissionMode: "bypassPermissions",
    mcpServers: {
      "brain-ui": createSdkMcpServer({
        name: "brain-ui",
        version: "0.1.0",
        tools: [createShowBlockTool()],
      }),
    },
  };
}

async function runTurn(
  prompt: (typeof PROMPTS)[number],
  arm: ArmName,
  rep: number
): Promise<TurnResult> {
  const started = Date.now();
  const kinds: string[] = [];
  // One entry per contiguous assistant text run, which is how `ui-server`'s
  // collector numbers parts — joining them first would let two structures on
  // either side of a tool call merge into a candidate neither one is.
  const textParts: string[] = [];
  let costUsd = 0;
  let error: string | undefined;
  try {
    for await (const message of query({
      prompt: prompt.text,
      options: optionsFor(arm),
    })) {
      if (message.type === "assistant") {
        for (const part of message.message.content) {
          if (part.type === "text") textParts.push(part.text);
          if (part.type === "tool_use" && part.name === BLOCK_TOOL) {
            const input = part.input as { block?: { kind?: unknown } };
            kinds.push(String(input?.block?.kind ?? "unknown"));
          }
        }
      }
      if (message.type === "result") {
        costUsd = message.total_cost_usd;
        if (message.subtype !== "success") error = message.subtype;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const plan = planClassification(textParts);
  return {
    prompt: prompt.id,
    invites: prompt.invites,
    classifiable: prompt.classifiable,
    arm,
    rep,
    calls: kinds.length,
    kinds,
    candidates: (plan?.candidates ?? []).map((planned) => planned.candidate.kind),
    answerChars: textParts.join("").length,
    durationMs: Date.now() - started,
    costUsd,
    answer: textParts.join("\n\n"),
    ...(error ? { error } : {}),
  };
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]!
    : fallback;
}

/**
 * What the brief costs, counted by the API rather than estimated: the same
 * system-prompt append with and without the block line, priced by
 * `count_tokens`. The keep-or-retire trade needs both halves to be real.
 */
async function briefCost(apiKey: string): Promise<{
  lines: number;
  chars: number;
  tokens: number;
}> {
  const append = (block: string | false) =>
    buildSystemPromptAppend({ client: CLIENT, turnBudgetMs: TURN_BUDGET_MS, tools: { block } });
  const withBrief = append(BLOCK_TOOL);
  const without = append(false);
  const count = async (system: string): Promise<number> => {
    const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        system,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { input_tokens: number }).input_tokens;
  };
  const brief = SHOW_BLOCK_CONTRACT.brief(BLOCK_TOOL);
  return {
    lines: brief.split("\n").length,
    chars: withBrief.length - without.length,
    tokens: (await count(withBrief)) - (await count(without)),
  };
}

/** Run `tasks` with at most `limit` in flight, preserving input order. */
async function pool<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
  onDone: (result: T, index: number) => void
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      const result = await task();
      results[index] = result;
      onDone(result, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function pct(part: number, whole: number): string {
  return `${((part / Math.max(whole, 1)) * 100).toFixed(0)}%`;
}

function armRows(runs: readonly TurnResult[]): string[] {
  const rows = ["| arm | turns | turns with a `show_block` call | rate | no call, but a candidate the pass would see |", "| --- | --- | --- | --- | --- |"];
  for (const arm of ARMS) {
    const mine = runs.filter((run) => run.arm === arm);
    const called = mine.filter((run) => run.calls > 0);
    const missed = mine.filter((run) => run.calls === 0 && run.candidates.length > 0);
    rows.push(
      `| ${arm} | ${mine.length} | ${called.length} | ${pct(called.length, mine.length)} | ${missed.length} (${pct(missed.length, mine.length)}) |`
    );
  }
  return rows;
}

function promptRows(runs: readonly TurnResult[]): string[] {
  const rows = [
    "| prompt | invites | pass can reach it | brief: calls/turns | no-brief: calls/turns |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const prompt of PROMPTS) {
    const cell = (arm: ArmName): string => {
      const mine = runs.filter((run) => run.prompt === prompt.id && run.arm === arm);
      const called = mine.filter((run) => run.calls > 0);
      const kinds = [...new Set(called.flatMap((run) => run.kinds))];
      return `${called.length}/${mine.length}${kinds.length ? ` (${kinds.join(", ")})` : ""}`;
    };
    rows.push(
      `| \`${prompt.id}\` | ${prompt.invites} | ${prompt.classifiable ? "yes" : "no"} | ${cell("brief")} | ${cell("no-brief")} |`
    );
  }
  return rows;
}

function splitRows(runs: readonly TurnResult[]): string[] {
  const rows = [
    "| kinds the pass can reach | turns | calls | rate |",
    "| --- | --- | --- | --- |",
  ];
  for (const arm of ARMS) {
    for (const classifiable of [true, false]) {
      const mine = runs.filter((run) => run.arm === arm && run.classifiable === classifiable);
      const called = mine.filter((run) => run.calls > 0);
      rows.push(
        `| ${classifiable ? "yes" : "no"} — ${arm} | ${mine.length} | ${called.length} | ${pct(called.length, mine.length)} |`
      );
    }
  }
  return rows;
}

function report(
  runs: readonly TurnResult[],
  cost: { lines: number; chars: number; tokens: number },
  reps: number
): string {
  const errors = runs.filter((run) => run.error);
  return [
    "# `show_block` rate with the classification pass on",
    "",
    `Model \`${MODEL}\`, ${new Set(runs.map((run) => run.prompt)).size} prompts x ${ARMS.length} arms x ${reps} reps = ${runs.length} live turns, $${runs.reduce((sum, run) => sum + run.costUsd, 0).toFixed(2)} of API spend.`,
    `Brain: a copy of \`packages/core/fixtures/corpus/\`. Harness: \`scripts/measure-show-block.ts\`.`,
    `Taken ${new Date().toISOString().slice(0, 10)}.`,
    "",
    `The brief costs **${cost.tokens} input tokens** (${cost.lines} lines, ${cost.chars} characters) on every turn.`,
    "",
    "## Rate per arm",
    "",
    ...armRows(runs),
    "",
    "## Split by whether the classification pass can reach the kind",
    "",
    `The pass reaches ${CLASSIFIABLE_KINDS.join(", ")}. It cannot reach \`trend\`, \`bars\` or \`contact\`: no markdown shape maps to them.`,
    "",
    ...splitRows(runs),
    "",
    "## Per prompt",
    "",
    ...promptRows(runs),
    "",
    errors.length
      ? `## Errors\n\n${errors.map((run) => `- \`${run.prompt}\` ${run.arm} rep${run.rep}: ${run.error}`).join("\n")}`
      : "No turn errored.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error(
      `${basename(import.meta.path)}: needs ANTHROPIC_API_KEY — this is a live measurement, not a test.`
    );
    process.exit(1);
  }
  const reps = Number(arg("reps", "3"));
  const concurrency = Number(arg("concurrency", "4"));
  const only = arg("only", "");
  const out = arg("out", "");
  const md = arg("md", "");
  const prompts = only ? PROMPTS.filter((p) => only.split(",").includes(p.id)) : PROMPTS;

  const tasks: (() => Promise<TurnResult>)[] = [];
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const arm of ARMS) {
      for (const prompt of prompts) tasks.push(() => runTurn(prompt, arm, rep));
    }
  }

  const done: TurnResult[] = [];
  const runs = await pool(tasks, concurrency, (result) => {
    done.push(result);
    console.log(
      `[${done.length}/${tasks.length}] ${result.arm}\trep${result.rep}\t${result.prompt}\tcalls=${result.calls}${result.kinds.length ? `(${result.kinds.join(",")})` : ""}\tcandidates=${result.candidates.join(",") || "-"}\t${result.durationMs}ms${result.error ? `\tERROR ${result.error}` : ""}`
    );
    if (out) void Bun.write(out, JSON.stringify(done, null, 2));
  });

  if (out) await Bun.write(out, JSON.stringify(runs, null, 2));
  const text = report(runs, await briefCost(apiKey), reps);
  if (md) await Bun.write(md, text);
  console.log(`\n${text}`);
}

await main();
