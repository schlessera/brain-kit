// Measures how often a backend reaches for `show_block` (D41) and what the
// classification pass (D42) finds in the markdown it typed instead —
// through the running server, so any backend can be measured.
//
// This is the companion to `scripts/measure-show-block.ts`, not a duplicate
// of it. That one drives the Claude Agent SDK directly, which is what an A/B
// over the brief needs and what D43 was measured with; it cannot reach the pi
// backend, which has no Agent SDK. This one boots a real ui-server on
// loopback, drives it with the shipped client over a real socket, and counts
// what the reader would have seen, so `--backend pi` and `--backend claude`
// are the same measurement of two backends.
//
// Why a script and not a test: there is no keyless stand-in. The question is
// what a frontier model does with a tool it was merely told about, which only
// live turns answer. CI never runs this.
//
// Two modes:
//
//   bun scripts/measure-show-block-server.ts --brain <dir> --out runs.json \
//     [--backend pi|claude] [--model claude-sonnet-5] [--prompts 0,1,2,3] [--runs 6]
//   bun scripts/measure-show-block-server.ts --report runs.json [more.json …]
//
// Point `--brain` at a copy of a brain OUTSIDE any checkout of this repo.
// The agent's cwd is the brain, and a brain nested in the worktree lets the
// model walk up into the repo and answer about brain-kit instead of the
// corpus — measured on 2026-09-22, two pi answers cited `bun:sqlite` and
// `Bun.Glob` from AGENTS.md. The agent's shell is not confined to the brain
// either; the deployment container is that boundary, so a turn measured on a
// developer host can still wander, and `--report` says how many did.
//
// The counting follows D43's rules, so the two harnesses' numbers can be read
// side by side: a call counts only when the handler accepted its payload,
// frames a subagent produced are skipped, and a turn that did not complete is
// excluded from the rate rather than counted as one that declined to call.
//
// The classifier half needs `TYPESAFE_API_KEY`. Without it the pass is
// disabled and `--report` prints only the deterministic candidate yield,
// which is the half that depends on the backend.

import { resolve } from "node:path";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { BrainUiClient, type ServerMessage } from "@schlessera/brain-ui-sdk/client";

import { planClassification } from "../packages/ui-sdk/src/classification/request.ts";
import {
  SHOW_BLOCK_TOOL_NAME,
  visibleToolName,
  type ToolAdapter,
} from "../packages/ui-sdk/src/tool-contracts/index.ts";
import { createApp } from "../packages/ui-server/src/app.ts";
import { createRecordingObservability } from "../packages/ui-server/src/observability/index.ts";
import { TurnTextCollector } from "../packages/ui-server/src/classification/classify-turn.ts";
import { resolveServerConfig } from "../packages/ui-server/src/config/env.ts";

/**
 * 0-3 are the four prompts the Claude backend was measured with (#45), kept
 * verbatim so the two tables are comparable. 4-7 are ordinary brain
 * questions spanning the catalogue's other candidate kinds — an ordered
 * list, a list with times, a blockquote, a key-value run — so the
 * classification half has answers to walk. None of them names a block or a
 * tool: the question is whether the model reaches for one unprompted.
 */
/**
 * The kind the brief itself prescribes for each prompt, so a measurement can
 * score WHICH block was drawn and not only whether one was (#156). Taken
 * from `SHOW_BLOCK_CONTRACT.brief` clause by clause — "the reader is
 * choosing between options" is a `comparison`, "one figure over time" a
 * `trend`, "the answer is a person" a `contact`, "a procedure" `steps`,
 * "what is coming" a `schedule`, "the words themselves are the evidence" a
 * `quote`. `null` where the brief prescribes nothing single: prompt 7 asks
 * for a status, some materials and an audience, and no clause covers that,
 * so it is counted but not scored for correctness rather than being given an
 * invented right answer.
 */
const EXPECTED_KIND: Array<string | null> = [
  "comparison",
  "comparison",
  "trend",
  "contact",
  "steps",
  "schedule",
  "quote",
  null,
];

const PROMPTS = [
  "Compare Bun and Node.js as a runtime for a small CLI tool. Keep it short.",
  "Compare Bun and Node.js as a runtime for a small CLI tool.",
  "How did the number of notes in this brain trend over the last months? Show me the trend.",
  "Who is the person this brain belongs to?",
  "What are the steps in the bookshelf project, in order?",
  "What is coming up in this brain over the next few weeks?",
  "What is the most striking single sentence in the journal? Quote it.",
  "Summarise the trail signage project: status, materials and who it is for.",
];

/** One live turn, as recorded. */
interface RunRecord {
  promptIndex: number;
  prompt: string;
  runIndex: number;
  /**
   * One entry per `show_block` call. `ok` is the handler's verdict: the
   * payload is validated before it is echoed, so a call is not a block until
   * its result comes back without an error.
   */
  showBlockCalls: Array<{ kind: string | null; ok: boolean }>;
  toolNames: string[];
  /**
   * GFM tables the model typed — the behaviour the brief asks it not to.
   * `--report` recounts this from `textParts` rather than reading it back.
   */
  markdownTables: number;
  /** The assistant message's text parts, numbered as the client numbers them. */
  textParts: string[];
  /** Blocks the classification pass swapped in, when it ran at all. */
  messageBlocks: unknown[];
  /**
   * The pass's own record for this turn, read from the server's
   * instrumentation rather than inferred from the frames: with no key it is
   * absent, because the pass returns before recording.
   */
  classification: {
    outcome: string;
    candidates: number;
    blocks: number;
    durationMs: number;
  } | null;
  result: Record<string, unknown> | null;
  errors: string[];
  wallMs: number;
  /**
   * True when a tool argument named a home-directory path outside the brain —
   * the agent's shell left the corpus, so the answer is about something else
   * and the turn is not a measurement of this brain.
   */
  escapedBrain: boolean;
  /** The turn reached a successful `result`. Others are excluded from rates. */
  completed: boolean;
}

/**
 * A `/home/...` or `~/...` path in a tool argument, outside the brain. A
 * heuristic over what the model asked for, not a sandbox: it catches the
 * observed failure — the shell reaching a home directory — and does not see
 * a relative escape or a path that only appears in a tool's OUTPUT. It is
 * here to drop turns that answered about the wrong brain, not to confine
 * anything.
 *
 * The comparison is by directory boundary after normalisation, because a
 * plain prefix test puts `/home/x/brain-backup` inside `/home/x/brain` and
 * lets `/home/x/brain/../private` back out. It stays a heuristic, and its
 * failure mode is deliberately the loud one: a turn wrongly judged to have
 * escaped is EXCLUDED, and `--report` prints how many were, so an over-eager
 * rule shows up as a shrunken denominator rather than as a wrong rate.
 *
 * It reads a serialised blob of tool arguments, not a parsed command line, so
 * whitespace after the brain has to mean "the next shell argument" — which is
 * why `assertMeasurableBrainPath` refuses a brain whose own path contains
 * any. Without that precondition `<brain> copy/notes.md` and
 * `find <brain> -type f` are the same string with opposite answers.
 */
/**
 * A brain whose own path contains whitespace makes the escape rule
 * ambiguous, so it is refused rather than measured wrongly. Exported for the
 * gate test.
 */
export function assertMeasurableBrainPath(brainPath: string): void {
  if (/\s/.test(brainPath)) {
    throw new Error(
      `--brain ${JSON.stringify(brainPath)} contains whitespace. The escape rule reads` +
        " serialised tool arguments, where a space after the brain has to mean the next" +
        " shell argument, so a brain path with one cannot be judged. Copy the brain to a" +
        " path without whitespace."
    );
  }
}

/**
 * Where a path can end in a serialised tool argument: a separator, a quote,
 * whitespace, or shell punctuation. Stated as the delimiters rather than as
 * the name characters, because a name allowlist has to enumerate every
 * character a filename may hold — an ASCII one read `/home/x/brainé` as
 * `/home/x/brain` followed by a boundary, and so as the brain itself.
 */
const PATH_BOUNDARY = /[\s"'`\\,;:)\]}&|<>=]/;

export function escapesBrain(inputs: unknown[], brainPath: string): boolean {
  const brain = brainPath.startsWith("~") ? brainPath : resolve(brainPath);
  const text = JSON.stringify(inputs);
  for (const match of text.matchAll(/(?:~|\/home)\//g)) {
    const at = match.index;
    // Anchored against the brain STRING rather than a path parsed out of the
    // blob, so a brain whose name carries a space or a non-ASCII character is
    // still recognised as itself.
    if (text.startsWith(brain, at)) {
      const rest = text.slice(at + brain.length);
      const next = rest[0];
      // The brain's name has to end here: a character that could continue it
      // means this is a sibling, not the brain — `/home/x/brain-backup` is
      // not `/home/x/brain`.
      if (next === undefined || next === "/" || PATH_BOUNDARY.test(next)) {
        // Anything but a separator means the path IS the brain, quoted or
        // followed by another shell argument.
        if (next !== "/") continue;
        const tail = /^[^"'`\s\\]*/.exec(rest)?.[0] ?? "";
        const full = resolve(brain + tail);
        if (full === brain || full.startsWith(`${brain}/`)) continue;
      }
    }
    return true;
  }
  return false;
}

/**
 * The ambient variables that can redirect a turn without showing up in the
 * numbers: a different endpoint, a different credential store, a different
 * binary, or a classifier that was or was not asked. Presence only — these
 * are secrets or home paths, and a report gets pasted into issues.
 */
function redirectingEnvironment(): Record<string, boolean> {
  return {
    TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
    ANTHROPIC_BASE_URL: Boolean(process.env.ANTHROPIC_BASE_URL?.trim()),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    CLAUDE_CODE_OAUTH_TOKEN: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()),
    CLAUDE_CODE_PATH: Boolean(process.env.CLAUDE_CODE_PATH?.trim()),
    PI_CODING_AGENT_DIR: Boolean(process.env.PI_CODING_AGENT_DIR?.trim()),
  };
}

interface RunFile {
  backend: string;
  model: string;
  /** Set on runs recorded after 2026-09-22; absent on older files. */
  environment?: Record<string, boolean>;
  records: RunRecord[];
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/**
 * GFM tables the model typed, counted from the parsed markdown rather than
 * by pattern, one text part at a time. A regex over delimiter rows counts a
 * table inside a fenced code block, which draws nothing, and misses a
 * single-column one, whose delimiter row has no interior pipe. This is the
 * same parser the classification pass walks, over the same parts.
 */
const MARKDOWN = unified().use(remarkParse).use(remarkGfm);

export function countMarkdownTables(...parts: string[]): number {
  interface Node {
    type: string;
    children?: Node[];
  }
  let tables = 0;
  const walk = (node: Node): void => {
    if (node.type === "table") tables++;
    for (const child of node.children ?? []) walk(child);
  };
  // Per part, never over the join: a tool call between prose and a table
  // makes them two parts, and gluing them together turns the table's header
  // row into the end of a paragraph, so the table the reader saw disappears.
  for (const part of parts) walk(MARKDOWN.parse(part) as unknown as Node);
  return tables;
}

async function measure(): Promise<void> {
  const brainPath = flag("brain");
  const outPath = flag("out");
  if (!brainPath || !outPath) throw new Error("--brain and --out are required");
  assertMeasurableBrainPath(brainPath);

  const backend = (flag("backend") ?? "pi") as ToolAdapter;
  const model = flag("model") ?? "claude-sonnet-4-6";
  const vendor = flag("vendor") ?? "anthropic";
  const profile = backend === "pi" ? "measure" : "claude";
  // The Claude backend exposes the tool MCP-prefixed, so the name matched in
  // the stream is computed rather than spelled.
  const blockTool = visibleToolName(SHOW_BLOCK_TOOL_NAME, backend);
  const indexes = (flag("prompts") ?? PROMPTS.map((_, i) => i).join(",")).split(",").map(Number);
  const runs = Number(flag("runs") ?? "1");

  const dbPath = `${brainPath}/.measure-ui.db`;
  const config = resolveServerConfig({
    // The real environment first, so a configured TYPESAFE_API_KEY reaches
    // the classification pass and the backends find their credentials; the
    // keys below are the harness's and override it.
    ...process.env,
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    BRAIN_PATH: brainPath,
    DB_PATH: dbPath,
    AGENT_BACKEND: backend,
    ...(backend === "pi"
      ? {
          BRAIN_UI_PI_PROFILES: JSON.stringify([
            { id: profile, label: `pi ${vendor}/${model}`, vendor, model },
          ]),
        }
      : { BRAIN_UI_CLAUDE_DEFAULT_MODEL: model }),
    // Discovery and coastline data are irrelevant here and cost a network
    // round trip per boot.
    BRAIN_UI_MODEL_DISCOVERY: "0",
    BRAIN_UI_PRICING_DISCOVERY: "0",
    BRAIN_UI_COASTLINE: "0",
    BRAIN_UI_TURN_TIMEOUT_MS: "420000",
  });

  // The server's own log stream, recorded rather than printed, so the
  // classification pass's outcome and latency come from the instrumentation
  // D42 already writes instead of being guessed from the frames.
  const observability = createRecordingObservability();
  const app = createApp({ config, dbPath, observability });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  console.error(`[measure] ${url} backend=${backend} model=${vendor}/${model} brain=${brainPath}`);

  const records: RunRecord[] = [];
  const environment = redirectingEnvironment();
  const save = () =>
    Bun.write(
      outPath,
      JSON.stringify({ backend, model: `${vendor}/${model}`, environment, records }, null, 2)
    );

  try {
    for (const promptIndex of indexes) {
      for (let runIndex = 0; runIndex < runs; runIndex++) {
        console.error(`[measure] prompt ${promptIndex} run ${runIndex + 1}/${runs}`);
        observability.logs.clear();
        const record = await runOnce(url, profile, brainPath, blockTool, promptIndex, runIndex);
        // One turn is one session here, and the log was cleared before it, so
        // the pass's record for this turn is the only one present.
        const pass = observability.logs.find({ body: "classification pass" }).at(-1);
        record.classification = pass
          ? {
              outcome: String(pass.attributes["classification.outcome"] ?? "?"),
              candidates: Number(pass.attributes["classification.candidates"] ?? 0),
              blocks: Number(pass.attributes["classification.blocks"] ?? 0),
              durationMs: Number(pass.attributes["duration.ms"] ?? 0),
            }
          : null;
        records.push(record);
        console.error(
          `[measure]   show_block=${record.showBlockCalls.length}` +
            ` tables=${record.markdownTables} tools=[${record.toolNames.join(",")}]` +
            ` class=${record.classification ? `${record.classification.outcome}/${record.classification.durationMs}ms` : "off"}` +
            ` ${record.wallMs}ms errors=${record.errors.length}`
        );
        await save();
      }
    }
  } finally {
    await save();
    server.stop(true);
    app.close();
  }
}

async function runOnce(
  url: string,
  profile: string,
  brainPath: string,
  blockTool: string,
  promptIndex: number,
  runIndex: number
): Promise<RunRecord> {
  const frames: ServerMessage[] = [];
  const protocolErrors: string[] = [];
  // The server's own collector, so the parts recorded here are the parts the
  // classification pass would have walked.
  const collector = new TurnTextCollector();
  const client = new BrainUiClient({
    url,
    handlers: {
      onAny: (frame) => {
        frames.push(frame);
        collector.observe(frame);
      },
    },
    onProtocolError: (e) => protocolErrors.push(`${e.reason}: ${e.detail}`),
  });
  client.connect();

  const openBy = Date.now() + 10_000;
  while (Date.now() < openBy && !client.isConnected) await Bun.sleep(20);
  if (!client.isConnected) throw new Error("socket never opened");

  const started = Date.now();
  client.send({
    type: "chat_message",
    text: PROMPTS[promptIndex],
    providerId: profile,
    draftId: `measure-${promptIndex}-${runIndex}-${started}`,
  });

  // The turn ends at `result`, or at a bare `error` when it died before a
  // session existed. Wait a little past `result` for the additive
  // `message_blocks` frame the classification pass sends after it.
  //
  // Every other shape ends at the 450 s deadline with no `result`, so it is
  // `completed: false` and excluded from the rate: an `error` that carries a
  // session, a dropped socket, a server that never answers. The one shape
  // that is silently COUNTED is a `message_blocks` frame that arrives later
  // than the window below — the turn's block count is right and its
  // classifier column reads empty. The window is therefore generous rather
  // than tight: the pass has a 2 s budget and then transforms and persists.
  const deadline = Date.now() + 450_000;
  let resultAt: number | null = null;
  while (Date.now() < deadline) {
    const hasResult = frames.some((f) => f.type === "result");
    if (hasResult && resultAt === null) resultAt = Date.now();
    // The classification pass runs after the result frame within its own 2 s
    // budget, then transforms and persists before the frame goes out, so the
    // wait has to outlast that rather than match it.
    if (resultAt !== null && Date.now() - resultAt > 8000) break;
    if (!hasResult && frames.some((f) => f.type === "error" && !("sessionId" in f && f.sessionId))) {
      await Bun.sleep(500);
      break;
    }
    await Bun.sleep(100);
  }
  const wallMs = Date.now() - started;
  client.close();

  // A subagent's frames are not what the reader saw: the chat adapter keeps
  // them off the surface, so they are not counted here either (D43).
  const toolCalls = frames.filter(
    (f): f is Extract<ServerMessage, { type: "tool_use_complete" }> =>
      f.type === "tool_use_complete" && !f.parentToolUseId
  );
  const textParts = collector.textParts();
  const result =
    (frames.find((f) => f.type === "result") as Record<string, unknown> | undefined) ?? null;
  const blocksFrame = frames.find(
    (f): f is Extract<ServerMessage, { type: "message_blocks" }> => f.type === "message_blocks"
  );
  const resultByToolUse = new Map(
    frames
      .filter(
        (f): f is Extract<ServerMessage, { type: "tool_result" }> => f.type === "tool_result"
      )
      .map((f) => [f.toolUseId, f])
  );

  return {
    promptIndex,
    prompt: PROMPTS[promptIndex],
    runIndex,
    showBlockCalls: toolCalls
      .filter((c) => c.toolName === blockTool)
      .map((c) => {
        const kind = (c.input as { block?: { kind?: unknown } } | undefined)?.block?.kind;
        return {
          kind: typeof kind === "string" ? kind : null,
          ok: resultByToolUse.get(c.toolUseId)?.isError === false,
        };
      }),
    toolNames: toolCalls.map((c) => c.toolName),
    markdownTables: countMarkdownTables(...textParts),
    textParts,
    messageBlocks: blocksFrame?.blocks ?? [],
    // Filled by the caller from the server's log, which is only readable
    // once the turn is over.
    classification: null,
    result,
    errors: [
      ...protocolErrors,
      ...frames.filter((f) => f.type === "error").map((f) => JSON.stringify(f)),
    ],
    wallMs,
    // Every tool call, not just the visible ones: a subagent that reads
    // outside the brain feeds what it found into the answer the reader sees.
    escapedBrain: escapesBrain(
      frames
        .filter(
          (f): f is Extract<ServerMessage, { type: "tool_use_complete" }> =>
            f.type === "tool_use_complete"
        )
        .map((c) => c.input),
      brainPath
    ),
    completed: result?.outcome === "success" && result?.isError === false,
  };
}

async function report(paths: string[]): Promise<void> {
  const records: RunRecord[] = [];
  let backend = "";
  let model = "";
  let environment: Record<string, boolean> | undefined;
  for (const path of paths) {
    const parsed = (await Bun.file(path).json()) as RunFile;
    environment ??= parsed.environment;
    if (backend && (parsed.backend !== backend || parsed.model !== model)) {
      throw new Error(
        `${path} is ${parsed.backend}/${parsed.model}, not ${backend}/${model} —` +
          " one report is one backend and one model"
      );
    }
    backend = parsed.backend;
    model = parsed.model;
    records.push(...parsed.records);
  }

  // A turn that did not complete produced no answer, and a turn whose shell
  // left the brain answered about something else: neither is a turn that
  // declined to call the tool, so both are reported and excluded from the rate.
  const dropped = records.filter((r) => !r.completed || r.escapedBrain);
  const counted = records.filter((r) => r.completed && !r.escapedBrain);

  const byPrompt = new Map<number, RunRecord[]>();
  for (const record of counted) {
    const group = byPrompt.get(record.promptIndex) ?? [];
    // The label comes from the first record in a group, so a prompt list
    // edited between two runs would print one prompt's text over another's
    // numbers.
    if (group.length && group[0].prompt !== record.prompt) {
      throw new Error(
        `prompt ${record.promptIndex} is two different prompts across these files:` +
          `\n  ${group[0].prompt}\n  ${record.prompt}`
      );
    }
    byPrompt.set(record.promptIndex, [...group, record]);
  }
  const order = [...byPrompt.keys()].sort((a, b) => a - b);

  console.log(
    `backend: ${backend}\nmodel: ${model}\nturns: ${records.length}` +
      ` (counted ${counted.length}; excluded ${dropped.length}: ` +
      `${records.filter((r) => !r.completed).length} did not complete, ` +
      `${records.filter((r) => r.completed && r.escapedBrain).length} left the brain)\n`
  );

  console.log("## show_block\n");
  // The rate is turns, not calls: one turn can draw two blocks, and what the
  // question asks is how often the model reached for the tool at all. The
  // kind column is the other half of the question (#156) — a block of the
  // wrong kind scores the same as the right one on rate alone.
  console.log(
    "| prompt | turns | turns with a block | blocks drawn | expected kind | right kind | kinds drawn | markdown tables |"
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  let rejected = 0;
  let scorable = 0;
  let rightKind = 0;
  const wrongKinds = new Map<string, number>();
  for (const index of order) {
    const list = byPrompt.get(index)!;
    const drawn = list.flatMap((r) => r.showBlockCalls.filter((c) => c.ok));
    const turnsWithBlock = list.filter((r) => r.showBlockCalls.some((c) => c.ok)).length;
    rejected += list.reduce((n, r) => n + r.showBlockCalls.filter((c) => !c.ok).length, 0);
    const kinds = [...new Set(drawn.map((c) => c.kind ?? "?"))];
    // Recounted from the recorded text rather than read back from the file,
    // so a correction to the counter reaches runs already on disk. The
    // escape flag cannot be recounted this way — it is decided from tool
    // arguments, which are not kept — so fixing that rule needs a re-run.
    const tables = list.reduce((n, r) => n + countMarkdownTables(...r.textParts), 0);

    const expected = EXPECTED_KIND[index] ?? null;
    let right = 0;
    if (expected) {
      for (const record of list) {
        const accepted = record.showBlockCalls.filter((c) => c.ok);
        if (accepted.length === 0) continue;
        scorable++;
        if (accepted.some((c) => c.kind === expected)) right++;
        else {
          for (const call of accepted) {
            wrongKinds.set(
              `${expected}\u2192${call.kind ?? "?"}`,
              (wrongKinds.get(`${expected}\u2192${call.kind ?? "?"}`) ?? 0) + 1
            );
          }
        }
      }
      rightKind += right;
    }

    console.log(
      `| ${list[0].prompt} | ${list.length} | ${turnsWithBlock} | ${drawn.length}` +
        ` | ${expected ?? "\u2014"} | ${expected ? `${right}/${turnsWithBlock}` : "not scored"}` +
        ` | ${kinds.join(", ") || "\u2014"} | ${tables} |`
    );
  }
  const withBlock = counted.filter((r) => r.showBlockCalls.some((c) => c.ok)).length;
  console.log(
    `\nturns that drew at least one block: ${withBlock}/${counted.length}` +
      `; calls the handler rejected: ${rejected}`
  );
  console.log(
    `right kind: ${rightKind}/${scorable} scorable turns` +
      (wrongKinds.size ? `; wrong: ${[...wrongKinds].map(([k, n]) => `${k} \u00d7${n}`).join(", ")}` : "")
  );

  console.log("\n## classification candidates\n");
  console.log("| prompt | runs | no candidate | candidates | kinds |");
  console.log("| --- | --- | --- | --- | --- |");
  const tally = new Map<string, number>();
  let none = 0;
  let total = 0;
  for (const index of order) {
    const list = byPrompt.get(index)!;
    let promptNone = 0;
    let promptTotal = 0;
    const kinds = new Set<string>();
    for (const record of list) {
      const plan = planClassification(record.textParts);
      if (!plan) {
        promptNone++;
        continue;
      }
      promptTotal += plan.candidates.length;
      for (const { candidate } of plan.candidates) {
        kinds.add(candidate.kind);
        tally.set(candidate.kind, (tally.get(candidate.kind) ?? 0) + 1);
      }
    }
    none += promptNone;
    total += promptTotal;
    console.log(
      `| ${list[0].prompt} | ${list.length} | ${promptNone} | ${promptTotal} | ${[...kinds].join(", ") || "—"} |`
    );
  }
  console.log(
    `\ncandidates: ${total} across ${counted.length - none} answers; ${none} answers had none`
  );
  console.log(`candidate kinds: ${[...tally].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);

  const swapped = counted.filter((r) => r.messageBlocks.length > 0).length;
  console.log(
    swapped === 0
      ? "classifier swaps: none recorded (no TYPESAFE_API_KEY means the pass is disabled)"
      : `classifier swaps: ${swapped} answers carried blocks`
  );

  const errored = records.filter((r) => r.errors.length > 0).length;
  const walls = counted.map((r) => r.wallMs).sort((a, b) => a - b);
  const costs = records
    .map((r) => r.result?.costUsd)
    .filter((c): c is number => typeof c === "number");
  console.log(
    `\nturns with errors: ${errored}; wall ms min ${walls[0]} median ${walls[walls.length >> 1]} max ${walls[walls.length - 1]}`
  );
  if (costs.length) {
    console.log(
      `cost recorded on ${costs.length}/${records.length} turns, total $${costs.reduce((a, b) => a + b, 0).toFixed(4)}`
    );
  }
  const outcomes = new Map<string, number>();
  for (const record of records) {
    const key = `${record.result?.outcome ?? "none"}/numTurns=${record.result?.numTurns ?? "none"}`;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
  }
  console.log(
    `outcomes, all ${records.length} turns: ${[...outcomes]
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ")}`
  );
  if (environment) {
    const set = Object.entries(environment)
      .filter(([, present]) => present)
      .map(([name]) => name);
    console.log(`environment set at record time: ${set.join(", ") || "none"}`);
  }
}

// Guarded, so `tests/measure-show-block-gate.test.ts` can import the counting
// rules without booting a server and spending money.
if (import.meta.main) {
  const reportIndex = process.argv.indexOf("--report");
  if (reportIndex > 0) {
    await report(process.argv.slice(reportIndex + 1));
  } else {
    await measure();
  }
  process.exit(0);
}
