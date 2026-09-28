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
 * Note that the arms only mean what they say on a backend that DEFERS the tool
 * behind tool search, which the Claude backend does and pi does not — pi
 * registers `show_block` as a plain tool, so it is always in the prompt and
 * `--always-load` below is the arm that corresponds to it.
 *
 * It needs a credential and the network, so it is a script and not a test:
 * CI never runs it. Re-run it before changing the brief again. The
 * credential is `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` when no key
 * is set (#336's ruling O1); the report names which one ran it.
 *
 * WHAT THIS HARNESS CANNOT SEE. It drives the Claude Agent SDK directly, so it
 * measures one backend below the server: no ui-server, no socket, no client,
 * and no classification pass actually running — `planClassification` is called
 * here only to score what the pass WOULD have seen. `scripts/measure-show-block-server.ts`
 * is the instrument one level up: it drives the whole server over a real
 * socket and is backend-agnostic, so it is the one to reach for when the
 * question involves pi, the wire frames, the swap actually happening, or what
 * the reader ends up looking at. The two are different instruments, not
 * duplicates; a claim about "the block rate" needs to say which one produced
 * it, and on which backend.
 *
 *   bun scripts/measure-show-block.ts --reps 3 --out runs.json --md report.md
 *   bun scripts/measure-show-block.ts --always-load   # tools in the prompt
 *   bun scripts/measure-show-block.ts --tokens        # the schema arithmetic
 *   bun scripts/measure-show-block.ts --both-arms     # loaded AND deferred, one run
 *   bun scripts/measure-show-block.ts --schema-forms  # #336: the schema written three ways
 *
 * `--both-arms` re-checks D44's CLI half on whatever runtime is installed
 * (#209): every prompt runs with the bridge server loaded and deferred, the
 * report compares their first-frame latency and `ToolSearch` use, and every
 * turn records the Claude Code version its `init` reported. Before any turn it
 * asserts the D44 claim about the startup wait set: the config
 * `createSdkMcpServer` returns carries no server-level `alwaysLoad`.
 *
 * `--always-load` and `--tokens` were added for #148, which asked whether the
 * bridge server should be created with `alwaysLoad: true`. It should, and D44
 * is the record; `--always-load` is therefore the configuration that ships
 * today, and a bare invocation measures the one that shipped before it. The
 * flag keeps its name so D43's commands keep reproducing D43's tables.
 *
 * `--schema-forms` was added for #336, which asks whether `show_block`'s
 * schema can be written shorter without moving the call rate or the parse
 * rate. Its arms are schema forms rather than brief/no-brief: `flat` (what
 * ships), `shared` (D47's reduction 1) and `shared-trimmed` (reductions 1 and
 * 2), defined in `scripts/show-block-schema-forms.ts`. It runs the shipping
 * configuration in every arm, the brief on and the bridge server loaded, so
 * the schema is the only difference. A turn that completed in a non-flat arm
 * is also the evidence that the API accepted a request carrying that form: a
 * schema the API refused would error the turn.
 *
 * Two counting rules keep the rate honest. A call is counted only when its
 * argument parses through the contract's schema, because a rejected call drew
 * nothing; and frames a subagent produced (`parent_tool_use_id` set) are
 * skipped, because the chat adapter keeps them off the surface, so they are
 * not what the reader saw. A turn that errored or hit `maxTurns` produced no
 * answer at all and is excluded from every rate rather than counted as a turn
 * that declined to call the tool.
 *
 * Each turn's text parts are also run through `planClassification` — the same
 * entry point `ui-server` calls, keyless up to the classifier request — so the
 * report says how many of the turns that did NOT call the tool left a
 * candidate the pass would have asked about. Detection is necessary but not
 * sufficient: the pass still needs the classifier to clear its confidence
 * gate, so a candidate is an upper bound on what the pass would have swapped.
 * That pair of numbers is what the keep-or-retire decision rests on.
 */

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  BRIDGE_TOOL_CONTRACTS,
  BRIDGE_TOOL_POSTURE,
  buildSystemPromptAppend,
  planClassification,
  SHOW_BLOCK_CONTRACT,
  type BridgeToolName,
  type ClientEnvironment,
} from "@schlessera/brain-ui-sdk/server";

// The backend's own tool factory and visible name, so the description the
// model reads here is the one it reads in production rather than a copy that
// can drift, and the name matched in the stream is the one the backend
// computes rather than a hand-spelled prefix.
import {
  createShowBlockTool,
  SHOW_BLOCK_INPUT_SCHEMA,
  SHOW_BLOCK_TOOL_NAME as BLOCK_TOOL,
} from "../packages/ui-backend-claude/src/show-block-tool.js";
import { createAgentHook } from "../packages/ui-backend-claude/src/input-rewrite-hooks.js";
import { showBlockInputSchema } from "@schlessera/brain-ui-sdk/server";
import {
  liveCredential,
  listedShowBlock,
  SCHEMA_ARM_NAMES,
  SCHEMA_ARMS,
  showBlockToolIn,
  type LiveCredential,
  type SchemaArm,
} from "./show-block-schema-forms.ts";
import { kvRunColumns, kvRunRows, type KvRunColumns } from "./measure-kv-runs.ts";

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

// The SDK the BACKEND loads, imported from the entry whose version the report
// names, so a hoisted second copy cannot be measured under the other's name.
const SDK_ENTRY = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
const { createSdkMcpServer, query } = (await import(SDK_ENTRY)) as typeof import("@anthropic-ai/claude-agent-sdk");

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
  "contact",
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
    // A key-and-value run can come back as a `contact` block (#132), and
    // `me/identity.md` carries one with an address for this prompt to find
    // (#208).
    classifiable: true,
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

type ArmName = "brief" | "no-brief" | SchemaArm;

/** `--schema-forms` (#336): the arms are schema forms, not brief/no-brief. */
const SCHEMA_FORMS = process.argv.includes("--schema-forms");

const ARMS: readonly ArmName[] = SCHEMA_FORMS ? SCHEMA_ARM_NAMES : ["brief", "no-brief"];

function isSchemaArm(arm: ArmName): arm is SchemaArm {
  return arm in SCHEMA_ARMS;
}

/** The schema a call in `arm` was offered, and so the one it must parse through. */
function inputSchemaFor(arm: ArmName) {
  return isSchemaArm(arm) ? showBlockInputSchema(SCHEMA_ARMS[arm]) : SHOW_BLOCK_INPUT_SCHEMA;
}

interface TurnResult {
  prompt: string;
  invites: string;
  classifiable: boolean;
  arm: ArmName;
  rep: number;
  /**
   * Calls that would have RENDERED: the argument parses through the contract's
   * own schema. A call the tool rejected drew nothing, so counting it would
   * read a failed attempt as the brief working.
   */
  calls: number;
  kinds: string[];
  /** Calls the schema rejected. Reported, never counted as a block. */
  rejectedCalls: number;
  /**
   * Every other tool the turn used, top-level frames only. Recorded so that
   * "did a turn delegate to a subagent at all" is answerable from the run
   * rather than argued about — `Agent` is in the roster, and a delegated turn
   * is a different turn from one that read the corpus itself.
   */
  otherTools: string[];
  /** Candidate kinds `planClassification` found across the turn's text parts. */
  candidates: string[];
  /**
   * Key-and-value runs the turn typed, the ones carrying an address, and the
   * `kv_run` candidates detected (#208).
   */
  kvRuns: KvRunColumns;
  answerChars: number;
  durationMs: number;
  /** What this turn cost, as the SDK priced it. Summed into the report. */
  costUsd: number;
  /**
   * What the turn actually billed on the input side, split the way the API
   * splits it. #148 turns on "does putting the schemas in the prompt cost more
   * than fetching them when wanted", and the tools block sits at the very
   * front of the cache prefix, so the fresh/created/read split is the
   * difference between a number that decides it and one that looks alarming.
   * `modelTurns` is the divisor: a turn is several model round-trips, and the
   * prompt is re-sent on each one.
   */
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  modelTurns: number;
  /**
   * Wall time from `query()` to the first assistant frame. The SDK warns that
   * `alwaysLoad` "blocks startup until the server is connected (capped at the
   * standard 5s connect timeout)", so first-turn latency is one of the three
   * axes #148 has to decide on.
   */
  firstFrameMs: number;
  /** The SDK's own time-to-first-token, when it reports one. */
  ttftMs?: number;
  /** The answer as the reader would have seen it, for the transcript. */
  answer: string;
  /** Whether the bridge server was created with `alwaysLoad`. */
  alwaysLoad: boolean;
  /** The Claude Code version the turn's `init` reported. */
  claudeCode?: string;
  /** The credential the CLI said it used, as its `init` reported it. */
  apiKeySource?: string;
  error?: string;
}

/**
 * `--always-load`: put the MCP tools in the prompt instead of behind tool
 * search.
 *
 * The SDK defers an MCP server's tools by default — they are not in the
 * model's context at all until it runs `ToolSearch`. This flag opts out of
 * that, which is the only way to tell "the brief makes the model WANT the
 * tool" apart from "the brief is the only thing that tells the model the tool
 * EXISTS".
 *
 * **It is off by default and production is now on.** D43 ran the arms without
 * it, because at the time deferral was what shipped; D44 read those arms and
 * flipped production to `alwaysLoad: true`
 * (`packages/ui-backend-claude/src/ask-user-tool.ts`). The default is left
 * alone anyway, so a bare invocation keeps reproducing D43's tables rather
 * than silently measuring something else under the same command. Pass
 * `--always-load` for the configuration that ships today.
 */
const ALWAYS_LOAD = process.argv.includes("--always-load") || SCHEMA_FORMS;

function optionsFor(arm: ArmName, abortController: AbortController, alwaysLoad: boolean): Options {
  return {
    cwd: BRAIN_PATH,
    // Production aborts a turn at this budget rather than letting it run on
    // (`packages/ui-server/src/ws/run-session.ts:184`). Without it the harness
    // would score an answer no reader could ever have received: five turns of
    // an earlier run took 190-306 s. `maxTurns` bounds the conversation, not
    // the clock.
    abortController,
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
        // Every schema arm runs with the brief, as production does.
        tools: { block: arm !== "no-brief" && BLOCK_TOOL },
      }),
    },
    // `tools` is what would narrow AVAILABILITY and it is left unset, as
    // `sdk-options.ts` leaves it: setting it to three built-ins was tried and
    // moved the absolute rates, because the MCP tool's share of a short roster
    // is not its share of the real one. `allowedTools` only auto-approves.
    allowedTools: ["Read", "Glob", "Grep", BLOCK_TOOL],
    // The named divergence from production, which disallows only
    // `AskUserQuestion`. `disallowedTools` DOES remove a tool from the model's
    // context, so these five are absent from the roster the model reads here,
    // and the absolute rates are a measurement of that roster rather than of
    // production's. Each is withheld for a reason a measurement cannot trade
    // away: `Bash` because the run is `bypassPermissions` on a real host;
    // `Edit`/`Write` because every turn shares one staged brain, so a mutation
    // by any turn would leak into every later turn in BOTH arms; `WebSearch` /
    // `WebFetch` because a live search makes the answer non-reproducible and
    // bills per call. The withholding is identical in both arms, so it cannot
    // move the contrast the A/B measures — only where both arms sit.
    disallowedTools: ["AskUserQuestion", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
    // Production's own hook, so a delegated turn behaves the way it does
    // there. The SDK backgrounds `Agent` calls by default and a background
    // agent dies with the turn's subprocess before it reports, which would
    // score the parent on an answer it never got. Registering the hook is why
    // `Agent` can stay in the roster rather than being disallowed.
    hooks: { PreToolUse: [{ matcher: "^Agent$", hooks: [createAgentHook()] }] },
    // One answer, not an investigation: enough turns to read the corpus and
    // reply, few enough that a wandering run cannot stall the measurement.
    maxTurns: 14,
    permissionMode: "bypassPermissions",
    mcpServers: {
      // A SECOND named divergence, and it is material to a tool-search claim:
      // production's `createBridgeMcpServer` registers up to five tools on
      // this server (`ask-user-tool.ts:95-108`) and this registers one. They
      // are deferred together, so a real deployment's `ToolSearch` returns a
      // roster this one never shows, and a model weighing whether to spend
      // the round-trip is weighing a different payoff. It cannot move the
      // contrast — both arms register the same one tool — but the absolute
      // search rate here is the rate for a one-tool server.
      "brain-ui": createSdkMcpServer({
        name: "brain-ui",
        version: "0.1.0",
        tools: [isSchemaArm(arm) ? showBlockToolIn(arm) : createShowBlockTool()],
        ...(alwaysLoad ? { alwaysLoad: true } : {}),
      }),
    },
  };
}

/**
 * D44's claim about the startup wait set: the CLI waits at startup only for
 * servers whose CONFIG sets `alwaysLoad`, and `createSdkMcpServer` stamps the
 * flag on each tool instead of the config. If a later SDK puts it on the
 * config, the in-process server joins the wait set and the latency argument
 * D44 rests on no longer holds.
 */
function assertNoServerLevelAlwaysLoad(): void {
  // The populated server the arms actually pass, not an empty one.
  const config = createSdkMcpServer({
    name: "brain-ui",
    version: "0.1.0",
    tools: [createShowBlockTool()],
    alwaysLoad: true,
  });
  if ("alwaysLoad" in config) {
    throw new Error("createSdkMcpServer now puts alwaysLoad on the server config: D44's startup-latency reading no longer holds");
  }
}

async function runTurn(
  prompt: (typeof PROMPTS)[number],
  arm: ArmName,
  rep: number,
  alwaysLoad: boolean = ALWAYS_LOAD
): Promise<TurnResult> {
  const started = Date.now();
  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), TURN_BUDGET_MS);
  const kinds: string[] = [];
  const otherTools = new Set<string>();
  let rejectedCalls = 0;
  // One entry per contiguous assistant text run, which is how `ui-server`'s
  // collector numbers parts — joining them first would let two structures on
  // either side of a tool call merge into a candidate neither one is.
  const textParts: string[] = [];
  let costUsd = 0;
  let error: string | undefined;
  // Input-token accounting and first-frame latency, the two axes #148 adds to
  // the call rate. Both are read off the run rather than modelled.
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let modelTurns = 0;
  let firstFrameMs = 0;
  let ttftMs: number | undefined;
  let claudeCode: string | undefined;
  let apiKeySource: string | undefined;
  const inputSchema = inputSchemaFor(arm);
  try {
    for await (const message of query({
      prompt: prompt.text,
      options: optionsFor(arm, abortController, alwaysLoad),
    })) {
      if (message.type === "system" && message.subtype === "init") {
        claudeCode = message.claude_code_version;
        apiKeySource = message.apiKeySource;
      }
      // The first frame the model produced, whatever its kind: what "the
      // answer started" means to a reader watching the surface.
      if (firstFrameMs === 0 && message.type === "assistant") {
        firstFrameMs = Date.now() - started;
      }
      // `parent_tool_use_id` is non-null on frames a subagent produced. Those
      // are not the answer, so neither their text nor their tool calls count.
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        for (const part of message.message.content) {
          if (part.type === "text") textParts.push(part.text);
          if (part.type !== "tool_use") continue;
          if (part.name !== BLOCK_TOOL) {
            otherTools.add(part.name);
            continue;
          }
          const parsed = inputSchema.safeParse(part.input);
          if (parsed.success) kinds.push(parsed.data.block.kind);
          else rejectedCalls += 1;
        }
      }
      if (message.type === "result") {
        costUsd = message.total_cost_usd;
        // `usage` is the main agent loop only — subagent and auxiliary calls
        // are excluded — which is the right scope here: the bridge server's
        // tools are offered to the main loop, and subagent frames are not
        // counted anywhere else in this harness either.
        inputTokens = message.usage.input_tokens;
        cacheCreationTokens = message.usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
        outputTokens = message.usage.output_tokens;
        modelTurns = message.num_turns;
        if (message.subtype === "success") ttftMs = message.ttft_ms;
        if (message.subtype !== "success") error = message.subtype;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(deadline);
  }
  // An aborted turn produced no answer a reader could have received, whatever
  // it emitted on the way, so it is excluded rather than scored.
  if (abortController.signal.aborted) error = "turn_budget_exceeded";
  const plan = planClassification(textParts);
  return {
    prompt: prompt.id,
    invites: prompt.invites,
    classifiable: prompt.classifiable,
    arm,
    rep,
    calls: kinds.length,
    kinds,
    rejectedCalls,
    otherTools: [...otherTools].sort(),
    candidates: (plan?.candidates ?? []).map((planned) => planned.candidate.kind),
    kvRuns: kvRunColumns(textParts),
    answerChars: textParts.join("").length,
    durationMs: Date.now() - started,
    costUsd,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    modelTurns,
    firstFrameMs,
    ...(ttftMs === undefined ? {} : { ttftMs }),
    answer: textParts.join("\n\n"),
    alwaysLoad,
    ...(claudeCode ? { claudeCode } : {}),
    ...(apiKeySource ? { apiKeySource } : {}),
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
 * One `count_tokens` call on `MODEL`, with one user turn, under whichever
 * credential the run holds. Whether the endpoint takes a subscription token
 * had not been tried when #336 was triaged; if it refuses one, the error says
 * so, and each live turn's `usage.input_tokens` is the fallback, a count
 * rather than an estimate.
 */
async function countTokens(credential: LiveCredential, body: Record<string, unknown>): Promise<number> {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: credential.headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });
  if (!res.ok) {
    const hint =
      credential.source === "CLAUDE_CODE_OAUTH_TOKEN"
        ? " (under CLAUDE_CODE_OAUTH_TOKEN: if the endpoint refuses subscription auth, run --schema-forms and read the per-turn input tokens instead)"
        : "";
    throw new Error(`count_tokens ${res.status}${hint}: ${await res.text()}`);
  }
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

/**
 * `--tokens`: what the bridge tools weigh, both ways, with no live turn.
 *
 * #148's whole question is arithmetic, and the issue is explicit that it has
 * to be counted rather than estimated. So the schemas are taken from the real
 * server — `createBrainUiMcpServer` with every handler supplied, listed over
 * an in-memory MCP client, which is the same serialisation the CLI forwards —
 * and priced by `count_tokens` in the two shapes the API actually receives:
 * a plain tool definition, and one carrying `defer_loading: true` alongside a
 * tool-search tool. The CLI uses the API's own tool search rather than a
 * client-side index (`tool_search_tool_regex` / `tool_search_tool_bm25` are in
 * the shipped binary, as is `defer_loading`), so those two shapes are what
 * `alwaysLoad` chooses between.
 *
 *   bun scripts/measure-show-block.ts --tokens
 */
async function schemaCost(credential: LiveCredential): Promise<{
  rows: { name: string; loaded: number; briefTokens: number; briefLines: number }[];
  forms: { arm: SchemaArm; chars: number; definitions: number; loaded: number }[];
  baseline: number;
  deferredAll: number;
  loadedAll: number;
}> {
  // Imported here rather than at the top: the rate measurement does not need
  // an MCP client, and a `--tokens` run should not pay for a staged brain.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createBrainUiMcpServer } = await import(
    "../packages/ui-backend-claude/src/ask-user-tool.js"
  );

  // Every handler supplied, because a handler the host does not pass means a
  // tool that is never registered: the roster this prices is the one a fully
  // wired deployment offers. The handlers are never called.
  const unreachable = () => Promise.reject(new Error("not called"));
  const server = createBrainUiMcpServer({
    askUser: unreachable as never,
    getLocation: unreachable as never,
    requestMask: unreachable as never,
    queryActivity: unreachable as never,
    brainPath: BRAIN_PATH,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure-show-block", version: "0.1.0" }, {});
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();

  const count = (body: Record<string, unknown>) => countTokens(credential, body);

  // The tool-search tool and one ordinary tool are the floor both sides are
  // measured against: the API rejects a request in which every tool is
  // deferred, and the search tool is present either way, since the CLI defers
  // plenty of other servers. Subtracting this floor leaves the delta that
  // `alwaysLoad` is actually responsible for.
  const search = {
    type: "tool_search_tool_bm25_20251119",
    name: "tool_search_tool_bm25",
  };
  const anchor = {
    name: "noop",
    description: "An undeferred tool, so the request is legal.",
    input_schema: { type: "object", properties: {} },
  };
  const asApi = (tool: (typeof tools)[number], defer: boolean) => ({
    // The MCP prefix is part of what the model reads, so it is part of the
    // count.
    name: `${BRIDGE_TOOL_POSTURE.claudePrefix}${tool.name}`,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(defer ? { defer_loading: true } : {}),
  });

  const baseline = await count({ tools: [search, anchor] });
  const rows: { name: string; loaded: number; briefTokens: number; briefLines: number }[] = [];
  const emptySystem = await count({ system: "x" });
  for (const tool of tools) {
    const contract = BRIDGE_TOOL_CONTRACTS.find((entry) => entry.name === tool.name);
    const brief = contract
      ? contract.brief(
          BRIDGE_TOOL_POSTURE.visibleName(contract.name as BridgeToolName, "claude")
        )
      : "";
    rows.push({
      name: tool.name,
      loaded: (await count({ tools: [search, anchor, asApi(tool, false)] })) - baseline,
      briefTokens: brief ? (await count({ system: `x${brief}` })) - emptySystem : 0,
      briefLines: brief ? brief.split("\n").length : 0,
    });
  }
  // #336: `show_block` in each schema form, priced the same way as the rows
  // above, against the same floor.
  const forms: { arm: SchemaArm; chars: number; definitions: number; loaded: number }[] = [];
  for (const arm of SCHEMA_ARM_NAMES) {
    const listed = await listedShowBlock(arm);
    const definitions = (listed.inputSchema as { definitions?: Record<string, unknown> }).definitions;
    forms.push({
      arm,
      chars: JSON.stringify(listed.inputSchema).length,
      definitions: definitions ? Object.keys(definitions).length : 0,
      loaded:
        (await count({ tools: [search, anchor, asApi({ name: "show_block", ...listed } as (typeof tools)[number], false)] })) -
        baseline,
    });
  }
  return {
    rows,
    forms,
    baseline,
    deferredAll:
      (await count({ tools: [search, anchor, ...tools.map((t) => asApi(t, true))] })) -
      baseline,
    loadedAll:
      (await count({ tools: [search, anchor, ...tools.map((t) => asApi(t, false))] })) -
      baseline,
  };
}

/**
 * What the brief costs, counted by the API rather than estimated: the same
 * system-prompt append with and without the block line, priced by
 * `count_tokens`. The keep-or-retire trade needs both halves to be real.
 */
async function briefCost(credential: LiveCredential): Promise<{
  lines: number;
  chars: number;
  tokens: number;
}> {
  const append = (block: string | false) =>
    buildSystemPromptAppend({ client: CLIENT, turnBudgetMs: TURN_BUDGET_MS, tools: { block } });
  const withBrief = append(BLOCK_TOOL);
  const without = append(false);
  const count = (system: string) => countTokens(credential, { system });
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

/**
 * The turns a rate may be computed over. A turn that errored or hit `maxTurns`
 * produced no answer a reader would have seen, so counting it as "did not call
 * the tool" would let an API failure read as the brief not working. They are
 * reported on their own instead.
 */
function completed(runs: readonly TurnResult[]): TurnResult[] {
  return runs.filter((run) => !run.error);
}

function armRows(runs: readonly TurnResult[]): string[] {
  const rows = ["| arm | turns | turns with a `show_block` call | rate | no call, but a candidate the pass would see |", "| --- | --- | --- | --- | --- |"];
  for (const arm of ARMS) {
    const mine = completed(runs).filter((run) => run.arm === arm);
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
    `| prompt | invites | pass can reach it | ${ARMS.map((arm) => `${arm}: calls/turns`).join(" | ")} |`,
    `| --- | --- | --- | ${ARMS.map(() => "---").join(" | ")} |`,
  ];
  for (const prompt of PROMPTS) {
    const cell = (arm: ArmName): string => {
      const mine = completed(runs).filter(
        (run) => run.prompt === prompt.id && run.arm === arm
      );
      const called = mine.filter((run) => run.calls > 0);
      const kinds = [...new Set(called.flatMap((run) => run.kinds))];
      return `${called.length}/${mine.length}${kinds.length ? ` (${kinds.join(", ")})` : ""}`;
    };
    rows.push(
      `| \`${prompt.id}\` | ${prompt.invites} | ${prompt.classifiable ? "yes" : "no"} | ${ARMS.map(cell).join(" | ")} |`
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
      const mine = completed(runs).filter(
        (run) => run.arm === arm && run.classifiable === classifiable
      );
      const called = mine.filter((run) => run.calls > 0);
      rows.push(
        `| ${classifiable ? "yes" : "no"} — ${arm} | ${mine.length} | ${called.length} | ${pct(called.length, mine.length)} |`
      );
    }
  }
  return rows;
}

/**
 * The parse rate: of the calls a completed turn made, how many its arm's
 * schema accepted. #336 needs it beside the call rate, because a shorter
 * schema that the model fills wrongly more often draws fewer blocks for a
 * reason the call rate alone would hide.
 */
function parseRows(runs: readonly TurnResult[]): string[] {
  const rows = [
    "| arm | turns | calls made | parsed | rejected | parse rate |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of ARMS) {
    const mine = completed(runs).filter((run) => run.arm === arm);
    const parsed = mine.reduce((sum, run) => sum + run.calls, 0);
    const rejected = mine.reduce((sum, run) => sum + run.rejectedCalls, 0);
    rows.push(
      `| ${arm} | ${mine.length} | ${parsed + rejected} | ${parsed} | ${rejected} | ${parsed + rejected ? pct(parsed, parsed + rejected) : "—"} |`
    );
  }
  return rows;
}

/** Mean of `pick` over the turns, rounded — every cell below is a mean. */
function mean(runs: readonly TurnResult[], pick: (run: TurnResult) => number): number {
  if (runs.length === 0) return 0;
  return Math.round(runs.reduce((sum, run) => sum + pick(run), 0) / runs.length);
}

/**
 * What a turn billed on the input side and how long it took to say anything.
 * The prompt is re-sent on every model round-trip, so the per-round-trip
 * column is the one that compares against a per-turn schema cost; the
 * fresh/cached split matters because the tools block sits at the front of the
 * cache prefix, where a re-read is a tenth of the price of a fresh read.
 */
function costRows(runs: readonly TurnResult[]): string[] {
  const rows = [
    "| arm | turns | model round-trips | fresh input | cache writes | cache reads | input per round-trip | first frame | ttft | $ / turn |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of ARMS) {
    const mine = completed(runs).filter((run) => run.arm === arm);
    const perTrip = mean(mine, (run) =>
      run.modelTurns > 0
        ? (run.inputTokens + run.cacheCreationTokens + run.cacheReadTokens) / run.modelTurns
        : 0
    );
    const withTtft = mine.filter((run) => run.ttftMs !== undefined);
    rows.push(
      `| ${arm} | ${mine.length} | ${mean(mine, (r) => r.modelTurns)} | ${mean(mine, (r) => r.inputTokens)} | ${mean(mine, (r) => r.cacheCreationTokens)} | ${mean(mine, (r) => r.cacheReadTokens)} | ${perTrip} | ${mean(mine, (r) => r.firstFrameMs)} ms | ${withTtft.length ? `${mean(withTtft, (r) => r.ttftMs ?? 0)} ms` : "—"} | $${(mine.reduce((sum, run) => sum + run.costUsd, 0) / Math.max(mine.length, 1)).toFixed(3)} |`
    );
  }
  return rows;
}

/** Loaded against deferred, when a `--both-arms` run produced both. */
function loadModeRows(runs: readonly TurnResult[]): string[] {
  if (new Set(runs.map((run) => run.alwaysLoad)).size < 2) return [];
  return [
    "",
    "## Loaded against deferred (D44)",
    "",
    "| bridge server | turns | ran `ToolSearch` | called `show_block` | first frame |",
    "| --- | --- | --- | --- | --- |",
    ...[true, false].map((alwaysLoad) => {
      const mine = completed(runs).filter((run) => run.alwaysLoad === alwaysLoad);
      const searched = mine.filter((run) => run.otherTools.includes("ToolSearch"));
      const called = mine.filter((run) => run.calls > 0);
      return `| ${alwaysLoad ? "loaded" : "deferred"} | ${mine.length} | ${searched.length} | ${called.length} | ${mean(mine, (run) => run.firstFrameMs)} ms |`;
    }),
    "",
  ];
}

/** The SDK copy the backend loads, and so the one this harness measured. */
function installedSdkVersion(): string {
  return (JSON.parse(readFileSync(join(dirname(SDK_ENTRY), "package.json"), "utf8")) as { version: string }).version;
}

function report(
  runs: readonly TurnResult[],
  cost: { lines: number; chars: number; tokens: number } | null,
  reps: number,
  credential: LiveCredential,
  forms: readonly { arm: SchemaArm; chars: number }[]
): string {
  const errors = runs.filter((run) => run.error);
  return [
    SCHEMA_FORMS ? "# `show_block` rate by schema form (#336)" : "# `show_block` rate with the classification pass on",
    "",
    `Model \`${MODEL}\`, ${new Set(runs.map((run) => run.prompt)).size} prompts x ${ARMS.length} arms x ${new Set(runs.map((run) => run.alwaysLoad)).size} load mode(s) x ${reps} reps = ${runs.length} live turns, $${runs.reduce((sum, run) => sum + run.costUsd, 0).toFixed(2)} at API prices as the SDK reports them.`,
    `Credential: \`${credential.source}\`${credential.source === "CLAUDE_CODE_OAUTH_TOKEN" ? " (subscription; the dollar figure is what the turns would have cost, not what was billed)" : ""}. \`apiKeySource\` in each turn's \`init\`: ${[...new Set(runs.map((run) => run.apiKeySource ?? "unreported"))].join(", ")}.`,
    ...(SCHEMA_FORMS
      ? [
          "",
          "Arms are schema forms, each with the brief on and the bridge server loaded, so the schema is the only difference: " +
            forms.map((form) => `\`${form.arm}\` lists ${form.chars} schema characters`).join(", ") +
            ". The listing is the Agent SDK's own `tools/list`; the `flat` arm is checked byte for byte against the production factory before any turn.",
          `API acceptance: ${SCHEMA_ARM_NAMES.filter((arm) => arm !== "flat")
            .map((arm) => `${runs.filter((run) => run.arm === arm && !run.error).length} completed turn(s) carried \`${arm}\``)
            .join("; ")}. A schema the API refused would error every turn in its arm.`,
        ]
      : []),
    errors.length
      ? `**${errors.length} turn(s) did not complete** and are excluded from every rate below; they are listed at the end. A rate is only over turns that produced an answer.`
      : `Every turn completed, so no rate below is drawn over a partial sample.`,
    `Brain: a copy of \`packages/core/fixtures/corpus/\`. Harness: \`scripts/measure-show-block.ts\`.`,
    `Taken ${new Date().toISOString().slice(0, 10)}.`,
    "",
    cost
      ? `The brief costs **${cost.tokens} input tokens** (${cost.lines} lines, ${cost.chars} characters) on every turn.`
      : "The brief's cost was not counted: `count_tokens` refused this credential.",
    "",
    `Calls the contract's schema REJECTED, and which therefore drew nothing, are not counted as calls: ${runs.reduce((sum, run) => sum + run.rejectedCalls, 0)} across the run.`,
    `Turns that delegated to a subagent (\`Agent\`, foregrounded by production's own hook): ${runs.filter((run) => run.otherTools.includes("Agent")).length}. Subagent frames are never counted.`,
    `Runtime: \`@anthropic-ai/claude-agent-sdk\` ${installedSdkVersion()}, Claude Code ${[...new Set(runs.map((run) => run.claudeCode ?? "unknown"))].join(", ")} as each turn's \`init\` reported it.`,
    new Set(runs.map((run) => run.alwaysLoad)).size > 1
      ? "MCP tools ran BOTH ways (`--both-arms`); the load-mode table below compares them."
      : `MCP tools ${runs[0]?.alwaysLoad ? "were in the prompt (\`--always-load\`), which is what ships since D44" : "sat behind tool search (\`--always-load\` not passed), which is what shipped BEFORE D44"}.`,
    ...loadModeRows(runs),
    "",
    "## `ToolSearch` against calls",
    "",
    "A deferred tool is not in the model's context until it searches, so this is the mechanism table. Completed turns only, like every rate above.",
    "",
    "| arm | ran `ToolSearch` | called `show_block` | called without searching |",
    "| --- | --- | --- | --- |",
    ...ARMS.map((arm) => {
      const mine = completed(runs).filter((run) => run.arm === arm);
      const searched = mine.filter((run) => run.otherTools.includes("ToolSearch"));
      const called = mine.filter((run) => run.calls > 0);
      const blind = called.filter((run) => !run.otherTools.includes("ToolSearch"));
      return `| ${arm} | ${searched.length} of ${mine.length} | ${called.length} | ${blind.length} |`;
    }),
    "",
    "## Rate per arm",
    "",
    ...armRows(runs),
    "",
    "## Parse rate per arm",
    "",
    "Calls are counted per call, not per turn: a turn can call more than once.",
    "",
    ...parseRows(runs),
    "",
    "## Split by whether the classification pass can reach the kind",
    "",
    `The pass reaches ${CLASSIFIABLE_KINDS.join(", ")}. It cannot reach \`trend\` or \`bars\`: no markdown shape maps to them.`,
    "",
    ...splitRows(runs),
    "",
    "## Per prompt",
    "",
    ...promptRows(runs),
    "",
    "## Key-and-value runs",
    "",
    "Completed turns. `written` counts the shape the model typed, without the detector's rules; `detected` is what the classification pass found. The middle column is set by what the corpus carries (`me/identity.md` holds one run with an address), not by how often a real answer holds one.",
    "",
    ...kvRunRows(
      ARMS.map((arm) => ({
        label: arm,
        turns: completed(runs)
          .filter((run) => run.arm === arm)
          .map((run) => run.kvRuns),
      }))
    ),
    "",
    "## What a turn billed, and how fast it started",
    "",
    "Means over completed turns. Read `input per round-trip` against the schema",
    "arithmetic from `--tokens`: the prompt is re-sent on every round-trip, so",
    "that is the column a per-turn tool schema is actually added to.",
    "",
    ...costRows(runs),
    "",
    errors.length
      ? `## Turns excluded\n\n${errors.map((run) => `- \`${run.prompt}\` ${run.arm} rep${run.rep}: ${run.error}`).join("\n")}\n\nThe arms are only comparable when the excluded counts are close. Re-run the missing cells before reading the table above as an A/B.`
      : "No turn errored.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const credential = liveCredential();
  if (!credential) {
    console.error(
      `${basename(import.meta.path)}: needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN — this is a live measurement, not a test.`
    );
    process.exit(1);
  }
  if (SCHEMA_FORMS && process.argv.includes("--both-arms")) {
    console.error(`${basename(import.meta.path)}: --schema-forms runs the loaded configuration only; drop --both-arms.`);
    process.exit(1);
  }
  // `--tokens` answers #148's arithmetic half. It runs no live turn, so it
  // costs a handful of `count_tokens` calls rather than dollars.
  if (process.argv.includes("--tokens")) {
    const schema = await schemaCost(credential);
    const brief = await briefCost(credential);
    console.log(
      [
        "# What the bridge tools weigh, both ways",
        "",
        `Model \`${MODEL}\`, counted by \`count_tokens\` over the schemas \`createBrainUiMcpServer\` actually registers, under \`${credential.source}\`. Taken ${new Date().toISOString().slice(0, 10)}.`,
        "",
        `Floor both columns are measured against — a tool-search tool plus one undeferred tool, which is the minimum legal shape: ${schema.baseline} tokens.`,
        "",
        "| bridge tool | always loaded | its brief | brief lines |",
        "| --- | --- | --- | --- |",
        ...schema.rows.map(
          (row) =>
            `| \`${row.name}\` | ${row.loaded} | ${row.briefTokens} | ${row.briefLines} |`
        ),
        `| **all five** | **${schema.loadedAll}** | **${schema.rows.reduce((sum, row) => sum + row.briefTokens, 0)}** | ${schema.rows.reduce((sum, row) => sum + row.briefLines, 0)} |`,
        "",
        `All five DEFERRED, which is what shipped BEFORE D44: **${schema.deferredAll}** tokens — and the same number for one deferred tool as for five, so the API prices the deferred set as a fixed block rather than per tool.`,
        "",
        `The block brief alone: ${brief.tokens} tokens, ${brief.lines} lines, ${brief.chars} characters.`,
        "",
        "## `show_block` by schema form (#336)",
        "",
        "Each form as the Agent SDK's own server lists it, priced like the rows above, against the same floor.",
        "",
        "| form | schema characters | definitions | always loaded | against `flat` |",
        "| --- | --- | --- | --- | --- |",
        ...schema.forms.map(
          (form) =>
            `| \`${form.arm}\` | ${form.chars} | ${form.definitions} | ${form.loaded} | ${form.loaded - schema.forms[0]!.loaded} |`
        ),
        "",
      ].join("\n")
    );
    return;
  }

  const reps = Number(arg("reps", "3"));
  const concurrency = Number(arg("concurrency", "4"));
  const only = arg("only", "");
  const out = arg("out", "");
  const md = arg("md", "");
  const prompts = only ? PROMPTS.filter((p) => only.split(",").includes(p.id)) : PROMPTS;

  // Listing every form before any turn also runs the flat arm's drift check,
  // so a baseline that no longer matches production refuses to start.
  const forms = SCHEMA_FORMS
    ? await Promise.all(
        SCHEMA_ARM_NAMES.map(async (arm) => ({
          arm,
          chars: JSON.stringify((await listedShowBlock(arm)).inputSchema).length,
        }))
      )
    : [];
  for (const form of forms) console.log(`${form.arm}: ${form.chars} schema characters`);

  const bothArms = process.argv.includes("--both-arms");
  if (bothArms) assertNoServerLevelAlwaysLoad();
  const loadModes = bothArms ? [true, false] : [ALWAYS_LOAD];
  const tasks: (() => Promise<TurnResult>)[] = [];
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const arm of ARMS) {
      for (const prompt of prompts) {
        for (const alwaysLoad of loadModes) tasks.push(() => runTurn(prompt, arm, rep, alwaysLoad));
      }
    }
  }

  const done: TurnResult[] = [];
  const runs = await pool(tasks, concurrency, (result) => {
    done.push(result);
    console.log(
      `[${done.length}/${tasks.length}] ${result.arm}\trep${result.rep}\t${result.prompt}\tcalls=${result.calls}${result.kinds.length ? `(${result.kinds.join(",")})` : ""}${result.rejectedCalls ? `\trejected=${result.rejectedCalls}` : ""}\tcandidates=${result.candidates.join(",") || "-"}\t${result.durationMs}ms${result.error ? `\tERROR ${result.error}` : ""}`
    );
    if (out) void Bun.write(out, JSON.stringify(done, null, 2));
  });

  if (out) await Bun.write(out, JSON.stringify(runs, null, 2));
  const cost = await briefCost(credential).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    return null;
  });
  const text = report(runs, cost, reps, credential, forms);
  if (md) await Bun.write(md, text);
  console.log(`\n${text}`);
}

await main();
