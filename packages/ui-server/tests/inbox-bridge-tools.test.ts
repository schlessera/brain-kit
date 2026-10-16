import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { INBOX_TOOL_CONTRACTS, toolInputJsonSchema, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { InboxActionItem, InboxOperation } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeSdkTurn } from "../../ui-backend-claude/src/sdk-options.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import type { SessionToolkit } from "../../ui-backend-pi/src/backend-options.js";
import { createInteractiveShares } from "../src/inbox/interactive-share.js";
import { createBrainApplication } from "../src/brain/application.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { createInboxBridgeTools, type InboxBridgeContext } from "../src/inbox/bridge-tools.js";

const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const operation: InboxOperation = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus returned." }, targetPath: "notes/harbor.md" };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "inbox-bridge-")); closes.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createUiDb(":memory:"); closes.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  const store = createInboxStore(db), intake = createInboxIntake(db, root); closes.push(() => intake.close());
  const now = Date.now(), expiresAt = now + 86400000;
  for (const source of ["share", "cli"] as const) store.ingest({ threadId: source, itemId: `work-${source}`, source, stagingId: crypto.randomUUID(), dedupKey: source, expiresAt, stakes: 1 });
  const action: InboxActionItem = { id: "decision", threadId: "cli", dedupKey: "decision", queue: "actions", type: "approve", status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt,
    payload: { title: "Write the harbor note?", detail: "An exact approved operation." }, options: [
      { id: "approve", label: "Write once", effect: { kind: "enqueue", payload: { instruction: "Write the note", operation } } },
      { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
    ] };
  store.commit([{ kind: "item", item: action }]);
  let current = true, session = "harbor-session", allowed = [operation];
  const resolver = createInboxResolver(db, { allowedOperations: () => allowed });
  const service = createInboxBridgeTools(db, intake, resolver);
  const base: InboxBridgeContext = { principalId: principal.id, turnId: "harbor-turn", origin: "interactive", membership: "interactive", isCurrent: () => current, sessionId: () => session };
  const binding = { sessionId: session, itemId: action.id, optionId: "approve", expectedVersion: 1, effect: action.options[0]!.effect } as InboxBridgeContext["approvedAction"];
  return { root, db, store, principal, intake, service, base, binding, resolver, action,
    expire: () => { current = false; }, session: (id: string) => { session = id; }, restrict: () => { allowed = []; } };
}
function data(text: string): any { return JSON.parse(text.split("\n")[2]!); }
async function attached(kind: "claude" | "pi", f: ReturnType<typeof setup>, context: InboxBridgeContext, extra: Partial<BackendBridge> = {}) {
  const bridge: BackendBridge = { emit() {}, requestPermission: async () => ({ behavior: "deny", message: "No authority from a tool alone" }), ...f.service.forTurn(context), ...extra };
  if (kind === "claude") {
    const { options } = createClaudeSdkTurn({ backend: { brainPath: f.root }, req: { prompt: "Read the inbox", bridge, signal: new AbortController().signal },
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never, abortController: new AbortController(), allowedTools: [], confirmPatterns: [], turnLock: { acquire() {}, release() {} } as never, log() {} });
    const client = new Client({ name: "inbox-proof", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = options.mcpServers!["brain-ui"] as { instance: { connect(t: unknown): Promise<void> } };
    await server.instance.connect(b); await client.connect(a); closes.push(() => client.close());
    const tools = (await client.listTools()).tools;
    for (const contract of INBOX_TOOL_CONTRACTS) {
      const tool = tools.find(tool => tool.name === contract.name);
      expect(tool).toBeDefined(); expect(tool!._meta?.["anthropic/alwaysLoad"]).toBe(true);
      const { $schema: _schema, ...advertised } = tool!.inputSchema;
      expect(advertised as Record<string, unknown>).toEqual(toolInputJsonSchema(contract));
    }
    return { call: async (name: string, input: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: input });
      const text = (result.content as { text: string }[])[0]!.text;
      if (result.isError) throw new Error(text);
      return data(text);
    } };
  }
  // Drive startTurn's real session toolkit, rather than a factory-only roster.
  let invoke: (() => Promise<unknown>) | undefined;
  let reply: unknown, caught: unknown, toolkit: SessionToolkit | undefined;
  const open = async (_id?: string, tools?: SessionToolkit) => {
    toolkit = tools;
    return { sessionId: "harbor-session", subscribe: () => () => {}, prompt: async () => { try { reply = await invoke!(); } catch (error) { caught = error; } }, abort: async () => {}, getSessionStats: () => ({ cost: 0 }), dispose() {} };
  };
  let resumeId: string | undefined;
  const backend = createPiBackend({ brainPath: f.root, loadExtensions: false, sessionFactory: { newSession: open, openSession: open } });
  return { call: async (name: string, input: Record<string, unknown>) => {
    caught = undefined;
    invoke = async () => {
      for (const contract of INBOX_TOOL_CONTRACTS) {
        const tool = toolkit!.tools.find(tool => tool.name === contract.name);
        expect(tool).toBeDefined(); expect(tool!.parameters).toEqual(toolInputJsonSchema(contract));
      }
      const tool = toolkit!.tools.find(tool => tool.name === name)!;
      const result = await tool.execute(`call-${name}`, input, undefined, undefined, {} as never);
      return data((result.content[0] as { text: string }).text);
    };
    await backend.startTurn({ prompt: "Read the inbox", bridge, sessionId: resumeId, signal: new AbortController().signal });
    resumeId = "harbor-session";
    if (caught) throw caught;
    return reply as any;
  } };
}
for (const kind of ["claude", "pi"] as const) {
  test(`${kind} attached inbox executors read populated storage, stage trusted text and replay intake`, async () => {
    const f = setup(), a = await attached(kind, f, f.base);
    expect((await a.call("inbox_list", { view: "queue", limit: 1 })).items).toHaveLength(1);
    expect((await a.call("inbox_get", { itemId: "work-share" })).thread.trustClass).toBe("untrusted");
    const input = { text: "Odysseus inspects the harbor.", idempotencyKey: "harbor" };
    const first = await a.call("inbox_add", input), second = await a.call("inbox_add", input);
    expect(first.created).toBe(true); expect(second).toEqual({ ...first, created: false });
    expect(f.store.getThread(first.threadId)).toMatchObject({ trustClass: "trusted", source: "cli" });
    await expect(a.call("inbox_add", { ...input, text: "Different content" })).rejects.toThrow("different content");
  });
  test(`${kind} untrusted origin cannot promote text and cannot read another thread`, async () => {
    const f = setup(), a = await attached(kind, f, { ...f.base, origin: { threadId: "share" } });
    await expect(a.call("inbox_add", { text: "Odysseus", idempotencyKey: "injection" })).rejects.toThrow("trusted origin");
    await expect(a.call("inbox_get", { itemId: "work-cli" })).rejects.toThrow("outside this turn's scope");
    await expect(a.call("inbox_list", { view: "queue", threadId: "cli" })).rejects.toThrow("outside this turn's scope");
    expect((await a.call("inbox_list", { view: "queue" })).items.map((item: any) => item.id)).toEqual(["work-share"]);
    expect(f.store.snapshot().threads).toHaveLength(2);
  });
  test(`${kind} resolution binds exact session Action option version and effect, then replays once`, async () => {
    const f = setup(), a = await attached(kind, f, { ...f.base, approvedAction: f.binding });
    const request = { sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 };
    for (const wrong of [{ sessionId: "another" }, { itemId: "work-share" }, { optionId: "dismiss" }, { expectedVersion: 2 }])
      await expect(a.call("resolve_action", { ...request, ...wrong })).rejects.toThrow("session/Action binding");
    const first = await a.call("resolve_action", request), second = await a.call("resolve_action", request);
    expect(first.replay).toBe(false); expect(second).toEqual({ ...first, replay: true });
    expect(f.store.getItem(first.followUpId)).toMatchObject({ type: "execute", payload: { operation } });
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
    f.session("other"); await expect(a.call("resolve_action", request)).rejects.toThrow("session/Action binding");
  });
  test(`${kind} unbound sessions, changed effects and revoked exact authority refuse resolution`, async () => {
    const f = setup(), request = { sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 };
    const unbound = await attached(kind, f, f.base);
    await expect(unbound.call("resolve_action", request)).rejects.toThrow("discuss is unavailable");
    const changed = await attached(kind, f, { ...f.base, approvedAction: { ...f.binding!, effect: { kind: "dismiss" } } });
    await expect(changed.call("resolve_action", request)).rejects.toThrow("exact approved binding");
    const bound = await attached(kind, f, { ...f.base, approvedAction: f.binding });
    f.restrict(); await expect(bound.call("resolve_action", request)).rejects.toThrow("outside the thread envelope");
    expect(f.store.getItem("decision")!.status).toBe("pending");
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  });
  test(`${kind} restricted and voice memberships refuse writes even with a trusted origin`, async () => {
    const f = setup();
    for (const membership of ["restricted", "voice"] as const) {
      const a = await attached(kind, f, { ...f.base, membership, allowedReads: ["inbox_list", "inbox_get"], approvedAction: f.binding });
      expect((await a.call("inbox_list", { view: "queue" })).items.length).toBeGreaterThan(0);
      await expect(a.call("inbox_add", { text: "Odysseus", idempotencyKey: "k" })).rejects.toThrow("membership");
      await expect(a.call("resolve_action", { sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 })).rejects.toThrow("membership");
    }
  });
  test(`${kind} restricted reads require the exact server roster even when an executor is invoked directly`, async () => {
    const f = setup(), a = await attached(kind, f, { ...f.base, membership: "restricted", origin: { threadId: "share" }, allowedReads: ["inbox_list"] });
    expect((await a.call("inbox_list", { view: "queue" })).items.map((item: any) => item.id)).toEqual(["work-share"]);
    await expect(a.call("inbox_get", { itemId: "work-share" })).rejects.toThrow("exact restricted roster");
  });
  test(`${kind} stale turn, revoked principal and closed origin cannot read or mutate`, async () => {
    const f = setup(), a = await attached(kind, f, f.base);
    f.expire();
    await expect(a.call("inbox_get", { itemId: "work-share" })).rejects.toThrow("no longer authorized");
    const g = setup(), b = await attached(kind, g, g.base);
    revokePrincipal(g.db, g.principal.id, Date.now());
    await expect(b.call("inbox_list", { view: "queue" })).rejects.toThrow("no longer authorized");
    await expect(b.call("inbox_add", { text: "Odysseus", idempotencyKey: "k" })).rejects.toThrow("no longer authorized");
    const h = setup(), c = await attached(kind, h, { ...h.base, origin: { threadId: "share" } });
    h.db.query("UPDATE inbox_threads SET status = 'closed' WHERE id = 'share'").run();
    await expect(c.call("inbox_list", { view: "queue" })).rejects.toThrow("origin thread is unavailable");
  });
  test(`${kind} intake rechecks turn authority after asynchronous staging before committing`, async () => {
    const f = setup(); let checks = 0;
    const a = await attached(kind, f, { ...f.base, isCurrent: () => ++checks <= 2 });
    await expect(a.call("inbox_add", { text: "Odysseus stages a note", idempotencyKey: "race" })).rejects.toThrow("no longer authorized");
    expect(f.store.snapshot().threads).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_intake_receipts WHERE state = 'committed'").get()).toEqual({ n: 0 });
  });
  test(`${kind} a scoped resolution cannot act on a different thread`, async () => {
    const f = setup(), a = await attached(kind, f, { ...f.base, origin: { threadId: "share" }, approvedAction: f.binding });
    await expect(a.call("resolve_action", { sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 })).rejects.toThrow("outside this turn's scope");
    expect(f.store.getItem("decision")!.status).toBe("pending");
  });
  test(`${kind} model authority fields and deferred effects cannot pass attached executors`, async () => {
    const f = setup(), a = await attached(kind, f, { ...f.base, approvedAction: f.binding });
    await expect(a.call("inbox_add", { text: "Odysseus", idempotencyKey: "k", origin: "trusted" })).rejects.toThrow();
    const request = { sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 };
    await expect(a.call("resolve_action", { ...request, effect: { kind: "dismiss" } })).rejects.toThrow();
    f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = 'decision'").run(JSON.stringify({ ...f.action, options: [{ id: "approve", label: "Discuss", effect: { kind: "open_session", seed: { prompt: "Discuss" } } }] }));
    await expect(a.call("resolve_action", request)).rejects.toThrow("Invalid or unavailable");
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  });
}

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} attached completion executor verifies a real bound application and replays its durable terminal receipt`, async () => {
    const f = setup();
    const intake = await f.intake.share({ text: "Odysseus studies the harbor", files: [] }, f.principal);
    const shares = createInteractiveShares(f.db, f.root), sid = f.base.sessionId()!;
    shares.start(f.principal.id, f.base.turnId, sid, intake.result.id, f.base.isCurrent);
    try {
      const input = { operation: "write" as const, path: "notes/harbor-share.md", expectedBaseHash: null,
        content: `Odysseus studies the harbor.\n<!-- share-source:${intake.result.id} -->\n` };
      const apply = createBrainApplication({ root: f.root, principalId: f.principal.id, turnId: f.base.turnId,
        signal: new AbortController().signal, isAuthorized: f.base.isCurrent, approve: async () => false, record() {},
        policy: { autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() },
        planner: { planAdd: async () => { throw Error("No capture here"); }, index: async () => {} } });
      const application = await shares.apply(f.principal.id, f.base.turnId, sid, f.base.isCurrent, input,
        () => apply({ principalId: f.principal.id, turnId: f.base.turnId, input }));
      expect(application.ok).toBe(true);
      const a = await attached(kind, f, f.base, { completeShare: raw => shares.complete(f.principal.id, f.base.turnId, sid, f.base.isCurrent, raw, async () => false, createKeyedLock()) });
      const request = { receiptIds: [application.shareReceiptId], files: [] };
      await expect(a.call("complete_share", { ...request, itemId: "work-share" })).rejects.toThrow();
      const first = await a.call("complete_share", request), repeated = await a.call("complete_share", request);
      expect(first).toEqual({ itemId: intake.itemId, status: "done", replay: false });
      expect(repeated).toEqual({ ...first, replay: true });
      expect(f.store.getItem(intake.itemId)!.status).toBe("done");
      f.expire(); await expect(a.call("complete_share", request)).rejects.toThrow("no longer authorized");
    } finally { shares.end(f.base.turnId); }
  });
}
