/** Native Pi workers and Responses serialization, inside the caller's offline namespace. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import { changeRepository, fixtureBrain } from "../../../../tests/fixtures/provider-history-brain.js";
import { historyHost } from "../../../../tests/fixtures/provider-history-host.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";

const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture;
let turnIndex = 0, sequence = 0;
let scenario = "", brain = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/responses") throw new Error(`Unexpected Pi endpoint: ${path}`);
  const raw = await request.text();
  const tool = sequence++ === 0;
  const id = `msg_odysseus_${sequence}`;
  const answer = tool ? { type: "function_call", id: "fc_odysseus", call_id: "call_odysseus",
    name: scenario === "promotion" ? "bash" : "read_file",
    arguments: JSON.stringify(scenario === "promotion" ? { command: "printf 'Odysseus raft plan' > /tmp/raft.txt" } : { path: "notes/raft.md" }) }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: scenario === "promotion" ? "[Raft plan](/tmp/raft.txt)" : "Odysseus checks the mast.", annotations: [] }], status: "completed", id };
  capture.exchanges.push({ turn: turnIndex, path, raw, main: true, answer });
  const response = { id: `resp_odysseus_${sequence}`, object: "response", status: "completed", model: "gpt-4o-mini", output: [answer],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: tool ? { ...answer, arguments: "" } : { ...answer, content: [] } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", item_id: "fc_odysseus", output_index: 0, delta: answer.arguments }]
      : [{ type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: answer.content![0]!.text }]),
    { type: "response.output_item.done", output_index: 0, item: answer },
    { type: "response.completed", response },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1`, apiKey: "offline-odysseus" } } }));
try {
  for (scenario of ["control", "repository", "facts", "promotion"]) {
    brain = fixtureBrain(scratch, scenario);
    capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(scratch, `sessions-${scenario}`), loadExtensions: false,
      profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
    let sessionId: string | undefined;
    sequence = 0;
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      if (scenario === "repository" && turnIndex) changeRepository(brain, turnIndex);
      const facts = scenario === "facts" ? turnIndex : 0;
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", ...(scenario === "promotion" ? {} : { areas: [] }) });
      const frames: ServerMessage[] = [];
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await startFixtureTurn(backend, brain, { prompt: `Odysseus checks voyage step ${turnIndex}.`, profileId: "fixture", sessionId,
          signal: controller.signal, turnId: `odysseus-${turnIndex}`,
          workerSandbox: { ...sandbox, noteFacts: { history: { journal: facts !== 1, userRevert: facts === 2 } } },
          client: { formFactor: facts === 1 ? "phone" : "tablet", viewportWidth: 800 + facts * 100, camera: facts !== 1 }, turnBudgetMs: 60_000 + facts * 1000,
          bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" as const }; } },
        });
        const result = frames.findLast(f => f.type === "result");
        if (!result || result.outcome !== "success") throw new Error(JSON.stringify(frames));
        sessionId = result.sessionId;
        capture.sessions.push(sessionId);
      } finally { clearTimeout(timer); }
    }
  }
  // Unsupported voice must stop before session acquisition or inference.
  const voiceCapture = captures.control!;
  const requestCount = () => Object.values(captures).reduce((count, value) => count + value.exchanges.length, 0);
  const before = requestCount();
  let message = "";
  const voiceBackend = createPiBackend({ brainPath: brain, loadExtensions: false });
  try { await voiceBackend.startTurn({ prompt: "Check the voyage", signal: new AbortController().signal,
    posture: "voice", noGrantSurface: true, enforceAllowedTools: true,
    bridge: { emit() {}, async requestPermission() { throw new Error("Voice permission unexpectedly reached"); } } }); }
  catch (error) { message = String(error); }
  voiceCapture.voiceRefusal = { message, before, after: requestCount() };
  scenario = "budget";
  brain = fixtureBrain(scratch, scenario);
  capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
  sequence = 0;
  const hosted = historyHost(brain, createPiBackend({ brainPath: brain, sessionDir: join(scratch, "sessions-budget"), loadExtensions: false,
    profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] }));
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
} finally { server.stop(true); }
