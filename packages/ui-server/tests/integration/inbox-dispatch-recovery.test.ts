/**
 * #689 crash and restore through the fixture host. A supervised app process
 * runs the gated production dispatcher; the test is its supervisor and cron.
 * It SIGKILLs the process after a claim, after an escalation checkpoint and
 * after an approved side effect, restarts it on the same database, and moves
 * the supervisor clock past the lease. Separately it takes the daily
 * `brain-ui-inbox export`, loses the installation and restores into an empty
 * target. Every path keeps spend, trust and pending decisions, and produces
 * the approved effect exactly once.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { BrainUiClient, type ServerMessage } from "@schlessera/brain-ui-sdk/client";

const HOST = join(import.meta.dir, "../fixtures/inbox-dispatch-host.ts");
const BIN = join(import.meta.dir, "../../src/bin/brain-ui-inbox.ts");
const MINUTE = 60_000;
// The host fixture's world (tests/fixtures/inbox-dispatch-host.ts).
const SECRET = "fixture-cookie-secret-0123456789abcdef";
const NOTE = "notes/ithaca-loom.md";
const WRITE = { content: "Penelope keeps the loom until Odysseus returns.\n" };
const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) { if (predicate()) return true; await Bun.sleep(20); }
  return predicate();
}

function installation(dir = mkdtempSync(join(tmpdir(), "brain-dispatch-host-"))) {
  const brain = join(dir, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  mkdirSync(join(brain, ".brain-ui"), { recursive: true });
  mkdirSync(join(dir, "run"), { recursive: true });
  // A fresh offline price table: T1 is API billed and the preload refuses catalog fetches.
  const rate = { input: 4.2e-8, output: 0, cacheRead: null, cacheWrite: null };
  writeFileSync(join(brain, ".brain-ui/model-pricing.json"), JSON.stringify({ version: 1, fetchedAt: Date.now() + 3_600_000,
    litellm: { fetchedAt: Date.now() + 3_600_000, rates: { "jev-1.13.0": rate } }, openrouter: { fetchedAt: Date.now() + 3_600_000, rates: {} } }));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, brain, db: join(dir, "ui.sqlite") };
}
type Install = ReturnType<typeof installation>;

/** The fixture supervisor: start the host process and wait for its listener. */
async function start(at: Install, hold = "") {
  rmSync(join(at.dir, "ready.json"), { force: true });
  const child = Bun.spawn([process.execPath, HOST, at.dir, at.brain, at.db, hold], { stdout: "pipe", stderr: "pipe" });
  let exited = false;
  void child.exited.then(() => { exited = true; });
  cleanup.push(() => { if (!exited) child.kill("SIGKILL"); });
  expect(await waitFor(() => existsSync(join(at.dir, "ready.json")) || exited), "host listener").toBe(true);
  if (exited) throw new Error(await new Response(child.stderr).text());
  const ready = JSON.parse(readFileSync(join(at.dir, "ready.json"), "utf8")) as { port: number; principalId: string };
  const origin = `http://127.0.0.1:${ready.port}`;
  const cookie = await serializeSigned("brain_ui_session", ready.principalId, SECRET);
  return { child, origin, cookie, principalId: ready.principalId,
    kill: async () => { child.kill("SIGKILL"); expect(await child.exited).not.toBe(0); },
    stop: async () => { child.kill("SIGTERM"); expect(await child.exited).toBe(0); } };
}
type Host = Awaited<ReturnType<typeof start>>;

/** The fixture cron: read the token file for every poke, as the generated host will. */
function poke(at: Install, host: Host) {
  return fetch(`${host.origin}/api/internal/inbox/poke`, { method: "POST",
    headers: { authorization: `Bearer ${readFileSync(join(at.dir, "run/inbox-poke.token"), "utf8").trim()}` } })
    .then(async response => { expect(response.status).toBe(200); return await response.json() as { claimed: number; recovered: number }; });
}
const clock = (at: Install, offset: number) => writeFileSync(join(at.dir, "clock"), String(offset));
async function arrive(host: Host): Promise<string> {
  const response = await fetch(`${host.origin}/api/queue`, { method: "POST",
    headers: { cookie: host.cookie, "content-type": "application/json", origin: host.origin },
    body: JSON.stringify({ key: "odysseus-loom", text: "Penelope asks that the loom be recorded in Ithaca's notes." }) });
  expect(response.status).toBe(201);
  return (await response.json() as { itemId: string }).itemId;
}
/** Two devices tap the same decision. */
async function resolve(host: Host, itemId: string, optionId = "apply") {
  const devices = await Promise.all([0, 1].map(async () => {
    const frames: ServerMessage[] = [];
    const client = new BrainUiClient({ url: `${host.origin.replace("http", "ws")}/ws`,
      socketFactory: (url) => new NativeWebSocket(url, { headers: { cookie: host.cookie } }), handlers: { onAny: (f) => frames.push(f) } });
    cleanup.push(() => client.close());
    client.connect();
    expect(await waitFor(() => frames.some((f) => f.type === "server_hello"))).toBe(true);
    return { client, frames };
  }));
  for (const { client } of devices) client.send({ type: "inbox_resolve", itemId, optionId });
  await Bun.sleep(300);
  for (const { frames, client } of devices) { expect(frames.filter(f => f.type === "error")).toEqual([]); client.close(); }
}
function read<T>(at: Install, sql: string, ...args: string[]): T[] {
  const db = new Database(at.db, { readonly: true });
  try { db.exec("PRAGMA busy_timeout = 5000"); return db.query(sql).all(...args) as T[]; } finally { db.close(); }
}
const item = (at: Install, id: string) => read<{ status: string; attempts: number; data_json: string }>(at, "SELECT status, attempts, data_json FROM inbox_items WHERE id = ?", id)[0]!;
const pending = (at: Install) => read<{ id: string; type: string }>(at, "SELECT id, type FROM inbox_items WHERE queue = 'actions' AND type != 'fyi' AND status = 'pending'");
const executes = (at: Install) => read<{ id: string; status: string }>(at, "SELECT id, status FROM inbox_items WHERE queue = 'queue' AND type = 'execute'");
const reservations = (at: Install) => read<{ purpose: string; status: string; charged_turns: number | null }>(at,
  "SELECT purpose, status, charged_turns FROM inbox_budget_reservations ORDER BY rowid");
const note = (at: Install) => existsSync(join(at.brain, NOTE)) ? readFileSync(join(at.brain, NOTE), "utf8") : null;
const turns = (at: Install) => readdirSync(at.dir).filter(name => name.startsWith("turn-")).sort()
  .map(name => JSON.parse(readFileSync(join(at.dir, name), "utf8")) as { followUp: boolean; result: { ok: boolean; code?: string } });

test("killed after its claim: the lease recovers with spend charged, and the retry escalates once", async () => {
  const at = installation();
  let host = await start(at, "claim");
  const itemId = await arrive(host);
  void poke(at, host).catch(() => {});
  expect(await waitFor(() => existsSync(join(at.dir, "reached-claim")))).toBe(true);
  await host.kill();
  expect(item(at, itemId)).toMatchObject({ status: "claimed", attempts: 2 });
  expect(reservations(at).map(r => [r.purpose, r.status])).toEqual([["triage", "settled"], ["execute", "active"]]);

  host = await start(at);
  clock(at, 11 * MINUTE);
  expect(await poke(at, host), "LEASE_RECOVERED").toMatchObject({ recovered: 1, claimed: 0 });
  expect(item(at, itemId)).toMatchObject({ status: "ready", attempts: 2 });
  expect(reservations(at)[1], "SPEND_RETAINED: the lost attempt stays charged").toMatchObject({ status: "released", charged_turns: 1 });
  clock(at, 14 * MINUTE);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  expect(pending(at), "one durable decision").toHaveLength(1);
  expect(item(at, itemId)).toMatchObject({ status: "blocked", attempts: 3 });
  expect(note(at)).toBeNull();
  expect(reservations(at).map(r => r.purpose)).toEqual(["triage", "execute", "retry"]);
  await host.stop();
}, 60_000);

test("killed after its escalation checkpoint: the decision survives once and resolves to one effect", async () => {
  const at = installation();
  let host = await start(at, "checkpoint");
  const itemId = await arrive(host);
  void poke(at, host).catch(() => {});
  expect(await waitFor(() => existsSync(join(at.dir, "reached-checkpoint")))).toBe(true);
  await host.kill();
  expect(item(at, itemId).status).toBe("blocked");
  const [action] = pending(at);
  expect(action).toMatchObject({ type: "approve" });

  host = await start(at);
  clock(at, 11 * MINUTE);
  await poke(at, host);
  expect(reservations(at).filter(r => r.status === "active"), "the lost attempt is reconciled").toEqual([]);
  expect(reservations(at).every(r => r.charged_turns === 1), "and stays charged").toBe(true);
  expect(pending(at), "CHECKPOINT_DURABLE").toEqual([action!]);
  await resolve(host, action!.id);
  expect(executes(at), "ONE_FOLLOW_UP").toHaveLength(1);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  expect(note(at)).toBe(WRITE.content as string);
  expect(executes(at)[0]).toMatchObject({ status: "done" });
  await host.stop();
}, 60_000);

test("killed after the approved side effect: the retried follow-up cannot apply it twice", async () => {
  const at = installation();
  let host = await start(at, "effect");
  await arrive(host);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  const [action] = pending(at);
  await resolve(host, action!.id);
  void poke(at, host).catch(() => {});
  expect(await waitFor(() => existsSync(join(at.dir, "reached-effect")))).toBe(true);
  await host.kill();
  expect(note(at)).toBe(WRITE.content as string);
  const [followUp] = executes(at);
  expect(followUp).toMatchObject({ status: "claimed" });

  host = await start(at);
  clock(at, 11 * MINUTE);
  expect(await poke(at, host)).toMatchObject({ recovered: 1 });
  clock(at, 14 * MINUTE);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  const applied = turns(at).filter(t => t.followUp).map(t => t.result.ok ? "applied" : t.result.code);
  expect(applied, "EXACTLY_ONCE: the replay is refused by the changed base").toEqual(["applied", "stale_base"]);
  expect(note(at)).toBe(WRITE.content as string);
  expect(pending(at)).toEqual([]);
  expect(executes(at)[0]).toMatchObject({ status: "done" });
  await host.stop();
}, 60_000);

test("the daily snapshot restores into an empty installation with its decision, spend and trust, and applies once", async () => {
  const at = installation();
  let host = await start(at);
  const itemId = await arrive(host);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  const [action] = pending(at);
  const thread = read<{ id: string; trust_class: string; source: string }>(at,
    "SELECT t.id, t.trust_class, t.source FROM inbox_threads t JOIN inbox_items i ON i.thread_id = t.id WHERE i.id = ?", itemId)[0]!;
  const backup = join(at.dir, "operational-backup.json");
  // The daily export, while the host runs; content Markdown has its own Git backup.
  const exported = Bun.spawnSync([process.execPath, BIN, "export", "--db", at.db, "--brain-root", at.brain, "--file", backup, "--json"]);
  expect(exported.exitCode, exported.stdout.toString() + exported.stderr.toString()).toBe(0);
  expect(JSON.parse(exported.stdout.toString())).toMatchObject({ ok: true, snapshot: { recovery_point_hours: 24 } });
  const spent = reservations(at);
  const content = installation();
  cpSync(join(at.brain, "notes"), join(content.brain, "notes"), { recursive: true });

  // Work after the capture point is lost with the installation.
  await resolve(host, action!.id);
  await host.kill();

  rmSync(content.db, { force: true });
  const restored = Bun.spawnSync([process.execPath, BIN, "restore", "--db", content.db, "--brain-root", content.brain, "--file", backup, "--json"]);
  expect(restored.exitCode, restored.stdout.toString() + restored.stderr.toString()).toBe(0);
  host = await start(content);
  expect(pending(content), "RESTORED_DECISION").toEqual([action!]);
  expect(executes(content), "the post-capture resolution is not invented").toEqual([]);
  expect(read(content, "SELECT id, trust_class, source FROM inbox_threads WHERE id = ?", thread.id)).toEqual([thread]);
  expect(reservations(content).slice(0, spent.length), "SPEND_RETAINED").toEqual(spent);
  expect(await poke(content, host)).toMatchObject({ claimed: 0 });
  await resolve(host, action!.id);
  expect(executes(content), "ONE_FOLLOW_UP").toHaveLength(1);
  expect(await poke(content, host)).toMatchObject({ claimed: 1 });
  expect(note(content)).toBe(WRITE.content as string);
  expect(await poke(content, host)).toMatchObject({ claimed: 0 });
  await host.stop();
}, 90_000);

const staging = (at: Install) => existsSync(join(at.brain, ".brain-ui/inbox"))
  ? readdirSync(join(at.brain, ".brain-ui/inbox")).filter(name => !name.startsWith(".")) : [];
const cleanups = (at: Install) => read<{ status: string; attempts: number }>(at,
  "SELECT status, attempts FROM inbox_items WHERE queue = 'queue' AND type = 'cleanup_pending'");

test("killed inside staging compensation: the restart repeats removal and acknowledges once", async () => {
  const at = installation();
  let host = await start(at, "cleanup");
  await arrive(host);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  await resolve(host, pending(at)[0]!.id);
  expect(await poke(at, host)).toMatchObject({ claimed: 1 });
  expect(note(at)).toBe(WRITE.content as string);
  expect(staging(at), "staging is retained until the thread's work is terminal").toHaveLength(1);
  expect(cleanups(at)).toEqual([{ status: "ready", attempts: 0 }]);
  // The next pass removes the staging and is killed before acknowledging it.
  void poke(at, host).catch(() => {});
  expect(await waitFor(() => existsSync(join(at.dir, "reached-cleanup")))).toBe(true);
  await host.kill();
  expect(staging(at)).toEqual([]);
  expect(cleanups(at), "CLEANUP_UNACKNOWLEDGED").toEqual([{ status: "claimed", attempts: 1 }]);

  host = await start(at);
  clock(at, 2 * MINUTE);
  await poke(at, host);
  clock(at, 5 * MINUTE);
  await poke(at, host);
  expect(cleanups(at), "CLEANUP_RECOVERED: repeated removal is acknowledged once").toEqual([{ status: "done", attempts: 2 }]);
  expect(executes(at)).toEqual([expect.objectContaining({ status: "done" })]);
  expect(turns(at).filter(t => t.followUp && t.result.ok), "no effect replays").toHaveLength(1);
  expect(pending(at)).toEqual([]);
  await host.stop();
}, 60_000);

test("staging missing after a restore becomes a visible decision, never blind execution", async () => {
  const at = installation();
  let host = await start(at);
  const itemId = await arrive(host);
  // This scenario needs a stable checkpoint, not a live-export race with the
  // host's periodic database writers. Live export is covered above.
  await host.stop();
  const backup = join(at.dir, "operational-backup.json");
  const exported = Bun.spawnSync([process.execPath, BIN, "export", "--db", at.db, "--brain-root", at.brain, "--file", backup, "--json"]);
  expect(exported.exitCode, exported.stdout.toString() + exported.stderr.toString()).toBe(0);
  const target = installation();
  rmSync(target.db, { force: true });
  const restored = Bun.spawnSync([process.execPath, BIN, "restore", "--db", target.db, "--brain-root", target.brain, "--file", backup, "--json"]);
  expect(restored.exitCode, restored.stdout.toString() + restored.stderr.toString()).toBe(0);
  expect(staging(target)).toHaveLength(1);
  // The staged bytes are lost after the restore.
  rmSync(join(target.brain, ".brain-ui/inbox"), { recursive: true, force: true });
  host = await start(target);
  expect(await poke(target, host)).toMatchObject({ claimed: 0 });
  expect(item(target, itemId), "MISSING_STAGING_BLOCKED").toMatchObject({ status: "blocked" });
  const review = read<{ data_json: string }>(target, "SELECT data_json FROM inbox_items WHERE queue = 'actions' AND status = 'pending'");
  expect(review.map(row => JSON.parse(row.data_json).payload.title), "VISIBLE").toEqual(["A queued arrival needs your review"]);
  expect(turns(target), "no agent turn ran on missing evidence").toEqual([]);
  expect(reservations(target).filter(r => r.purpose !== "triage")).toEqual([]);
  await host.stop();
}, 60_000);
