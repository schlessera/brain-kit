import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { createKeyedLock, type BrainApplicationInput, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ShareIntakeResult } from "@schlessera/brain-ui-sdk/protocol";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";
import { createInteractiveShares } from "../src/inbox/interactive-share.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createTestApp } from "./helpers/test-app.js";

const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const SECRET = "odysseus-share-fixture-cookie-0123456789";
const pdf = "%PDF-1.4\nOdysseus returns to Ithaca.\n%%EOF\n";
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const scripts: ((req: StartTurnRequest) => Promise<void>)[] = [];
  let count = 0;
  const backend = makeFakeBackend({ id: "pi", startTurn: async req => {
    const sid = req.sessionId ?? `odysseus-share-${++count}`;
    req.bridge.emit({ type: "session_info", sessionId: sid, isNew: !req.sessionId });
    await scripts.shift()!(req);
    req.bridge.emit({ type: "result", sessionId: sid, isError: false, durationMs: 1, numTurns: 1 });
  } });
  backend.brainApplicationPolicy = () => ({ available: ["write"], autoAllowed: ["write"], lock: createKeyedLock() });
  const f = await createTestApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: Bun.password.hashSync("odysseus-fixture"), COOKIE_SECRET: SECRET },
    appOptions: { registry: createStaticBackendRegistry([backend], "pi") } });
  closes.push(() => f.teardown());
  f.app.wsHost.applicationPlanner!.index = async () => {};
  const principal = createPrincipal(f.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch, websocket: f.app.websocket });
  closes.push(() => server.stop(true));
  const AuthenticatedWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const ws = new AuthenticatedWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } });
  closes.push(() => ws.close());
  const ready = deferred();
  const frames: any[] = [];
  ws.addEventListener("message", e => { const frame = JSON.parse(String(e.data)); frames.push(frame); if (frame.type === "server_hello") ready.resolve(); });
  await ready.promise;
  const store = createInboxStore(f.app.db);
  async function upload(files = true, text = "Odysseus returns") {
    const body = new FormData(); body.set("text", text);
    if (files) body.append("files", new File([pdf], "ithaca.pdf", { type: "application/pdf" }));
    const response = await fetch(`http://127.0.0.1:${server.port}/api/share`, { method: "POST", body, headers: { cookie } });
    expect(response.status).toBe(201);
    return await response.json() as ShareIntakeResult;
  }
  async function send(share: ShareIntakeResult, script: (req: StartTurnRequest) => Promise<void>, sessionId?: string) {
    const finished = deferred<unknown>();
    scripts.push(async req => { try { await script(req); finished.resolve(undefined); } catch (error) { finished.resolve(error); throw error; } });
    ws.send(JSON.stringify({ type: "chat_message", text: "File the Odysseus share", shareId: share.id, ...(sessionId ? { sessionId } : {}) }));
    const error = await finished.promise;
    await Promise.all([...f.app.wsHost.turnTasks]);
    if (error) throw error;
    return frames.findLast(frame => frame.type === "session_info")?.sessionId as string;
  }
  const item = (share: ShareIntakeResult) => {
    const row = f.app.db.query("SELECT item_id FROM inbox_intake_receipts WHERE staging_id = ?").get(share.id) as { item_id: string };
    return store.getItem(row.item_id)!;
  };
  return { ...f, principal, ws, store, scripts, frames, upload, send, item };
}
function application(share: ShareIntakeResult, path = "notes/ithaca-share.md"): BrainApplicationInput {
  return { operation: "write", path, expectedBaseHash: null,
    content: `# Odysseus returns\n[Original](assets/ithaca.pdf)\n<!-- share-source:${share.id} -->\n` };
}

test("real app/WS completion verifies filing and retained PDF, then a lost reply replays without content or Queue duplication", async () => {
  const f = await fixture(), share = await f.upload();
  mkdirSync(join(f.brainPath, "assets"), { recursive: true }); writeFileSync(join(f.brainPath, "assets/ithaca.pdf"), pdf);
  let request: any, receipt: any;
  const sid = await f.send(share, async req => {
    const result = await req.bridge.applyBrain!(application(share));
    expect(result.ok).toBe(true); expect(result.shareReceiptId).toBeDefined();
    request = { receiptIds: [result.shareReceiptId], files: [{ sourcePath: share.files[0]!.path, disposition: "retained", path: "assets/ithaca.pdf" }] };
    receipt = await req.bridge.completeShare!(request);
    expect(receipt).toEqual({ itemId: f.item(share).id, status: "done", replay: false });
    expect(f.item(share).status, "INTERACTIVE_FILING_COMPLETES_DURABLE_ITEM").toBe("done");
    // Completion precedes unwind; live work still protects originals.
    const cleanup = createInboxCleanup(f.app.db, f.brainPath);
    try { expect(await cleanup.sweep(), "LIVE_INTERACTIVE_ORIGINAL_IS_PROTECTED").toBe(0); } finally { await cleanup.close(); }
    expect(existsSync(join(f.brainPath, share.files[0]!.path))).toBe(true);
  });
  const before = readFileSync(join(f.brainPath, "notes/ithaca-share.md"), "utf8");
  const repeated = await f.upload(); expect(repeated.id).toBe(share.id);
  expect(repeated.filingSessionId, "LOST_ADMISSION_RECOVERS_BOUND_SESSION_WITHOUT_DISPATCH").toBe(sid);
  await f.send(repeated, async req => {
    await expect(req.bridge.completeShare!(request), "COMPLETION_REPLAY_IS_IDEMPOTENT").resolves.toEqual({ ...receipt, replay: true });
    expect((await req.bridge.applyBrain!(application(share))).shareReceiptId).toBe(request.receiptIds[0]);
  }, sid);
  expect(f.frames.findLast(frame => frame.type === "session_info").sessionId, "REUPLOADED_SHARE_RESUMES_ORIGINAL_SESSION").toBe(sid);
  expect(readFileSync(join(f.brainPath, "notes/ithaca-share.md"), "utf8")).toBe(before);
  expect(f.store.snapshot().items.filter(item => item.type === "triage")).toHaveLength(1);
  const cleanup = createInboxCleanup(f.app.db, f.brainPath);
  try { await cleanup.sweep(); } finally { await cleanup.close(); }
  expect(existsSync(join(f.brainPath, share.dir))).toBe(false);
  expect(readFileSync(join(f.brainPath, "assets/ithaca.pdf"), "utf8")).toBe(pdf);
});

test("partial filing and duplicate application delivery recover the same item/session without writing twice", async () => {
  const f = await fixture(), share = await f.upload(false);
  let result: any;
  const sid = await f.send(share, async req => {
    result = await req.bridge.applyBrain!(application(share));
    expect(result.ok).toBe(true);
    expect(await req.bridge.applyBrain!(application(share)), "FILING_REPLAY_HAS_ORIGINAL_RECEIPT").toEqual(result);
    expect(await req.bridge.applyBrain!({ ...application(share), expectedBaseHash: result.changes[0].contentHash } as BrainApplicationInput), "FRESH_BASE_CANNOT_DUPLICATE_FILING").toEqual(result);
    await expect(req.bridge.completeShare!({ receiptIds: ["forged"], files: [] })).rejects.toThrow("forged");
  });
  expect(f.item(share).status).toBe("ready");
  expect((await f.upload(false)).filingSessionId, "PARTIAL_FILING_RECOVERS_THE_SAME_SESSION").toBe(sid);
  expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
  // Reconstruct the concrete service after unwind; authority comes from the
  // persisted binding/receipts, rather than the previous instance's memory.
  f.app.wsHost.inboxTools!.shares = createInteractiveShares(f.app.db, f.brainPath);
  await f.send(share, async req => {
    expect(await req.bridge.applyBrain!(application(share))).toEqual(result);
    expect(await req.bridge.completeShare!({ receiptIds: [result.shareReceiptId], files: [] })).toMatchObject({ status: "done", replay: false });
  }, sid);
  expect(f.item(share)).toMatchObject({ status: "done", attempts: 2 });
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM inbox_share_applications").get()).toEqual({ n: 1 });
});

test("unrelated writes, another item's receipt, changed binaries and stale authority refuse without losing originals", async () => {
  const f = await fixture(), first = await f.upload(false), share = await f.upload(true, "Athena safeguards the PDF");
  let foreign: any;
  await f.send(first, async req => { foreign = await req.bridge.applyBrain!(application(first, "notes/athena.md")); });
  mkdirSync(join(f.brainPath, "assets"), { recursive: true }); writeFileSync(join(f.brainPath, "assets/ithaca.pdf"), "wrong bytes");
  await f.send(share, async req => {
    const unrelated = await req.bridge.applyBrain!({ operation: "write", path: "notes/unrelated.md", expectedBaseHash: null, content: "Telemachus sails.\n" });
    const input = { receiptIds: [unrelated.shareReceiptId!], files: [] };
    await expect(req.bridge.completeShare!(input)).rejects.toThrow("source identity");
    await expect(req.bridge.completeShare!({ ...input, receiptIds: [foreign.shareReceiptId] })).rejects.toThrow("unrelated");
    const result = await req.bridge.applyBrain!(application(share));
    const complete = { receiptIds: [result.shareReceiptId!], files: [{ sourcePath: share.files[0]!.path, disposition: "retained" as const, path: "assets/ithaca.pdf" }] };
    await expect(req.bridge.completeShare!(complete)).rejects.toThrow("differs");
    // Equal-sized original tampering cannot replace intake evidence.
    writeFileSync(join(f.brainPath, share.files[0]!.path), pdf.replace("Odysseus", "Achilles"));
    writeFileSync(join(f.brainPath, "assets/ithaca.pdf"), pdf.replace("Odysseus", "Achilles"));
    await expect(req.bridge.completeShare!(complete)).rejects.toThrow("verified intake evidence");
    writeFileSync(join(f.brainPath, share.files[0]!.path), pdf);
    unlinkSync(join(f.brainPath, "assets/ithaca.pdf"));
    symlinkSync(join(f.brainPath, share.files[0]!.path), join(f.brainPath, "assets/ithaca.pdf"));
    await expect(req.bridge.completeShare!(complete), "ALIASED_RETENTION_IS_NOT_EVIDENCE").rejects.toThrow();
    unlinkSync(join(f.brainPath, "assets/ithaca.pdf"));
    linkSync(join(f.brainPath, share.files[0]!.path), join(f.brainPath, "assets/ithaca.pdf"));
    await expect(req.bridge.completeShare!(complete), "HARDLINKED_RETENTION_IS_NOT_EVIDENCE").rejects.toThrow("Unsupported binary evidence");
    unlinkSync(join(f.brainPath, "assets/ithaca.pdf")); writeFileSync(join(f.brainPath, "assets/ithaca.pdf"), pdf);
    revokePrincipal(f.app.db, f.principal.id, Date.now());
    await expect(req.bridge.completeShare!(complete)).rejects.toThrow("principal authority");
  });
  expect(f.item(share).status).toBe("ready"); expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
});

test("a controlled dispatcher cannot acquire interactive ownership or replay partial filing", async () => {
  const f = await fixture(), share = await f.upload(false);
  let dispatched = 0;
  const runtime = createInboxRuntime(f.app.db, { log: { emit() {} } as never, brainRoot: f.brainPath,
    timers: { setInterval: () => 0 as never, clearInterval() {} }, dispatch: async () => { dispatched++; },
    budget: { config: { spendUsd: 1, turns: 10, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.00001 },
      pricing: { resolve: () => null } },
    operation: () => ({ principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "execute", runId: crypto.randomUUID(), maximumTokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) });
  closes.push(() => runtime.close());
  await f.send(share, async req => {
    expect(f.item(share).status).toBe("claimed");
    expect((await runtime.tick()).claimed).toBe(0);
    expect((await req.bridge.applyBrain!(application(share))).ok).toBe(true);
  });
  expect(f.item(share).status).toBe("ready");
  expect((await runtime.tick()).claimed).toBe(0); expect(dispatched, "DISPATCHER_NEVER_REFILES_BOUND_CONTENT").toBe(0);
});

test("another authenticated principal cannot claim an intake by quoting its staging identity", async () => {
  const f = await fixture(), share = await f.upload(false);
  const other = createPrincipal(f.app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
  expect(() => f.app.wsHost.inboxTools!.shares!.start(other.id, "foreign-turn", undefined, share.id, () => true), "INTAKE_PRINCIPAL_OWNS_BINDING").toThrow("authenticated share intake");
  expect(f.item(share)).toMatchObject({ status: "ready", attempts: 0 });
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM inbox_interactive_shares").get()).toEqual({ n: 0 });
});

test("a dispatcher that wins the Queue claim cannot be displaced by interactive intake binding", async () => {
  const f = await fixture(), share = await f.upload(false), original = f.item(share);
  f.store.commit([{ kind: "transition", itemId: original.id, expectedVersion: original.version, to: "claimed", runId: "dispatcher-first", leaseUntil: Date.now() + 60_000 }]);
  expect(() => f.app.wsHost.inboxTools!.shares!.start(f.principal.id, "interactive-contender", undefined, share.id, () => true), "EXISTING_QUEUE_OWNER_IS_NOT_DISPLACED").toThrow("live owner");
  expect(f.item(share)).toMatchObject({ status: "claimed", runId: "dispatcher-first", attempts: 1 });
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM inbox_interactive_shares").get()).toEqual({ n: 0 });
  expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
});

test("client cancellation preserves partial effects and originals and never commits successful completion", async () => {
  const f = await fixture(), share = await f.upload(false);
  await f.send(share, async req => {
    const result = await req.bridge.applyBrain!(application(share));
    const cancelled = deferred();
    req.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    f.ws.send(JSON.stringify({ type: "cancel", sessionId: "odysseus-share-1" }));
    await cancelled.promise;
    await expect(req.bridge.completeShare!({ receiptIds: [result.shareReceiptId!], files: [] })).rejects.toThrow("principal authority");
  });
  expect(f.item(share).status, "CANCEL_IS_NEVER_SUCCESSFUL_FILING").toBe("ready");
  expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
  expect(readFileSync(join(f.brainPath, "notes/ithaca-share.md"), "utf8")).toContain(`share-source:${share.id}`);
  expect(f.app.db.query("SELECT completion_json FROM inbox_interactive_shares").get()).toEqual({ completion_json: null });
});

test("uncertain application receipt refuses replay instead of duplicating a committed filing", async () => {
  const f = await fixture(), share = await f.upload(false);
  let result: any;
  const sid = await f.send(share, async req => { result = await req.bridge.applyBrain!(application(share)); });
  // Simulate a stop after filesystem application but before the reply is
  // journaled. The pending operation remains authoritative replay restriction.
  f.app.db.query("UPDATE inbox_share_applications SET result_json = NULL WHERE id = ?").run(result.shareReceiptId);
  await f.send(share, async req => {
    await expect(req.bridge.applyBrain!(application(share))).rejects.toThrow("outcome is uncertain");
    await expect(req.bridge.completeShare!({ receiptIds: [result.shareReceiptId], files: [] })).rejects.toThrow("Unsupported");
  }, sid);
  expect(f.item(share).status).toBe("ready"); expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
  expect(readFileSync(join(f.brainPath, "notes/ithaca-share.md"), "utf8")).toBe((application(share) as { content: string }).content);
});

test("a proven no-effect failure retries only in a fresh bounded claim with a corrected authoritative base", async () => {
  const f = await fixture(), share = await f.upload(false);
  mkdirSync(join(f.brainPath, "notes"), { recursive: true });
  writeFileSync(join(f.brainPath, "notes/ithaca-share.md"), "Odysseus checks the earlier harbor note.\n");
  const sid = await f.send(share, async req => {
    const refused = await req.bridge.applyBrain!(application(share));
    expect(refused).toMatchObject({ ok: false, code: "stale_base", changes: [] });
    const base = await req.bridge.readBrainBase!("notes/ithaca-share.md");
    const corrected = { ...application(share), expectedBaseHash: base.expectedBaseHash } as BrainApplicationInput;
    expect(await req.bridge.applyBrain!(corrected), "SAME_CLAIM_CANNOT_RETRY_REFUSED_EFFECT").toEqual(refused);
  });
  expect(f.item(share)).toMatchObject({ status: "ready", attempts: 1 });
  expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
  await f.send(share, async req => {
    const base = await req.bridge.readBrainBase!("notes/ithaca-share.md");
    const result = await req.bridge.applyBrain!({ ...application(share), expectedBaseHash: base.expectedBaseHash } as BrainApplicationInput);
    expect(result.ok, "FRESH_CLAIM_RECOVERS_KNOWN_NO_EFFECT_FAILURE").toBe(true);
    expect(await req.bridge.completeShare!({ receiptIds: [result.shareReceiptId!], files: [] })).toMatchObject({ status: "done" });
  }, sid);
  expect(f.item(share)).toMatchObject({ status: "done", attempts: 2 });
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM inbox_share_applications").get()).toEqual({ n: 1 });
});

test("completed filing preserves success and uncertainty replay guards while allowing later ordinary no-effect retries", async () => {
  const f = await fixture(), share = await f.upload(false);
  mkdirSync(join(f.brainPath, "notes"), { recursive: true });
  writeFileSync(join(f.brainPath, "notes/ithaca-share.md"), "Odysseus checks an earlier note.\n");
  let filed: any;
  const sid = await f.send(share, async req => {
    expect((await req.bridge.applyBrain!(application(share))).code).toBe("stale_base");
    filed = await req.bridge.applyBrain!(application(share, "notes/filed-ithaca.md"));
    expect(await req.bridge.completeShare!({ receiptIds: [filed.shareReceiptId], files: [] })).toMatchObject({ status: "done" });
  });
  await f.send(share, async req => {
    const base = await req.bridge.readBrainBase!("notes/ithaca-share.md");
    const result = await req.bridge.applyBrain!({ ...application(share), expectedBaseHash: base.expectedBaseHash } as BrainApplicationInput);
    expect(result.ok, "COMPLETED_CHAT_ALLOWS_FRESH_ORDINARY_NO_EFFECT_RETRY").toBe(true);
    expect(result.shareReceiptId).toBeUndefined();
    expect(await req.bridge.applyBrain!(application(share, "notes/filed-ithaca.md"))).toEqual(filed);
  }, sid);
  // Even after completion an interrupted reply remains a replay restriction.
  f.app.db.query("UPDATE inbox_share_applications SET result_json = NULL WHERE id = ?").run(filed.shareReceiptId);
  await f.send(share, async req => {
    await expect(req.bridge.applyBrain!(application(share, "notes/filed-ithaca.md")), "COMPLETION_NEVER_REOPENS_UNCERTAIN_WRITES").rejects.toThrow("outcome is uncertain");
  }, sid);
  expect(f.item(share).status).toBe("done");
});

test("the existing exact approval surface owns binary discard and completion commits only after approval", async () => {
  const f = await fixture(), share = await f.upload();
  const approval = deferred<any>();
  const listener = (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "tool_approval_request") approval.resolve(frame);
  };
  f.ws.addEventListener("message", listener);
  try {
    await f.send(share, async req => {
      const result = await req.bridge.applyBrain!({ operation: "write", path: "notes/ithaca-share.md", expectedBaseHash: null, content: `# Odysseus returns\n<!-- share-source:${share.id} -->\n` });
      const input = { receiptIds: [result.shareReceiptId!], files: [{ sourcePath: share.files[0]!.path, disposition: "discarded" as const, reason: "Keep the extracted note only" }] };
      const completion = req.bridge.completeShare!(input);
      const frame = await approval.promise;
      expect(frame.toolName).toBe("complete_share");
      expect(f.item(share).status).toBe("claimed");
      expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
      f.ws.send(JSON.stringify({ type: "tool_approval", toolUseId: frame.toolUseId, turnId: frame.turnId }));
      expect(await completion).toMatchObject({ status: "done", replay: false });
    });
  } finally { f.ws.removeEventListener("message", listener); }
  expect(f.item(share).status).toBe("done");
});


test("a lost admission reply recovers the persisted session without dispatching a second backend turn", async () => {
  const f = await fixture(), share = await f.upload(false);
  const sid = await f.send(share, async () => {});
  const repeated = await f.upload(false);
  expect(repeated.filingSessionId).toBe(sid);
  const receipt = deferred<any>();
  const requestId = crypto.randomUUID();
  const listener = (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data));
    if (frame.requestId === requestId) receipt.resolve(frame);
  };
  f.ws.addEventListener("message", listener);
  let dispatched = false;
  f.scripts.push(async () => { dispatched = true; });
  try {
    // The client may still have the pre-binding intake response: the host
    // checks the binding again instead of trusting that stale response.
    f.ws.send(JSON.stringify({ type: "chat_message", shareId: share.id, text: "File the Odysseus share", requestId }));
    expect(await receipt.promise).toMatchObject({ type: "session_info", sessionId: sid, isNew: false, requestId });
    await Promise.all([...f.app.wsHost.turnTasks]);
    expect(dispatched, "LOST_ADMISSION_NEVER_DISPATCHES_TWICE").toBe(false);
    expect(f.item(share)).toMatchObject({ status: "ready", attempts: 1 });
    expect(existsSync(join(f.brainPath, share.dir))).toBe(true);
  } finally { f.ws.removeEventListener("message", listener); }
});


test("an identical authenticated upload cannot expose another principal's filing session", async () => {
  const f = await fixture(), share = await f.upload(false);
  await f.send(share, async () => {});
  const other = createPrincipal(f.app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", other.id, SECRET)).split(";")[0]!;
  const body = new FormData(); body.set("text", "Odysseus returns");
  const response = await f.app.fetch(new Request("http://localhost/api/share", { method: "POST", body, headers: { cookie } }));
  expect(response.status).toBe(201);
  const result = await response.json() as ShareIntakeResult;
  expect(result.id).toBe(share.id);
  expect(result.filingSessionId, "RECOVERY_SESSION_IS_PRINCIPAL_SCOPED").toBeUndefined();
});


test("a repeated intake during a live filing only acknowledges its bound session", async () => {
  const f = await fixture(), share = await f.upload(false);
  await f.send(share, async () => {
    const receipt = deferred<any>();
    const requestId = crypto.randomUUID();
    const listener = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.requestId === requestId) receipt.resolve(frame);
    };
    f.ws.addEventListener("message", listener);
    try {
      const repeated = await f.upload(false);
      expect(repeated.filingSessionId).toBe("odysseus-share-1");
      f.ws.send(JSON.stringify({ type: "chat_message", shareId: share.id, text: "File the Odysseus share", requestId }));
      expect(await receipt.promise).toMatchObject({ type: "session_info", sessionId: "odysseus-share-1", isNew: false, requestId });
      expect(f.item(share)).toMatchObject({ status: "claimed", attempts: 1 });
    } finally { f.ws.removeEventListener("message", listener); }
  });
});
