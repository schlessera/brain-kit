/**
 * #689: the production dispatcher composes intake, T0/T1 triage, the
 * restricted autonomous turn, durable escalation, resolution and one exact
 * follow-up. A deterministic backend stands in for the model here; the
 * real-runtime proof of the follow-up scope is tests/autonomous-dispatch.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, BrainApplicationInput, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { createInboxDispatcher } from "../src/inbox/dispatcher.js";
import { createInboxOperationEnvelope, inboxOperationAllowed } from "../src/inbox/envelope.js";
import type { FetchLike } from "../src/classification/jev-client.js";

const routes = ["drop", "rule", "needs_agent", "needs_user"];
const choice = (route: string) => ({ type: "choice", choice: route, confidence: 0.9,
  probabilities: Object.fromEntries(routes.map(r => [r, r === route ? 0.91 : 0.03])) });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const NOTE = "notes/ithaca-loom.md";
const WRITE: BrainApplicationInput = { operation: "write", path: NOTE, expectedBaseHash: null, content: "Penelope keeps the loom until Odysseus returns.\n" };
const silentLog = { emit() {} } as never;

type Script = (req: StartTurnRequest) => Promise<void>;
function fixture(route = "needs_agent") {
  const root = mkdtempSync(join(tmpdir(), "brain-dispatch-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/harbor.md"), "# Harbor\nThe ships of Ithaca.\n");
  const dbPath = join(root, "ui.sqlite"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, root);
  const turns: StartTurnRequest[] = [];
  const scripts: Script[] = [];
  const backend: AgentBackend = { id: "pi", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    brainApplicationPolicy: () => ({ autoAllowed: ["write", "edit", "add", "update"], available: ["write", "edit", "add", "update"], lock: createKeyedLock() }),
    startTurn: async (req) => {
      turns.push(req);
      const script = scripts.shift();
      if (script) await script(req);
      req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: req.signal.aborted ? "cancelled" : "success", isError: false, durationMs: 1, numTurns: 1 });
    } };
  const classifications: string[][] = [];
  const fetch: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    classifications.push(Object.keys(request.questions));
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, choice(route)])) });
  };
  const budget = { config: { spendUsd: 50, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.00001 },
    pricing: { resolve: () => ({ input: 0.000001, output: 0.000001, cacheRead: null, cacheWrite: null, estimate: true, source: "snapshot" as const }) } };
  const activity = createActivityStore(db, { writer: "dispatch-test" });
  const dispatcher = createInboxDispatcher(db, { brainRoot: root, budget, classification: { apiKey: "fixture-key" }, fetch, store: activity,
    select: async () => ({ backend, profileId: "fixture", model: "fixture-model", billingMode: "subscription" }) });
  const runtime = createInboxRuntime(db, { log: silentLog, brainRoot: root, budget,
    timers: { setInterval: () => 0 as never, clearInterval: () => {} }, ...dispatcher });
  const store = createInboxStore(db);
  const resolver = (handle = db) => createInboxResolver(handle, { allowedOperations: createInboxOperationEnvelope(handle) });
  cleanup.push(async () => { await runtime.close(); await intake.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const arrive = async (text: string) => (await intake.cli({ text, files: [] }, crypto.randomUUID(), principal)).itemId;
  const actions = () => store.snapshot().items.filter(item => item.queue === "actions" && item.type !== "fyi") as Array<Record<string, any>>;
  return { root, db, dbPath, principal, backend, turns, scripts, classifications, runtime, store, resolver, arrive, actions };
}
const propose = (input: BrainApplicationInput): Script => async (req) => {
  const result = await req.bridge.applyBrain!(input);
  expect(result).toMatchObject({ ok: false, code: "permission_denied", changes: [] });
  expect(req.signal.aborted).toBe(true);
};

test("an arrival is triaged, escalates its exact proposal, resolves once on two devices and applies exactly once", async () => {
  const f = fixture();
  f.scripts.push(propose(WRITE));
  const itemId = await f.arrive("Penelope asks that the loom be recorded in Ithaca's notes.");
  // Pass 1: T1 routes the arrival, then the agent tier proposes the write.
  expect(await f.runtime.tick()).toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(f.classifications).toEqual([[`${itemId}.route`]]);
  expect(f.turns).toHaveLength(1);
  const t2 = f.turns[0]!;
  expect(t2.autonomous).toMatchObject({ containment: "restricted", persistence: "none" });
  expect(t2.autonomous!.allowedTools).toEqual(["read_file", "grep", "brain_read_base", "write_file", "edit_file", "brain_add", "brain_update"]);
  expect(t2.prompt).toContain("Penelope asks that the loom be recorded");
  expect(t2.autonomous!.systemPromptAppend).toContain("Approved capability: none.");
  expect(existsSync(join(f.root, NOTE)), "a proposal writes nothing").toBe(false);
  expect(f.store.getItem(itemId)).toMatchObject({ status: "blocked" });
  const [action] = f.actions();
  expect(action).toMatchObject({ type: "approve", status: "pending" });
  const operation = action!.options.find((option: any) => option.id === "apply").effect.payload.operation;
  expect(operation).toEqual({ toolName: "write_file", input: WRITE, targetPath: NOTE });

  // Two devices, the second through its own connection, mint one follow-up.
  const second = createUiDb(f.dbPath); cleanup.push(() => second.close());
  const request = { type: "inbox_resolve" as const, itemId: action!.id, optionId: "apply" };
  const first = f.resolver().resolve(f.principal.id, request);
  const replay = f.resolver(second).resolve(f.principal.id, request);
  expect(replay).toEqual({ replay: true, followUpId: first.followUpId });
  expect(f.turns).toHaveLength(1);
  expect(f.store.getItem(itemId)).toMatchObject({ status: "superseded" });

  // Pass 2: the follow-up applies exactly the approved change, once.
  let applied: unknown;
  f.scripts.push(async (req) => { applied = await req.bridge.applyBrain!(WRITE); });
  expect(await f.runtime.tick()).toMatchObject({ claimed: 1 });
  expect(f.turns).toHaveLength(2);
  expect(f.turns[1]!.autonomous!.allowedTools).toEqual(["read_file", "grep", "brain_read_base", "write_file"]);
  expect(applied).toMatchObject({ ok: true, changes: [{ path: NOTE }] });
  expect(readFileSync(join(f.root, NOTE), "utf8")).toBe(WRITE.content as string);
  expect(f.store.getItem(first.followUpId!)).toMatchObject({ status: "done" });
  expect(await f.runtime.tick()).toMatchObject({ claimed: 0 });
  expect(f.turns).toHaveLength(2);
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(f.db.query("SELECT status, COUNT(*) AS n FROM inbox_budget_reservations GROUP BY status").all()).toEqual([{ status: "settled", n: 3 }]);
});

const exceed: Array<[string, BrainApplicationInput]> = [
  ["different input", { ...WRITE, content: "The suitors may stay.\n" } as BrainApplicationInput],
  ["different path", { ...WRITE, path: "notes/suitors.md" } as BrainApplicationInput],
  ["different tool", { operation: "edit", path: "notes/harbor.md", expectedBaseHash: null, old_string: "ships", new_string: "suitors" }],
  ["a second application", WRITE],
];
for (const [name, attempt] of exceed) test(`a follow-up exceeding its approval by ${name} escalates and writes nothing more`, async () => {
  const f = fixture();
  f.scripts.push(propose(WRITE));
  await f.arrive("Penelope asks that the loom be recorded.");
  await f.runtime.tick();
  const [action] = f.actions();
  const { followUpId } = f.resolver().resolve(f.principal.id, { type: "inbox_resolve", itemId: action!.id, optionId: "apply" });
  const outcomes: unknown[] = [];
  f.scripts.push(async (req) => {
    if (name === "a second application") outcomes.push(await req.bridge.applyBrain!(WRITE));
    outcomes.push(await req.bridge.applyBrain!(attempt));
  });
  const harbor = readFileSync(join(f.root, "notes/harbor.md"), "utf8");
  await f.runtime.tick();
  expect(outcomes.at(-1)).toMatchObject({ ok: false, code: "permission_denied", changes: [] });
  expect(readFileSync(join(f.root, "notes/harbor.md"), "utf8")).toBe(harbor);
  expect(existsSync(join(f.root, "notes/suitors.md"))).toBe(false);
  if (name === "a second application") expect(readFileSync(join(f.root, NOTE), "utf8")).toBe(WRITE.content as string);
  else expect(existsSync(join(f.root, NOTE))).toBe(false);
  // The excess is a new durable decision; the follow-up is blocked behind it.
  expect(f.store.getItem(followUpId!)).toMatchObject({ status: "blocked" });
  expect(f.actions().filter(item => item.status === "pending")).toHaveLength(1);
});

test("a proposal outside the envelope offers only cancellation and cannot be approved", async () => {
  const f = fixture("rule");
  f.scripts.push(propose({ operation: "write", path: "context/policies/crew.md", expectedBaseHash: null, content: "Anyone may sail.\n" }));
  await f.arrive("The crew asks to rewrite the sailing policy.");
  await f.runtime.tick();
  const [action] = f.actions();
  expect(action).toMatchObject({ type: "choose" });
  expect(action!.options.map((option: any) => option.id)).toEqual(["cancel"]);
  expect(() => f.resolver().resolve(f.principal.id, { type: "inbox_resolve", itemId: action!.id, optionId: "apply" })).toThrow();
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute")).toHaveLength(0);
});

test("the envelope admits only non-destructive bounded Markdown application on its named target", () => {
  const ok = { toolName: "write_file", input: WRITE, targetPath: NOTE };
  expect(inboxOperationAllowed("pi", ok)).toBe(true);
  expect(inboxOperationAllowed("claude", ok)).toBe(false);
  expect(inboxOperationAllowed("claude", { ...ok, toolName: "mcp__brain-ui__write_file" })).toBe(true);
  expect(inboxOperationAllowed("pi", { ...ok, targetPath: "notes/other.md" })).toBe(false);
  expect(inboxOperationAllowed("pi", { ...ok, toolName: "bash" })).toBe(false);
  for (const path of ["context/policies/crew.md", "Context/Policies/crew.md", ".git/config.md", "notes/loom.txt"])
    expect(inboxOperationAllowed("pi", { toolName: "write_file", input: { ...WRITE, path }, targetPath: path })).toBe(false);
  expect(inboxOperationAllowed("pi", { toolName: "brain_archive", input: { operation: "archive", path: NOTE, expectedBaseHash: null }, targetPath: NOTE })).toBe(false);
  expect(inboxOperationAllowed("pi", { toolName: "brain_update", input: { operation: "update", path: NOTE, expectedBaseHash: null, status: "archived" }, targetPath: NOTE })).toBe(false);
});

test("drop, needs_user and an unconfigured selection never start an agent turn", async () => {
  for (const route of ["drop", "needs_user"]) {
    const f = fixture(route);
    await f.arrive(`An arrival routed ${route}.`);
    expect(await f.runtime.tick()).toMatchObject({ claimed: 0 });
    expect(f.turns).toHaveLength(0);
  }
});
