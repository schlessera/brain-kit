// Re-measures the Claude Code runtime behaviours the permission design rests
// on, against whatever SDK and CLI this workspace installs (#209,
// docs/decisions/claude-code-runtime.md, "Re-checking a measured behaviour
// when the version moves").
//
//   bun scripts/measure-claude-runtime.ts [--out probe.json] [--only <case>,…]
//
// Keyless, and nothing leaves the machine. The CLI is the real one the lockfile
// installs (the Agent SDK's bundled binary); the MODEL is a scripted stand-in
// on loopback, set as `ANTHROPIC_BASE_URL`, that answers the first request of
// a turn with one planned tool call and every later request with plain text.
// That is enough, because every behaviour measured here is the CLI's own
// permission precedence — which hook, rule or callback admits a tool call the
// model asked for — and none of it depends on what a real model would have
// chosen to ask. The credentials are bogus.
//
// Each case names the property it measures and carries the control that
// property needs:
//   - a BYPASS (the tool runs without `canUseTool`) is paired with the same
//     call under the enforcement `ask`, where the callback must be consulted;
//   - an OVERRIDE (a hook stops or redirects the call) is paired with the same
//     call without the overriding hook, where the tool must run;
//   - a NOT-A-BYPASS (the callback is consulted) is paired with an allowing
//     callback, where the tool must run.
// A case also requires its planned tool call to have been sent to the CLI and
// every hook it installs to have fired. Anything else — no tool call, an auth
// or `init` failure, a hook that never fired — is INCONCLUSIVE, and an
// inconclusive or failed case makes the run exit non-zero.
//
// The run records the SDK version, the `claude_code_version` the CLI reported
// in `init`, and the date. When a case's result differs from what the code
// says, that is a finding to file, not a constant to bump.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  CanUseTool,
  HookCallback,
  Options,
  PreToolUseHookInput,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { createClaudeBackend, defineProfiles, MEASURED_RUNTIME } from "../packages/ui-backend-claude/src/index";

// The SDK the BACKEND loads, not whatever this directory would resolve: a
// hoisted second copy must not answer for the one the measurements are about.
const BACKEND_SOURCE = join(import.meta.dir, "../packages/ui-backend-claude/src");
const SDK_ENTRY = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", BACKEND_SOURCE);
const { createSdkMcpServer, query, tool } = (await import(SDK_ENTRY)) as typeof import("@anthropic-ai/claude-agent-sdk");

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

interface PlannedCall {
  name: string;
  input: Record<string, unknown>;
}

interface ModelLog {
  /** Requests that offered the planned tool, i.e. the turn's main-loop calls. */
  mainRequests: number;
  /** The planned call went out to the CLI. */
  callSent: boolean;
  /** Auth headers of every /v1/messages request. */
  auth: Array<{ xApiKey: string | null; authorization: string | null }>;
  /** Tool names each main request offered. */
  offered: string[][];
  /** Whether each main request marked any tool `defer_loading`. */
  deferred: string[][];
}

const CALL_ID = "toolu_probe_1";

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function messageStart(): unknown {
  return {
    type: "message_start",
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-probe",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function textReply(text: string): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function toolReply(call: PlannedCall): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: CALL_ID, name: call.name, input: {} } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

/** A tool result's text, with any tool references ToolSearch returned named inline. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part?.text === "string" ? part.text : typeof part?.tool_name === "string" ? `[tool:${part.tool_name}]` : ""
      )
      .join("");
  }
  return "";
}

/** A loopback Messages API that plays one planned tool call per turn. */
function scriptedModel(): {
  url: string;
  plan(call: PlannedCall | null): ModelLog;
  stop(): void;
} {
  let call: PlannedCall | null = null;
  let log: ModelLog = freshLog();
  function freshLog(): ModelLog {
    return { mainRequests: 0, callSent: false, auth: [], offered: [], deferred: [] };
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/v1/messages") return Response.json({});
      log.auth.push({
        xApiKey: req.headers.get("x-api-key"),
        authorization: req.headers.get("authorization"),
      });
      const body = (await req.json()) as {
        tools?: Array<{ name: string; defer_loading?: boolean }>;
        messages?: Array<{ role: string; content: unknown }>;
      };
      const tools = body.tools ?? [];
      const names = tools.map((t) => t.name);
      if (!call || !names.includes(call.name)) return textReply("ok");
      log.mainRequests++;
      log.offered.push(names);
      log.deferred.push(tools.filter((t) => t.defer_loading).map((t) => t.name));
      if (log.callSent) return textReply("done");
      log.callSent = true;
      return toolReply(call);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    plan(next) {
      call = next;
      log = freshLog();
      return log;
    },
    stop() {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// One probe turn
// ---------------------------------------------------------------------------

const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;

interface TurnSetup {
  call: PlannedCall;
  /** Project settings for the turn's cwd. */
  projectSettings?: Record<string, unknown>;
  /**
   * In-process PreToolUse hooks, by name, registered in this order with a
   * matcher for the planned tool only. Each is handed a recorder, so its
   * firing is tied to the planned call's tool-use id.
   */
  hooks?: Record<string, (record: HookRecorder) => HookCallback>;
  /** What `canUseTool` answers. It records every consultation either way. */
  callback: "allow" | "deny";
  /** An in-process MCP server whose tools are deferred, so ToolSearch exists. */
  deferredMcp?: boolean;
  /** The same server created with `alwaysLoad`, as production does since D44. */
  loadedMcp?: boolean;
  allowedTools?: string[];
}

interface HookCall {
  toolUseId: string;
  command: string | undefined;
  startedAt: number;
  endedAt?: number;
}

interface HookRecorder {
  start(input: PreToolUseHookInput): HookCall;
}

interface TurnObservation {
  claudeCodeVersion: string | undefined;
  /** The CLI emitted the planned tool_use, with its id, in the main loop. */
  toolUseSeen: boolean;
  /** canUseTool consultations for the planned call only. */
  callbackCalls: Array<{ tool: string; input: Record<string, unknown> }>;
  hookCalls: Record<string, HookCall[]>;
  /** The turn's result subtype; anything but success makes a case inconclusive. */
  resultSubtype: string | undefined;
  /** tool_result blocks the CLI produced for the planned call. */
  toolResults: Array<{ isError: boolean; text: string }>;
  /** The tools the first main-loop request offered, and which were deferred. */
  offered: string[];
  deferred: string[];
  error?: string;
}

async function runTurn(
  model: ReturnType<typeof scriptedModel>,
  cwd: string,
  home: string,
  setup: TurnSetup
): Promise<TurnObservation> {
  const log = model.plan(setup.call);
  if (setup.projectSettings) {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(setup.projectSettings));
  }
  const callbackCalls: TurnObservation["callbackCalls"] = [];
  const hookCalls: Record<string, HookCall[]> = {};
  const hookCallbacks = Object.entries(setup.hooks ?? {}).map(([name, make]) => {
    hookCalls[name] = [];
    return make({
      start(input) {
        const call: HookCall = {
          toolUseId: input.tool_use_id,
          command: (input.tool_input as { command?: string } | undefined)?.command,
          startedAt: performance.now(),
        };
        hookCalls[name]!.push(call);
        return call;
      },
    });
  });
  const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
    if (toolUseID === CALL_ID && toolName === setup.call.name) callbackCalls.push({ tool: toolName, input });
    return setup.callback === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "denied by the probe" };
  };
  const options: Options = {
    cwd,
    settingSources: ["project"],
    maxTurns: 3,
    allowedTools: setup.allowedTools ?? [],
    canUseTool,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: model.url,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Tool search is off by default for a non-first-party base URL, which the
      // loopback model is; production runs against Anthropic, where it is on.
      ...(setup.deferredMcp || setup.loadedMcp ? { ENABLE_TOOL_SEARCH: "true" } : {}),
    },
    // A model id the CLI recognises, so model-dependent features (tool search)
    // behave as they do in production. The loopback model ignores it.
    model: "claude-sonnet-4-6",
    ...(hookCallbacks.length > 0
      ? { hooks: { PreToolUse: [{ matcher: `^${setup.call.name}$`, hooks: hookCallbacks }] } }
      : {}),
    ...(setup.deferredMcp || setup.loadedMcp
      ? {
          mcpServers: {
            probe: createSdkMcpServer({
              name: "probe",
              tools: [tool("probe_lookup", "Looks something up for the probe.", { q: z.string() }, async () => ({ content: [{ type: "text", text: "found" }] }))],
              ...(setup.loadedMcp ? { alwaysLoad: true } : {}),
            }),
          },
        }
      : {}),
  };
  let claudeCodeVersion: string | undefined;
  let error: string | undefined;
  let toolUseSeen = false;
  let resultSubtype: string | undefined;
  const toolResults: TurnObservation["toolResults"] = [];
  try {
    for await (const message of query({ prompt: "Run the planned tool call.", options }) as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "init") {
        claudeCodeVersion = (message as { claude_code_version?: string }).claude_code_version;
      }
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        for (const part of message.message.content) {
          if (part.type === "tool_use" && part.id === CALL_ID && part.name === setup.call.name) toolUseSeen = true;
        }
      }
      if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const part of message.message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
          if (part.type === "tool_result" && part.tool_use_id === CALL_ID) {
            toolResults.push({ isError: part.is_error === true, text: resultText(part.content) });
          }
        }
      }
      if (message.type === "result") {
        resultSubtype = message.subtype;
        break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    claudeCodeVersion,
    toolUseSeen,
    callbackCalls,
    hookCalls,
    resultSubtype,
    toolResults,
    offered: log.offered[0] ?? [],
    deferred: log.deferred[0] ?? [],
    ...(error ? { error } : {}),
  };
}


// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

type Verdict = "pass" | "fail" | "inconclusive";

interface CaseResult {
  name: string;
  /** What the code relies on, in one sentence. */
  claim: string;
  /** Where the claim is written down. */
  sites: string[];
  verdict: Verdict;
  /** Why, when not "pass". */
  detail?: string;
  observations: Record<string, TurnObservation>;
}

interface Scratch {
  cwd: string;
  home: string;
  path(name: string): string;
}

function scratch(): Scratch {
  const cwd = mkdtempSync(join(tmpdir(), "probe-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "probe-home-"));
  mkdirSync(join(home, ".claude"));
  return { cwd, home, path: (name) => join(cwd, name) };
}

/** The enforcement hook's answer: `ask`, for every call. */
const askHook = (record: HookRecorder): HookCallback => async (input) => {
  record.start(input as PreToolUseHookInput).endedAt = performance.now();
  return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
};

const denyHook = (record: HookRecorder): HookCallback => async (input) => {
  record.start(input as PreToolUseHookInput).endedAt = performance.now();
  return {
    continue: true,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "probe" },
  };
};

/** Rewrites the command, with NO decision, optionally after a delay. */
const rewriteHook =
  (command: string, delayMs = 0) =>
  (record: HookRecorder): HookCallback =>
  async (input) => {
    const call = record.start(input as PreToolUseHookInput);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    call.endedAt = performance.now();
    return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command } } };
  };

/** A project-settings PreToolUse hook that answers `allow` and leaves a marker. */
function settingsAllowHook(marker: string): Record<string, unknown> {
  const answer = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `touch ${marker}; echo '${answer}'` }] }],
    },
  };
}

const ran = (o: TurnObservation) => o.toolResults.some((r) => !r.isError);
/** Only the planned call's consultations are recorded, so any is the one. */
const consulted = (o: TurnObservation, name: string) => o.callbackCalls.some((c) => c.tool === name);

/**
 * INCONCLUSIVE unless the turn completed, the CLI emitted the planned tool
 * call, and every installed hook fired FOR THAT CALL.
 */
function premises(o: TurnObservation, label: string): string | null {
  if (!o.claudeCodeVersion) return `${label}: no init message${o.error ? ` (${o.error})` : ""}`;
  if (o.error) return `${label}: the turn failed (${o.error})`;
  if (o.resultSubtype !== "success") return `${label}: the turn ended ${o.resultSubtype ?? "without a result"}`;
  if (!o.toolUseSeen) return `${label}: the CLI never emitted the planned tool call`;
  for (const [hook, calls] of Object.entries(o.hookCalls)) {
    if (!calls.some((c) => c.toolUseId === CALL_ID)) return `${label}: the ${hook} hook never fired for the planned call`;
  }
  return null;
}

type Check = [ok: boolean, detail: string];

/** `--only a,b`: the cases to run; every case when absent. */
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? new Set(process.argv[i + 1]?.split(",")) : null;
})();

async function measure(
  model: ReturnType<typeof scriptedModel>,
  name: string,
  claim: string,
  sites: string[],
  turns: Record<string, (s: Scratch) => TurnSetup>,
  judge: (o: Record<string, TurnObservation>, s: Record<string, Scratch>) => Check[],
  extraPremise?: (o: Record<string, TurnObservation>, s: Record<string, Scratch>) => string | null
): Promise<CaseResult | null> {
  if (ONLY && !ONLY.has(name)) return null;
  const observations: Record<string, TurnObservation> = {};
  const scratches: Record<string, Scratch> = {};
  for (const [label, make] of Object.entries(turns)) {
    const sc = scratch();
    scratches[label] = sc;
    observations[label] = await runTurn(model, sc.cwd, sc.home, make(sc));
  }
  const missing =
    Object.entries(observations)
      .map(([label, o]) => premises(o, label))
      .find((m) => m !== null) ?? extraPremise?.(observations, scratches) ?? null;
  const result: CaseResult = { name, claim, sites, verdict: "pass", observations };
  if (missing) {
    result.verdict = "inconclusive";
    result.detail = missing;
  } else {
    const failed = judge(observations, scratches).filter(([ok]) => !ok);
    if (failed.length > 0) {
      result.verdict = "fail";
      result.detail = failed.map(([, d]) => d).join("; ");
    }
  }
  for (const sc of Object.values(scratches)) {
    rmSync(sc.cwd, { recursive: true, force: true });
    rmSync(sc.home, { recursive: true, force: true });
  }
  return result;
}

const HOOKS_SITE = "packages/ui-backend-claude/src/permission-hooks.ts (DO NOT WEAKEN THIS INTO A FALLTHROUGH)";
const ENFORCEMENT_TEST = "packages/ui-backend-claude/tests/allowlist-enforcement.test.ts";
const NO_GRANT_TEST = "packages/ui-backend-claude/tests/no-grant-surface.test.ts";
const REWRITE_SITE = "packages/ui-backend-claude/src/input-rewrite-hooks.ts";
const VOICE_RECORD = "docs/decisions/voice-permission.md (an in-process deny beats a settings allow)";
const BACKENDS_DOC = "docs/extending/agent-backends.md";

async function permissionCases(model: ReturnType<typeof scriptedModel>): Promise<CaseResult[]> {
  const bash = (command: string): PlannedCall => ({ name: "Bash", input: { command } });
  const results: Array<CaseResult | null> = [];

  results.push(
    await measure(
      model,
      "classifier-bypass",
      "The safe-command classifier runs `echo hi` under an EMPTY allowlist without consulting canUseTool; an `ask` forces the callback.",
      [HOOKS_SITE, ENFORCEMENT_TEST, NO_GRANT_TEST, BACKENDS_DOC],
      {
        bypass: () => ({ call: bash("echo hi"), callback: "deny" }),
        underAsk: () => ({ call: bash("echo hi"), callback: "deny", hooks: { ask: askHook } }),
      },
      (o) => [
        [ran(o.bypass!), "echo hi did not run with an empty allowlist"],
        [!consulted(o.bypass!, "Bash"), "canUseTool was consulted for echo hi"],
        [consulted(o.underAsk!, "Bash"), "the ask did not force canUseTool"],
        [!ran(o.underAsk!), "echo hi ran under ask with a denying callback"],
      ]
    )
  );

  results.push(
    await measure(
      model,
      "classifier-not-a-bypass",
      "`touch <path>` under the same empty allowlist goes to canUseTool; the command's shape decides.",
      [HOOKS_SITE, BACKENDS_DOC],
      {
        denied: (sc) => ({ call: bash(`touch ${sc.path("marker")}`), callback: "deny" }),
        allowed: (sc) => ({ call: bash(`touch ${sc.path("marker")}`), callback: "allow" }),
      },
      (o, sc) => [
        [consulted(o.denied!, "Bash"), "canUseTool was not consulted for touch"],
        [!existsSync(sc.denied!.path("marker")), "touch ran with a denying callback"],
        [consulted(o.allowed!, "Bash"), "canUseTool was not consulted in the allowing arm"],
        [existsSync(sc.allowed!.path("marker")), "touch did not run with an allowing callback"],
      ]
    )
  );

  const toolSearch: PlannedCall = { name: "ToolSearch", input: { query: "select:mcp__probe__probe_lookup", max_results: 1 } };
  results.push(
    await measure(
      model,
      "toolsearch-bypass",
      "A built-in tool (`ToolSearch`) runs with an empty allowlist and no callback; an `ask` forces the callback.",
      [HOOKS_SITE, ENFORCEMENT_TEST, NO_GRANT_TEST, BACKENDS_DOC],
      {
        bypass: () => ({ call: toolSearch, callback: "deny", deferredMcp: true }),
        underAsk: () => ({ call: toolSearch, callback: "deny", deferredMcp: true, hooks: { ask: askHook } }),
      },
      (o) => [
        [ran(o.bypass!), "ToolSearch did not run with an empty allowlist"],
        [!consulted(o.bypass!, "ToolSearch"), "canUseTool was consulted for ToolSearch"],
        [consulted(o.underAsk!, "ToolSearch"), "the ask did not force canUseTool for ToolSearch"],
        [!ran(o.underAsk!), "ToolSearch ran under ask with a denying callback"],
      ]
    )
  );

  results.push(
    await measure(
      model,
      "settings-hook-allow-bypass",
      "A project-settings PreToolUse hook returning `allow` admits a call without canUseTool; an in-process `ask` beats it.",
      [HOOKS_SITE, ENFORCEMENT_TEST, NO_GRANT_TEST, BACKENDS_DOC],
      {
        bypass: (sc) => ({
          call: bash(`touch ${sc.path("marker")}`),
          callback: "deny",
          projectSettings: settingsAllowHook(sc.path("settings-hook-ran")),
        }),
        underAsk: (sc) => ({
          call: bash(`touch ${sc.path("marker")}`),
          callback: "deny",
          projectSettings: settingsAllowHook(sc.path("settings-hook-ran")),
          hooks: { ask: askHook },
        }),
      },
      (o, sc) => [
        [existsSync(sc.bypass!.path("marker")), "the settings allow did not admit touch"],
        [!consulted(o.bypass!, "Bash"), "canUseTool was consulted despite the settings allow"],
        [consulted(o.underAsk!, "Bash"), "the in-process ask did not beat the settings allow"],
        [!existsSync(sc.underAsk!.path("marker")), "touch ran under ask with a denying callback"],
      ],
      (_o, sc) =>
        existsSync(sc.bypass!.path("settings-hook-ran")) && existsSync(sc.underAsk!.path("settings-hook-ran"))
          ? null
          : "the project-settings hook never ran"
    )
  );

  for (const [name, settings, claim] of [
    [
      "permissions-allow-not-a-bypass",
      { permissions: { allow: ["Bash(touch:*)", "Bash"] } },
      "A project-settings `permissions.allow` rule does not skip canUseTool.",
    ],
    [
      "bypass-mode-not-a-bypass",
      { permissions: { defaultMode: "bypassPermissions" } },
      "A project-settings `defaultMode: \"bypassPermissions\"` does not skip canUseTool.",
    ],
  ] as const) {
    results.push(
      await measure(
        model,
        name,
        claim,
        [HOOKS_SITE, BACKENDS_DOC],
        {
          denied: (sc) => ({ call: bash(`touch ${sc.path("marker")}`), callback: "deny", projectSettings: settings }),
          allowed: (sc) => ({ call: bash(`touch ${sc.path("marker")}`), callback: "allow", projectSettings: settings }),
        },
        (o, sc) => [
          [consulted(o.denied!, "Bash"), "canUseTool was not consulted"],
          [!existsSync(sc.denied!.path("marker")), "touch ran with a denying callback"],
          [consulted(o.allowed!, "Bash"), "canUseTool was not consulted in the allowing arm"],
          [existsSync(sc.allowed!.path("marker")), "touch did not run with an allowing callback"],
        ]
      )
    );
  }

  results.push(
    await measure(
      model,
      "rewrite-without-decision",
      "A PreToolUse hook's `updatedInput` applies with NO decision, and canUseTool then sees the rewritten input.",
      [REWRITE_SITE, HOOKS_SITE, ENFORCEMENT_TEST],
      {
        rewritten: (sc) => ({
          call: bash(`touch ${sc.path("a")}`),
          callback: "allow",
          hooks: { rewrite: rewriteHook(`touch ${sc.path("b")}`) },
        }),
        control: (sc) => ({ call: bash(`touch ${sc.path("a")}`), callback: "allow" }),
      },
      (o, sc) => [
        [
          o.rewritten!.callbackCalls.some((c) => String(c.input.command).includes(sc.rewritten!.path("b"))),
          "canUseTool did not see the rewritten command",
        ],
        [existsSync(sc.rewritten!.path("b")) && !existsSync(sc.rewritten!.path("a")), "the rewritten command did not execute"],
        [existsSync(sc.control!.path("a")), "the unrewritten control did not run"],
      ]
    )
  );

  results.push(
    await measure(
      model,
      "ask-keeps-rewrite",
      "An `ask` leaves another hook's `updatedInput` intact: the callback sees, and the call executes, the rewrite.",
      [HOOKS_SITE, ENFORCEMENT_TEST],
      {
        composed: (sc) => ({
          call: bash(`touch ${sc.path("a")}`),
          callback: "allow",
          hooks: { rewrite: rewriteHook(`touch ${sc.path("b")}`), ask: askHook },
        }),
      },
      (o, sc) => [
        [
          o.composed!.callbackCalls.some((c) => String(c.input.command).includes(sc.composed!.path("b"))),
          "canUseTool did not see the rewritten command under ask",
        ],
        [existsSync(sc.composed!.path("b")) && !existsSync(sc.composed!.path("a")), "the rewrite did not execute under ask"],
      ]
    )
  );

  // Registration order is varied, so "the last REGISTERED wins" and "the last
  // to FINISH wins" predict different outcomes in one of the two arms; the
  // overlap check tells parallel from sequential.
  const race = (first: "slow" | "fast") => (sc: Scratch): TurnSetup => {
    // Both wait, so run in parallel they are in flight at the same time.
    const slow = rewriteHook(`touch ${sc.path("slow")}`, 600);
    const fast = rewriteHook(`touch ${sc.path("fast")}`, 150);
    return {
      call: bash(`touch ${sc.path("a")}`),
      callback: "allow",
      hooks: first === "slow" ? { slow, fast } : { fast, slow },
    };
  };
  const raced = (o: TurnObservation, sc: Scratch, label: string): Check[] => {
    const slow = o.hookCalls.slow!.find((c) => c.toolUseId === CALL_ID)!;
    const fast = o.hookCalls.fast!.find((c) => c.toolUseId === CALL_ID)!;
    return [
      [slow.command?.includes(sc.path("a")) === true && fast.command?.includes(sc.path("a")) === true, `${label}: a hook saw another hook's rewrite`],
      [fast.startedAt < (slow.endedAt ?? Infinity) && slow.startedAt < (fast.endedAt ?? Infinity), `${label}: the hooks did not overlap`],
      [existsSync(sc.path("slow")) && !existsSync(sc.path("fast")), `${label}: the slower hook's rewrite did not win`],
    ];
  };
  results.push(
    await measure(
      model,
      "parallel-rewrites-last-wins",
      "Matching PreToolUse hooks run in parallel, each sees the ORIGINAL input, and the last to FINISH decides what runs — whatever the registration order.",
      [REWRITE_SITE, HOOKS_SITE],
      { slowFirst: race("slow"), slowLast: race("fast") },
      (o, sc) => [...raced(o.slowFirst!, sc.slowFirst!, "slow registered first"), ...raced(o.slowLast!, sc.slowLast!, "slow registered last")]
    )
  );

  results.push(
    await measure(
      model,
      "inprocess-deny-beats-settings-allow",
      "An in-process PreToolUse `deny` beats a project-settings hook's `allow`: the tool does not run.",
      [VOICE_RECORD, HOOKS_SITE],
      {
        denied: (sc) => ({
          call: bash(`touch ${sc.path("marker")}`),
          callback: "allow",
          projectSettings: settingsAllowHook(sc.path("settings-hook-ran")),
          hooks: { deny: denyHook },
        }),
        control: (sc) => ({
          call: bash(`touch ${sc.path("marker")}`),
          callback: "deny",
          projectSettings: settingsAllowHook(sc.path("settings-hook-ran")),
        }),
      },
      (_o, sc) => [
        [!existsSync(sc.denied!.path("marker")), "the tool ran despite the in-process deny"],
        [existsSync(sc.control!.path("marker")), "the settings allow alone did not run the tool"],
      ],
      (_o, sc) => (existsSync(sc.denied!.path("settings-hook-ran")) ? null : "the project-settings hook never ran")
    )
  );

  const lookup = "mcp__probe__probe_lookup";
  results.push(
    await measure(
      model,
      "d44-always-load-reaches-the-model",
      "An MCP tool stamped `alwaysLoad` reaches the model undeferred; without the stamp it is deferred behind tool search. The server config itself carries no `alwaysLoad`, so the in-process server never joins the startup wait set.",
      ["docs/decisions/design-kit.md (D44)", "packages/ui-backend-claude/src/ask-user-tool.ts"],
      {
        loaded: () => ({ call: bash("echo hi"), callback: "allow", loadedMcp: true }),
        deferred: () => ({ call: toolSearch, callback: "allow", deferredMcp: true }),
      },
      (o) => {
        const config = createSdkMcpServer({ name: "probe", tools: [], alwaysLoad: true });
        return [
          [!("alwaysLoad" in config), "createSdkMcpServer put alwaysLoad on the server config"],
          [o.loaded!.offered.includes(lookup) && !o.loaded!.deferred.includes(lookup), "the stamped tool did not reach the model undeferred"],
          [!o.deferred!.offered.includes(lookup) || o.deferred!.deferred.includes(lookup), "the unstamped tool was not deferred"],
          [
            o.deferred!.toolResults.some((r) => !r.isError && r.text.includes("probe_lookup")),
            "ToolSearch did not find the deferred tool, so its absence proves nothing",
          ],
        ];
      }
    )
  );

  return results.filter((r): r is CaseResult => r !== null);
}

// ---------------------------------------------------------------------------
// Credential precedence (docs/decisions/claude-code-runtime.md)
// ---------------------------------------------------------------------------

interface CredentialRow {
  row: string;
  apiKeySource: string | undefined;
  tokenSource: string | undefined;
  auth: ModelLog["auth"];
  /** How the turn ended: the result text, or the error it threw. */
  ending: string;
  verdict: Verdict;
  detail?: string;
}

async function credentialRows(model: ReturnType<typeof scriptedModel>): Promise<CredentialRow[]> {
  const rows: CredentialRow[] = [];
  // A credentialed row must have sent something; an empty log proves nothing.
  const sent = (r: CredentialRow) => r.auth.length > 0;
  const cases: Array<[string, Record<string, string>, (r: CredentialRow) => string | null]> = [
    ["OAuth only", { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, (r) =>
      r.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN" && r.apiKeySource === "none" && sent(r) &&
      r.auth.every((a) => a.authorization === `Bearer ${OAUTH}` && !a.xApiKey)
        ? null
        : "expected the OAuth bearer only"],
    ["API key only", { ANTHROPIC_API_KEY: API_KEY }, (r) =>
      r.apiKeySource === "ANTHROPIC_API_KEY" && sent(r) && r.auth.every((a) => a.xApiKey === API_KEY)
        ? null
        : "expected x-api-key"],
    ["both (raw CLI)", { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API_KEY }, (r) =>
      r.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN" && r.apiKeySource === "ANTHROPIC_API_KEY" && sent(r) &&
      r.auth.every((a) => a.xApiKey === API_KEY && !a.authorization)
        ? null
        : "the raw CLI no longer prefers the API key — #253's reason changed"],
    ["neither", {}, (r) =>
      r.tokenSource === "none" && !sent(r) && /Not logged in/.test(r.ending)
        ? null
        : "expected no request and a not-logged-in ending"],
  ];
  for (const [row, creds, judge] of cases) {
    const log = model.plan({ name: "Bash", input: { command: "echo hi" } });
    const sc = scratch();
    const q = query({
      prompt: "Run the planned tool call.",
      options: {
        cwd: sc.cwd,
        maxTurns: 1,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: sc.home,
          CLAUDE_CONFIG_DIR: join(sc.home, ".claude"),
          ANTHROPIC_BASE_URL: model.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ...creds,
        },
      },
    });
    let apiKeySource: string | undefined;
    let tokenSource: string | undefined;
    let ending = "";
    try {
      tokenSource = (await q.initializationResult()).account?.tokenSource;
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") apiKeySource = message.apiKeySource;
        if (message.type === "result") {
          ending = "result" in message ? String(message.result) : message.subtype;
          break;
        }
      }
    } catch (e) {
      ending = e instanceof Error ? e.message : String(e);
    }
    const result: CredentialRow = { row, apiKeySource, tokenSource, auth: [...log.auth], ending, verdict: "pass" };
    const problem = judge(result);
    if (problem) {
      result.verdict = "fail";
      result.detail = problem;
    }
    rows.push(result);
    rmSync(sc.cwd, { recursive: true, force: true });
    rmSync(sc.home, { recursive: true, force: true });
  }

  // The same both-present row through the production backend (#253).
  const log = model.plan({ name: "Bash", input: { command: "echo hi" } });
  const sc = scratch();
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: sc.home,
    CLAUDE_CONFIG_DIR: join(sc.home, ".claude"),
    ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    ANTHROPIC_API_KEY: API_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  });
  try {
    const backend = createClaudeBackend({
      brainPath: sc.cwd,
      profiles: defineProfiles([{ id: "claude", label: "Claude", source: "builtin" }]),
      log: () => {},
    });
    await backend.startTurn({
      prompt: "Run the planned tool call.",
      signal: new AbortController().signal,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "probe" }) },
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const production: CredentialRow = {
    row: "both (production backend)",
    apiKeySource: undefined,
    tokenSource: undefined,
    auth: [...log.auth],
    ending: "",
    verdict:
      log.auth.length > 0 && log.auth.every((a) => a.authorization === `Bearer ${OAUTH}` && !a.xApiKey) ? "pass" : "fail",
  };
  if (production.verdict === "fail") production.detail = "the production backend did not send the OAuth bearer alone — a finding against #253";
  rows.push(production);
  rmSync(sc.cwd, { recursive: true, force: true });
  rmSync(sc.home, { recursive: true, force: true });
  return rows;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The version of the SDK copy this run actually loaded (SDK_ENTRY). */
function installedSdkVersion(): string {
  return (JSON.parse(readFileSync(join(dirname(SDK_ENTRY), "package.json"), "utf8")) as { version: string }).version;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const model = scriptedModel();
  try {
    const cases = await permissionCases(model);
    const credentials = await credentialRows(model);
    const versions = new Set(
      cases.flatMap((c) => Object.values(c.observations).map((o) => o.claudeCodeVersion)).filter(Boolean)
    );
    const report = {
      command: `bun scripts/measure-claude-runtime.ts ${process.argv.slice(2).join(" ")}`.trim(),
      date: new Date().toISOString(),
      agentSdk: installedSdkVersion(),
      claudeCode: [...versions].join(", "),
      constant: MEASURED_RUNTIME,
      cases: cases.map(({ name, claim, sites, verdict, detail }) => ({ name, claim, sites, verdict, ...(detail ? { detail } : {}) })),
      credentials: credentials.map(({ row, apiKeySource, tokenSource, auth, ending, verdict, detail }) => ({
        row,
        apiKeySource,
        tokenSource,
        ending: ending.slice(0, 80),
        headers: auth.map((a) => ({ xApiKey: a.xApiKey ? `${a.xApiKey.slice(0, 14)}…` : null, authorization: a.authorization ? `${a.authorization.slice(0, 20)}…` : null })),
        verdict,
        ...(detail ? { detail } : {}),
      })),
    };
    const text = JSON.stringify(report, null, 2);
    const out = flag("--out");
    if (out) writeFileSync(out, `${text}\n`);
    console.log(text);
    const bad: Array<{ verdict: string }> = [...report.cases, ...report.credentials].filter((c) => c.verdict !== "pass");
    if (versions.size !== 1) bad.push({ verdict: `mixed or missing Claude Code versions: ${[...versions].join(", ") || "none"}` });
    if (bad.length > 0) {
      console.error(`${bad.length} case(s) did not pass.`);
      process.exitCode = 1;
    }
  } finally {
    model.stop();
  }
}
