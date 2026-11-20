/**
 * Production SDK assembly and hooks through the pinned runtime and Unix relay.
 * captureOffline isolates networking. This probe launches the runtime directly:
 * worker boundary qualification remains in provider-history-probe.ts.
 */
import { chmodSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createTurnLockBinding } from "../../src/turn-lock.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { claudePromptContext } from "../../src/prompt-context.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture, scenario = "", turnIndex = 0;
let queue: Array<{ name: string; input: object }> = [];
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read");
  const step = main ? queue.shift() : undefined;
  if (step?.name === "CronDelete") {
    const match = /Scheduled one-shot task ([a-z0-9]+)/.exec(JSON.stringify(body.messages));
    if (!match) throw new Error("Missing created fixture job");
    step.input = { id: match[1] };
  }
  const content = step ? [{ type: "tool_use", id: `toolu_ithaca_${capture.exchanges.length}`, ...step }]
    : [{ type: "text", text: "Odysseus checks Ithaca." }];
  capture.exchanges.push({ turn: turnIndex, path, raw, main, answer: { role: "assistant", content } });
  (capture.calls ??= []).push({ beta: request.headers.get("anthropic-beta"), speed: body.speed });
  const block = content[0]!;
  const events = [{ type: "message_start", message: { id: `msg_ithaca_${capture.exchanges.length}`, type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: step ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: step ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) } : { type: "text_delta", text: "Odysseus checks Ithaca." } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const relay = startInferenceRelay({ upstream: model.url.origin, routes: ["/v1/messages"], credentials: { "x-api-key": "offline-odysseus" } });
linkSync(relay.socketPath, join(relay.dir, "inference.sock"));
const proxy = Bun.serve({ unix: join(relay.dir, "proxy.sock"), fetch() { return new Response("Unused fixture proxy", { status: 403 }); } });
chmodSync(join(relay.dir, "proxy.sock"), 0o600);
const restore = replaceNativeStartupAcquisitionForFixture();
try {
 for (scenario of ["discovery", "legacy", "gateway", "removed", "builtins", "fast-api", "fast-subscription", "fast-disabled", "fast-thirdparty"]) {
  const brain = fixtureBrain(scratch, scenario), home = join(scratch, `home-${scenario}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(brain, "ithaca.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ id: "raft", cell_type: "markdown", metadata: {}, source: ["Odysseus checks Ithaca."] }] }));
  const marker = join(brain, "legacy-metadata");
  if (scenario === "legacy") writeFileSync(marker, "Odysseus keeps the old roster.");
  mkdirSync(join(brain, ".claude"), { recursive: true });
  writeFileSync(join(brain, ".claude/settings.json"), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "false" } }));
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [], budgets: [], calls: [] };
  let sessionId: string | undefined;
  const legacy = scenario === "legacy" || scenario === "builtins";
  if (legacy) { sessionId = crypto.randomUUID(); claudePromptContext(brain, sessionId).retainAppend("Odysseus retains the original system brief."); }
  for (turnIndex = 0; turnIndex < (scenario === "builtins" || scenario === "fast-thirdparty" ? 1 : 3); turnIndex++) {
    if (turnIndex) rmSync(marker, { force: true });
    queue = scenario === "discovery" && turnIndex === 0 ? [{ name: "ToolSearch", input: { query: "select:mcp__brain__brain_graph", max_results: 1 } }]
      : scenario === "removed" && turnIndex === 0 ? [{ name: "SendMessage", input: { to: "athena", message: "Odysseus checks Ithaca." } }]
      : scenario === "builtins" ? [
        { name: "EnterPlanMode", input: {} }, { name: "ExitPlanMode", input: {} },
        { name: "EnterWorktree", input: { name: "ithaca" } }, { name: "ExitWorktree", input: { action: "keep" } },
        { name: "CronCreate", input: { cron: "0 0 12 7 *", prompt: "Odysseus checks Ithaca.", recurring: false } },
        { name: "CronList", input: {} }, { name: "CronDelete", input: { id: "ithaca" } },
        { name: "ScheduleWakeup", input: { delaySeconds: 3600, reason: "Odysseus checks Ithaca.", prompt: "Odysseus checks Ithaca.", noop: true } },
        { name: "RemoteTrigger", input: {} }, { name: "Workflow", input: { name: "ithaca" } },
        { name: "SendMessage", input: { to: "athena", message: "Odysseus checks Ithaca." } },
        { name: "ListAgents", input: {} }, { name: "ReportFindings", input: { findings: [] } },
        { name: "Read", input: { file_path: join(brain, "ithaca.ipynb") } },
        { name: "NotebookEdit", input: { notebook_path: join(brain, "ithaca.ipynb"), cell_id: "raft", new_source: "Penelope checks Ithaca." } },
      ] : [];
    const controller = new AbortController();
    const view = createFixtureWorkerStartupView(brain);
    const turnLock = createTurnLockBinding({ turn: { pendingReleases: new Map(), ended: false }, writeLock: createKeyedLock(), lockWaitMs: 1000, log() {} });
    const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: { prompt: `Odysseus checks Ithaca step ${turnIndex}.`, sessionId,
      applicationAuthority: "server", signal: controller.signal, turnId: `ithaca-${turnIndex}`, workerStartupView: view,
      workerSandbox: prepareFixtureWorkerSandbox(brain, { home, profile: "strict", areas: [] }),
      bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" }; } },
    }, profile: { id: "fixture", label: "Fixture", model: "claude-opus-5-5", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
      turnEnvironment: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", MCP_CONNECTION_NONBLOCKING: "0",
        ...(scenario === "gateway" ? { ANTHROPIC_BASE_URL: "https://gateway.example.com" } : {}) },
      hostInference: { proxyDir: relay.dir, placeholders: { ANTHROPIC_API_KEY: "offline-odysseus" } },
      abortController: controller, allowedTools: ["Read"], confirmPatterns: [], turnLock, log(level, message) { console.error(level, message); },
    });
    delete turn.options.spawnClaudeCodeProcess;
    turn.options.env!.ANTHROPIC_UNIX_SOCKET = relay.socketPath;
    (turn.options.settings as any).env.ANTHROPIC_UNIX_SOCKET = relay.socketPath;
    turn.options.env!.ENABLE_TOOL_SEARCH = "false";
    (turn.options.settings as any).env.ENABLE_TOOL_SEARCH = "false";
    // Qualification only: the pinned runtime violates the approved tools-prefix
    // rule on discovery. Production must not enable this flag (#4306).
    if (["discovery", "removed"].includes(scenario)) {
      turn.options.env!.ENABLE_TOOL_SEARCH = "true";
      (turn.options.settings as any).env.ENABLE_TOOL_SEARCH = "true";
    }
    if (legacy && turnIndex === 0) { delete turn.options.resume; turn.options.sessionId = sessionId; }
    turn.options.mcpServers = { ...turn.options.mcpServers, brain: { command: process.execPath, args: [resolve(import.meta.dir, "request-shape-mcp.ts"), marker] } };
    if (scenario.startsWith("fast-")) {
      turn.options.settings = { ...turn.options.settings as object, fastMode: true };
      if (scenario === "fast-disabled") {
        turn.options.env!.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
        (turn.options.settings as any).env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
      }
      if (scenario === "fast-thirdparty") {
        const cloud = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "offline-odysseus", AWS_SECRET_ACCESS_KEY: "offline-odysseus", AWS_REGION: "us-east-1" };
        Object.assign(turn.options.env!, cloud);
        Object.assign((turn.options.settings as any).env, cloud);
      }
      if (scenario === "fast-subscription") {
        turn.options.env!.ANTHROPIC_API_KEY = "";
        turn.options.env!.CLAUDE_CODE_OAUTH_TOKEN = "brain-inference-placeholder";
        (turn.options.settings as any).env.ANTHROPIC_API_KEY = "";
        (turn.options.settings as any).env.CLAUDE_CODE_OAUTH_TOKEN = "brain-inference-placeholder";
      }
    }
    turn.options.stderr = text => console.error(text);
    capture.appends.push(turn.options.systemPrompt);
    capture.budgets!.push({ disallowed: turn.options.disallowedTools, env: turn.options.env?.ENABLE_TOOL_SEARCH, settings: (turn.options.settings as any)?.env?.ENABLE_TOOL_SEARCH,
      mcp: Object.keys(turn.options.mcpServers), requestedFast: (turn.options.settings as any)?.fastMode });
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      let success = false;
      for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
        if (message.type === "system" && message.subtype === "init") {
          (capture.rosters ??= []).push(JSON.stringify({ version: message.claude_code_version, state: message.fast_mode_state, reason: message.fast_mode_disabled_reason }));
          if (scenario === "fast-thirdparty") controller.abort();
        }
        if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); sessionId = message.session_id; success = true; }
      }
      if (!success || !sessionId) throw new Error("Missing successful SDK result");
      capture.sessions.push(sessionId);
    } catch (error) {
      if (scenario !== "fast-thirdparty" || !controller.signal.aborted || !capture.rosters?.length) throw error;
    } finally { clearTimeout(timer); await turn.finishWorker(); view.cleanup(); turnLock.close(); }
  }
 }
 writeFileSync(join(scratch, "requests.json"), JSON.stringify(captures));
} finally { restore(); proxy.stop(true); relay.stop(); model.stop(true); }
