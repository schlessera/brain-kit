/**
 * The fixture host process for #689's recovery proof. It boots the real app
 * with the gated production dispatcher and serves it on loopback, as the
 * generated host's supervised process will. The test is its supervisor: it
 * pokes through the token file, SIGKILLs it at a named point and restarts it.
 *
 * argv: <dir> <brain> <db> <hold>. `hold` names where the deterministic model
 * stops and waits to be killed: "claim" (the backend started), "checkpoint"
 * (an escalation committed), "effect" (an approved write applied), or "".
 * `<dir>/clock` holds the supervisor's clock offset in milliseconds.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend, BrainApplicationInput } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createApp, type CreateAppOptions } from "../../src/app.js";
import { resolveServerConfig } from "../../src/config/env.js";
import { createStaticBackendRegistry } from "../../src/agent/backend.js";
import { createSilentObservability } from "../../src/observability/index.js";
import { createPrincipal } from "../../src/db/principals.js";
import { INBOX_DISPATCH_FIXTURE, type InboxDispatchFixture } from "../../src/inbox/dispatch-fixture.js";

const SECRET = "fixture-cookie-secret-0123456789abcdef";
const NOTE = "notes/ithaca-loom.md";
const WRITE: BrainApplicationInput = { operation: "write", path: NOTE, expectedBaseHash: null,
  content: "Penelope keeps the loom until Odysseus returns.\n" };
const [dir, brain, dbPath, hold] = process.argv.slice(2) as [string, string, string, string];
const now = () => Date.now() + Number(existsSync(join(dir, "clock")) ? readFileSync(join(dir, "clock"), "utf8") : 0);
const reached = (point: string) => { writeFileSync(join(dir, `reached-${point}`), String(process.pid)); return new Promise<never>(() => {}); };
let turn = 0;
const log = (entry: unknown) => writeFileSync(join(dir, `turn-${process.pid}-${++turn}.json`), JSON.stringify(entry));

const backend: AgentBackend = { id: "pi", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
  thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
  listProfiles: () => [{ id: "fixture", label: "Fixture" }], listSessions: async () => [], getHistory: async () => [],
  brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
  startTurn: async (req) => {
    const followUp = req.autonomous?.systemPromptAppend.includes("Approved capability: exactly") ?? false;
    if (hold === "claim") await reached("claim");
    const result = await req.bridge.applyBrain!(WRITE);
    log({ followUp, result });
    if (hold === "checkpoint" && !followUp) await reached("checkpoint");
    if (hold === "effect" && followUp && result.ok) await reached("effect");
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: req.signal.aborted ? "cancelled" : "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
const fixture: InboxDispatchFixture = { classificationKey: "fixture-classification-key", now,
  fetch: async (_url, init) => {
    const ids = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(ids.map(id => [id,
      { type: "choice", choice: "needs_agent", confidence: 0.9, probabilities: { drop: 0.03, rule: 0.03, needs_agent: 0.91, needs_user: 0.03 } }])) });
  },
  select: async () => ({ backend, profileId: "fixture", model: "fixture-model", billingMode: "subscription" }) };

const app = await createApp({
  config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: SECRET, HOST: "127.0.0.1",
    DB_PATH: dbPath, BRAIN_PATH: brain, BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "1",
    BRAIN_UI_INBOX_POKE_TOKEN_FILE: join(dir, "run/inbox-poke.token"), BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "100" }),
  observability: createSilentObservability(),
  registry: createStaticBackendRegistry([backend], backend.id),
  [INBOX_DISPATCH_FIXTURE]: fixture,
} as CreateAppOptions);
const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
writeFileSync(join(dir, "ready.json"), JSON.stringify({ port: server.port, principalId: principal.id, pid: process.pid }));
process.on("SIGTERM", async () => { server.stop(true); await app.close(); process.exit(0); });
