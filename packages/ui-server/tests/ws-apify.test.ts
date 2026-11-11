/**
 * The server's own Apify wiring (#3162): createApp builds the hosted
 * operations, and a first-party backend's turn reaches them through the
 * bridge with the context the host authenticated (principal, named session,
 * turn, posture, approvals), the default shared ledger beside the UI
 * database, and the session's G6 taint recorded before remote text returns.
 *
 * Keyless and offline: the fixed Apify origins are routed to a loopback fake
 * after the network preload; the token is a synthetic sentinel.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ApifyEnvelope } from "@schlessera/brain-common/internal/apify-operations";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { GOVERNANCE_EVENT_SCHEMAS, queryGovernanceEvents } from "../src/governance/events.js";
import { pruneSafetyDetail, safetyProjection } from "../src/governance/safety-store.js";
import { APIFY_INPUT, APIFY_LIMITS, APIFY_SENTINEL, apifyPolicy, fakeApify, routeApifyOrigins } from "./fixtures/apify-host-fixture.js";

async function hostedTurn(backendId: "pi" | "claude", policy: Record<string, unknown> | null, script: (apify: (tool: string, input: unknown) => Promise<ApifyEnvelope>) => Promise<void>,
  checkSafety?: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-apify-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  apifyPolicy(brain, policy);
  const fake = fakeApify(), restore = routeApifyOrigins(fake);
  const previous = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = APIFY_SENTINEL;
  let finished = false;
  let scriptError: unknown;
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge }) => {
    // All remote bytes in this fixture come through the real host Apify
    // collector; there are no unobserved SDK/native tool deliveries.
    await bridge.inputSafety!.ready(backendId, 1);
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca-apify", isNew: true });
    try {
      await script(async (tool, input) => bridge.apify!({ tool: tool as never, input: input as Record<string, unknown> }));
      await checkSafety?.(app);
    }
    catch (error) { scriptError = error; throw error; }
    finally {
      bridge.emit({ type: "result", sessionId: "sess-ithaca-apify", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      finished = true;
    }
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: "odysseus-apify-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  const sent: string[] = [];
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus Apify", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => {
      sent.push(text);
      const frame = JSON.parse(text);
      if (frame.type === "tool_approval_request" && frame.kind === "actor") queueMicrotask(() => handlers.onMessage({ data: JSON.stringify({ type: "tool_approval", toolUseId: frame.toolUseId, turnId: frame.turnId, always: true, channel: "card" }) } as MessageEvent, ws));
    }, close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Chart the way home", requestId: "apify-request" }) } as MessageEvent, ws);
    const until = Date.now() + 45_000;
    while (!finished || app.isTurnActive()) { if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`); await Bun.sleep(10); }
    if (scriptError) throw scriptError;
    const taint = app.db.query("SELECT session_id, turn_id, payload FROM governance_events WHERE kind = 'taint'").all() as Array<{ session_id: string | null; turn_id: string | null; payload: string }>;
    return { root, fake, sent, taint, ledger: resolve(root, "ui.db.apify-ledger.sqlite") };
  } finally {
    await app.close(); broker.close(); await native.close();
    restore(); fake.stop();
    if (previous === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = previous;
  }
}

test("a pi turn reaches the hosted operations with its own context, ledger and taint; an Actor-specific always approval admits the run", async () => {
  const envelopes: ApifyEnvelope[] = [];
  const outcome = await hostedTurn("pi", { enabled: true, discovery: "allow", actors: "ask", limits: APIFY_LIMITS }, async apify => {
    const found = await apify("brain_apify_discover", { query: "sea charts" });
    envelopes.push(found);
    const candidate = (found as { data: { candidates: Array<{ candidate: string }> } }).data.candidates[0]!.candidate;
    envelopes.push(await apify("brain_apify_inspect", { candidate }));
    const prepared = await apify("brain_apify_prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 });
    envelopes.push(prepared);
    envelopes.push(await apify("brain_apify_run", { proposal: (prepared as { data: { proposal: string } }).data.proposal }));
  }, async app => {
    expect(safetyProjection(app.db, null, "sess-ithaca-apify"), "APIFY_LATER_INPUT_REMAINS_RESTRICTIVE").toMatchObject({
      unresolvedCount: 2, restriction: "restricted", coverage: { state: "complete" } });
    const events = queryGovernanceEvents(app.db, { kinds: ["taint"], limit: 10 }).sort((a, b) => a.id - b.id);
    expect(events.map(event => event.payload.tool), "APIFY_INDEPENDENT_REMOTE_DELIVERIES")
      .toEqual(["brain_apify_discover", "brain_apify_inspect"]);
    const occurrences = events.map(event => GOVERNANCE_EVENT_SCHEMAS.taint.payload.parse(event.payload).occurrence!);
    expect(new Set(occurrences.map(item => item.id)).size, "APIFY_DISTINCT_HOST_OCCURRENCE_IDENTITIES").toBe(2);
    expect(new Set(occurrences.map(item => item.signalId)).size).toBe(2);
    expect(new Set(occurrences.map(item => item.exposureId)).size).toBe(2);
    const epoch = app.db.query("SELECT id FROM safety_collections WHERE turn_id=?").get(events[0]!.turnId!) as { id: string };
    for (const item of occurrences) expect(item).toMatchObject({ epochId: epoch.id, detector: "compute_input", exposure: "finalized",
      provenance: null, admission: { trusted: false, trustRevision: "0" } });
    // Replay the same host occurrence through the real writer while the turn
    // is live: exact delivery deduplicates, separate remote pages do not.
    const { id: _id, schemaVersion: _version, kind: _kind, payload, ...attribution } = events[0]!;
    const writes = app.wsHost.activity!.governanceWrites!;
    expect(await writes.firstTaint({ ...attribution, kind: "taint", payload: GOVERNANCE_EVENT_SCHEMAS.taint.payload.parse(payload) }),
      "APIFY_EXACT_OCCURRENCE_REPLAY_DEDUPLICATES").toBe(false);
    expect(queryGovernanceEvents(app.db, { kinds: ["taint"], limit: 10 })).toHaveLength(2);
    pruneSafetyDetail(app.db, Date.now() + 1);
    expect(safetyProjection(app.db, null, "sess-ithaca-apify"), "APIFY_PRUNING_PRESERVES_BOTH_RESTRICTIONS").toMatchObject({
      unresolvedCount: 2, restriction: "restricted", coverage: { state: "complete" } });
  });
  try {
    expect(envelopes.map(envelope => envelope.ok ? "ok" : envelope.error.code), "APIFY_APP_WIRING_SEQUENCE").toEqual(["ok", "ok", "ok", "ok"]);
    expect((envelopes[1] as { data: { eligibility: { executable: boolean } } }).data.eligibility.executable, "APIFY_NO_PROFILE_GATE").toBe(true);
    expect(outcome.fake.starts(), "APIFY_APP_APPROVED_ACTOR_STARTED").toBe(1);
    expect(outcome.sent.map(text => JSON.parse(text)).filter(frame => frame.type === "tool_approval_request").map(frame => frame.kind), "APIFY_ACTOR_APPROVAL_CARD").toContain("actor");
    // Discovery and inspection each delivered a separate untrusted page.
    expect(outcome.taint.map(row => ({ session: row.session_id, source: JSON.parse(row.payload).source })), "APIFY_TAINTS_SESSION")
      .toEqual([{ session: "sess-ithaca-apify", source: "apify_result" }, { session: "sess-ithaca-apify", source: "apify_result" }]);
    // The default shared ledger: beside the UI database, private to the host user.
    expect(existsSync(outcome.ledger), "APIFY_DEFAULT_LEDGER_PATH").toBe(true);
    expect(statSync(outcome.ledger).mode & 0o077).toBe(0);
    expect(outcome.sent.join("\n"), "APIFY_SENTINEL_NEVER_SENT_TO_CLIENT").not.toContain(APIFY_SENTINEL);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

test("a claude turn with Apify absent from the policy is refused before any request, and no ledger is created", async () => {
  let envelope: ApifyEnvelope | undefined;
  const outcome = await hostedTurn("claude", null, async apify => { envelope = await apify("brain_apify_discover", { query: "sea charts" }); });
  try {
    expect(envelope, "APIFY_APP_DISABLED_BY_DEFAULT").toMatchObject({ ok: false, error: { code: "provider_disabled", reason: "not_enabled" } });
    expect(outcome.fake.seen).toEqual([]);
    expect(existsSync(outcome.ledger), "APIFY_NO_LEDGER_UNTIL_USED").toBe(false);
    expect(outcome.taint).toEqual([]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);
