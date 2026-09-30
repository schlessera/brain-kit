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
//   bun scripts/measure-show-block-server.ts --suggestions --brain <dir> --backend pi --runs 3 --out suggestions.json
//   bun scripts/measure-show-block-server.ts --report runs.json [more.json …]
//
// Point `--brain` at a copy of a brain OUTSIDE any checkout of this repo.
// The agent's cwd is the brain, and a brain nested in the worktree lets the
// model walk up into the repo and answer about brain-kit instead of the
// corpus — measured on 2026-09-22, two pi answers cited `bun:sqlite` and
// `Bun.Glob` from AGENTS.md. On `--backend claude` it has to live outside
// the operator's home directory as well: the CLI walks up from the cwd and
// reads `.claude/CLAUDE.md`, skills and agents at every ancestor, so a brain
// under `~` loads that user's own instructions as project context, whatever
// `CLAUDE_CONFIG_DIR` says (#137). The agent's shell is not confined to the brain
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

import { posix, resolve, join, dirname } from "node:path";

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { SUGGESTION_ARMS, SUGGESTION_PROMPTS, observeSuggestions, suggestionReport, type SuggestionTurn, type SuggestionArm } from "./measure-suggestions.ts";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { BrainUiClient, type ServerMessage } from "@schlessera/brain-ui-sdk/client";

import {
  applyClassification,
  planClassification,
} from "../packages/ui-sdk/src/classification/request.ts";
import {
  SHOW_BLOCK_TOOL_NAME,
  visibleToolName,
  type ToolAdapter,
} from "../packages/ui-sdk/src/tool-contracts/index.ts";
import { createApp } from "../packages/ui-server/src/app.ts";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client.ts";
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
export const EXPECTED_KIND: Array<string | null> = [
  "comparison",
  "comparison",
  "trend",
  "contact",
  "steps",
  "schedule",
  "quote",
  null,
];

export const PROMPTS = [
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
   * True when a tool argument named an absolute path outside the brain —
   * the agent's shell left the corpus, so the answer is about something else
   * and the turn is not a measurement of this brain.
   */
  escapedBrain: boolean;
  /** The turn reached a successful `result`. Others are excluded from rates. */
  completed: boolean;
  suggestionTurn?: SuggestionTurn;
  observedVersions?: Record<string, string>;
}

/**
 * An absolute or `~` path in a tool argument that is not the brain or inside
 * it — a bare `/`, `/etc/hostname`, a sibling of the brain, a home directory,
 * wherever the brain itself lives. A heuristic over what the model asked
 * for, not a sandbox. It is here to drop turns that answered about the wrong
 * brain, not to confine anything.
 *
 * It is a deliberately conservative text scan: it prefers excluding a clean
 * turn to counting a leaking one. A path field (`PATH_KEYS`) is one path.
 * Every other string is scanned raw, and every `/` or `~` that could start a
 * path is a candidate. No quote, comment, heredoc or substitution is
 * interpreted, because a shell parser that gets one of them wrong hides the
 * rest of the command, and a miss is a silently wrong rate. The comparison
 * is by directory boundary after normalisation, so `/x/brain-backup` is not
 * `/x/brain` and `/x/brain/a,b/../../y` leaves it.
 *
 * What it over-counts: a `/` that is not a path — an awk or sed regex, a
 * markdown link target, a lone `/` in prose, a binary called by its absolute
 * path. Such a turn is EXCLUDED, and `--report` prints how many were, so an
 * over-eager rule shows up as a shrunken denominator rather than as a wrong
 * rate. `DEVICE_PATHS` is let through, because models redirect to
 * `/dev/null` constantly and none of those reads anything outside the brain.
 *
 * What it does not see: a relative escape (`cd ..`, `cat ../private.md`,
 * `$HOME/x`), which only a shell that tracked the working directory could
 * judge, and a path that only appears in a tool's OUTPUT.
 *
 * Whitespace ends a path in free text, which is why
 * `assertMeasurableBrainPath` refuses a brain whose own path contains any.
 * Without that precondition `<brain> copy/notes.md` and
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
 * Argument keys whose value is one path, taken whole: whitespace, brackets
 * and all, so `<brain>(1)/a.md` is the brain and `<brain>/a b/../../x`
 * leaves it.
 */
const PATH_KEYS = new Set(["file_path", "path", "notebook_path"]);

/**
 * What may come right before a path in free text: nothing, or a character
 * that cannot be part of a name before it. `\` is not on it, so the escaped
 * slash of a regex like `'^\.\/\.git'` starts nothing.
 */
const PATH_START = /[\s"'`(=:,;|&<>${[]/;

/**
 * What ends a path in free text: whitespace, a quote, a backtick, or a shell
 * operator. A shell operator also starts the next path, so
 * `cmd</etc/hostname` is read as two.
 */
const PATH_END = /[\s"'`;|&<>]/;

/** Device paths a turn may name without leaving the brain. */
const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);

/**
 * The candidate paths in a string of free text — a shell command, a
 * pattern, a description. No quote, comment or heredoc is interpreted, so
 * none of them can hide the text after it.
 */
function textPaths(text: string): string[] {
  const paths: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "/" && c !== "~") continue;
    const before = text[i - 1];
    const starts =
      before === undefined ||
      PATH_START.test(before) ||
      // An attached short option's value: `env -C/etc`, `tar -C/x`.
      /(?:^|\s)-[A-Za-z]$/.test(text.slice(Math.max(0, i - 3), i));
    if (!starts) continue;
    // The `//` of a URL scheme is not the root.
    if (c === "/" && before === ":" && text[i + 1] === "/") continue;
    // `~` is a home directory alone, before `/`, or before a user name, and
    // nothing else — `~5 files` is not a path.
    if (c === "~" && /^[^\s/A-Za-z_;|&<>"'`)]/.test(text.slice(i + 1, i + 2))) continue;
    let end = i + 1;
    let depth = 0;
    for (; end < text.length; end++) {
      const d = text[end];
      if (PATH_END.test(d)) break;
      // A `)` ends the path unless it closes a `(` inside it, so
      // `$(cat /etc/x)` ends at `x` and `<brain>(1)/a.md` is one name.
      if (d === "(") depth++;
      else if (d === ")" && depth-- === 0) break;
    }
    paths.push(text.slice(i, end));
  }
  return paths;
}

function argumentPaths(value: unknown, key: string | null, into: string[] = []): string[] {
  if (typeof value === "string") {
    if (key !== null && PATH_KEYS.has(key) && /^[/~]/.test(value)) into.push(value);
    else into.push(...textPaths(value));
  } else if (Array.isArray(value)) for (const v of value) argumentPaths(v, key, into);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) argumentPaths(v, k, into);
  return into;
}

export function escapesBrain(inputs: unknown[], brainPath: string): boolean {
  const home = brainPath.startsWith("~");
  const brain = home ? posix.normalize(brainPath) : resolve(brainPath);
  for (const path of argumentPaths(inputs, null)) {
    // A `~` path cannot be resolved against this process's home, which is
    // not the agent's, so it is only inside a brain that is itself named
    // from `~`.
    const tilde = path.startsWith("~");
    if (tilde && !home) return true;
    const full = tilde ? posix.normalize(path) : resolve(path);
    if (!tilde && DEVICE_PATHS.has(full)) continue;
    if (full === brain || full.startsWith(`${brain}/`)) continue;
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
  versions?: Record<string, string>;
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
  const suggestions = process.argv.includes("--suggestions");
  const prompts: readonly string[] = suggestions ? SUGGESTION_PROMPTS.map((prompt) => prompt.text) : PROMPTS;
  const indexes = (flag("prompts") ?? prompts.map((_, i) => i).join(",")).split(",").map(Number);
  const runs = Number(flag("runs") ?? (suggestions ? "3" : "1"));
  if (!Number.isInteger(runs) || runs < 1 || indexes.some((index) => !Number.isInteger(index) || !prompts[index])) {
    throw new Error("Select valid --prompts indexes and a positive integer --runs.");
  }

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
  const app = await createApp({ config, dbPath, observability });
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
  const classifierConfigured = environment.TYPESAFE_API_KEY;
  const save = () =>
    Bun.write(
      outPath,
      JSON.stringify({ backend, model: `${vendor}/${model}`, environment, versions: runtimeVersions(), records }, null, 2)
    );

  try {
    for (const promptIndex of indexes) {
      for (let runIndex = 0; runIndex < runs; runIndex++) {
        console.error(`[measure] prompt ${promptIndex} run ${runIndex + 1}/${runs}`);
        observability.logs.clear();
        const record = await runOnce(url, profile, brainPath, blockTool, promptIndex, runIndex, prompts[promptIndex]);
        record.observedVersions = observedRuntimeVersions(app.db, record.result?.sessionId);
        // One turn is one session here and the log was cleared before it, so
        // the pass's record for this turn is the only one present — but the
        // pass is fire-and-forget, so it can still be in flight. When a key
        // is configured its record is waited for rather than read once:
        // absent would otherwise be indistinguishable from "pass disabled".
        const passRecords = async () => {
          const deadline = Date.now() + 5000;
          for (;;) {
            const found = observability.logs.find({ body: "classification pass" });
            if (found.length || !classifierConfigured || Date.now() > deadline) return found;
            await Bun.sleep(100);
          }
        };
        const found = await passRecords();
        const pass = found.at(-1);
        record.classification = pass
          ? {
              outcome: String(pass.attributes["classification.outcome"] ?? "?"),
              candidates: Number(pass.attributes["classification.candidates"] ?? 0),
              blocks: Number(pass.attributes["classification.blocks"] ?? 0),
              durationMs: Number(pass.attributes["duration.ms"] ?? 0),
            }
          : classifierConfigured
            ? // A key was set and the pass never reported. Recorded as its own
              // outcome, never as silence, because silence reads as "off".
              { outcome: "not_observed", candidates: 0, blocks: 0, durationMs: 0 }
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
    await app.close();
  }
}

export async function runOnce(
  url: string,
  profile: string,
  brainPath: string,
  blockTool: string,
  promptIndex: number,
  runIndex: number,
  prompt: string = PROMPTS[promptIndex],
  arm: SuggestionArm | undefined = process.env.BRAIN_MEASURE_SUGGESTIONS_ARM as SuggestionArm | undefined
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
    text: prompt,
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

  const escapedBrain = escapesBrain(
    frames.filter((frame): frame is Extract<ServerMessage, { type: "tool_use_complete" }> =>
      frame.type === "tool_use_complete" && frame.toolName !== blockTool).map((call) => call.input), brainPath);
  const suggestionTurn: SuggestionTurn | undefined = arm === "rule" || arm === "no-rule" ? {
    arm, prompt, group: SUGGESTION_PROMPTS[promptIndex].group, answerParts: textParts,
    suggestions: toolCalls.filter((call) => call.toolName === blockTool && resultByToolUse.get(call.toolUseId)?.isError === false)
      .flatMap((call) => { const observation = observeSuggestions(call.input, prompt); return observation ? [observation] : []; }),
    completed: result?.outcome === "success" && result?.isError === false && !escapedBrain,
  } : undefined;
  return {
    ...(suggestionTurn ? { suggestionTurn } : {}),
    promptIndex,
    prompt,
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
    // Except the block tool's own: it touches no file, and its payload is
    // prose, where a lone `/` would read as the root and drop exactly the
    // turns that drew a block.
    escapedBrain,
    completed: result?.outcome === "success" && result?.isError === false,
  };
}

/**
 * Put the recorded answers that DO carry a candidate through the real
 * classifier, one request each, on the same client and the same 2 s budget
 * the pass uses.
 *
 * Why this exists: on pi almost every turn ends `skipped_no_candidates`,
 * because the model drew the block instead of typing the markdown. That is
 * the finding, but it leaves "does the pass behave the same against
 * pi-authored markdown" unanswered for the answers where it can run at all.
 * This is not a turn and does not pretend to be one — it is the same
 * request the pass would have made, made outside it.
 */
async function classifyRecorded(paths: string[]): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? null;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const jev = createJevClient({ apiKey });

  const records: RunRecord[] = [];
  for (const path of paths) {
    const parsed = (await Bun.file(path).json()) as RunFile;
    records.push(...parsed.records);
  }
  const usable = records.filter((r) => r.completed && !r.escapedBrain);

  console.log(`answers: ${usable.length}\n`);
  console.log("| prompt | candidates | kinds | outcome | ms | blocks | confidence |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  let asked = 0;
  for (const record of usable) {
    const plan = planClassification(record.textParts);
    if (!plan) continue;
    asked++;
    const result = await jev.classify(plan.request);
    const blocks = result.answers ? applyClassification(plan, result.answers) : [];
    const kinds = plan.candidates.map(({ candidate }) => candidate.kind).join(", ");
    const confidences = blocks.map((b) => b.confidence.toFixed(2)).join(", ") || "\u2014";
    console.log(
      `| ${record.prompt} | ${plan.candidates.length} | ${kinds} | ${result.outcome}` +
        ` | ${result.durationMs} | ${blocks.length}` +
        `${blocks.length ? ` (${blocks.map((b) => b.block.kind).join(", ")})` : ""}` +
        ` | ${confidences} |`
    );
  }
  console.log(`\nanswers with a candidate: ${asked}/${usable.length}`);
}

async function report(paths: string[]): Promise<void> {
  const records: RunRecord[] = [];
  const versions: Record<string, string>[] = [];
  let backend = "";
  let model = "";
  const environments: Array<{ path: string; environment: Record<string, boolean> }> = [];
  for (const path of paths) {
    const parsed = (await Bun.file(path).json()) as RunFile;
    if (parsed.versions) versions.push(parsed.versions);
    if (parsed.environment) environments.push({ path, environment: parsed.environment });
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

  if (records.some((record) => record.suggestionTurn)) {
    if (records.some((record) => !record.suggestionTurn)) throw new Error("Do not pool legacy block runs with suggestions runs.");
    console.log(`backend: ${backend}\nmodel: ${model}\nversions: ${JSON.stringify(versions)}\nenvironments: ${JSON.stringify(environments.map((entry) => entry.environment))}\n`);
    console.log(`observed runtime versions: ${JSON.stringify(records.map((record) => record.observedVersions ?? { runtime: "not recorded" }))}\n`);
    console.log(suggestionReport(records.map((record) => record.suggestionTurn!)));
    return;
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
  // Per file, never merged: pooling a classifier-off run with a
  // classifier-on one is legitimate for the block rate and NOT legitimate to
  // describe with one configuration line, and printing only the first file's
  // would make the file order change the reported configuration.
  const named = (env: Record<string, boolean>) =>
    Object.entries(env)
      .filter(([, present]) => present)
      .map(([name]) => name)
      .join(", ") || "none";
  const unknown = paths.length - environments.length;
  const distinct = new Set(environments.map((e) => named(e.environment)));
  if (distinct.size === 1 && unknown === 0) {
    console.log(`environment set at record time: ${[...distinct][0]}`);
  } else {
    console.log("environment set at record time, per run file:");
    for (const entry of environments) {
      console.log(`  ${entry.path.split("/").pop()}: ${named(entry.environment)}`);
    }
    // A run file written before the harness recorded this says nothing about
    // its configuration, and must not inherit another file's.
    for (const path of paths) {
      if (!environments.some((e) => e.path === path)) {
        console.log(`  ${path.split("/").pop()}: not recorded`);
      }
    }
  }
}

/** Versions the backend actually reported, without its credential/account fields. */
export function observedRuntimeVersions(db: Database, sessionId: unknown): Record<string, string> {
  if (typeof sessionId !== "string") return { runtime: "not reported" };
  const row = db.query("SELECT attrs FROM activity_spans WHERE session_id = ? AND parent_span_id IS NULL ORDER BY started_at DESC LIMIT 1").get(sessionId) as { attrs: string | null } | null;
  const attrs = row?.attrs ? JSON.parse(row.attrs) as Record<string, unknown> : {};
  const versions: Record<string, string> = {};
  for (const kind of ["runtime", "sdk"]) {
    const name = attrs[`brain.${kind}.name`];
    const version = attrs[`brain.${kind}.version`];
    if (typeof name === "string" && typeof version === "string") versions[name] = version;
  }
  return Object.keys(versions).length ? versions : { runtime: "not reported" };
}

/** Installed packages, rather than a version remembered by the operator. */
function runtimeVersions(): Record<string, string> {
  const versions: Record<string, string> = { bun: Bun.version };
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent"]) {
    let dir = dirname(Bun.resolveSync(name, import.meta.dir));
    for (;;) {
      const manifest = join(dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === name) { versions[name] = pkg.version; break; }
      } catch { /* walk to the package root */ }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`Could not find ${name}'s installed version.`);
      dir = parent;
    }
  }
  return versions;
}

/** Each description arm runs in a fresh process, before either backend loads. */
async function measureSuggestionArms(): Promise<void> {
  const out = flag("out");
  if (!flag("brain") || !out) throw new Error("--brain and --out are required");
  const files: RunFile[] = [];
  for (const arm of SUGGESTION_ARMS) {
    const armOut = `${out}.${arm}.json`;
    const args = process.argv.slice(2);
    args[args.indexOf("--out") + 1] = armOut;
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "measure-suggestions-preload.ts"), import.meta.path, ...args], {
      env: { ...process.env, BRAIN_MEASURE_SUGGESTIONS_ARM: arm }, stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error(`Suggestions arm ${arm} failed; partial records remain in ${armOut}.`);
    files.push(await Bun.file(armOut).json() as RunFile);
  }
  await Bun.write(out, JSON.stringify({ ...files[0], records: files.flatMap((file) => file.records) }, null, 2));
}

/** Keyless audit of the tool definitions/handlers that both backends load. */
async function inspectSuggestions(): Promise<void> {
  const { createShowBlockTool } = await import("../packages/ui-backend-claude/src/show-block-tool.ts");
  const { createPiBridgeTools } = await import("../packages/ui-backend-pi/src/bridge-tools.ts");
  const { createTurnContext } = await import("../packages/ui-backend-pi/src/turn-context.ts");
  const { listedTool } = await import("./show-block-schema-forms.ts");
  const claude = createShowBlockTool();
  const pi = createPiBridgeTools({ brainPath: "/tmp/fictional-brain", turn: createTurnContext() }).find((tool) => tool.name === "show_block")!;
  const input = { block: { kind: "suggestions" as const, items: [{ label: "Plan the bookshelf step" }] } };
  console.log(JSON.stringify({
    claude: await listedTool(claude),
    pi: { description: pi.description, inputSchema: pi.parameters },
    claudeResult: await claude.handler(input, {}), piResult: await pi.execute("inspect", input, undefined, undefined, {} as Parameters<typeof pi.execute>[4]),
  }));
}

// Guarded, so `tests/measure-show-block-gate.test.ts` can import the counting
// rules without booting a server and spending money.
if (import.meta.main) {
  const reportIndex = process.argv.indexOf("--report");
  const classifyIndex = process.argv.indexOf("--classify");
  if (process.argv.includes("--inspect-suggestions")) {
    await inspectSuggestions();
  } else if (reportIndex > 0) {
    await report(process.argv.slice(reportIndex + 1));
  } else if (classifyIndex > 0) {
    await classifyRecorded(process.argv.slice(classifyIndex + 1));
  } else if (process.argv.includes("--suggestions") && !process.env.BRAIN_MEASURE_SUGGESTIONS_ARM) {
    await measureSuggestionArms();
  } else {
    await measure();
  }
  process.exit(0);
}
