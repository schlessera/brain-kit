/** The caller confines the SDK, bundled CLI and every tool to loopback. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { createClaudeBackend } from "../../src/backend.js";
import { historyHost } from "../../../../tests/fixtures/provider-history-host.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { changeRepository, fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";

const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture;
let turnIndex = 0, sequence = 0;
let scenario = "";
let brain = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages") return Response.json({});
  const raw = await request.text(), body = JSON.parse(raw);
  const main = body.tools?.some((tool: any) => tool.name === "Read") === true;
  const tool = main && sequence++ === 0;
  const content = tool ? [{ type: "tool_use", id: "toolu_odysseus", name: scenario === "promotion" ? "Bash" : "Read",
    input: scenario === "promotion" ? { command: "printf 'Odysseus raft plan' > /tmp/raft.txt" } : { file_path: join(brain, "notes/raft.md") } }]
    : [{ type: "text", text: scenario === "promotion" && main ? "[Raft plan](/tmp/raft.txt)" : "Odysseus checks the mast." }];
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
  for (scenario of ["control", "repository", "facts", "posture", "promotion"]) {
    brain = fixtureBrain(scratch, scenario);
    capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
    const home = join(scratch, `home-${scenario}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    let sessionId: string | undefined;
    sequence = 0;
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      if (scenario === "repository" && turnIndex) changeRepository(brain, turnIndex);
      const facts = scenario === "facts" ? turnIndex : 0;
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { home, profile: "strict", ...(scenario === "promotion" ? {} : { areas: [] }) });
      const view = createFixtureWorkerStartupView(brain);
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
        prompt: `Odysseus checks voyage step ${turnIndex}.`, sessionId, signal: controller.signal, turnId: `odysseus-${turnIndex}`,
        workerStartupView: view, workerSandbox: { ...sandbox, noteFacts: { history: { journal: facts !== 1, userRevert: facts === 2 } } },
        client: { formFactor: facts === 1 ? "phone" : "tablet", viewportWidth: 800 + facts * 100 }, turnBudgetMs: 60_000 + facts * 1000,
        ...(scenario === "posture" && turnIndex === 1 ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
        bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" as const }; },
          async proposePolicyChange() { throw new Error("Unused fixture capability"); } },
      }, profile: { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
        HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }) }, abortController: controller, allowedTools: ["Read", "Bash"], confirmPatterns: [],
        turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
      });
      capture.appends.push(turn.options.systemPrompt);
      const timer = setTimeout(() => controller.abort(), 30_000);
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
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
  sequence = 0;
  const home = join(scratch, "home-budget");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const hosted = historyHost(brain, createClaudeBackend({ brainPath: brain, allowedTools: ["Read", "Bash"], confirmBashPatterns: [],
    profiles: [{ id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [], buildEnv: () => ({
      HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "offline-odysseus",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    }) }], log() {},
  }));
  try {
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      if (turnIndex) changeRepository(brain, turnIndex);
      if (turnIndex === 1) mkdirSync(join(brain, "workspaces"));
      capture.sessions.push(await hosted.turn(`Odysseus checks voyage step ${turnIndex}.`,
        { formFactor: turnIndex === 1 ? "phone" : "tablet", viewportWidth: 800 + turnIndex * 100 }, capture.sessions.at(-1)));
    }
    capture.budgets = hosted.receipts();
  } finally { await hosted.close(); }
  writeFileSync(join(scratch, "requests.json"), JSON.stringify(captures));
} finally { restore(); server.stop(true); }
