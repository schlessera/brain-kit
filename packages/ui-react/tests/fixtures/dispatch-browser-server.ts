/**
 * #689 AC1 browser fixture: the real `createApp` as the fixture host, with
 * the gated production dispatcher, served on loopback for real browser pages.
 *
 * The deterministic model proposes one note in the agent tier and applies it
 * in the follow-up. The installed runtimes' containment is proven separately
 * (tests/autonomous-app.test.ts). This browser container cannot create the
 * restricted envelope, so the fixture answers the per-turn host probe; the
 * deterministic backend starts no worker. The test drives `/fixture` for
 * intake, the cron poke and state reads, and drives the Actions page through
 * the app's own WebSocket.
 *
 * argv: <allowed scene origin>. Prints `{"url": ...}` once it listens.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, BrainApplicationInput } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
import { type CreateAppOptions } from "../../../ui-server/src/app";
import { createFixtureApp as createApp } from "../../../ui-server/tests/helpers/native-app-fixture.js";
import { resolveServerConfig } from "../../../ui-server/src/config/env.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createSilentObservability } from "../../../ui-server/src/observability/index.js";
import { createInboxIntake } from "../../../ui-server/src/inbox/intake.js";
import { createInboxStore } from "../../../ui-server/src/inbox/store.js";
import { resolveAmbientPrincipal } from "../../../ui-server/src/db/principals.js";
import { INBOX_DISPATCH_FIXTURE, type InboxDispatchFixture } from "../../../ui-server/src/inbox/dispatch-fixture.js";

const NOTE = "notes/ithaca-loom.md";
const WRITE: BrainApplicationInput = { operation: "write", path: NOTE, expectedBaseHash: null, content: "Penelope keeps the loom until Odysseus returns.\n" };
const sceneOrigin = process.argv[2]!;
const dir = mkdtempSync(join(tmpdir(), "dispatch-browser-"));
const brain = join(dir, "brain");
mkdirSync(join(brain, "notes"), { recursive: true });
mkdirSync(join(brain, ".brain-ui"), { recursive: true });
mkdirSync(join(dir, "run"), { recursive: true });
const later = Date.now() + 3_600_000;
writeFileSync(join(brain, ".brain-ui/model-pricing.json"), JSON.stringify({ version: 1, fetchedAt: later,
  litellm: { fetchedAt: later, rates: { "jev-1.13.0": { input: 4.2e-8, output: 0, cacheRead: null, cacheWrite: null } } },
  openrouter: { fetchedAt: later, rates: {} } }));
workerHostBoundary.probe = () => ({ ok: true });

const applied: unknown[] = [];
const backend: AgentBackend = { id: "pi", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
  thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
  listProfiles: () => [{ id: "fixture", label: "Fixture" }], listSessions: async () => [], getHistory: async () => [],
  brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
  startTurn: async (req) => {
    applied.push(await req.bridge.applyBrain!(WRITE));
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: req.signal.aborted ? "cancelled" : "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
const fixture: InboxDispatchFixture = { classificationKey: "fixture-classification-key",
  fetch: async (_url, init) => {
    const ids = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(ids.map(id => [id,
      { type: "choice", choice: "needs_agent", confidence: 0.9, probabilities: { drop: 0.03, rule: 0.03, needs_agent: 0.91, needs_user: 0.03 } }])) });
  },
  select: async () => ({ backend, profileId: "fixture", model: "fixture-model", billingMode: "subscription" }) };
const app = await createApp({
  config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: join(dir, "ui.sqlite"), BRAIN_PATH: brain,
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "1", ALLOWED_ORIGINS: sceneOrigin,
    BRAIN_UI_INBOX_POKE_TOKEN_FILE: join(dir, "run/inbox-poke.token"), BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "100" }),
  observability: createSilentObservability(),
  registry: createStaticBackendRegistry([backend], backend.id),
  [INBOX_DISPATCH_FIXTURE]: fixture,
} as CreateAppOptions);
const intake = createInboxIntake(app.db, brain);
const store = createInboxStore(app.db);
let origin = "";

async function control(op: string): Promise<unknown> {
  if (op === "arrive") {
    const principal = resolveAmbientPrincipal(app.db, "none", "No authentication", "No authentication");
    return await intake.cli({ text: "Penelope asks that her loom be recorded in Ithaca's notes.", files: [] }, "odysseus-loom", principal);
  }
  if (op === "poke") {
    const token = readFileSync(join(dir, "run/inbox-poke.token"), "utf8").trim();
    return await (await fetch(`${origin}/api/internal/inbox/poke`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json();
  }
  const items = store.snapshot().items;
  return {
    actions: items.filter(i => i.queue === "actions" && i.type !== "fyi").map(i => ({ id: i.id, status: i.status })),
    executes: items.filter(i => i.queue === "queue" && i.type === "execute").map(i => i.status),
    resolutions: (app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get() as { n: number }).n,
    note: existsSync(join(brain, NOTE)) ? readFileSync(join(brain, NOTE), "utf8") : null,
    applied,
  };
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: app.websocket,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture" && request.method === "POST") {
      const { op } = await request.json() as { op: string };
      return Response.json(await control(op), { headers: { "access-control-allow-origin": sceneOrigin } });
    }
    return app.fetch(request, srv);
  } });
origin = `http://127.0.0.1:${server.port}`;
process.stdout.write(JSON.stringify({ url: origin }) + "\n");
