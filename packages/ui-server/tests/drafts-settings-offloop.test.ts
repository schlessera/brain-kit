import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Logger } from "@opentelemetry/api-logs";
import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createSettingsWrites } from "../src/db/settings-writes.js";
import { getSetting } from "../src/db/settings.js";
import { createDraftStore, DraftAuthError, DraftError } from "../src/drafts/store.js";
import { createDraftRoutes } from "../src/routes/drafts.js";
import { acceptDraft } from "../src/ws/drafts.js";
import type { WsHost } from "../src/ws/host.js";
import { createTranscriptionWrites } from "../src/voice/transcription-writes.js";
import { TranscriptionError } from "../src/voice/transcription-store.js";
import { createTranscriptionRoutes } from "../src/routes/transcriptions.js";
import { createModelRoutes } from "../src/routes/models.js";
import { createToolPermissionRoutes } from "../src/routes/tool-permissions.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import { createActivityRuntime } from "../src/activity/runtime.js";
import { createTurnRecorder } from "../src/activity/recorder.js";
import { createRuntimeStatus } from "../src/activity/runtime-status.js";
import { createActivityStore } from "../src/activity/store.js";
import { createSubscriptionMonitor, LAST_PROVEN_SETTING } from "../src/agent/subscription.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const quietLog = { emit() {} } as unknown as Logger;
const tables = ["session_drafts", "session_draft_attachments", "session_draft_receipts", "session_draft_sends", "recording_transcriptions", "settings"];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drafts-settings-odysseus-"));
  const db = createUiDb(join(root, "ui.db"));
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',?,?)").run(NOW, NOW);
  const writer = openSqliteWriter(db);
  expect(writer.offloop, "FILE_BACKED_WRITER_IS_OFFLOOP").toBe(true);
  const sites = await watchWriteSites(db, writer, tables);
  const slow = writer.channel(probe, { table: "odysseus_queue" });
  await slow.ready;
  return { root, db, owner, writer, sites, slow,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function refused(work: () => unknown): Promise<unknown> {
  try { await work(); } catch (error) { return error; }
  throw new Error("Expected a refusal");
}
const save = (key: string, ifMatch = 0) => ({ ifMatch, idempotencyKey: key, sessionId: null, text: "Sail for Ithaca", attachmentIds: [] as string[] });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("draft save, upload, remove, bind and accept commit on the worker at FULL; refusals keep their class and body", async () => {
  const f = await fixture();
  try {
    const drafts = createDraftStore(f.db, { now: () => NOW }, f.writer);
    const uploaded = await drafts.upload(f.owner.id, "ithaca-draft", { idempotencyKey: "oar-image", mime: "image/png", name: "oar.png", bytes: png });
    expect(uploaded.attachmentId, "DRAFT_UPLOAD_COMMITS_ON_WORKER").toBeString();
    expect(await drafts.save(f.owner.id, "ithaca-draft", { ...save("oar-save"), attachmentIds: [uploaded.attachmentId] }), "DRAFT_SAVE_COMMITS_ON_WORKER").toEqual({ revision: 1, updatedAt: NOW });
    const conflict = await refused(() => drafts.save(f.owner.id, "ithaca-draft", save("stale-save")));
    expect(conflict, "DRAFT_CONFLICT_REVIVED_CLASS").toBeInstanceOf(DraftError);
    expect(conflict, "DRAFT_CONFLICT_REVIVED_BODY").toMatchObject({ status: 409, body: { error: "DRAFT_CONFLICT", current: drafts.get(f.owner.id, "ithaca-draft") } });
    const missing = await refused(() => drafts.remove(f.owner.id, "troy-missing", 1));
    expect(missing, "DRAFT_NOT_FOUND_REVIVED_CLASS").toBeInstanceOf(DraftError);
    expect(missing, "DRAFT_NOT_FOUND_REVIVED_BODY").toMatchObject({ status: 404, body: { error: "DRAFT_NOT_FOUND", message: "No draft with this id is stored on this host." } });
    expect(await refused(() => drafts.save("missing-principal", "troy-draft", save("unauthorized"))), "DRAFT_AUTH_REVIVED_CLASS").toBeInstanceOf(DraftAuthError);
    // A newer edit survives the accepted revision and binds using its send receipt.
    await drafts.save(f.owner.id, "ithaca-draft", save("newer-save", 1));
    expect(await drafts.accept({ draftRef: { draftId: "ithaca-draft", revision: 1 }, sessionId: "ithaca", resumed: false, requestId: "voyage-request", principalId: f.owner.id }), "DRAFT_ACCEPT_RECEIPT_COMMITS_ON_WORKER").toBe("kept");
    expect(await drafts.bind(f.owner.id, "ithaca-draft", { sessionId: "ithaca", requestId: "voyage-request" }), "DRAFT_BIND_COMMITS_ON_WORKER").toEqual({ revision: 3 });
    await drafts.remove(f.owner.id, "ithaca-draft", 3);
    expect(f.db.query("SELECT revision, deleted_reason FROM session_drafts").get(), "DRAFT_REMOVE_COMMITS_ON_WORKER").toEqual({ revision: 4, deleted_reason: "deleted" });
    expect(new Set(await f.sites.log()), "DRAFT_WRITES_OBSERVED_AT_FULL").toEqual(new Set(tables.slice(0, 4)));
  } finally { await f.close(); }
});

test("draft acceptance returns immediately behind a slow write; reads wait and a later save cannot overwrite its tombstone", async () => {
  const f = await fixture();
  try {
    const drafts = createDraftStore(f.db, { now: () => NOW }, f.writer);
    await drafts.save(f.owner.id, "ithaca-draft", save("first"));
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("principal", f.owner); await next(); });
    app.route("/", createDraftRoutes(drafts));
    const host = { drafts, log: quietLog } as WsHost;
    let slowDone = false;
    const held = f.slow.call("slow", "hold-draft-accept", 250).then(() => { slowDone = true; });
    const beforeAccept = performance.now();
    expect(acceptDraft(host, { draftRef: { draftId: "ithaca-draft", revision: 1 }, sessionId: "ithaca", resumed: false, requestId: "accepted", principalId: f.owner.id }), "ACCEPT_DRAFT_RETURNS_WITHOUT_WAITING").toBeUndefined();
    expect(performance.now() - beforeAccept, "ACCEPT_DRAFT_RETURNS_BEFORE_SLOW_COMMIT").toBeLessThan(150);
    expect(slowDone, "ACCEPT_DRAFT_DID_NOT_WAIT_FOR_QUEUE").toBe(false);
    let readDone = false;
    const read = Promise.resolve(app.request("/drafts/ithaca-draft")).then(response => { readDone = true; return response; });
    const list = app.request("/drafts");
    const late = refused(() => drafts.save(f.owner.id, "ithaca-draft", save("late", 1)));
    await Bun.sleep(30);
    expect(readDone, "DRAFT_GET_WAITS_FOR_ACCEPT_COMMIT").toBe(false);
    await held;
    const response = await read;
    expect(response.status, "DRAFT_GET_SEES_SENT_TOMBSTONE").toBe(410);
    expect(await response.json()).toMatchObject({ error: "DRAFT_DELETED", tombstoneRevision: 2 });
    expect(await (await list).json(), "DRAFT_LIST_WAITS_FOR_ACCEPT_COMMIT").toEqual({ drafts: [] });
    expect(await late, "SAVE_AFTER_ACCEPT_OBSERVES_TOMBSTONE").toMatchObject({ status: 410, body: { error: "DRAFT_DELETED", tombstoneRevision: 2 } });
    expect(f.db.query("SELECT deleted_reason FROM session_drafts").get()).toEqual({ deleted_reason: "sent" });
  } finally { await f.close(); }
});

test("a transcription claim commits at FULL before provider dispatch; duplicates dispatch once and refusals retain their receipt", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const store = createTranscriptionWrites(f.db, { brainPath: f.root, authMode: "password" }, f.writer);
    let calls = 0;
    const speechProvider: SpeechProvider = {
      id: "odysseus-speech", capabilities: { streaming: false, interimResults: false, endpointing: false, keyterms: false },
      createSession: async () => { throw new Error("No streaming session"); },
      async transcribeRecording() {
        calls++;
        expect(f.db.query("SELECT status FROM recording_transcriptions").get(), "PROVIDER_SEES_COMMITTED_CLAIM").toEqual({ status: "transcribing" });
        await gate;
        return { text: "Odysseus reaches Ithaca." };
      },
    };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("principal", f.owner); await next(); });
    app.route("/", createTranscriptionRoutes({ store, speechProvider, voice: { provider: speechProvider.id, deepgramApiKey: null, keytermLimit: 0, cacheDir: f.root }, keyterms: { brainPath: f.root, cacheDir: f.root, limit: 0 } }));
    const id = randomUUID(), audio = new Uint8Array([1, 2, 3]);
    const hash = createHash("sha256").update(audio).digest("hex");
    const path = `/voice/recordings/${id}/transcription`;
    const put = () => app.request(path, { method: "PUT", headers: { "content-type": "audio/webm", "content-sha256": hash }, body: audio });
    // Observe the route actually submitting its claim while the queue is held.
    const claim = store.claim;
    let submitted!: () => void;
    const queued = new Promise<void>(resolve => { submitted = resolve; });
    let held!: Promise<unknown>;
    store.claim = (...args) => {
      held = f.slow.call("slow", "hold-transcription-claim", 250);
      const result = claim(...args);
      submitted();
      return result;
    };
    const first = put();
    await queued;
    await Bun.sleep(30);
    expect(calls, "TRANSCRIPTION_NO_DISPATCH_BEFORE_CLAIM_COMMIT").toBe(0);
    await held;
    store.claim = claim;
    const duplicate = await put();
    expect(duplicate.status, "TRANSCRIPTION_DUPLICATE_REFUSED").toBe(409);
    const body = await duplicate.json();
    expect(body).toMatchObject({ error: "transcription_in_progress", receipt: { recordingId: id, status: "transcribing" } });
    const refusal = await refused(() => store.claim(f.owner.id, id, hash, speechProvider.id));
    expect(refusal, "TRANSCRIPTION_REVIVED_CLASS").toBeInstanceOf(TranscriptionError);
    expect(refusal, "TRANSCRIPTION_REVIVED_STATUS_CODE_RECEIPT").toMatchObject({ status: 409, body });
    expect(calls, "TRANSCRIPTION_AT_MOST_ONE_DISPATCH").toBe(1);
    release();
    expect(await (await first).json(), "TRANSCRIPTION_COMPLETE_COMMITS_ON_WORKER").toMatchObject({ status: "done", text: "Odysseus reaches Ithaca." });
    expect((await put()).status).toBe(200);
    expect(calls, "TRANSCRIPTION_DONE_NEVER_REDISPATCHES").toBe(1);
    expect(await store.remove(f.owner.id, id, "accepted"), "TRANSCRIPTION_REMOVE_COMMITS_ON_WORKER").toMatchObject({ status: "consumed", disposition: "accepted" });
    expect(await f.sites.log(), "TRANSCRIPTION_SEED_AND_RECEIPTS_COMMIT_AT_FULL").toEqual(["settings", "recording_transcriptions", "recording_transcriptions", "recording_transcriptions"]);
  } finally { release(); await f.close(); }
});

test("model, tool, digest and subscription settings commit on the worker and routes read their committed writes", async () => {
  const f = await fixture();
  try {
    const settingsWrites = createSettingsWrites(f.db, f.writer);
    const registry = createStaticBackendRegistry([makeFakeBackend({ id: "odysseus", profiles: [{ id: "ithaca", label: "Ithaca", vendor: "fixture" }] })], "odysseus");
    const models = createModelRoutes({ db: f.db, registry, settingsWrites });
    const put = (path: string, body: unknown) => models.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const hidden = await put("/models/hidden", { hidden: ["ithaca"] });
    expect(hidden.status, "MODEL_HIDDEN_COMMITS_ON_WORKER").toBe(200);
    expect((await hidden.json()).models[0].hidden, "MODEL_ROUTE_READS_ITS_COMMIT").toBe(true);
    expect((await (await models.request("/models")).json()).models[0].hidden, "NEXT_MODEL_READ_SEES_SETTING").toBe(true);
    expect((await put("/models/default", { defaultId: "ithaca" })).status, "MODEL_DEFAULT_COMMITS_ON_WORKER").toBe(200);
    expect((await put("/models/billing", { billing: { ithaca: "api" } })).status, "MODEL_BILLING_COMMITS_ON_WORKER").toBe(200);
    expect((await put("/models/thinking", { thinking: {} })).status, "MODEL_THINKING_COMMITS_ON_WORKER").toBe(200);
    await settingsWrites.setDefaultModelId("openrouter:ithaca/odysseus");
    const custom = await put("/models/custom", { models: [] });
    expect(custom.status, "MODEL_CUSTOM_COMMITS_ON_WORKER").toBe(200);
    expect((await custom.json()).defaultModelId, "MODEL_CUSTOM_REMOVAL_WAITS_FOR_DEFAULT_RESET").toBeNull();
    await settingsWrites.setAutoAllowedTools(["Read"]);
    await Promise.all([settingsWrites.addAutoAllowedTool("Write"), settingsWrites.addAutoAllowedTool("Edit")]);
    const tools = createToolPermissionRoutes({ db: f.db, settingsWrites });
    expect(await (await tools.request("/tool-permissions/Read", { method: "DELETE" })).json(), "TOOL_ROUTE_READS_ITS_COMMIT").toEqual({ tools: ["Edit", "Write"] });
    const activity = createActivityRoutes({ db: f.db, store: createActivityStore(f.db), settingsWrites });
    expect((await activity.request("/activity/digest")).status, "DIGEST_VISIT_COMMITS_ON_WORKER").toBe(200);
    expect((await activity.request("/activity/digest/dismiss", { method: "POST" })).status, "DIGEST_DISMISS_COMMITS_ON_WORKER").toBe(200);
    const generated = await activity.request("/activity/digest/generate", { method: "POST" });
    expect(generated.status, "DIGEST_GENERATION_COMMITS_ON_WORKER").toBe(200);
    const digest = (await generated.json()).digest;
    expect(getSetting(f.db, "activity.digest.coveredUntil", null), "DIGEST_TRANSACTION_KEEPS_COVERED_WINDOW").toBe(digest.windowEnd);
    // Seed an observed successful subscription turn, then exercise boot,
    // hourly tick and status through the monitor's actual settings writer.
    const spans = createActivityStore(f.db);
    spans.startSpan({ spanId: "voyage", runId: "voyage", name: "Sail", kind: "turn", origin: "session", attrs: { "brain.billing_observed": "subscription" }, startedAt: NOW });
    spans.endSpan("voyage", { outcome: "success", endedAt: NOW + 1000 });
    const monitor = createSubscriptionMonitor({ db: f.db, settingsWrites, config: { tokenSet: false, mintedAt: null }, log: quietLog, lastTurnFailure: () => undefined, modelSource: async () => null, now: () => new Date(NOW), every: () => () => {} });
    try {
      monitor.tick();
      expect((await monitor.status()).lastProvenAt, "SUBSCRIPTION_STATUS_WAITS_FOR_PROOF").toBe(new Date(NOW + 1000).toISOString());
      expect(getSetting<number | null>(f.db, LAST_PROVEN_SETTING, null), "SUBSCRIPTION_PROOF_COMMITS_ON_WORKER").toBe(NOW + 1000);
    } finally { monitor.close(); }
    const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer, settingsWrites });
    try {
      await runtime.runtime.subscriptionProven(NOW + 2000);
      expect(getSetting<number | null>(f.db, LAST_PROVEN_SETTING, null), "RUNTIME_SUBSCRIPTION_PROOF_COMMITS_ON_WORKER").toBe(NOW + 2000);
    } finally { runtime.close(); }
    const log = await f.sites.log();
    expect(log.length, "SETTINGS_WRITES_OBSERVED_AT_FULL").toBeGreaterThanOrEqual(14);
    expect(new Set(log)).toEqual(new Set(["settings"]));
  } finally { await f.close(); }
});


test("the turn recorder settles only after its subscription proof has committed", async () => {
  const db = createUiDb(":memory:");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let proved = false;
  const runtime = createRuntimeStatus(() => new Date(NOW), quietLog, () => held.then(() => { proved = true; }));
  const recorder = createTurnRecorder({ store: createActivityStore(db), runtime }, { turnId: "ithaca", sessionId: null });
  try {
    recorder.observeActivity({ kind: "runtime_observed", billing: "subscription", policy: "subscription" });
    recorder.finish("success");
    let settled = false;
    const done = recorder.settled().then(() => { settled = true; });
    await Bun.sleep(20);
    expect(settled, "RECORDER_SETTLED_WAITS_FOR_SUBSCRIPTION_PROOF").toBe(false);
    release();
    await done;
    expect(proved).toBe(true);
  } finally { release(); await recorder.settled(); db.close(); }
});
