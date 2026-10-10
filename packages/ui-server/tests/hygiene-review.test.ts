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
