/** Native Pi workers and Responses serialization, inside the caller's offline namespace. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";
import { changeRepository, fixtureBrain, turnDataTree } from "../../../../tests/fixtures/provider-history-brain.js";
import { historyHost } from "../../../../tests/fixtures/provider-history-host.js";
import type { Captures, HistoryCapture } from "../../../../tests/helpers/provider-history.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import type { ReferenceToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";

const scratch = process.argv[2]!;
const captures: Captures = {};
let capture: HistoryCapture;
let turnIndex = 0, sequence = 0, turnOpen = false;
/** The reference lifecycle (#2432): each turn calls the worktree tool through the worker pipe, and the host's answer changes between turns. */
const REFERENCE_ACTIONS = [{ action: "request", repository: "https://github.com/odysseus/ithaca", revision: "main" },
  { action: "renew", worktreeId: "raft-worktree" }, { action: "release", worktreeId: "raft-worktree" }];
/** #2751: shared source moves to a newer commit, then a failed refresh reports the same commit as stale. */
const SOURCE_FRESHNESS = [{ commit: "1".repeat(40), freshness: "fresh", hour: 0, error: null }, { commit: "2".repeat(40), freshness: "fresh", hour: 1, error: null },
  { commit: "2".repeat(40), freshness: "stale", hour: 1, error: "The Ithaca remote did not answer." }] as const;
/** Scenarios whose every turn calls a reference tool: `reference` withholds the handler on turn 1, the others answer every turn. */
const REFERENCE_SCENARIOS = ["reference", "renewal", "freshness"];
let scenario = "", brain = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/responses") throw new Error(`Unexpected Pi endpoint: ${path}`);
  const raw = await request.text();
  const tool = REFERENCE_SCENARIOS.includes(scenario) ? turnOpen : sequence === 0;
  sequence++; turnOpen = false;
  const id = `msg_odysseus_${sequence}`;
  const answer = tool ? { type: "function_call", id: "fc_odysseus", call_id: `call_odysseus_${turnIndex}`,
    name: scenario === "freshness" ? "reference_source" : REFERENCE_SCENARIOS.includes(scenario) ? "reference_worktree" : scenario === "promotion" ? "bash" : "read_file",
    arguments: JSON.stringify(scenario === "freshness" ? { repository: "https://github.com/odysseus/ithaca", revision: "main" }
      : REFERENCE_SCENARIOS.includes(scenario) ? REFERENCE_ACTIONS[turnIndex] : scenario === "promotion" ? { command: "printf 'Odysseus raft plan' > /tmp/raft.txt" } : { path: "notes/raft.md" }) }
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
  for (scenario of ["control", "repository", "facts", "promotion", "reference", "renewal", "freshness", "datatree"]) {
    brain = fixtureBrain(scratch, scenario);
    capture = captures[scenario] = { sessions: [], exchanges: [], appends: [] };
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(scratch, `sessions-${scenario}`), loadExtensions: false,
      profiles: [{ id: "fixture", label: "Fixture", vendor: "openai", model: "gpt-4o-mini", thinkingLevel: "off" }], confirmBashPatterns: [] });
    let sessionId: string | undefined;
    sequence = 0;
    for (turnIndex = 0; turnIndex < 3; turnIndex++) {
      turnOpen = true;
      if (scenario === "repository" && turnIndex) changeRepository(brain, turnIndex);
      const facts = scenario === "facts" ? turnIndex : 0;
      const controller = new AbortController();
      const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", ...(scenario === "promotion" ? {} : { areas: [] }) });
      const frames: ServerMessage[] = [];
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await startFixtureTurn(backend, brain, { prompt: `Odysseus checks voyage step ${turnIndex}.`, profileId: "fixture", sessionId,
          signal: controller.signal, turnId: `odysseus-${turnIndex}`,
          workerSandbox: { ...sandbox, noteFacts: { history: { journal: facts !== 1, userRevert: facts === 2 } },
            ...(scenario === "datatree" ? { dataTree: turnDataTree(scratch, brain, scenario, turnIndex) } : {}) },
          client: { formFactor: facts === 1 ? "phone" : "tablet", viewportWidth: 800 + facts * 100, camera: facts !== 1 }, turnBudgetMs: 60_000 + facts * 1000,
          bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" as const }; },
            // The second turn has no host handler: the tool refuses, and the roster must not change.
            ...(REFERENCE_SCENARIOS.includes(scenario) && (scenario !== "reference" || turnIndex !== 1) ? { async referenceAccess(call: ReferenceToolCall) {
              (capture.calls ??= []).push(call);
              if (scenario === "freshness") {
                const step = SOURCE_FRESHNESS[turnIndex]!;
                return { ok: true as const, guidance: "Fixture source step.", source: { repository: "https://github.com/odysseus/ithaca", revision: "main", domain: "public" as const,
                  commit: step.commit, path: "/tmp/brain-reference/public/ithaca", freshness: step.freshness, refreshedAt: new Date(Date.UTC(2026, 6, 12, step.hour)).toISOString(),
                  validatedAt: new Date(Date.UTC(2026, 6, 12, turnIndex)).toISOString(), error: step.error } };
              }
              const worktree = { id: "raft-worktree", repository: "https://github.com/odysseus/ithaca", revision: "main", domain: "public" as const,
                startingCommit: "1".repeat(40), state: turnIndex === 2 ? "released" as const : "active" as const, path: turnIndex === 2 ? null : "/tmp/brain-worktrees/raft-worktree",
                lastActivityAt: new Date(Date.UTC(2026, 6, 12, turnIndex)).toISOString(), expiresAt: new Date(Date.UTC(2026, 6, 15, turnIndex)).toISOString(),
                releasedAt: turnIndex === 2 ? new Date(Date.UTC(2026, 6, 12, 2)).toISOString() : null, allowanceBytes: 2 ** 31 };
              return { ok: true as const, action: REFERENCE_ACTIONS[turnIndex]!.action as "request", worktree, guidance: "Fixture lifecycle step." };
            } } : {}) },
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
