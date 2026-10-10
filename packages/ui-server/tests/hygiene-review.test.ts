import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createBrainClient } from "../src/brain/client.js";
import { createHygieneReview } from "../src/inbox/hygiene-review.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxStream } from "../src/inbox/stream.js";
import { inboxSnoozeUntil } from "../src/inbox/resolve.js";
import { createInboxAction, inboxIdentity, INBOX_ACTION_CAP, sweepInboxLifecycle } from "../src/inbox/actions.js";
import { exportInboxSnapshot, restoreInboxSnapshot } from "../src/inbox/snapshot.js";
import { createHygieneReviewRoutes } from "../src/routes/hygiene-review.js";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env.js";
import type { InboxActionItem, InboxDelta, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
function setup(body = "Odysseus sees [[Eumaeus hut]].", missingTitle = false) {
  const root = mkdtempSync(join(tmpdir(), "brain-hygiene-review-"));
  clean.push(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "journeys"));
  symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "scripts/brain-cli.ts"), `import ${JSON.stringify(resolve(import.meta.dir, "fixtures/hygiene-cli.ts"))};\n`);
  // Minimal supported config, no providers or module inference.
  writeFileSync(join(root, "brain.config.ts"), 'export default { taxonomy: { types: { note: { dir: "journeys", orphanExempt: true, staleDays: 10000 } } } };\n');
  writeFileSync(join(root, "journeys/return-to-ithaca.md"), `---\n${missingTitle ? "" : "title: Return to Ithaca\n"}type: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\n${body}\n`);
  utimesSync(join(root, "journeys/return-to-ithaca.md"), new Date("2026-07-12T12:00:00Z"), new Date("2026-07-12T12:00:00Z"));
  if (body === "Odysseus sees [[Eumaeus hut]].") {
    const second = join(root, "journeys/circe-palace.md");
    writeFileSync(second, '---\ntitle: Circe palace\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\nOdysseus sees [[Aeolus island]].\n');
    utimesSync(second, new Date("2026-07-12"), new Date("2026-07-12"));
  }
  const db = createUiDb(join(root, "ui.sqlite")); clean.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  const brain = createBrainClient({ brainPath: root, exec: {} });
  const review = createHygieneReview(db, { brain });
  const store = createInboxStore(db);
  const argv = () => existsSync(join(root, "argv.jsonl")) ? readFileSync(join(root, "argv.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s) as string[]) : [];
  const applies = () => argv().filter(a => a.includes("resolve") && !a.includes("--dry-run"));
  return { root, db, principal, brain, review, store, argv, applies };
}
const request = (item: InboxActionItem, optionId = "link-text") => ({ type: "inbox_resolve" as const, itemId: item.id, optionId });
function pending(f: ReturnType<typeof setup>) { return f.store.snapshot().items.filter(i => i.queue === "actions" && i.hygiene && i.status === "pending"); }
function logBytes(root: string) {
  const dir = join(root, "context/hygiene");
  return readdirSync(dir).sort().map(p => [p, readFileSync(join(dir, p), "utf8")]);
}

function fillActions(f: ReturnType<typeof setup>, at: number, count = INBOX_ACTION_CAP) {
  for (let i = 0; i < count; i++) {
    const id = `ordinary-${i}-${at}`, threadId = `ordinary-thread-${i}-${at}`;
    f.store.openReviewThread(threadId);
    createInboxAction(f.db, { id, dedupKey: id, threadId, queue: "actions", type: "choose", status: "pending", version: 1,
      createdAt: at + i, updatedAt: at + i, expiresAt: Number.MAX_SAFE_INTEGER, payload: { title: "Review the voyage", detail: "Choose the next harbor." },
      options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] }, [], { now: at + i });
  }
}

for (const status of ["pending", "snoozed"] as const) test(`Actions production cap retires ${status} review atomically; reload, backup and explicit concurrent Resume preserve one fresh finding`, async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  if (status === "snoozed") f.store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "snoozed", waitUntil: Date.now() + 86400000 }]);
  await expect(exportInboxSnapshot(f.db, f.root)).resolves.toMatchObject({ format: "brain-ui-operational-backup" });
  const before = logBytes(f.root), at = Date.now() + 1000;
  fillActions(f, at, INBOX_ACTION_CAP - 1);
  expect(f.store.getItem(item.id)?.status).toBe(status);
  fillActions(f, at + 1000, 1);
  expect(f.store.getItem(item.id)?.status).toBe("dropped");
  // This must fail before any schema/backup assertion if reconciliation is removed.
  expect(f.review.read().review.pendingActionId).toBeUndefined();
  const retired = f.review.read();
  expect(retired.action).toBeNull();
  expect(retired.review).toMatchObject({ status: "paused", fixed: 0, dismissed: 0, snoozed: 0,
    pauseReason: { kind: "actions-limit", retiredActionId: item.id, retirementReceiptId: inboxIdentity("retired", item.id) } });
  expect(f.store.getItem(inboxIdentity("retired", item.id))?.type).toBe("fyi");
  const suppressions = f.db.query("SELECT * FROM inbox_suppressions").all();
  expect(suppressions).toHaveLength(1);
  expect(logBytes(f.root)).toEqual(before);
  const foreign = createUiDb(join(f.root, "ui.sqlite")); clean.push(() => foreign.close());
  const restarted = createHygieneReview(foreign, { brain: f.brain });
  expect(restarted.read()).toEqual(retired);
  const calls = f.argv().length;
  await restarted.recover(); sweepInboxLifecycle(f.db);
  expect(f.argv()).toHaveLength(calls); expect(pending(f)).toHaveLength(0);
  const backup = await exportInboxSnapshot(f.db, f.root);
  f.db.query("UPDATE hygiene_review SET data_json = ? WHERE singleton = 1").run(JSON.stringify({ ...retired.review,
    pauseReason: { ...retired.review.pauseReason, retirementReceiptId: "missing-receipt" } }));
  await expect(exportInboxSnapshot(f.db, f.root)).rejects.toThrow("inbox_snapshot_hygiene_relations");
  f.db.query("UPDATE hygiene_review SET data_json = ? WHERE singleton = 1").run(JSON.stringify(retired.review));
  const restoredPath = join(f.root, "restored.sqlite");
  await restoreInboxSnapshot(backup, restoredPath, f.root);
  const restoredDb = createUiDb(restoredPath); clean.push(() => restoredDb.close());
  expect(createHygieneReview(restoredDb, { brain: f.brain }).read()).toEqual(retired);
  // Use a later admission clock so the fresh review card wins the age tie.
  const resume = createHygieneReview(f.db, { brain: f.brain, now: () => at + 3000 });
  const responses = Promise.all([resume.command(f.principal.id, "resume"), resume.command(f.principal.id, "resume")]);
  await expect(responses).resolves.toBeArray();
  const [one, two] = await responses;
  expect(one.action?.id).not.toBe(item.id); expect(one.action?.status).toBe("pending");
  expect(two.action?.id).toBe(one.action!.id); expect(pending(f)).toHaveLength(1);
  expect(one.action?.hygiene?.findingId).toBe(item.hygiene!.findingId);
  expect(one.action?.hygiene?.fingerprint).toBe(item.hygiene!.fingerprint);
  expect(one.review.pauseReason).toBeUndefined();
  expect(f.db.query("SELECT * FROM inbox_suppressions WHERE class_key = ?").all((suppressions[0] as { class_key: string }).class_key)).toEqual(suppressions);
  expect(f.store.orderedItems().filter(({ item }) => item.queue === "actions" && item.type !== "fyi" && ["pending", "snoozed"].includes(item.status))).toHaveLength(INBOX_ACTION_CAP);
  expect(logBytes(f.root)).toEqual(before);
  expect((await resume.command(f.principal.id, "start")).action?.id).toBe(one.action!.id);
  expect(f.applies()).toHaveLength(0);
});

test("an immediately retired admission pauses again with a fresh receipt and never auto-retries", async () => {
  const f = setup(), at = Date.now() + 60000;
  fillActions(f, at);
  const started = await f.review.command(f.principal.id, "start");
  expect(started.review.pendingActionId).toBeUndefined(); expect(started.action).toBeNull();
  expect(started.review.status).toBe("paused");
  const original = started.review.pauseReason!.retiredActionId;
  const resumed = await f.review.command(f.principal.id, "resume");
  expect(resumed.review.pendingActionId).toBeUndefined(); expect(resumed.action).toBeNull();
  expect(resumed.review.status).toBe("paused");
  const fresh = resumed.review.pauseReason!.retiredActionId;
  expect(fresh).not.toBe(original);
  expect(f.store.getItem(fresh)?.status).toBe("dropped");
  expect(resumed.review.pauseReason!.retirementReceiptId).toBe(inboxIdentity("retired", fresh));
  expect(pending(f)).toHaveLength(0);
  const calls = f.argv().length;
  await f.review.recover(); sweepInboxLifecycle(f.db);
  expect(f.argv()).toHaveLength(calls); expect(f.review.read()).toEqual(resumed);
  await exportInboxSnapshot(f.db, f.root);
  const next = await f.review.command(f.principal.id, "start");
  expect(next.review.pauseReason!.retiredActionId).not.toBe(fresh);
  expect(pending(f)).toHaveLength(0); expect(f.applies()).toHaveLength(0);
});

test("Resume re-admits the retired canonical finding even when next would select another eligible finding", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  const at = Date.now() + 1000; fillActions(f, at);
  // A new validation error outranks the retired warning, but explicit Resume
  // must finish the human's interrupted finding first.
  writeFileSync(join(f.root, "journeys/telemachus.md"), '---\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\nTelemachus returns.\n');
  const selected = await f.brain.hygiene!(["next"]) as { finding: { id: string } };
  expect(selected.finding.id).not.toBe(item.hygiene!.findingId);
  const path = join(f.root, item.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8") + "\nThe crew waits.\n");
  const resumed = await createHygieneReview(f.db, { brain: f.brain, now: () => at + 3000 }).command(f.principal.id, "resume");
  expect(resumed.action?.hygiene?.findingId).toBe(item.hygiene!.findingId);
  expect(resumed.action?.hygiene?.fingerprint).toBe(item.hygiene!.fingerprint);
  expect(resumed.action?.options.find(o => o.id === "link-text")?.preview?.before).toContain("The crew waits.");
  expect(pending(f)).toHaveLength(1);
});

test("failed or unauthorized Resume preserves the retirement; configuration recovery requires another explicit Resume", async () => {
  const f = setup(); await f.review.command(f.principal.id, "start");
  const at = Date.now() + 1000; fillActions(f, at);
  const retired = f.review.read();
  const agent = createPrincipal(f.db, { authMethod: "delegated", label: "Odysseus helper", createdBy: f.principal.id, ttlSeconds: 3600 });
  await expect(f.review.command(agent.id, "resume")).rejects.toThrow("Human review authority");
  const failing = createHygieneReview(f.db, { brain: { ...f.brain, hygiene: async () => { throw new Error("CLI unavailable"); } } });
  await expect(failing.command(f.principal.id, "resume")).rejects.toThrow("CLI unavailable");
  expect(f.review.read()).toEqual(retired); expect(pending(f)).toHaveLength(0);
  const config = join(f.root, "brain.config.ts"), before = readFileSync(config, "utf8");
  writeFileSync(config, 'throw new Error("unknown schemaa");\n');
  const blocked = await f.review.command(f.principal.id, "resume");
  expect(blocked.review.status).toBe("blocked");
  expect(blocked.review.pauseReason).toEqual(retired.review.pauseReason);
  expect(blocked.review.blocker?.kind).toBe("configuration"); expect(blocked.action).toBeNull();
  writeFileSync(config, before);
  const calls = f.argv().length; await f.review.recover();
  expect(f.argv()).toHaveLength(calls);
  const resumed = await createHygieneReview(f.db, { brain: f.brain, now: () => at + 3000 }).command(f.principal.id, "resume");
  expect(resumed.action?.status).toBe("pending"); expect(resumed.review.pauseReason).toBeUndefined();
});

test("Pause during retired-card Resume cancels its pending admission", async () => {
  const f = setup(); await f.review.command(f.principal.id, "start");
  const at = Date.now() + 1000; fillActions(f, at);
  const retired = f.review.read();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { reached = r; });
  const review = createHygieneReview(f.db, { now: () => at + 3000, brain: { ...f.brain, hygiene: async args => {
    if (args[0] === "next") { reached(); await gate; }
    return f.brain.hygiene!(args);
  } } });
  const resumed = review.command(f.principal.id, "resume");
  await entered;
  try { await review.command(f.principal.id, "pause"); } finally { release(); }
  await resumed;
  expect(pending(f)).toHaveLength(0);
  expect(review.read()).toEqual(retired);
});

test("repeated concurrent start and resume preserve exactly one pending Action; pause writes no disposition", async () => {
  const f = setup();
  const [first, repeated] = await Promise.all([f.review.command(f.principal.id, "start"), f.review.command(f.principal.id, "start")]);
  expect(first.action).not.toBeNull(); expect(repeated.action?.id).toBe(first.action!.id);
  await f.review.command(f.principal.id, "start");
  expect(pending(f)).toHaveLength(1);
  const before = logBytes(f.root);
  const paused = await f.review.command(f.principal.id, "pause");
  expect(paused.review.status).toBe("paused"); expect(paused.action?.status).toBe("pending");
  expect(logBytes(f.root)).toEqual(before);
  const restarted = createHygieneReview(f.db, { brain: f.brain });
  expect(restarted.read().review.status).toBe("paused");
  expect((await restarted.command(f.principal.id, "resume")).action?.id).toBe(first.action!.id);
  expect(f.applies()).toHaveLength(0);
});

test("two connections confirm one real CLI repair, next appears once and replay creates none", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  const frames: ServerMessage[][] = [[], []];
  const stream = createInboxStream(f.store, f.db, undefined, f.review.resolver); clean.push(() => stream.close());
  const auth = { principalId: f.principal.id, expiresAt: f.principal.expiresAt, valid: true, retain: () => () => {}, release() {} };
  const sockets = frames.map(target => ({ raw: {}, send(wire: string) { const p = parseServerMessage(wire); if (!p.ok) throw new Error(p.error); target.push(p.message); }, close() {} }));
  // Direct stream receives the same server-owned principal context as dispatch.
  for (const ws of sockets) stream.handleSubscribe(ws, { type: "inbox_subscribe", view: "actions" }, auth as never);
  await Promise.all(sockets.map(ws => stream.handleDecision!(ws, request(item), auth as never)));
  // Async concrete method is structurally typed as void for existing embedded streams.
  for (let i = 0; i < 500 && f.store.getItem(item.id)?.status !== "resolved"; i++) await Bun.sleep(10);
  stream.pump();
  expect(f.applies()).toHaveLength(1); expect(f.store.getItem(item.id)?.status).toBe("resolved");
  expect(pending(f)).toHaveLength(1);
  for (const delivered of frames) expect(delivered.some(v => v.type === "inbox_delta" && (v as InboxDelta).change.kind === "upsert_item" && ((v as InboxDelta).change as { item: InboxActionItem }).item.id === item.id && ((v as InboxDelta).change as { item: InboxActionItem }).item.status === "resolved")).toBe(true);
  const next = f.review.read().action!.id;
  await f.review.resolver.resolveAsync(f.principal.id, request(item));
  expect(f.review.read().action!.id).toBe(next); expect(pending(f)).toHaveLength(1); expect(f.applies()).toHaveLength(1);
});

for (const status of ["stale", "refused", "check_failed"] as const) test(`${status} remains pending, never advances, and its versioned outcome survives reopen`, async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  writeFileSync(join(f.root, "fault.txt"), status);
  await f.review.resolver.resolveAsync(f.principal.id, request(item));
  expect(f.store.getItem(item.id)?.status).toBe("pending"); expect(pending(f)).toHaveLength(1);
  const foreign = createUiDb(join(f.root, "ui.sqlite")); clean.push(() => foreign.close());
  const read = createHygieneReview(foreign, { brain: f.brain }).read();
  expect(read.action?.id).toBe(item.id); expect(read.action?.hygiene?.outcome).toMatchObject({ version: 1, status });
  expect(read.review.fixed).toBe(0);
});

test("typed field input requires a bound real preview and cannot be substituted at resolve", async () => {
  const f = setup("Odysseus returned.", true), item = (await f.review.command(f.principal.id, "start")).action!;
  expect(item.options.find(o => o.id === "required-field")?.input?.type).toBe("string");
  await expect(f.review.resolver.resolveAsync(f.principal.id, request(item, "required-field"))).rejects.toThrow("valid preview");
  const previewed = await f.review.preview(f.principal.id, { itemId: item.id, optionId: "required-field", expectedVersion: item.version, input: "Return to Ithaca" });
  expect(previewed.options.find(o => o.id === "required-field")?.preview?.after).toContain('title: "Return to Ithaca"');
  await expect(f.review.resolver.resolveAsync(f.principal.id, { ...request(previewed, "required-field"), input: "Circe palace" })).rejects.toThrow("confirmed preview");
  await f.review.resolver.resolveAsync(f.principal.id, { ...request(previewed, "required-field"), input: "Return to Ithaca" });
  expect(f.applies()).toHaveLength(1); expect(f.store.getItem(item.id)?.status).toBe("resolved");
});

test("Later uses exactly the same server-derived due time in the Action and hygiene log", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  const at = Date.now(), deterministic = createHygieneReview(f.db, { brain: f.brain, now: () => at });
  await deterministic.resolver.resolveAsync(f.principal.id, request(item, "later"));
  const stored = f.store.getItem(item.id)!;
  expect(stored.status).toBe("snoozed"); expect(stored.waitUntil).toBe(inboxSnoozeUntil(at, 1, item.version));
  const log = await f.brain.hygiene!(["list"] ) as { entries: Array<{ id: string; dueAt: string }> };
  expect(Date.parse(log.entries.find(e => e.id === item.hygiene!.findingId)!.dueAt)).toBe(stored.waitUntil!);
  expect(readFileSync(join(f.root, "context/hygiene/snoozed.md"), "utf8")).toContain(`- until: ${new Date(stored.waitUntil!).toISOString()}`);
  const next = deterministic.read().action!.id;
  await deterministic.resolver.resolveAsync(f.principal.id, request(item, "later"));
  expect(deterministic.read().action!.id).toBe(next);
});

test("configuration blocker and empty backlog return counts without any Action", async () => {
  const f = setup("Odysseus returned.");
  writeFileSync(join(f.root, "brain.config.ts"), 'throw new Error("unknown schemaa");\n');
  const blocked = await f.review.command(f.principal.id, "start");
  expect(blocked.review.status).toBe("blocked"); expect(blocked.review.blocker?.kind).toBe("configuration"); expect(f.store.snapshot().items).toHaveLength(0);
  writeFileSync(join(f.root, "brain.config.ts"), 'export default { taxonomy: { types: { note: { dir: "journeys", orphanExempt: true, staleDays: 10000 } } } };\n');
  const empty = await f.review.command(f.principal.id, "start");
  expect(empty.review.status).toBe("complete"); expect(empty.review.counts?.eligibleRemaining).toBe(0); expect(empty.action).toBeNull();
});

test("agent and revoked principals cannot start or confirm effects; paused confirmation never selects next", async () => {
  const f = setup(), agent = createPrincipal(f.db, { authMethod: "delegated", label: "Odysseus helper", createdBy: f.principal.id, ttlSeconds: 3600 });
  await expect(f.review.command(agent.id, "start")).rejects.toThrow("Human review authority");
  const item = (await f.review.command(f.principal.id, "start")).action!;
  await expect(f.review.resolver.resolveAsync(agent.id, request(item))).rejects.toThrow("Human review authority");
  await f.review.command(f.principal.id, "pause");
  await f.review.resolver.resolveAsync(f.principal.id, request(item, "dismiss"));
  expect(pending(f)).toHaveLength(0); expect(f.review.read().review).toMatchObject({ status: "paused", dismissed: 1 });
  expect((await f.review.command(f.principal.id, "resume")).action).not.toBeNull();
  revokePrincipal(f.db, f.principal.id, Date.now());
  await expect(f.review.resolver.resolveAsync(f.principal.id, request(f.review.read().action!))).rejects.toThrow("principal");
  expect(f.applies()).toHaveLength(0);
});

test("HTTP review and preview reject extra authority/input fields and expose the same persisted read", async () => {
  const f = setup();
  const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("principal", f.principal); await next(); }); app.route("/", createHygieneReviewRoutes(f.review));
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/hygiene/review", { operation: "start", principalId: "wide" })).status).toBe(400);
  expect((await post("/hygiene/review", { operation: "start" })).status).toBe(200);
  expect(await (await app.request("/hygiene/review")).json()).toEqual(f.review.read());
  expect((await post("/hygiene/review/preview", { itemId: f.review.read().action!.id, optionId: "link-note", expectedVersion: 1, input: { principal: "wide" } })).status).toBe(400);
});

test("killed process after content write recovers with check and never runs resolve twice", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!, ready = join(f.root, "written.flag");
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/hygiene-review-worker.ts"), f.root, f.principal.id, item.id, ready], { stdout: "pipe", stderr: "pipe" });
  clean.push(() => child.kill());
  for (let i = 0; i < 1000 && !existsSync(ready); i++) await Bun.sleep(10);
  expect(existsSync(ready)).toBe(true);
  expect(f.applies()).toHaveLength(1);
  const written = readFileSync(join(f.root, item.hygiene!.finding.path as string), "utf8");
  expect(written).not.toContain(`[[${item.hygiene!.finding.evidence as string}]]`);
  child.kill("SIGKILL"); expect(await child.exited).not.toBe(0);
  const recovery = createHygieneReview(f.db, { brain: f.brain }); await recovery.recover();
  expect(f.applies()).toHaveLength(1); expect(f.store.getItem(item.id)?.status).toBe("resolved");
  expect(f.argv().some(a => a.includes("check") && a.includes(item.hygiene!.findingId))).toBe(true);
  expect(readFileSync(join(f.root, item.hygiene!.finding.path as string), "utf8")).toBe(written);
  expect(pending(f)).toHaveLength(1);
});

test("real post-check failure offers a confirmed inverse only after write; undo stays pending and check alone completes", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut]]. "), item = (await f.review.command(f.principal.id, "start")).action!;
  expect(item.options.some(o => o.id === "undo")).toBe(false);
  const path = join(f.root, item.hygiene!.finding.path as string);
  const before = readFileSync(path, "utf8").replace("title: Return to Ithaca\n", "");
  writeFileSync(path, before);
  await f.review.resolver.resolveAsync(f.principal.id, request(item));
  const failed = f.review.read().action!;
  expect(failed.status).toBe("pending");
  expect(failed.hygiene?.outcome).toMatchObject({ status: "check_failed", code: "required-missing" });
  const inverse = failed.options.find(o => o.id === "undo")!;
  expect(inverse.preview?.after).toBe(before); expect(f.applies()).toHaveLength(1);
  await f.review.resolver.resolveAsync(f.principal.id, request(failed, "undo"));
  expect(readFileSync(path, "utf8")).toBe(before); expect(f.review.read().action?.status).toBe("pending");
  expect(f.review.read().action?.options.some(o => o.id === "undo")).toBe(false);
  await f.review.resolver.resolveAsync(f.principal.id, request(f.review.read().action!, "check"));
  expect(f.review.read().action?.hygiene?.outcome?.status).toBe("still_detected");
  writeFileSync(path, before.replace("type: note\n", "title: Return to Ithaca\ntype: note\n").replace(/\[\[([^\]]+)\]\]/g, "$1"));
  await f.review.resolver.resolveAsync(f.principal.id, request(f.review.read().action!, "check"));
  expect(f.applies()).toHaveLength(1); expect(f.store.getItem(item.id)?.status).toBe("resolved");
});

test("all supported link descriptors become choices; the picker input needs a current bound preview", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut]]. ");
  mkdirSync(join(f.root, "places"));
  const note = '---\ntitle: Eumaeus hut\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\nThe swineherd waits.\n';
  writeFileSync(join(f.root, "places/eumaeus-hut.md"), note);
  utimesSync(join(f.root, "places/eumaeus-hut.md"), new Date("2026-07-12"), new Date("2026-07-12"));
  const item = (await f.review.command(f.principal.id, "start")).action!;
  expect(item.options.filter(o => o.effect.kind === "hygiene" && o.effect.operation === "resolve").map(o => o.id)).toEqual(["link-suggested", "link-note", "link-text"]);
  const previewed = await f.review.preview(f.principal.id, { itemId: item.id, optionId: "link-note", expectedVersion: item.version, input: "places/eumaeus-hut.md" });
  expect(previewed.options.find(o => o.id === "link-note")?.preview?.after).toContain("[[places/eumaeus-hut|Eumaeus hut]]");
  await f.review.resolver.resolveAsync(f.principal.id, { ...request(previewed, "link-note"), input: "places/eumaeus-hut.md" });
  expect(f.store.getItem(item.id)?.status).toBe("resolved");
  expect(f.argv().every(a => a[0] === "hygiene" && ["next", "resolve", "check", "undo", "list", "dismiss", "snooze"].some(op => a.includes(op)))).toBe(true);
});

test("confirmed revisions reject tampering and obsolete preview versions before any CLI apply", async () => {
  const f = setup("Odysseus returned.", true), item = (await f.review.command(f.principal.id, "start")).action!;
  const current = await f.review.preview(f.principal.id, { itemId: item.id, optionId: "required-field", expectedVersion: item.version, input: "Return to Ithaca" });
  await expect(f.review.preview(f.principal.id, { itemId: item.id, optionId: "required-field", expectedVersion: item.version, input: "Circe palace" })).rejects.toThrow("version conflict");
  const raw = { ...current, options: current.options.map(o => o.id === "required-field" ? { ...o, effect: { ...o.effect, input: "Circe palace" } } : o) };
  f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = ?").run(JSON.stringify(raw), item.id);
  await expect(f.review.resolver.resolveAsync(f.principal.id, request(current, "required-field"))).rejects.toThrow("Stored Action options changed");
  expect(f.applies()).toHaveLength(0);
});

test("due hygiene snoozes cannot create a second pending review card through the generic sweep", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  await f.review.resolver.resolveAsync(f.principal.id, request(item, "later"));
  const snoozed = f.store.getItem(item.id)!;
  const { sweepInboxLifecycle } = await import("../src/inbox/actions.js");
  sweepInboxLifecycle(f.db, snoozed.waitUntil! + 1);
  expect(f.store.getItem(item.id)?.status).toBe("snoozed");
  expect(pending(f)).toHaveLength(1);
});

test("createApp mounts authenticated review operations and invokes no backend through start, pause or resume", async () => {
  const f = setup();
  const { createApp } = await import("../src/app.js");
  const { resolveServerConfig } = await import("../src/config/env.js");
  const { createStaticBackendRegistry } = await import("../src/agent/backend.js");
  const { makeFakeBackend } = await import("./helpers/fake-backend.js");
  const { createRecordingObservability } = await import("../src/observability/index.js");
  let inference = 0;
  const backend = makeFakeBackend({ id: "fixture", startTurn: async () => { inference++; throw new Error("Inference is forbidden in hygiene review"); } });
  const app = await createApp({ config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: join(f.root, "ui.sqlite"), BRAIN_PATH: f.root,
    BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_INBOX_POKE_TOKEN_FILE: join(f.root, "poke.token") }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  clean.push(() => app.close());
  const post = (operation: string) => app.fetch(new Request("http://localhost/api/hygiene/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation }) }));
  const started = await post("start"); expect(started.status).toBe(200);
  const first = await started.json() as { action: InboxActionItem };
  expect(first.action.status).toBe("pending");
  expect((await post("pause")).status).toBe(200);
  const resumed = await post("resume"); expect(resumed.status).toBe(200);
  expect((await resumed.json() as { action: InboxActionItem }).action.id).toBe(first.action.id);
  expect((await app.fetch(new Request("http://localhost/api/hygiene/review"))).status).toBe(200);
  expect(inference).toBe(0);
});


test("durable preview revisions and completed dispatch receipts cannot be rewritten or deleted", async () => {
  const f = setup(), item = (await f.review.command(f.principal.id, "start")).action!;
  await f.review.resolver.resolveAsync(f.principal.id, request(item));
  expect(f.store.getItem(item.id)?.status).toBe("resolved");
  expect(() => f.db.query("UPDATE hygiene_action_revisions SET options_json = '[]' WHERE item_id = ?").run(item.id)).toThrow("Immutable hygiene revision");
  expect(() => f.db.query("DELETE FROM hygiene_action_revisions WHERE item_id = ?").run(item.id)).toThrow("Retained hygiene revision");
  expect(() => f.db.query("UPDATE hygiene_effect_attempts SET request_json = '{}' WHERE item_id = ?").run(item.id)).toThrow("Immutable hygiene attempt");
  expect(() => f.db.query("DELETE FROM hygiene_effect_attempts WHERE item_id = ?").run(item.id)).toThrow("Retained hygiene attempt");
});


test("same-identity refresh supersedes the old Action with current evidence without advancing or writing Markdown", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("|the hut", "|his hut"));
  await f.review.resolver.resolveAsync(f.principal.id, request(old));
  expect(f.review.read().action?.hygiene?.outcome?.status).toBe("stale");
  const fresh = await f.brain.hygiene!(["next"]) as { finding: { id: string; fingerprint: string } };
  expect(fresh.finding.id).toBe(old.hygiene!.findingId);
  expect(fresh.finding.fingerprint).not.toBe(old.hygiene!.fingerprint);
  const before = readFileSync(path, "utf8"), logs = logBytes(f.root), position = f.review.read().review.position;
  const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("principal", f.principal); await next(); }); app.route("/", createHygieneReviewRoutes(f.review));
  const response = await app.request("/hygiene/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "refresh" }) });
  const refreshed = await response.json() as { action?: InboxActionItem };
  // The failing-first receipt names the obsolete fingerprint, before other new wire assertions.
  expect(refreshed.action?.hygiene?.fingerprint ?? old.hygiene!.fingerprint).toBe(fresh.finding.fingerprint);
  expect(response.status).toBe(200);
  const current = refreshed.action!;
  expect(current.id).not.toBe(old.id); expect(current.hygiene!.findingId).toBe(old.hygiene!.findingId);
  expect(current.options.find(o => o.id === "link-text")?.preview?.before).toBe(before);
  expect((f.store.getItem(old.id) as InboxActionItem).options).toEqual(old.options);
  expect(f.store.getItem(old.id)).toMatchObject({ status: "dropped", hygiene: { outcome: { status: "superseded", supersededBy: current.id } } });
  expect(f.review.read().review).toMatchObject({ position, fixed: 0, dismissed: 0, snoozed: 0 });
  expect(pending(f)).toHaveLength(1); expect(logBytes(f.root)).toEqual(logs); expect(readFileSync(path, "utf8")).toBe(before);
  await expect(f.review.preview(f.principal.id, { itemId: old.id, optionId: "link-text", expectedVersion: old.version, input: null })).rejects.toThrow();
  await expect(f.review.resolver.resolveAsync(f.principal.id, request(old))).rejects.toThrow("not resolvable");
  expect(f.applies()).toHaveLength(1); // Only the original stale attempt reached apply.
  const { exportInboxSnapshot, restoreInboxSnapshot } = await import("../src/inbox/snapshot.js");
  const backup = await exportInboxSnapshot(f.db, f.root);
  const restoredPath = join(f.root, "restored.sqlite");
  await restoreInboxSnapshot(backup, restoredPath, f.root);
  const restoredDb = createUiDb(restoredPath); clean.push(() => restoredDb.close());
  expect(createHygieneReview(restoredDb, { brain: f.brain }).read().action?.id).toBe(current.id);
  expect((createInboxStore(restoredDb).getItem(old.id) as InboxActionItem | null)?.hygiene?.outcome?.supersededBy).toBe(current.id);
  const foreign = createUiDb(join(f.root, "ui.sqlite")); clean.push(() => foreign.close());
  const restarted = createHygieneReview(foreign, { brain: f.brain });
  const repeated = await Promise.all([restarted.command(f.principal.id, "refresh"), f.review.command(f.principal.id, "refresh")]);
  expect(repeated.map(r => r.action?.id)).toEqual([current.id, current.id]);
  await restarted.command(f.principal.id, "pause");
  expect((await restarted.command(f.principal.id, "refresh")).review.status).toBe("paused");
  expect((await restarted.command(f.principal.id, "resume")).action?.id).toBe(current.id);
  const previewed = await restarted.preview(f.principal.id, { itemId: current.id, optionId: "link-text", expectedVersion: current.version, input: null });
  await restarted.resolver.resolveAsync(f.principal.id, request(previewed));
  expect(readFileSync(path, "utf8")).toContain("his hut"); expect(readFileSync(path, "utf8")).not.toContain("[[Eumaeus hut");
  expect(f.store.getItem(current.id)?.status).toBe("resolved");
});

test("refresh targets the current finding even when another finding would win next, and returning evidence never revives an old Action", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("|the hut", "|his hut").replace("title: Return to Ithaca\n", ""));
  const next = await f.brain.hygiene!(["next"]) as { finding: { id: string } };
  expect(next.finding.id).not.toBe(old.hygiene!.findingId);
  const logs = logBytes(f.root);
  const changed = (await f.review.command(f.principal.id, "refresh")).action!;
  expect(changed.hygiene!.findingId).toBe(old.hygiene!.findingId);
  expect(changed.hygiene!.fingerprint).not.toBe(old.hygiene!.fingerprint);
  expect(changed.hygiene!.finding.priorityReason).toMatchObject({ severity: "warning", tieBreak: "severity" });
  expect(logBytes(f.root)).toEqual(logs);
  writeFileSync(path, original);
  const returning = f.review.command(f.principal.id, "refresh");
  await expect(returning).resolves.toMatchObject({ action: { hygiene: { fingerprint: old.hygiene!.fingerprint } } });
  const returned = (await returning).action!;
  expect(returned.hygiene!.fingerprint).toBe(old.hygiene!.fingerprint);
  expect(returned.id).not.toBe(old.id); expect(returned.id).not.toBe(changed.id);
  expect((f.store.getItem(changed.id) as InboxActionItem | null)?.hygiene?.outcome?.supersededBy).toBe(returned.id);
  expect(pending(f)).toHaveLength(1); expect(f.review.read().review.position).toBe(1);
});

test("refresh of a gone finding or unavailable checks stays pending without claiming a disposition", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("[[Eumaeus hut|the hut]]", "the hut"));
  const before = readFileSync(path, "utf8"), logs = logBytes(f.root);
  const gone = await f.review.command(f.principal.id, "refresh");
  expect(gone.action?.id).toBe(old.id); expect(gone.action?.hygiene?.outcome).toMatchObject({ status: "stale", reason: "finding-not-detected" });
  writeFileSync(join(f.root, "brain.config.ts"), 'throw new Error("unknown schemaa");\n');
  const blocked = await f.review.command(f.principal.id, "refresh");
  expect(blocked.action?.id).toBe(old.id); expect(blocked.action?.hygiene?.outcome?.status).toBe("refused");
  expect(blocked.review).toMatchObject({ position: 1, fixed: 0, dismissed: 0, snoozed: 0 });
  expect(readFileSync(path, "utf8")).toBe(before); expect(logBytes(f.root)).toEqual(logs); expect(f.applies()).toHaveLength(0);
});

for (const during of ["edit", "revoke", "resolve", "preview"] as const) test(`refresh refuses ${during} during preparation without admitting a replacement`, async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("|the hut", "|his hut"));
  const hygiene = f.brain.hygiene!; let reads = 0;
  const racing = createHygieneReview(f.db, { brain: { ...f.brain, hygiene: async args => {
    const result = await hygiene(args);
    if (during === "edit" && args.includes("link-text") && args.includes("--dry-run")) writeFileSync(path, readFileSync(path, "utf8").replace("|his hut", "|their hut"));
    if (args.includes("--finding") && ++reads === 1) {
      if (during === "revoke") revokePrincipal(f.db, f.principal.id, Date.now());
      if (during === "resolve") await f.review.resolver.resolveAsync(f.principal.id, request(old, "dismiss"));
      if (during === "preview") await f.review.preview(f.principal.id, { itemId: old.id, optionId: "link-text", expectedVersion: old.version, input: null });
    }
    return result;
  } } });
  if (during === "edit") {
    const result = await racing.command(f.principal.id, "refresh");
    expect(result.action?.id).toBe(old.id); expect(result.action?.hygiene?.outcome).toMatchObject({ status: "stale", reason: "refresh-premise-changed" });
  } else await expect(racing.command(f.principal.id, "refresh")).rejects.toThrow(during === "revoke" ? "Human review authority" : "version conflict");
  expect((f.store.getItem(old.id) as InboxActionItem | null)?.hygiene?.outcome?.status).not.toBe("superseded");
  expect(f.applies()).toHaveLength(0); expect(pending(f)).toHaveLength(1);
});

test("simultaneous refreshes across connections admit one replacement and refresh never retires other capped decisions", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const { createInboxAction } = await import("../src/inbox/actions.js");
  for (let i = 0; i < 59; i++) {
    const threadId = `other-${i}`; f.store.openReviewThread(threadId);
    createInboxAction(f.db, { id: threadId, dedupKey: threadId, threadId, queue: "actions", type: "choose", status: "pending", version: 1, createdAt: 1, updatedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, payload: { title: "Odysseus chooses", detail: "Odysseus reviews a choice." }, options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] }, []);
  }
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("|the hut", "|his hut"));
  const foreign = createUiDb(join(f.root, "ui.sqlite")); clean.push(() => foreign.close());
  const second = createHygieneReview(foreign, { brain: f.brain });
  const results = await Promise.allSettled([f.review.command(f.principal.id, "refresh"), second.command(f.principal.id, "refresh")]);
  expect(results.some(r => r.status === "fulfilled")).toBe(true);
  expect(pending(f)).toHaveLength(1); expect((f.store.getItem(old.id) as InboxActionItem | null)?.hygiene?.outcome?.status).toBe("superseded");
  expect(f.store.snapshot().items.filter(i => i.queue === "actions" && i.status === "pending")).toHaveLength(60);
  expect(f.store.snapshot().items.filter(i => i.id.startsWith("retired-"))).toHaveLength(0);
  expect(f.review.read().review.position).toBe(1); expect(f.applies()).toHaveLength(0);
});

test("refresh authority and an in-progress effect are rechecked, while an empty paused review requires Resume", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]].");
  const agent = createPrincipal(f.db, { authMethod: "delegated", label: "Odysseus helper", createdBy: f.principal.id, ttlSeconds: 3600 });
  await expect(f.review.command(agent.id, "refresh")).rejects.toThrow("Human review authority");
  await f.review.command(f.principal.id, "pause");
  expect((await f.review.command(f.principal.id, "refresh")).action).toBeNull();
  expect(f.argv()).toHaveLength(0);
  const old = (await f.review.command(f.principal.id, "resume")).action!;
  const hygiene = f.brain.hygiene!;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const applying = createHygieneReview(f.db, { brain: { ...f.brain, hygiene: async args => {
    if (args.includes("resolve") && !args.includes("--dry-run")) { entered(); await gate; }
    return hygiene(args);
  } } });
  const apply = applying.resolver.resolveAsync(f.principal.id, request(old));
  await ready;
  try { await expect(f.review.command(f.principal.id, "refresh")).rejects.toThrow("Effect in progress"); }
  finally { release(); await apply; }
  expect(f.store.getItem(old.id)?.status).toBe("resolved");
});

test("refresh refuses a failed input-free preview even when the final fingerprint is current", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("|the hut", "|his hut"));
  const hygiene = f.brain.hygiene!;
  const unavailable = createHygieneReview(f.db, { brain: { ...f.brain, hygiene: async args => {
    if (args.includes("link-text") && args.includes("--dry-run")) return { status: "refused", id: old.hygiene!.findingId, reason: "lock-unavailable" };
    return hygiene(args);
  } } });
  const result = await unavailable.command(f.principal.id, "refresh");
  expect(result.action?.id).toBe(old.id); expect(result.action?.hygiene?.outcome?.status).toBe("stale");
  expect(f.applies()).toHaveLength(0); expect(pending(f)).toHaveLength(1);
});

test("superseded replacement receipts survive backup and refuse missing or self references", async () => {
  const f = setup("Odysseus sees [[Eumaeus hut|the hut]]."), old = (await f.review.command(f.principal.id, "start")).action!;
  const path = join(f.root, old.hygiene!.finding.path as string);
  writeFileSync(path, readFileSync(path, "utf8").replace("|the hut", "|his hut"));
  await f.review.command(f.principal.id, "refresh");
  const { exportInboxSnapshot } = await import("../src/inbox/snapshot.js");
  await expect(exportInboxSnapshot(f.db, f.root)).resolves.toBeDefined();
  const stored = f.store.getItem(old.id) as InboxActionItem;
  for (const supersededBy of ["missing-card", old.id]) {
    try {
      f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...stored, hygiene: { ...stored.hygiene!, outcome: { ...stored.hygiene!.outcome!, supersededBy } } }), old.id);
      await expect(exportInboxSnapshot(f.db, f.root)).rejects.toThrow("inbox_snapshot_hygiene_relations");
    } finally { f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = ?").run(JSON.stringify(stored), old.id); }
  }
});
