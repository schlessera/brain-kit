import { spyOn } from "bun:test";
import { spawn } from "node:child_process";
import * as workerApi from "@schlessera/brain-ui-sdk/internal";
/**
 * Production SDK assembly and hooks through the pinned runtime and Unix relay.
 * captureOffline isolates networking. This probe launches the runtime directly:
 * worker boundary qualification remains in provider-history-probe.ts.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { watchdogMs } from "../../../../scripts/test-deadlines.js";
import { sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { baseline, legacySdkTurn } from "./legacy-sdk-turn.js";
import { TurnTerminal, TurnFrames } from "../../src/turn-terminal.js";
import { gatedPrompt, promptGateCheck } from "../../src/turn-prompt-gate.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { INFERENCE_PLACEHOLDER, startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createTurnLockBinding } from "../../src/turn-lock.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { SessionRosterIncompatibleError } from "../../src/session-request-shape.js";
import { claudePromptContext } from "../../src/prompt-context.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture, scenario = "", turnIndex = 0;
let mcpReady: string | undefined;
let queue: Array<{ name: string; input: object }> = [];
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read");
  if (main && mcpReady) {
    capture.qualification ??= {};
    capture.qualification.firstRequestBeforeMcpRelease ??= !existsSync(mcpReady);
    writeFileSync(mcpReady, "Odysseus permits MCP startup.");
  }
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
 for (scenario of (process.env.REQUEST_SHAPE_MANAGED_GATEWAY ? ["managed-gateway"] : ["discovery", "legacy", "legacy-no-snapshot", "legacy-inherited", "gateway", "project-on", "authority-upgrade", "removed", "builtins", "fast-api", "fast-subscription", "fast-disabled", "fast-thirdparty"])) {
  const brain = fixtureBrain(scratch, scenario), home = join(scratch, `home-${scenario}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(brain, "ithaca.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ id: "raft", cell_type: "markdown", metadata: {}, source: ["Odysseus checks Ithaca."] }] }));
  const marker = join(brain, "legacy-metadata"), counter = join(brain, "mcp-start-count");
  mcpReady = scenario === "discovery" ? join(brain, "mcp-ready") : undefined;
  if (scenario.startsWith("legacy")) writeFileSync(marker, "Odysseus keeps the old roster.");
  mkdirSync(join(brain, ".claude"), { recursive: true });
  writeFileSync(join(brain, ".claude/settings.json"), JSON.stringify({ enableAllProjectMcpServers: true, env: scenario === "legacy-inherited" ? {} : { ENABLE_TOOL_SEARCH: scenario === "project-on" ? "true" : "false" } }));
  if (!scenario.startsWith("legacy") && scenario !== "builtins") writeFileSync(join(brain, ".mcp.json"), JSON.stringify({ mcpServers: {
    brain: { command: process.execPath, args: [resolve(import.meta.dir, "request-shape-mcp.ts"), marker, ...(mcpReady ? [mcpReady, counter] : [])] },
  } }));
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [], budgets: [], calls: [] };
  let sessionId: string | undefined;
  const legacy = scenario.startsWith("legacy") || scenario === "builtins";
  if (legacy) {
    sessionId = crypto.randomUUID();
    // This is the pre-upgrade context format: only the old append, no request
    // selection or marker. The first query uses independently frozen inputs.
    if (scenario !== "legacy-no-snapshot") claudePromptContext(brain, sessionId).retainAppend(baseline.append);
  }
  for (turnIndex = 0; turnIndex < (scenario === "builtins" ? 2 : scenario === "fast-thirdparty" || scenario === "managed-gateway" ? 1 : 3); turnIndex++) {
    if (turnIndex) rmSync(marker, { force: true });
    // Each diagnostic process starts before its project MCP server is ready.
    // Reset the event latch on resume too, so qualification is not a CPU race.
    if (mcpReady) { rmSync(mcpReady, { force: true }); rmSync(counter, { force: true }); }
    queue = scenario === "discovery" && turnIndex === 0 ? [{ name: "ToolSearch", input: { query: "select:mcp__brain__brain_graph", max_results: 1 } }, { name: "mcp__brain__brain_read", input: { path: "notes/raft.md" } }]
      : scenario === "removed" && turnIndex === 0 ? [{ name: "SendMessage", input: { to: "athena", message: "Odysseus checks Ithaca." } }]
      : scenario === "builtins" && turnIndex === 1 ? [
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
    const environment: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(legacy || scenario === "authority-upgrade" ? { MCP_CONNECTION_NONBLOCKING: "0" } : {}),
      ...(scenario === "legacy-inherited" ? { ENABLE_TOOL_SEARCH: turnIndex === 0 ? "true" : "false" } : {}),
      ...(scenario.endsWith("gateway") ? { ANTHROPIC_BASE_URL: "https://gateway.example.com" } : {}) };
    const requestsBeforeAssembly = capture.exchanges.length;
    let turn: ReturnType<typeof createClaudeSdkTurn> | ReturnType<typeof legacySdkTurn>;
    try { turn = legacy && turnIndex === 0 ? legacySdkTurn(brain, sessionId!, environment, relay.socketPath, controller) : createClaudeSdkTurn({ brainBridgeInventory: "core-only", backend: { brainPath: brain }, req: { prompt: `Odysseus checks Ithaca step ${turnIndex}.`, sessionId,
      applicationAuthority: scenario === "authority-upgrade" && turnIndex !== 1 ? undefined : "server", signal: controller.signal, turnId: `ithaca-${turnIndex}`, workerStartupView: view,
      // #4310: a fast session's speed through production assembly, the same on every turn.
      ...(scenario === "fast-api" || scenario === "fast-subscription" ? { outputSpeed: "fast" as const } : {}),
      workerSandbox: prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] }),
      bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" }; } },
    }, profile: { id: "fixture", label: "Fixture", model: "claude-opus-5-5", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
      turnEnvironment: environment,
      hostInference: { proxyDir: relay.dir, placeholders: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER } },
      abortController: controller, allowedTools: ["Read"], confirmPatterns: [], turnLock, log(level, message) { console.error(level, message); },
    }); } catch (error) {
      view.cleanup(); turnLock.close();
      if (scenario !== "authority-upgrade" || turnIndex !== 1 || !(error instanceof SessionRosterIncompatibleError)) throw error;
      capture.qualification ??= {};
      capture.qualification.authorityRefusal = { errorClass: error.errorClass, message: error.message,
        before: requestsBeforeAssembly, after: capture.exchanges.length };
      continue;
    }
    delete turn.options.spawnClaudeCodeProcess;
    turn.options.env!.ANTHROPIC_UNIX_SOCKET = relay.socketPath;
    (turn.options.settings as any).env.ANTHROPIC_UNIX_SOCKET = relay.socketPath;
    // Route only the transport socket into this direct-runtime probe. Never
    // override production tool-search selection for gateway or removal cases.
    const contextFile = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME!, ".claude"), brain, sessionId ?? turn.options.sessionId!);
    const hostSnapshotPresent = existsSync(join(contextFile.dir, contextFile.name));
    const savedContext = hostSnapshotPresent ? JSON.parse(readFileSync(join(contextFile.dir, contextFile.name), "utf8")) : {};
    const initialized = savedContext.claudeRequestShapeInitialized === true;
    capture.qualification ??= {};
    capture.qualification.watchdogMs = watchdogMs(45_000);
    ((capture.qualification.hostSnapshotPresentByTurn ??= []) as boolean[]).push(hostSnapshotPresent);
    if (legacy && turnIndex > 0) capture.qualification.legacyOriginalSetting = savedContext.claudeRequestShape.toolSearch === null ? "unknown" : "known";
    capture.qualification.projectToolSearch = JSON.parse(readFileSync(join(brain, ".claude/settings.json"), "utf8")).env.ENABLE_TOOL_SEARCH;
    if (legacy && turnIndex === 0) capture.qualification.baseline = { source: baseline.source, initialized };
    if (legacy) turn.options.mcpServers = { ...turn.options.mcpServers, brain: { command: process.execPath, args: [resolve(import.meta.dir, "request-shape-mcp.ts"), marker] } };
    if (scenario === "discovery") {
      // This probe owns only runtime/relay qualification. Replace the lowest
      // worker launch with a real stdio process in the probe's offline namespace;
      // brain-tool-forwarder-runtime.test.ts owns the real worker boundary.
      const launch = spyOn(workerApi, "launchAgentWorkerAsync").mockImplementation(async input => {
        const child = spawn(process.execPath, [resolve(import.meta.dir, "request-shape-mcp.ts"), marker, mcpReady!, counter], {
          cwd: brain, env: environment, stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
          kill: () => { child.kill("SIGKILL"); }, async released() { await input.startupView?.cleanup(); } } as never;
      });
      (turn as ReturnType<typeof createClaudeSdkTurn>).startBrainTools!();
      // start() enters its asynchronous launch after this synchronous probe setup.
      await Promise.resolve(); await Promise.resolve();
      launch.mockRestore();
    }
    capture.qualification.mcpStartup = legacy ? "frozen blocking baseline" : "project .mcp.json, production non-blocking";
    if (scenario.startsWith("fast-")) {
      // Runtime-condition qualification only: production assembly set the
      // product scenarios' speed above; these emulate refusals it cannot reach.
      if (scenario === "fast-disabled" || scenario === "fast-thirdparty") turn.options.settings = { ...turn.options.settings as object, fastMode: true };
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
        turn.options.env!.CLAUDE_CODE_OAUTH_TOKEN = INFERENCE_PLACEHOLDER;
        (turn.options.settings as any).env.ANTHROPIC_API_KEY = "";
        (turn.options.settings as any).env.CLAUDE_CODE_OAUTH_TOKEN = INFERENCE_PLACEHOLDER;
      }
    }
    turn.options.stderr = text => console.error(text);
    capture.appends.push(turn.options.systemPrompt);
    capture.budgets!.push({ disallowed: turn.options.disallowedTools, allowed: turn.options.allowedTools,
      env: turn.options.env?.ENABLE_TOOL_SEARCH, settings: (turn.options.settings as any)?.env?.ENABLE_TOOL_SEARCH,
      inheritedRequested: environment.ENABLE_TOOL_SEARCH, flagSettings: turn.options.settings, mcp: Object.keys(turn.options.mcpServers ?? {}), requestedFast: (turn.options.settings as any)?.fastMode });
    const timer = setTimeout(() => controller.abort(), watchdogMs(45_000));
    try {
      let success = false;
      let runtime: ReturnType<typeof query>;
      let gateTerminal: TurnTerminal | undefined;
      let prompt = turn.prompt;
      if (scenario === "managed-gateway" || scenario === "discovery") {
        gateTerminal = new TurnTerminal({ frames: new TurnFrames({ emit() {}, async requestPermission() { return { behavior: "deny", message: "Qualification cannot approve permission prompts." }; } }, null), hostSignal: new AbortController().signal,
          abortController: controller, startedAt: Date.now(), pendingFailure: () => null });
        const terminal = gateTerminal;
        prompt = gatedPrompt(turn.prompt, async () => {
          const cli = runtime;
          const check = promptGateCheck({ queryHandle: Promise.resolve(cli), initialize: value => value.initializationResult(),
            sdkTurn: turn as ReturnType<typeof createClaudeSdkTurn>, relay: undefined, terminal, runtimeRequirements: [], phase: "qualification", abortController: controller,
            profileId: "fixture", log() {}, reportActivity() {}, reportRuntime() {} });
          const settings = await (cli as any).getSettings();
          capture.qualification!.effectiveToolSearch = settings.effective?.env?.ENABLE_TOOL_SEARCH;
          capture.qualification!.effectiveDisabledMcpjsonServers = settings.effective?.disabledMcpjsonServers;
          const allowed = await check();
          capture.qualification!.promptReleased = allowed;
          capture.qualification!.refusal = terminal.refused;
          return allowed;
        });
      }
      runtime = query({ prompt, options: turn.options });
      for await (const message of runtime) {
        if (message.type === "system" && message.subtype === "init") {
          (capture.rosters ??= []).push(JSON.stringify({ version: message.claude_code_version, state: message.fast_mode_state, reason: message.fast_mode_disabled_reason }));
          if (scenario === "fast-thirdparty") controller.abort();
        }
        if (message.type === "result") { if (message.subtype !== "success") throw new Error(JSON.stringify(message)); sessionId = message.session_id; success = true; }
      }
      if (scenario === "managed-gateway" && gateTerminal?.withheld) continue;
      if (!success || !sessionId) throw new Error("Missing successful SDK result");
      capture.sessions.push(sessionId);
    } catch (error) {
      if (scenario === "managed-gateway" && controller.signal.aborted && capture.qualification?.promptReleased === false) { /* Expected gate refusal, before any model request. */ }
      else if (scenario !== "fast-thirdparty" || !controller.signal.aborted || !capture.rosters?.length) throw error;
    } finally { clearTimeout(timer); await turn.finishWorker();
      if (scenario === "discovery") ((capture.qualification!.brainProcessStarts ??= []) as number[]).push(readFileSync(counter, "utf8").trim().split("\n").length);
      view.cleanup(); turnLock.close(); }
  }
 }
 // #4310 (ruling 2026-11-27): a direct fast turn runs under the runtime's own
 // first-party provider policy, pinned by assembly in managedSettings. These
 // need a runner without an admin managed tier (a private /etc here). Pinned
 // route scenarios release the prompt whatever the gate says, so they prove
 // the RUNTIME refuses the route; the unpinned controls show the same route
 // reaches the fake upstream without the pin.
 for (scenario of process.env.REQUEST_SHAPE_MANAGED_GATEWAY ? [] : ["fast-direct-policy", "fast-direct-socket-env", "fast-direct-socket-project",
   "fast-direct-gateway", "fast-direct-socket-unpinned", "fast-direct-gateway-unpinned"]) {
  const brain = fixtureBrain(scratch, scenario), home = join(scratch, `home-${scenario}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(brain, ".claude"), { recursive: true });
  // The relay serves plain HTTP on its socket, as production's relayed turns use it.
  const socketRoute = { ANTHROPIC_UNIX_SOCKET: relay.socketPath, ANTHROPIC_BASE_URL: "http://localhost" };
  const projectEnv = scenario.startsWith("fast-direct-gateway") ? { ANTHROPIC_BASE_URL: model.url.origin }
    : scenario === "fast-direct-socket-project" || scenario === "fast-direct-socket-unpinned" ? socketRoute : {};
  writeFileSync(join(brain, ".claude/settings.json"), JSON.stringify({ env: projectEnv }));
  const qualification: Record<string, unknown> = { watchdogMs: watchdogMs(45_000) };
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [], budgets: [], calls: [], qualification };
  turnIndex = 0; queue = [];
  const controller = new AbortController();
  const view = createFixtureWorkerStartupView(brain);
  const turnLock = createTurnLockBinding({ turn: { pendingReleases: new Map(), ended: false }, writeLock: createKeyedLock(), lockWaitMs: 1000, log() {} });
  const environment: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ANTHROPIC_API_KEY: "offline-odysseus", ...(scenario === "fast-direct-socket-env" ? socketRoute : {}) };
  let turn: ReturnType<typeof createClaudeSdkTurn>;
  try {
    turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: { prompt: "Odysseus checks Ithaca fast.", applicationAuthority: "server", signal: controller.signal,
      turnId: `${scenario}-0`, workerStartupView: view, outputSpeed: "fast", workerSandbox: prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] }),
      bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" }; } } },
      profile: { id: "fixture", label: "Fixture", model: "claude-opus-5-5", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
      turnEnvironment: environment, abortController: controller, allowedTools: ["Read"], confirmPatterns: [], turnLock, log() {} });
  } catch (error) {
    qualification.assemblyRefusal = { errorClass: (error as { errorClass?: unknown }).errorClass, message: error instanceof Error ? error.message : String(error) };
    view.cleanup(); turnLock.close();
    continue;
  }
  delete turn.options.spawnClaudeCodeProcess;
  if (scenario.endsWith("-unpinned")) delete turn.options.managedSettings;
  qualification.managedSettings = turn.options.managedSettings ?? null;
  turn.options.stderr = text => console.error(text);
  const terminal = new TurnTerminal({ frames: new TurnFrames({ emit() {}, async requestPermission() { return { behavior: "deny", message: "Qualification cannot approve permission prompts." }; } }, null),
    hostSignal: new AbortController().signal, abortController: controller, startedAt: Date.now(), pendingFailure: () => null });
  let runtime!: ReturnType<typeof query>;
  const release = scenario !== "fast-direct-policy";
  const prompt = gatedPrompt(turn.prompt, async () => {
    const check = promptGateCheck({ queryHandle: Promise.resolve(runtime), initialize: value => value.initializationResult(), sdkTurn: turn, relay: undefined,
      terminal, runtimeRequirements: [], phase: "qualification", abortController: new AbortController(), profileId: "fixture", log() {}, reportActivity() {}, reportRuntime() {} });
    try {
      const settings = await (runtime as unknown as { getSettings(): Promise<{ effective?: { allowedProviders?: unknown } }> }).getSettings();
      qualification.effectiveAllowedProviders = settings?.effective?.allowedProviders ?? null;
    } catch (error) { qualification.settingsError = String(error); }
    try { qualification.gateAllowed = await check(); } catch (error) { qualification.gateError = String(error); }
    qualification.gateRefusal = terminal.refused;
    // The policy scenario has no upstream to reach; route scenarios release
    // regardless, so only the runtime's own policy can stop the request.
    if (!release) controller.abort();
    return release;
  });
  const timer = setTimeout(() => controller.abort(), watchdogMs(45_000));
  const results: unknown[] = [];
  try {
    runtime = query({ prompt, options: turn.options });
    for await (const message of runtime) {
      if (message.type === "system" && message.subtype === "init") qualification.init = { state: message.fast_mode_state, reason: message.fast_mode_disabled_reason };
      if (message.type === "result") results.push({ subtype: message.subtype, startup_failure_reason: (message as { startup_failure_reason?: unknown }).startup_failure_reason ?? null });
    }
  } catch (error) { qualification.streamError = error instanceof Error ? error.message.slice(0, 500) : String(error); }
  finally { clearTimeout(timer); qualification.results = results; await turn.finishWorker().catch(() => {}); view.cleanup(); turnLock.close(); }
 }
 writeFileSync(join(scratch, "requests.json"), JSON.stringify(captures));
} finally { restore(); proxy.stop(true); relay.stop(); model.stop(true); }
