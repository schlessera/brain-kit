/** Executed inside a network namespace with loopback fixture inference only. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeBackend } from "../../packages/ui-backend-claude/src/backend.js";
import { createPiBackend } from "../../packages/ui-backend-pi/src/backend.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createActivityStore } from "../../packages/ui-server/src/activity/store.js";
import { createInboxStore } from "../../packages/ui-server/src/inbox/store.js";
import { createInboxBudget } from "../../packages/ui-server/src/inbox/budget.js";
import { createPrincipal, revokePrincipal } from "../../packages/ui-server/src/db/principals.js";
import { runAutonomousTurn, type AutonomousEscalation } from "../../packages/ui-server/src/inbox/autonomous-turn.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import type { InferenceProfile } from "../../packages/ui-backend-claude/src/profiles.js";

const [backendName, scenario, root] = process.argv.slice(2) as [string, string, string];
const brainPath = join(root, "brain");
const configDir = join(root, "claude");
const piDir = join(root, "pi");
for (const dir of [brainPath, configDir, piDir]) mkdirSync(dir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.PI_CODING_AGENT_DIR = piDir;
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
const db = createUiDb(join(root, "ui.sqlite"));
// Fictional rates for the loopback transport, shared by admission and rollup.
const pricing = { resolve: () => ({ input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0.001,
  estimate: false, source: "snapshot" as const }) };
const store = createActivityStore(db, { writer: "autonomous-runtime-test", pricing });
const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
const frames: ServerMessage[] = [];
const captured: AutonomousEscalation[] = [];
let failure: { name: string; message: string } | undefined;
const inbox = createInboxStore(db);
if (scenario !== "ordinary" && scenario !== "unreserved") {
  inbox.ingest({ threadId: "fixture-thread", itemId: "fixture-item", dedupKey: "fixture-dedup",
    stagingId: "fixture-staging", source: "cli", stakes: 1, expiresAt: Date.now() + 3600_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 1, emergencySpendUsd: 0, emergencyTurns: 0,
    timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing });
  const admitted = budget.claim("fixture-item", { runId: "fixture-run", principalId: principal.id, model: "claude-sonnet-4-6",
    billingMode: "api", purpose: "execute", maximumTokens: { inputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 0, cacheCreationTokens: 0 } }, Date.now() + 600_000);
  if (!admitted) throw new Error("Fixture budget admission refused");
}
let calls = 0;
let sent = false;
let sawExpectedTool = false;
let revokedAt: number | undefined;
const toolName = backendName === "claude" ? "Write" : "write_file";
const witness = join(brainPath, "unauthorized.md");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
  const body = await request.json() as { tools?: Array<{ name: string }> };
  calls++;
  if (scenario === "revoked") {
    if (revokedAt === undefined) {
      revokedAt = Date.now();
      revokePrincipal(db, principal.id, revokedAt);
    }
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
  }
  const permission = scenario === "permission";
  const callName = permission ? toolName : backendName === "claude" ? "mcp__brain-ui__ask_user" : "ask_user";
  const question = scenario === "question";
  const bridgePermission = scenario === "bridge-permission";
  const offered = Boolean(body.tools?.some((tool) => tool.name === callName));
  if ((permission || question || bridgePermission) && !sent && offered) {
    sent = true;
    sawExpectedTool = true;
    const input = permission ? backendName === "claude" ? { file_path: witness, content: "should not exist" } :
      { path: "unauthorized.md", content: "should not exist" } :
      { questions: [{ question: "Which harbor should Odysseus choose?", header: "Harbor", options: [{ label: "Ithaca", description: "Return home." }, { label: "Pylos", description: "Continue sailing." }], multiSelect: false }] };
    return sse([
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus reached the authority boundary." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_autonomous", name: callName, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  }
  return sse([start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus completed the fixture turn." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }]);
} });
function start(): unknown {
  return { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant",
    model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
}
function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
function transcripts(path: string): string[] {
  return readdirSync(path, { recursive: true }).filter((name) => typeof name === "string" && name.endsWith(".jsonl")) as string[];
}
const url = `http://127.0.0.1:${server.port}`;
// Isolated runtime config and bogus credential. The surrounding namespace has
// no external network; no saved credential or provider endpoint is reachable.
writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: url, apiKey: "offline-fixture" } } }));
const profile: InferenceProfile = { id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api",
  requiredEnvKeys: [], buildEnv: () => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) };
const backend = backendName === "claude" ? createClaudeBackend({ brainPath, profiles: [profile], log: () => {} }) :
  createPiBackend({ brainPath, profiles: [{ id: "fixture", label: "Fixture", vendor: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" }], loadExtensions: false });
const controller = new AbortController();
if (scenario === "preaborted") controller.abort();
const deadline = setTimeout(() => controller.abort(), 15_000);
try {
  if (scenario === "ordinary") {
    await backend.startTurn({ prompt: "Odysseus fixture", profileId: "fixture", signal: controller.signal,
      bridge: { emit: (frame) => frames.push(frame), requestPermission: async () => ({ behavior: "deny", message: "Fixture" }) } });
  } else {
    try { await runAutonomousTurn({ db, store, backend, emit: (frame) => frames.push(frame), checkpoint: (intent) => { captured.push(intent);
      // A real synchronous commit witnesses ordering before runtime abort.
      writeFileSync(join(root, "checkpoint.json"), JSON.stringify(intent));
    } }, { turnId: "fixture-run", principalId: principal.id, prompt: "Odysseus fixture", profileId: scenario === "unsupported" ? "unknown" : "fixture",
      billingMode: "api", allowedTools: scenario === "question" ? [backendName === "claude" ? "mcp__brain-ui__ask_user" : "ask_user"] : [],
      systemPromptAppend: "Use the explicit fixture task.", signal: controller.signal });
    } catch (error) {
      if (scenario !== "unsupported" && scenario !== "unreserved") throw error;
      failure = { name: (error as Error).name, message: (error as Error).message };
    }
  }
  const revocationElapsedMs = revokedAt === undefined ? undefined : Date.now() - revokedAt;
  const rollup = db.query("SELECT * FROM activity_run_rollups WHERE run_id = 'fixture-run'").get() as { cost_usd: number | null } | null;
  const spans = db.query("SELECT * FROM activity_spans WHERE run_id = 'fixture-run'").all();
  const events = db.query("SELECT * FROM activity_events").all();
  const sessions = await backend.listSessions();
  const histories = await Promise.all(sessions.map((session) => backend.getHistory(session.id)));
  console.log(JSON.stringify({ frames, captured, calls, sawExpectedTool, rollup, spans, events, sessions, failure, revocationElapsedMs,
    reservation: db.query("SELECT r.*, a.input_tokens, a.output_tokens FROM inbox_budget_reservations r JOIN activity_run_rollups a ON a.run_id = r.run_id").get(),
    histories, transcripts: transcripts(root), interactiveRows: db.query("SELECT COUNT(*) AS n FROM sessions").get(),
    checkpoint: captured.length ? JSON.parse(readFileSync(join(root, "checkpoint.json"), "utf8")) : null }));
} finally {
  clearTimeout(deadline);
  server.stop(true);
  db.close();
}
