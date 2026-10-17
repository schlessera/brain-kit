import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import type { WSContext } from "../src/ws/clients.js";
import { queryGovernanceEvents } from "../src/governance/events.js";

const promotion = (source: string) => ({ kind: "promotion_refused" as const, source,
  originalLink: source, reason: "missing" as const, bytes: null, limitBytes: null });
const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > until) throw Error("main-model fixture timed out"); await Bun.sleep(5); }
};

for (const cancel of [false, true]) test(`runtime main identity preserves earlier unknown events through ${cancel ? "cancellation" : "completion and resume"}`, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-main-model-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  let release: () => void = () => {}, started = 0, oldBridge: BackendBridge | undefined;
  const admissions: string[] = [], helperModels: (string | null)[] = [];
  let resumedIdentity: string | null | undefined;
  const backend = makeFakeBackend({ id: "athena", startTurn: async req => {
    started++;
    admissions.push(app.wsHost.journal!.summary(req.turnId!).state);
    const sid = req.sessionId ?? "ithaca";
    req.bridge.emit({ type: "session_info", sessionId: sid, isNew: !req.sessionId });
    if (started === 2) {
      oldBridge!.activity?.({ kind: "main_model", model: "stale-main", sessionId: sid });
      resumedIdentity = app.wsHost.journal!.summary(req.turnId!).model;
    }
    oldBridge = req.bridge;
    req.bridge.activity?.(promotion(`before-${started}`));
    const before = queryGovernanceEvents(app.db, { limit: 100, turnId: req.turnId, kinds: ["promotion_refused"] });
    expect(before[0]?.model, "MODEL_LIVE_EARLY_UNKNOWN").toBeNull();
    const adapter = new StreamAdapter(req.bridge.activity);
    adapter.adapt({ type: "system", subtype: "init", session_id: sid, model: "helper", parent_tool_use_id: "helper-call" } as unknown as SDKMessage);
    helperModels.push(app.wsHost.journal!.summary(req.turnId!).model);
    if (!cancel) adapter.adapt({ type: "system", subtype: "init", session_id: sid, model: "runtime-main" } as unknown as SDKMessage);
    req.bridge.activity?.(promotion(`after-${started}`));
    if (started === 1) await new Promise<void>(done => { release = done; });
    if (cancel) req.bridge.activity?.({ kind: "main_model", model: "late-main", sessionId: sid });
    req.bridge.emit({ type: "tool_use_start", toolUseId: `read-${started}`, toolName: "Read" });
    req.bridge.emit({ type: "tool_result", toolUseId: `read-${started}`, output: "Read refused", isError: true });
    req.bridge.emit({ type: "result", sessionId: sid, outcome: "error", isError: true, durationMs: 1, numTurns: 1,
      usage: { inputTokens: 2, outputTokens: 2, perModel: { "runtime-main": { inputTokens: 1, outputTokens: 1 }, helper: { inputTokens: 1, outputTokens: 1 } } } });
  } });
  const app = await createFixtureApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id) });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 });
    const sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    const handlers = createWsHandlers(app.wsHost, principal); await handlers.onOpen(undefined as never, ws);
    const send = (message: object) => handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
    send({ type: "chat_message", text: "Record Ithaca" });
    await waitFor(() => queryGovernanceEvents(app.db, { limit: 100, kinds: ["promotion_refused"] }).length === 2);
    expect(admissions, "MODEL_ADMISSION_PRECEDES_RUNTIME").toEqual(["recording"]);
    expect(helperModels, "MODEL_HELPER_CANNOT_CHOOSE_MAIN").toEqual([null]);
    if (cancel) send({ type: "cancel", sessionId: "ithaca" });
    release(); await waitFor(() => !app.wsHost.coordinator.isTurnActive());
    const turnId = queryGovernanceEvents(app.db, { limit: 100, kinds: ["promotion_refused"] })[0]!.turnId!;
    oldBridge!.activity?.({ kind: "main_model", model: "post-finish", sessionId: "ithaca" });
    const expected = cancel ? null : "runtime-main";
    expect(app.wsHost.journal!.summary(turnId).model, "MODEL_RUNTIME_ACTIVE_SUMMARY_AND_LATE_REJECTION").toBe(expected);
    const stored = queryGovernanceEvents(app.db, { limit: 100, turnId, kinds: ["promotion_refused"] });
    expect(stored.map(event => event.model), "MODEL_STORED_EARLIER_NULL_PRESERVED").toEqual([null, expected]);
    const replay = await app.fetch(new Request(`http://localhost/api/governance/events?turn=${turnId}&kind=promotion_refused`));
    const exported = await replay.json();
    expect(exported.events.map((event: { model: string | null }) => event.model), "MODEL_REPLAY_EXPORT_EARLIER_NULL_PRESERVED").toEqual([null, expected]);
    expect(JSON.parse(JSON.stringify(stored)).map((event: { model: string | null }) => event.model)).toEqual([null, expected]);
    const summaries = sent.map(text => JSON.parse(text)).filter(frame => frame.type === "turn_journal" && frame.turnId === turnId);
    expect(summaries.at(-1)?.journal.model, "MODEL_LIVE_JOURNAL_SUMMARY").toBe(expected);
    if (!cancel) {
      expect(queryGovernanceEvents(app.db, { limit: 100, turnId, kinds: ["roadblock"] }).at(-1)?.model, "MODEL_MIXED_USAGE_ROADBLOCK_MAIN").toBe("runtime-main");
      send({ type: "chat_message", sessionId: "ithaca", text: "Continue Ithaca" });
      await waitFor(() => started === 2 && !app.wsHost.coordinator.isTurnActive());
      expect(resumedIdentity, "MODEL_RESUMED_TURN_NOT_ENRICHED_BY_OLD_BRIDGE").toBeNull();
      expect(admissions).toEqual(["recording", "recording"]);
      expect(helperModels).toEqual([null, null]);
      app.db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,effective_cost_usd,input_tokens) VALUES('retained','session','invoke_agent','ithaca',?,4000,0,1)").run(Date.now());
      send({ type: "chat_message", sessionId: "ithaca", text: "Review Ithaca", requestId: "refused" });
      await waitFor(() => sent.some(text => { const frame = JSON.parse(text); return frame.type === "error" && frame.requestId === "refused"; }) && !app.wsHost.coordinator.isTurnActive());
      expect(started, "MODEL_DEFAULT_REFUSAL_PRECEDES_RUNTIME").toBe(2);
      expect(queryGovernanceEvents(app.db, { limit: 100, kinds: ["budget_block"] }).at(-1)?.model, "MODEL_DEFAULT_ADMISSION_REFUSAL_STAYS_NULL").toBeNull();
    }
  } finally { release(); await app.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
