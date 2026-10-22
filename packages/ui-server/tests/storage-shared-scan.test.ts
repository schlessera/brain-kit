import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createUiDb } from "../src/db/client.js";
import { createSharedStorageScan } from "../src/storage/shared-scan.js";
import { createStorageCoordinator } from "../src/storage/coordinator.js";
import { createStorageHistory } from "../src/storage/history-store.js";
import { hashScope } from "../src/storage/history-model.js";
import { processAlive, processStart } from "../src/brain/writer-gate.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const driver = resolve(import.meta.dir, "fixtures/storage-shared-process.ts");
const preload = resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-shared-scan-")), brain = join(root, "brain"), cache = join(root, "cache");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(brain, ".git/objects"), { recursive: true }); mkdirSync(join(brain, ".git/refs/heads"), { recursive: true });
  writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "Odysseus.md"), "# Odysseus\n\nPrepare the return to Ithaca.\n");
  const db = createUiDb(join(root, "operations.sqlite")); cleanup.push(() => db.close());
  const history = createStorageHistory(db, brain), shared = createSharedStorageScan(db, brain, cache, id => id === "odysseus-owner");
  return { root, brain, cache, db, history, shared };
}
function child(root: string, mode: string, marker = "") {
  return Bun.spawn([process.execPath, "--preload", preload, driver, root, mode, marker], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function marker(path: string, process: ReturnType<typeof child>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && process.exitCode === null) {
    try { const value = JSON.parse(readFileSync(path, "utf8")); if (Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d+$/.test(value.start)) return value as { pid: number; start: string; lease: string }; } catch { /* publication not complete */ }
    await sleep(10);
  }
  throw Error("STORAGE_SHARED_CHILD_DID_NOT_PUBLISH_PID");
}
function running(pid: number, start: string) {
  if (!processAlive(pid, start)) return false;
  try { const value = readFileSync(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; } catch { return false; }
}
test("two native processes share one collection and the same complete cached pages", async () => {
  const f = fixture(), children = [child(f.root, "collect"), child(f.root, "collect")];
  const outputs: string[] = ["", ""], readers = children.map((value, index) => (async () => { for await (const bytes of value.stdout) outputs[index] += Buffer.from(bytes).toString("utf8"); })());
  const errors = children.map(value => new Response(value.stderr).text());
  try {
    const deadline = Date.now() + 10_000;
    while (!outputs.every(value => value.includes("READY\n")) && Date.now() < deadline) await sleep(10);
    expect(outputs.every(value => value.includes("READY\n")), "STORAGE_SHARED_BOTH_CALLERS_READY").toBe(true);
    for (const value of children) { value.stdin.write("collect\n"); value.stdin.end(); }
    const exits = await Promise.all(children.map(value => value.exited)); await Promise.all(readers);
    expect(exits, (await Promise.all(errors)).join("\n")).toEqual([0, 0]);
    const results = outputs.map(value => JSON.parse(value.trim().split("\n").at(-1)!));
    expect(results[0].id, "STORAGE_SHARED_ONE_COLLECTION").toBe(results[1].id);
    expect(results.map(value => value.collections).reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(results[0].names).toEqual(results[1].names); expect(results[0].names).toContain("Odysseus.md");
    expect(f.db.query("SELECT job_id, workers_json FROM storage_scan_leases").get()).toEqual({ job_id: null, workers_json: "[]" });
  } finally {
    for (const value of children) if (value.exitCode === null) value.kill("SIGKILL");
    await Promise.all(children.map(value => value.exited)); await Promise.allSettled([...readers, ...errors]);
  }
});
test("uncontended and joined in-process operation requests take one scan without a transfer cache", async () => {
  const f = fixture(); let collected = 0;
  const coordinator = createStorageCoordinator({ brainPath: f.brain, stores: [], shared: f.shared, salt: f.history.read()!.metadata.state.salt, authorized: id => id === "odysseus-owner", onCollection() { collected++; } });
  try {
    const first = coordinator.start("odysseus-owner", true);
    const measurement = await coordinator.measure("odysseus-owner", new AbortController().signal);
    expect(measurement?.id ?? null, "STORAGE_OPERATION_JOINS_ACTIVE_SCAN").toBe(first.activeScanId);
    expect(collected).toBe(1); expect(existsSync(f.cache)).toBe(false);
  } finally { await coordinator.close(); }
});
for (const phase of ["registered", "before-register"]) test(`native collector exits after parent SIGKILL ${phase}`, async () => {
  const f = fixture(), path = join(f.root, "ready.json"), process = child(f.root, phase, path);
  let worker: { pid: number; start: string; lease: string } | null = null;
  const output = new Response(process.stdout).text(), errors = new Response(process.stderr).text();
  try {
    worker = await marker(path, process); expect(running(worker.pid, worker.start)).toBe(true);
    process.kill("SIGKILL"); expect(await process.exited).not.toBe(0);
    const deadline = Date.now() + 3500;
    while (running(worker.pid, worker.start) && Date.now() < deadline) await sleep(20);
    expect(running(worker.pid, worker.start), "STORAGE_PARENT_DEATH_REAPS_READER").toBe(false);
    const lease = f.shared.acquire("odysseus-owner", randomUUID(), hashScope("Odysseus guard fixture"), 1, true)!;
    await f.shared.reap(lease); expect(f.shared.finish(lease, false, true)).toBe(true);
    expect(f.db.query("SELECT job_id, workers_json FROM storage_scan_leases").get()).toEqual({ job_id: null, workers_json: "[]" });
  } finally {
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
    if (worker && processStart(worker.pid) === worker.start && running(worker.pid, worker.start)) globalThis.process.kill(worker.pid, "SIGKILL");
    await Promise.allSettled([output, errors]);
  }
});
test("lease identity, cancellation, different scopes and a shared completed result retain owner checks", async () => {
  const f = fixture(), scope = hashScope("Odysseus scope");
  const owner = f.shared.acquire("odysseus-owner", randomUUID(), scope, 1, true)!;
  expect(() => f.shared.acquire("odysseus-owner", randomUUID(), hashScope("Troy scope"), 1, true)).toThrow("storage-scan-other-scope-busy");
  expect(() => f.shared.acquire("agent", randomUUID(), scope, 1, true)).toThrow("storage-scan-owner-revoked");
  const joined = f.shared.acquire("odysseus-owner", randomUUID(), scope, 1, true)!;
  expect(joined.id, "STORAGE_SHARED_ONE_LEASE").toBe(owner.id); expect(joined.owner).toBe(false);
  f.shared.cancel(joined); expect(() => f.shared.check(owner)).toThrow("storage-scan-authority-lost");
  expect(f.shared.finish(owner, false, true)).toBe(true);
  expect(f.shared.acquire("odysseus-owner", randomUUID(), scope, 0, true)).toBeNull();
});

test("failed shared-cache publication keeps the previous snapshot and releases the native scan lease", async () => {
  const f = fixture(); let failures = 0;
  const settings = { brainPath: f.brain, stores: [], shared: f.shared, salt: f.history.salt, authorized: (id: string) => id === "odysseus-owner" };
  const first = createStorageCoordinator({ ...settings, onFailure() { failures++; } }), other = createStorageCoordinator(settings);
  try {
    first.start("odysseus-owner", true); await first.idle(); const before = first.status("odysseus-owner").snapshot!; expect(before).not.toBeNull();
    writeFileSync(f.cache, "The cache destination is unavailable.");
    const owner = first.start("odysseus-owner", true), joined = other.start("odysseus-owner", true);
    expect(joined.activeScanId).toBe(owner.activeScanId); await Promise.all([first.idle(), other.idle()]);
    expect(first.status("odysseus-owner").snapshot?.id, "STORAGE_CACHE_FAILURE_RETAINS_PREVIOUS").toBe(before.id);
    expect(first.status("odysseus-owner").lastFailure?.reason).toBe("collection-unavailable");
    expect(other.status("odysseus-owner").lastFailure?.reason).toBe("collection-unavailable"); expect(failures).toBe(1);
    expect(f.db.query("SELECT job_id, workers_json FROM storage_scan_leases").get(), "STORAGE_FAILED_SHARED_SCAN_RELEASES_LEASE").toEqual({ job_id: null, workers_json: "[]" });
    rmSync(f.cache); other.start("odysseus-owner", true); await other.idle(); expect(other.status("odysseus-owner").snapshot).not.toBeNull();
  } finally { await Promise.all([first.close(), other.close()]); }
});

test("joined cancellation stops publication and leaves no reader ownership behind", async () => {
  const f = fixture(), settings = { brainPath: f.brain, stores: [], shared: f.shared, salt: f.history.salt, authorized: (id: string) => id === "odysseus-owner" };
  const first = createStorageCoordinator(settings), joined = createStorageCoordinator(settings);
  try {
    first.start("odysseus-owner", true); const status = joined.start("odysseus-owner", true); joined.cancel("odysseus-owner", status.activeScanId!);
    await Promise.all([first.idle(), joined.idle()]);
    expect(first.status("odysseus-owner").snapshot, "STORAGE_JOINED_CANCEL_PREVENTS_PUBLICATION").toBeNull();
    expect(joined.status("odysseus-owner").snapshot).toBeNull();
    expect(f.db.query("SELECT job_id, workers_json FROM storage_scan_leases").get()).toEqual({ job_id: null, workers_json: "[]" });
  } finally { await Promise.all([first.close(), joined.close()]); }
});
