import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";
/**
 * #2741, maintainer ruling C: a provider-masked autonomous turn starts only
 * when trusted host provenance shows every item and checkpoint of its origin
 * thread compatible with the turn's masks, before any thread text is read
 * into its prompt, and its inbox reads revalidate that before returning
 * anything. The production dispatcher and autonomous bridge run against a
 * deterministic offline backend; no provider is called.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { createInboxDispatcher } from "../src/inbox/dispatcher.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { boundaryPlanner } from "../src/brain/application.js";
import type { FetchLike } from "../src/classification/jev-client.js";

const REPO = resolve(import.meta.dir, "../../..");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
/** A fictional protected fact: Odysseus's private oath lives under me/. */
const SENTINEL = "Zakynthosmarker";
const POLICY = "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\nOnly Anthropic may read Odysseus's own folder.\n";
const routes = ["drop", "rule", "needs_agent", "needs_user"];
const choice = (route: string) => ({ type: "choice", choice: route, confidence: 0.9,
  probabilities: Object.fromEntries(routes.map(r => [r, r === route ? 0.91 : 0.03])) });
const budgetConfig = { config: { spendUsd: 50, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.00001 },
  pricing: { resolve: () => ({ input: 0.000001, output: 0.000001, cacheRead: null, cacheWrite: null, estimate: true, source: "snapshot" as const }) } };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Script = (req: StartTurnRequest) => Promise<void>;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "brain-provenance-")), root = join(directory, "brain");
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "me"), { recursive: true });
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "notes/harbor.md"), "# Harbor\nThe ships of Ithaca.\n");
  writeFileSync(join(root, "me/oath.md"), `# Oath\n${SENTINEL} is the word Odysseus keeps to himself.\n`);
  writeFileSync(join(root, "context/policies/governance.md"), POLICY);
  const dbPath = join(directory, "ui.sqlite"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, root);
  const turns: StartTurnRequest[] = [], scripts: Script[] = [];
  const backend: AgentBackend = { id: "claude", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    brainApplicationPolicy: () => ({ autoAllowed: [], available: ["write", "edit", "add", "update"], lock: createKeyedLock() }),
    startTurn: async (req) => {
      turns.push(req);
      const script = scripts.shift();
      if (script) await script(req);
      req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: req.signal.aborted ? "cancelled" : "success", isError: false, durationMs: 1, numTurns: 1 });
    } };
  const fetch: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, choice("needs_agent")])) });
  };
  const native = createNativeAppFixture(root), nativeManager = createNativeBrainManagerClient(native.nativeBrain);
  const activity = createActivityStore(db, { writer: "provenance-test" });
  const privateIndex = { maskPaths: [], command: CLI };
  const dispatcher = createInboxDispatcher(db, { brainRoot: root, nativeManager, privateIndex,
    applicationPlanner: boundaryPlanner(createHostBoundary({ brainPath: root, dbPath, nativeManager })), budget: budgetConfig,
    classification: { apiKey: "fixture-key" }, fetch, store: activity,
    select: async () => ({ backend, profileId: "fixture", model: "fixture-model", billingMode: "subscription" }) });
  const runtime = createInboxRuntime(db, { log: { emit() {} } as never, brainRoot: root, budget: budgetConfig,
    timers: { setInterval: () => 0 as never, clearInterval: () => {} }, ...dispatcher });
  const store = createInboxStore(db);
  cleanup.push(async () => { await runtime.close(); await intake.close(); await native.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  /** A person's arrival through the authenticated queue route's intake. */
  const arrive = async (text: string) => intake.person({ text, files: [] }, crypto.randomUUID(), principal);
  /** An arrival a conversation added (`inbox_add`): no person provenance. */
  const conversationArrival = async (text: string) => intake.cli({ text, files: [] }, `bridge:${principal.id}:turn:${crypto.randomUUID()}`, principal, () => true);
  /** Text an earlier run left in the thread before any provenance was recorded. */
  const legacy = (threadId: string, text: string) => {
    const at = Date.now(), id = crypto.randomUUID();
    store.commit([{ kind: "item", item: { id, dedupKey: id, threadId, queue: "actions", type: "fyi", status: "pending", version: 1,
      createdAt: at, updatedAt: at, expiresAt: at + 86_400_000, payload: { title: "Earlier run", detail: text }, options: [] } }]);
    return id;
  };
  /** Every table outside the inbox's own stored items: traces, runs, events. */
  const traces = () => (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'inbox_%'").all() as { name: string }[])
    .map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).join("\n");
  const claim = (itemId: string, runId: string) => createInboxBudget(db, budgetConfig)
    .claim(itemId, { runId, principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, Date.now() + 600_000);
  const deps = { db, store: activity, brainPath: root, nativeManager, privateIndex, checkpoint() {} };
  return { root, db, principal, backend, turns, scripts, runtime, store, arrive, conversationArrival, legacy, traces, claim, deps };
}

test("dispatch refuses a thread holding an earlier item without provenance before its prompt is built", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded in Ithaca's notes.");
  const earlier = f.legacy(arrival.threadId, `${SENTINEL}: quoted from me/oath.md by a run before the provider rule existed.`);
  expect(await f.runtime.tick()).toMatchObject({ claimed: 1 });
  expect(f.turns, "NO_DISPATCH_FOR_AN_UNQUALIFIED_THREAD").toHaveLength(0);
  expect(f.traces(), "NO_TRACE_RECEIVES_THE_EARLIER_SENTINEL").not.toContain(SENTINEL);
  expect(f.traces(), "REFUSAL_RECORDED_WITH_THE_EXISTING_ENVELOPE").toContain(`provider_masked: inbox thread ${arrival.threadId} is unavailable`);
  // Stored, not completed, dropped or rewritten: the work waits in backoff.
  expect(f.store.getItem(arrival.itemId), "QUEUED_WORK_PRESERVED").toMatchObject({ status: "ready", waitUntil: expect.any(Number) });
  expect((f.store.getItem(earlier) as { payload: { detail: string } }).payload.detail).toContain(SENTINEL);
  expect(existsSync(join(f.root, SHARE_STAGING_DIR, arrival.result.id, "meta.json")), "ARRIVAL_STAGING_PRESERVED").toBe(true);
}, 120_000);

test("dispatch refuses a triggering arrival without person provenance, so its text never reaches the prompt", async () => {
  const f = fixture();
  const arrival = await f.conversationArrival(`A conversation added this: ${SENTINEL} from me/oath.md.`);
  expect(await f.runtime.tick()).toMatchObject({ claimed: 1 });
  expect(f.turns.map(turn => turn.prompt), "TRIGGER_SENTINEL_NEVER_DISPATCHED").toEqual([]);
  expect(f.traces(), "NO_TRACE_RECEIVES_THE_TRIGGER_SENTINEL").not.toContain(SENTINEL);
  expect(f.store.getItem(arrival.itemId)).toMatchObject({ status: "ready", waitUntil: expect.any(Number) });
}, 120_000);

test("dispatch refuses an arrival whose staged bytes changed after intake recorded them", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded.");
  const meta = join(f.root, SHARE_STAGING_DIR, arrival.result.id, "meta.json");
  const manifest = JSON.parse(await Bun.file(meta).text()) as Record<string, unknown>;
  writeFileSync(meta, JSON.stringify({ ...manifest, text: `Rewritten in place: ${SENTINEL}.` }));
  await f.runtime.tick();
  expect(f.turns.map(turn => turn.prompt), "REWRITTEN_ARRIVAL_NEVER_DISPATCHED").toEqual([]);
  expect(f.traces()).not.toContain(SENTINEL);
}, 120_000);

test("a person's arrival through real intake is admitted under the masks with its evidence recorded", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded in Ithaca's notes.");
  await f.runtime.tick();
  expect(f.turns, "COMPATIBLE_THREAD_ADMITTED").toHaveLength(1);
  expect(f.turns[0]!.prompt).toContain("Penelope asks that the loom be recorded");
  expect(f.turns[0]!.workerProviderMasks?.folders, "ADMITTED_UNDER_THE_PROVIDER_MASKS").toEqual(["me"]);
  const row = f.db.query("SELECT provider_admission FROM inbox_budget_reservations WHERE item_id = ? AND purpose = 'execute'").get(arrival.itemId) as { provider_admission: string };
  const admission = JSON.parse(row.provider_admission) as { masked: string[]; policyHash: string; subjects: { subject: string; origin: string; derivedFrom?: string }[] };
  expect(admission.masked).toEqual(["me"]);
  expect(admission.policyHash).toEqual(expect.any(String));
  expect(admission.subjects, "EVIDENCE_RECORDED_ON_THE_ADMISSION").toEqual([
    { subject: `item:${arrival.itemId}`, origin: "person" },
    { subject: `checkpoint:triage-result:${arrival.itemId}`, origin: "person", derivedFrom: `item:${arrival.itemId}` },
  ]);
}, 120_000);

const READS = ["mcp__brain-ui__inbox_list", "mcp__brain-ui__inbox_get"];
const input = (turnId: string, principalId: string, allowedTools = READS) => ({ turnId, principalId, prompt: "Odysseus reviews his queue.",
  systemPromptAppend: "Server selected instructions", allowedTools, signal: new AbortController().signal });
const message = async (call: () => Promise<unknown>) => { try { return JSON.stringify(await call()); } catch (error) { return `refused: ${(error as Error).message}`; } };

test("autonomous inbox reads revalidate the admission and never return an incompatible item appended mid-turn", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded.");
  f.claim(arrival.itemId, "autonomous-reads");
  const seen: string[] = [];
  let appended = "";
  const backend = { ...f.backend, startTurn: async (req: StartTurnRequest) => {
    seen.push(await message(() => req.bridge.inboxList!({ view: "queue", limit: 50 })));
    seen.push(await message(() => req.bridge.inboxGet!({ itemId: arrival.itemId })));
    appended = f.legacy(arrival.threadId, `${SENTINEL} appended after admission.`);
    seen.push(await message(() => req.bridge.inboxList!({ view: "actions", limit: 50 })));
    seen.push(await message(() => req.bridge.inboxGet!({ itemId: appended })));
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  await runAutonomousTurn({ ...f.deps, backend }, input("autonomous-reads", f.principal.id));
  expect(seen[0], "COMPATIBLE_READ_ALLOWED").toContain(arrival.itemId);
  expect(seen[1]).toContain(arrival.itemId);
  expect(seen.slice(2).join("\n"), "BRIDGE_NEVER_RETURNS_THE_APPENDED_SENTINEL").not.toContain(SENTINEL);
  for (const refusal of seen.slice(2)) expect(refusal).toContain(`refused: provider_masked: inbox thread ${arrival.threadId}`);
  expect(f.store.getItem(appended), "APPENDED_ITEM_PRESERVED").not.toBeNull();
}, 120_000);

test("autonomous inbox reads refuse after the policy changes mid-turn", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded.");
  f.claim(arrival.itemId, "autonomous-policy");
  const seen: string[] = [];
  const backend = { ...f.backend, startTurn: async (req: StartTurnRequest) => {
    seen.push(await message(() => req.bridge.inboxList!({ view: "queue", limit: 50 })));
    writeFileSync(join(f.root, "context/policies/governance.md"), `${POLICY}Penelope may read it too, one day.\n`);
    seen.push(await message(() => req.bridge.inboxList!({ view: "queue", limit: 50 })));
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  await runAutonomousTurn({ ...f.deps, backend }, input("autonomous-policy", f.principal.id));
  expect(seen[0]).toContain(arrival.itemId);
  expect(seen[1], "CHANGED_POLICY_INVALIDATES_THE_ADMISSION").toContain("the policy changed after the turn was admitted");
}, 120_000);

test("masked autonomous reads keep the exact roster, the origin thread scope and live principal authority", async () => {
  const f = fixture();
  const arrival = await f.arrive("Penelope asks that the loom be recorded.");
  const other = await f.arrive("Telemachus asks about the ships.");
  f.claim(arrival.itemId, "autonomous-scope");
  const seen: string[] = [];
  const backend = { ...f.backend, startTurn: async (req: StartTurnRequest) => {
    seen.push(await message(() => req.bridge.inboxList!({ view: "queue", limit: 50 })));
    seen.push(await message(() => req.bridge.inboxGet!({ itemId: arrival.itemId })));
    seen.push(await message(() => req.bridge.inboxGet!({ itemId: other.itemId })));
    revokePrincipal(f.db, f.principal.id, Date.now());
    seen.push(await message(() => req.bridge.inboxGet!({ itemId: arrival.itemId })));
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  await runAutonomousTurn({ ...f.deps, backend }, input("autonomous-scope", f.principal.id, ["mcp__brain-ui__inbox_get"]));
  expect(seen[0], "ROSTER_EXCLUDES_INBOX_LIST").toBe("refused: Inbox read is outside the exact restricted roster");
  expect(seen[1], "ROSTER_ALLOWS_INBOX_GET").toContain(arrival.itemId);
  expect(seen[2], "OTHER_THREAD_OUTSIDE_SCOPE").toBe("refused: Inbox read is outside this turn's scope");
  expect(seen[3], "REVOKED_PRINCIPAL_REFUSED").toBe("refused: Inbox principal or turn is no longer authorized");
}, 120_000);

test("an unrestricted turn keeps its reads and needs no provenance", async () => {
  const f = fixture();
  rmSync(join(f.root, "context/policies/governance.md"));
  const arrival = await f.conversationArrival("A conversation added this before any provider rule.");
  f.legacy(arrival.threadId, "An earlier run's note.");
  f.claim(arrival.itemId, "autonomous-open");
  let seen = "";
  const backend = { ...f.backend, startTurn: async (req: StartTurnRequest) => {
    seen = await message(() => req.bridge.inboxList!({ view: "actions", limit: 50 }));
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const result = await runAutonomousTurn({ ...f.deps, backend }, input("autonomous-open", f.principal.id));
  expect(result.outcome).toBe("success");
  expect(seen, "UNRESTRICTED_READS_UNCHANGED").toContain("An earlier run's note.");
}, 120_000);
