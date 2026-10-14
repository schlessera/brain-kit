/**
 * #689 through the real app: production autonomous dispatch stays off for
 * every configuration, and the repository's fixture host drives the gated
 * production dispatcher through the supported interfaces the generated host
 * will use: authenticated CLI intake, the `BRAIN_UI_INBOX_POKE_TOKEN_FILE`
 * cron poke, WebSocket resolution from two devices, and a supervisor restart.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { BrainUiClient, type ServerMessage } from "@schlessera/brain-ui-sdk/client";
import type { AgentBackend, BrainApplicationInput, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { type CreateAppOptions } from "../../src/app";
import { createFixtureApp as createApp } from "../helpers/native-app-fixture.js";
import { resolveServerConfig } from "../../src/config/env.js";
import { createStaticBackendRegistry } from "../../src/agent/backend.js";
import { createSilentObservability } from "../../src/observability/index.js";
import { createPrincipal } from "../../src/db/principals.js";
import { createInboxStore } from "../../src/inbox/store.js";
import { INBOX_DISPATCH_FIXTURE, type InboxDispatchFixture } from "../../src/inbox/dispatch-fixture.js";
import type { FetchLike } from "../../src/classification/jev-client.js";

const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
const SECRET = "fixture-cookie-secret-0123456789abcdef";
const NOTE = "notes/ithaca-loom.md";
const WRITE: BrainApplicationInput = { operation: "write", path: NOTE, expectedBaseHash: null, content: "Penelope keeps the loom until Odysseus returns.\n" };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) { if (predicate()) return true; await Bun.sleep(10); }
  return predicate();
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "brain-dispatch-app-"));
  const brain = join(dir, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  // A fresh offline price table: T1 is API billed and refuses unpriced work,
  // and a fresh cache needs no catalog fetch (the test preload refuses one).
  mkdirSync(join(brain, ".brain-ui"), { recursive: true });
  const rate = { input: 4.2e-8, output: 0, cacheRead: null, cacheWrite: null };
  writeFileSync(join(brain, ".brain-ui/model-pricing.json"), JSON.stringify({ version: 1, fetchedAt: Date.now(),
    litellm: { fetchedAt: Date.now(), rates: { "jev-1.13.0": rate } }, openrouter: { fetchedAt: Date.now(), rates: {} } }));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const turns: StartTurnRequest[] = [];
  const applied: unknown[] = [];
  const backend: AgentBackend = { id: "pi", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "fixture", label: "Fixture" }], listSessions: async () => [], getHistory: async () => [],
    brainApplicationPolicy: () => ({ autoAllowed: [], available: [], lock: createKeyedLock() }),
    startTurn: async (req) => {
      turns.push(req);
      // The deterministic model proposes, then applies, the same exact write.
      if (req.autonomous && req.bridge.applyBrain) applied.push(await req.bridge.applyBrain(WRITE));
      req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: req.signal.aborted ? "cancelled" : "success", isError: false, durationMs: 1, numTurns: 1 });
    } };
  const classify: FetchLike = async (_url, init) => {
    const ids = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(ids.map(id => [id,
      { type: "choice", choice: "needs_agent", confidence: 0.9, probabilities: { drop: 0.03, rule: 0.03, needs_agent: 0.91, needs_user: 0.03 } }])) });
  };
  const fixture: InboxDispatchFixture = { classificationKey: "fixture-classification-key", fetch: classify,
    select: async () => ({ backend, profileId: "fixture", model: "fixture-model", billingMode: "subscription" }) };
  return { dir, brain, backend, turns, applied, fixture, tokenFile: join(dir, "run/inbox-poke.token") };
}

async function boot(w: ReturnType<typeof world>, activate: boolean) {
  mkdirSync(join(w.dir, "run"), { recursive: true });
  const options = {
    config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: SECRET, HOST: "127.0.0.1",
      DB_PATH: join(w.dir, "ui.sqlite"), BRAIN_PATH: w.brain, BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "1",
      BRAIN_UI_INBOX_POKE_TOKEN_FILE: w.tokenFile, BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "100", TYPESAFE_API_KEY: "fixture-classification-key" }),
    observability: createSilentObservability(),
    registry: createStaticBackendRegistry([w.backend], w.backend.id),
    ...(activate ? { [INBOX_DISPATCH_FIXTURE]: w.fixture } : {}),
  } as CreateAppOptions;
  const app = await createApp(options);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; server.stop(true); await app.close(); };
  cleanup.push(close);
  const origin = `http://127.0.0.1:${server.port}`;
  /** The fixture cron: read the current token file for each request, as the generated host will. */
  const poke = async () => {
    const response = await fetch(`${origin}/api/internal/inbox/poke`, { method: "POST",
      headers: { authorization: `Bearer ${readFileSync(w.tokenFile, "utf8").trim()}` } });
    expect(response.status).toBe(200);
    return await response.json() as { claimed: number; dispatchEnabled: boolean };
  };
  return { app, origin, poke, close };
}

async function device(running: Awaited<ReturnType<typeof boot>>, principalId: string) {
  const cookie = await serializeSigned("brain_ui_session", principalId, SECRET);
  const frames: ServerMessage[] = [];
  const client = new BrainUiClient({ url: `${running.origin.replace("http", "ws")}/ws`,
    socketFactory: (url) => new NativeWebSocket(url, { headers: { cookie } }), handlers: { onAny: (f) => frames.push(f) } });
  cleanup.push(() => client.close());
  client.connect();
  expect(await waitFor(() => frames.some((f) => f.type === "server_hello"))).toBe(true);
  return { client, frames, cookie };
}

test("no configuration activates production dispatch: a fully configured app leaves arrivals untouched", async () => {
  const w = world(), running = await boot(w, false);
  const principal = createPrincipal(running.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const { cookie } = await device(running, principal.id);
  const queued = await fetch(`${running.origin}/api/queue`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: running.origin },
    body: JSON.stringify({ key: "odysseus-loom", text: "Penelope asks that the loom be recorded." }) });
  expect(queued.status).toBe(201);
  const { itemId } = await queued.json() as { itemId: string };
  expect(await running.poke(), "DISPATCH_DISABLED").toMatchObject({ claimed: 0, dispatchEnabled: false });
  expect(createInboxStore(running.app.db).getItem(itemId)).toMatchObject({ status: "ready", attempts: 0 });
  expect(running.app.db.query("SELECT COUNT(*) AS n FROM inbox_budget_reservations").get()).toEqual({ n: 0 });
  expect(w.turns).toHaveLength(0);
  // The activation symbol is reachable from no package entry point.
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { exports: Record<string, unknown> };
  expect(Object.keys(manifest.exports)).toEqual([".", "./internal", "./package.json"]);
  for (const entry of [await import("../../src/index.js"), await import("../../src/internal.js")])
    expect(Object.values(entry)).not.toContain(INBOX_DISPATCH_FIXTURE);
});

test("the fixture host's cron poke, two devices and a supervisor restart produce one exact effect", async () => {
  const w = world();
  let running = await boot(w, true);
  const principal = createPrincipal(running.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const phone = await device(running, principal.id), laptop = await device(running, principal.id);
  const queued = await fetch(`${running.origin}/api/queue`, { method: "POST", headers: { cookie: phone.cookie, "content-type": "application/json", origin: running.origin },
    body: JSON.stringify({ key: "odysseus-loom", text: "Penelope asks that the loom be recorded in Ithaca's notes." }) });
  expect(queued.status).toBe(201);
  const { itemId } = await queued.json() as { itemId: string };

  // Cron poke 1: T1 routes, the agent tier proposes and escalates.
  expect(await running.poke()).toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(w.turns).toHaveLength(1);
  expect(w.applied[0]).toMatchObject({ ok: false, code: "permission_denied" });
  expect(existsSync(join(w.brain, NOTE))).toBe(false);
  const store = createInboxStore(running.app.db);
  const action = store.snapshot().items.find(item => item.queue === "actions" && item.type === "approve")!;
  expect(action).toBeDefined();
  expect(store.getItem(itemId)).toMatchObject({ status: "blocked", blockedByItemId: action.id });

  // Two devices tap Apply at once; one resolution and one follow-up result.
  for (const { client } of [phone, laptop]) client.send({ type: "inbox_resolve", itemId: action.id, optionId: "apply" });
  expect(await waitFor(() => running.app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get() !== null &&
    (running.app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get() as { n: number }).n === 1)).toBe(true);
  await Bun.sleep(100);
  for (const { frames } of [phone, laptop]) expect(frames.filter(f => f.type === "error")).toEqual([]);
  const executes = () => createInboxStore(running.app.db).snapshot().items.filter(item => item.queue === "queue" && item.type === "execute");
  expect(executes()).toHaveLength(1);

  // Fixture supervisor: the process restarts before the follow-up runs; the
  // new boot rotates the token file and the next cron poke runs it once.
  const before = readFileSync(w.tokenFile, "utf8");
  await running.close();
  running = await boot(w, true);
  expect(readFileSync(w.tokenFile, "utf8")).not.toBe(before);
  expect(await running.poke()).toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(w.applied[1]).toMatchObject({ ok: true, changes: [{ path: NOTE }] });
  expect(readFileSync(join(w.brain, NOTE), "utf8")).toBe(WRITE.content as string);
  expect(createInboxStore(running.app.db).getItem(executes()[0]!.id)).toMatchObject({ status: "done" });
  expect(await running.poke()).toMatchObject({ claimed: 0 });
  expect(w.turns).toHaveLength(2);
});
