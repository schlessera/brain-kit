import { watchdogMs } from "../../../../scripts/test-deadlines.js";
/** The caller confines the SDK, bundled CLI and every tool to loopback. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createClaudeBackend } from "../../src/backend.js";
import { historyHost } from "../../../../tests/fixtures/provider-history-host.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { changeRepository, fixtureBrain, turnDataTree } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import { REFERENCE_ACTIONS, REFERENCE_SCENARIOS, TOOL_SCENARIOS, hostToolHandlers } from "../../../../tests/fixtures/provider-history-scenarios.js";

const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture;
let turnIndex = 0, sequence = 0, turnOpen = false;
let scenario = "";
let brain = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read") === true;
  const tool = main && (TOOL_SCENARIOS.includes(scenario) ? turnOpen : sequence++ === 0);
  if (main) turnOpen = false;
  const content = tool ? [scenario === "compute"
    ? { type: "tool_use", id: `toolu_odysseus_${turnIndex}`, name: "mcp__brain-ui__brain_compute_status", input: { job: "cj_ithaca" } }
    : scenario === "immutable"
    ? { type: "tool_use", id: `toolu_odysseus_${turnIndex}`, name: "mcp__brain-ui__reference_read", input: { repository: "https://github.com/odysseus/ithaca", revision: "main", path: "README.md", offset: 0, maximum: 64 } }
    : scenario === "freshness"
    ? { type: "tool_use", id: `toolu_odysseus_${turnIndex}`, name: "mcp__brain-ui__reference_source", input: { repository: "https://github.com/odysseus/ithaca", revision: "main" } }
    : REFERENCE_SCENARIOS.includes(scenario)
    ? { type: "tool_use", id: `toolu_odysseus_${turnIndex}`, name: "mcp__brain-ui__reference_worktree", input: REFERENCE_ACTIONS[turnIndex] }
    : { type: "tool_use", id: "toolu_odysseus", name: scenario === "promotion" ? "Bash" : "Read",
    input: scenario === "promotion" ? { command: "printf 'Odysseus raft plan' > /tmp/raft.txt" } : { file_path: join(brain, "notes/raft.md") } }]
    : [{ type: "text", text: !main ? JSON.stringify({ title: "Odysseus checks the mast" }) : scenario === "promotion" ? "[Raft plan](/tmp/raft.txt)" : "Odysseus checks the mast." }];
  capture.exchanges.push({ turn: turnIndex, path, raw, main, answer: { role: "assistant", content } });
  const events: any[] = [{ type: "message_start", message: { id: `msg_odysseus_${capture.exchanges.length}`, type: "message", role: "assistant",
    model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
  const block = content[0]!;
  events.push({ type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: "input" in block ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const restore = replaceNativeStartupAcquisitionForFixture();
try {
  for (scenario of ["control", "repository", "facts", "posture", "promotion", "title", "reference", "renewal", "freshness", "immutable", "datatree", "compute", "safety"]) {
    brain = fixtureBrain(scratch, scenario);
    if (scenario === "facts") mkdirSync(join(brain, "workspaces/ithaca"), { recursive: true });
    capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
    const home = join(scratch, `home-${scenario}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    let sessionId: string | undefined;
    sequence = 0;
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      turnOpen = true;
      if (scenario === "repository" && turnIndex) changeRepository(brain, turnIndex);
      const facts = scenario === "facts" ? turnIndex : 0;
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", ...(scenario === "facts" ? { areas: ["workspaces"], codeChanges: turnIndex === 1 } : scenario === "promotion" ? {} : { areas: [] }) });
      const view = createFixtureWorkerStartupView(brain);
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain, ...(scenario === "safety" ? { systemPromptAppend: turnIndex === 0 ? "Legacy safety policy: this session stays restricted." : "Reviewed safety policy: finalized individual verdicts may restore normal." } : {}) }, req: {
        prompt: `Odysseus checks voyage step ${turnIndex}.`, sessionId, signal: controller.signal, turnId: `odysseus-${turnIndex}`,
        workerStartupView: view, workerSandbox: { ...sandbox, ...(scenario === "safety" ? { commandPolicy: { hash: null, deny: [], confirm: [], outwardAllow: [],
            taint: () => turnIndex === 2 ? null : { eventId: 7, source: "web_fetch" } } } : {}), noteFacts: { history: { journal: facts !== 1, userRevert: facts === 2 } },
          ...(scenario === "datatree" ? { dataTree: turnDataTree(scratch, brain, scenario, turnIndex) } : {}) },
        client: { formFactor: facts === 1 ? "phone" : "tablet", viewportWidth: 800 + facts * 100, camera: facts !== 1 }, turnBudgetMs: 60_000 + facts * 1000,
        ...((scenario === "posture" || scenario === "compute") && turnIndex === 1 ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
        bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" as const }; },
          async proposePolicyChange() { throw new Error("Unused fixture capability"); },
          // The local CLI replays turn 0's MCP roster on resume, so the assembled roster is held as well.
          ...(TOOL_SCENARIOS.includes(scenario) ? { activity(event: { kind: string; prefix?: { tools: string | null } }) {
            if (event.kind === "prompt_prefix") (capture.rosters ??= []).push(event.prefix!.tools);
          } } : {}),
          ...hostToolHandlers(scenario, turnIndex, capture) },
      }, profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
        HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus",
        ...(scenario === "title" ? {} : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }) }, abortController: controller, allowedTools: ["Read", "Bash"], confirmPatterns: [],
        turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
      });
      capture.appends.push(turn.options.systemPrompt);
      const timer = setTimeout(() => controller.abort(), watchdogMs(30_000));
      try {
        let success = false;
        for await (const message of query({ prompt: turn.prompt, options: turn.options })) {
          if (message.type === "assistant") for (const block of message.message.content) if (block.type === "text") turn.observeAnswerText(block.text);
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(JSON.stringify(message));
            sessionId = message.session_id; success = true;
          }
        }
        if (!success || !sessionId) throw new Error("Missing successful SDK session result");
        capture.sessions.push(sessionId);
      } finally { clearTimeout(timer); await turn.finishWorker(); view.cleanup(); }
    }
  }
  scenario = "budget";
  brain = fixtureBrain(scratch, scenario);
    if (scenario === "facts") mkdirSync(join(brain, "workspaces/ithaca"), { recursive: true });
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
  sequence = 0;
  const home = join(scratch, "home-budget");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const budgetBackend = createClaudeBackend({ brainPath: brain, allowedTools: ["Read", "Bash"], confirmBashPatterns: [],
    profiles: [{ id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
      HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    }) }], log() {},
  });
  // Hosted budget turns do not expose the turn object to this fixture. Capture
  // the production fingerprint of that exact SDK systemPrompt option instead
  // of leaving their option check vacuous behind the CLI's replayed system.
  const hosted = historyHost(brain, { ...budgetBackend, async startTurn(req) {
    return budgetBackend.startTurn({ ...req, bridge: { ...req.bridge, activity(event) {
      if (event.kind === "prompt_prefix") capture.appends.push(event.prefix.system);
      req.bridge.activity?.(event);
    } } });
  } });
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      if (turnIndex) changeRepository(brain, turnIndex);
      if (turnIndex === 1) mkdirSync(join(brain, "workspaces"));
      capture.sessions.push(await hosted.turn(`Odysseus checks voyage step ${turnIndex}.`,
        { formFactor: turnIndex === 1 ? "phone" : "tablet", viewportWidth: 800 + turnIndex * 100, camera: turnIndex !== 1 }, capture.sessions.at(-1)));
    }
    capture.budgets = hosted.receipts();
  } finally { await hosted.close(); }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify(captures));
} finally { restore(); server.stop(true); }
