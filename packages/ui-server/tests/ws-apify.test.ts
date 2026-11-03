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
import { APIFY_INPUT, APIFY_LIMITS, APIFY_SENTINEL, apifyPolicy, fakeApify, routeApifyOrigins } from "./fixtures/apify-host-fixture.js";

async function hostedTurn(backendId: "pi" | "claude", policy: Record<string, unknown> | null, script: (apify: (tool: string, input: unknown) => Promise<ApifyEnvelope>) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-apify-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  apifyPolicy(brain, policy);
  const fake = fakeApify(), restore = routeApifyOrigins(fake);
  const previous = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = APIFY_SENTINEL;
  let finished = false;
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge }) => {
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca-apify", isNew: true });
    try { await script(async (tool, input) => bridge.apify!({ tool: tool as never, input: input as Record<string, unknown> })); }
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
    const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Chart the way home", requestId: "apify-request" }) } as MessageEvent, ws);
    const until = Date.now() + 20_000;
    while (!finished) { if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`); await Bun.sleep(10); }
    await Bun.sleep(50);
    const taint = app.db.query("SELECT session_id, turn_id, payload FROM governance_events WHERE kind = 'taint'").all() as Array<{ session_id: string | null; turn_id: string | null; payload: string }>;
    return { root, fake, sent, taint, ledger: resolve(root, "ui.db.apify-ledger.sqlite") };
  } finally {
    await app.close(); broker.close(); await native.close();
    restore(); fake.stop();
    if (previous === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = previous;
  }
}

test("a pi turn reaches the hosted operations with its own context, ledger and taint; no build is qualified, so nothing runs", async () => {
  const envelopes: ApifyEnvelope[] = [];
  const outcome = await hostedTurn("pi", { enabled: true, discovery: "allow", actors: "ask", limits: APIFY_LIMITS }, async apify => {
    const found = await apify("brain_apify_discover", { query: "sea charts" });
    envelopes.push(found);
    const candidate = (found as { data: { candidates: Array<{ candidate: string }> } }).data.candidates[0]!.candidate;
    envelopes.push(await apify("brain_apify_inspect", { candidate }));
    const prepared = await apify("brain_apify_prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 });
    envelopes.push(prepared);
    envelopes.push(await apify("brain_apify_run", { proposal: (prepared as { data: { proposal: string } }).data.proposal }));
  });
  try {
    expect(envelopes.map(envelope => envelope.ok ? "ok" : envelope.error.code), "APIFY_APP_WIRING_SEQUENCE").toEqual(["ok", "ok", "ok", "actor_unsupported"]);
    expect((envelopes[1] as { data: { eligibility: { reasons: string[] } } }).data.eligibility.reasons, "APIFY_NO_PRODUCTION_PROFILE").toContain("no_qualified_profile");
    expect(outcome.fake.starts(), "APIFY_APP_NOTHING_STARTED").toBe(0);
    // G6: the first untrusted Apify text tainted the named session, before it reached the turn.
    expect(outcome.taint.map(row => ({ session: row.session_id, source: JSON.parse(row.payload).source })), "APIFY_TAINTS_SESSION")
      .toEqual([{ session: "sess-ithaca-apify", source: "apify_result" }]);
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
