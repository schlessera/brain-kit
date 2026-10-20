import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStorage } from "../src/storage/collect";
import { createStorageCoordinator } from "../src/storage/coordinator";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "storage-odysseus-")), brain = join(root, "brain"), app = join(root, "app");
  mkdirSync(brain); mkdirSync(app);
  writeFileSync(join(brain, "brain.config.ts"), 'throw Error("STORAGE_CONFIG_MUST_NOT_RUN");');
  for (const [name, size] of [["Troy.PDF", 5_000_001], ["Ithaca.pdf", 5_000_000]] as const) { const fd = openSync(join(brain, name), "wx"); try { ftruncateSync(fd, size); } finally { closeSync(fd); } }
  linkSync(join(brain, "Troy.PDF"), join(app, "chart.pdf"));
  return { root, brain, app, close() { rmSync(root, { recursive: true, force: true }); } };
}
test("real trusted metadata reader and exact app stores share one object union and capacity observation", async () => {
  const f = fixture(), dbPath = join(f.app, "state.sqlite"), db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE chart (id INTEGER); INSERT INTO chart VALUES (1)");
    const result = await collectStorage({ brainPath: f.brain, salt: "odysseus", stores: [
      { path: f.app, label: "App", category: "journal", owner: "app", recursive: true },
      { path: dbPath, label: "DB", category: "database", owner: "app", recursive: false },
      { path: dbPath + "-wal", label: "WAL", category: "database", owner: "app", recursive: false },
    ] }, "scan-odysseus", new AbortController().signal);
    expect(result.summary.errors, "STORAGE_PUBLIC_READER_AVAILABLE").toEqual([]);
    expect(result.entries.some(entry => entry.name === "Troy.PDF")).toBe(true);
    const troy = result.entries.find(entry => entry.name === "Troy.PDF")!, alias = result.entries.find(entry => entry.name === "chart.pdf")!;
    expect(troy.objectId, "STORAGE_CROSS_OWNER_OBJECT_IDENTITY").toBe(alias.objectId);
    expect(result.summary.totals.all.logical! < result.summary.totals.brain.logical! + result.summary.totals.app.logical!, "STORAGE_CROSS_OWNER_UNION").toBe(true);
    expect(result.summary.capacities, "STORAGE_SHARED_CAPACITY_ONCE").toHaveLength(1);
    expect(result.summary.capacities[0]?.identity).toBe("resolved");
    expect(result.summary.capacities[0]?.measured).toBeNull();
    expect(JSON.stringify(result)).not.toContain(f.root);
  } finally { db.close(); f.close(); }
});
test("coordinator coalesces scans, uses strict PDF threshold, binds cursors, and revalidates revoked access", async () => {
  const f = fixture(); let allowed = true;
  for (let index = 0; index < 205; index++) writeFileSync(join(f.brain, `chart-${index}.txt`), "Odysseus");
  const storage = createStorageCoordinator({ brainPath: f.brain, stores: [], authorized: id => allowed && id === "odysseus" });
  try {
    expect(() => storage.status("athena")).toThrow("human-owner");
    const first = storage.start("odysseus"), second = storage.start("odysseus");
    expect(second.activeScanId, "STORAGE_COALESCED_SCAN").toBe(first.activeScanId);
    await storage.idle();
    const status = storage.status("odysseus");
    expect(status.lastFailure).toBeNull(); expect(status.snapshot).not.toBeNull();
    const id = status.snapshot!.id;
    const pdf = storage.page("odysseus", id, { type: "pdf", largerThan: 5_000_000 });
    expect(pdf.entries.map(entry => entry.name), "STORAGE_STRICT_PDF_THRESHOLD").toEqual(["Troy.PDF"]);
    const page = storage.page("odysseus", id, {});
    expect(page.entries).toHaveLength(200); expect(page.nextCursor).not.toBeNull();
    const next = storage.page("odysseus", id, { cursor: page.nextCursor! });
    expect(next.entries.some(entry => page.entries.some(previous => previous.id === entry.id))).toBe(false);
    expect(() => storage.page("odysseus", id, { type: "pdf", cursor: page.nextCursor! })).toThrow("filters changed");
    allowed = false;
    expect(() => storage.page("odysseus", id, {}), "STORAGE_REVOKED_RESULT_REFUSED").toThrow("human-owner");
  } finally { await storage.close(); f.close(); }
});

test("revocation during a real scan never publishes its result", async () => {
  const f = fixture(); let allowed = true;
  const storage = createStorageCoordinator({ brainPath: f.brain, stores: [], authorized: () => allowed });
  try {
    storage.start("odysseus"); allowed = false;
    await storage.idle(); allowed = true;
    expect(storage.status("odysseus"), "STORAGE_REVOKED_INFLIGHT_DISCARDED").toMatchObject({ snapshot: null, lastFailure: { reason: "cancelled-or-revoked" } });
  } finally { await storage.close(); f.close(); }
});

test("bounded process cancellation reaps the real child", async () => {
  const { storageProcess } = await import("../src/storage/process");
  const { readFileSync, existsSync } = await import("node:fs");
  const f = fixture(), pidFile = join(f.app, "pid"), controller = new AbortController();
  const pending = storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", `await Bun.write(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`], { signal: controller.signal });
  try {
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise(done => setTimeout(done, 5));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(() => process.kill(pid, 0), "STORAGE_CANCEL_REAPS_CHILD").toThrow();
  } finally { controller.abort(); await pending.catch(() => {}); f.close(); }
});

test("separate real tmpfs capacities remain separate and unknown stores never look empty", async () => {
  const f = fixture(), other = mkdtempSync("/dev/shm/storage-odysseus-");
  try {
    writeFileSync(join(other, "Ithaca.pdf"), "chart");
    const result = await collectStorage({ brainPath: f.brain, salt: "odysseus", stores: [{ path: other, label: "Memory store", category: "temporary", owner: "app", recursive: true }], unavailable: [{ label: "Backup", category: "backup", owner: "operator", reason: "unavailable" }] }, "separate", new AbortController().signal);
    expect(result.summary.capacities, "STORAGE_SEPARATE_CAPACITIES").toHaveLength(2);
    expect(result.summary.capacities.every(value => value.identity === "resolved")).toBe(true);
    expect(result.summary.totals.operator.logical, "STORAGE_UNKNOWN_OWNER_NOT_ZERO").toBeNull();
  } finally { rmSync(other, { recursive: true, force: true }); f.close(); }
});

test("filtered file-entry total counts aliases while its allocation union does not", async () => {
  const f = fixture(); linkSync(join(f.brain, "Troy.PDF"), join(f.brain, "Poseidon.PDF"));
  const storage = createStorageCoordinator({ brainPath: f.brain, stores: [], authorized: () => true });
  try {
    storage.start("odysseus"); await storage.idle();
    const page = storage.page("odysseus", storage.status("odysseus").snapshot!.id, { type: "pdf", largerThan: 5_000_000 });
    expect(page.matched).toBe(2);
    expect(page.fileLogicalTotal, "STORAGE_PER_ENTRY_SELECTION_TOTAL").toBe(10_000_002);
    expect(page.totals.logical).toBe(5_000_001);
  } finally { await storage.close(); f.close(); }
});

test("reference inspection runs the supported query without repository configuration and marks unchecked consumers", async () => {
  const f = fixture(), db = new Database(join(f.brain, "brain.db"));
  db.exec(`CREATE TABLE index_metadata(key TEXT,value TEXT); INSERT INTO index_metadata VALUES('schema_version','3');
    CREATE TABLE documents(id INTEGER PRIMARY KEY,path TEXT,title TEXT,type TEXT,summary TEXT,updated TEXT,indexed_at TEXT);
    CREATE TABLE links(source_id INTEGER,target_id INTEGER,target TEXT);
    INSERT INTO documents VALUES(1,'Troy.PDF','Chart','asset',NULL,NULL,'2026-07-12T00:00:00Z'),(2,'notes/voyage.md','Voyage','note',NULL,NULL,'2026-07-12T00:00:00Z');
    INSERT INTO links VALUES(2,1,'Troy.PDF');`);
  db.close();
  const storage = createStorageCoordinator({ brainPath: f.brain, stores: [], authorized: () => true });
  try {
    storage.start("odysseus"); await storage.idle(); const id = storage.status("odysseus").snapshot!.id;
    const entry = storage.page("odysseus", id, { type: "pdf", largerThan: 5_000_000 }).entries[0]!;
    expect(await storage.references("odysseus", id, entry.id), "STORAGE_SUPPORTED_REFERENCE_EVIDENCE").toMatchObject({ state: "observed", sources: [{ path: "notes/voyage.md", indexedAt: "2026-07-12T00:00:00Z" }], freshness: "unchecked" });
  } finally { await storage.close(); f.close(); }
});

test("a partial refresh preserves complete evidence, signed cursors expire, and shutdown drops cached data", async () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(Date, "now")!;
  const realNow = Date.now; let offset = 0, unavailable = false;
  for (let index = 0; index < 205; index++) writeFileSync(join(f.brain, `chart-${index}.txt`), "Odysseus");
  const storage = createStorageCoordinator({ brainPath: f.brain, stores: [], authorized: () => true, storesNow: () => ({ stores: [], unavailable: unavailable ? [{ label: "Unknown store", owner: "app", category: "temporary", reason: "unavailable" }] : [] }) });
  try {
    Object.defineProperty(Date, "now", { ...descriptor, value: () => realNow() + offset });
    storage.start("odysseus"); await storage.idle(); const first = storage.status("odysseus").snapshot!;
    expect(first.coverage).toBe("complete");
    const page = storage.page("odysseus", first.id, {}); expect(page.nextCursor).not.toBeNull();
    offset = 6000; unavailable = true; storage.start("odysseus"); await storage.idle();
    expect(storage.status("odysseus").snapshot?.id, "STORAGE_PARTIAL_PRESERVES_COMPLETE").toBe(first.id);
    expect(storage.status("odysseus").previous?.coverage).toBe("partial");
    offset = 62_000;
    expect(() => storage.page("odysseus", first.id, { cursor: page.nextCursor! }), "STORAGE_CURSOR_EXPIRY").toThrow("expired");
    offset = 610_000;
    expect(storage.status("odysseus").snapshot, "STORAGE_CACHE_EXPIRY").toBeNull();
    await storage.close(); expect(() => storage.start("odysseus")).toThrow("shutting down");
  } finally { Object.defineProperty(Date, "now", descriptor); await storage.close(); f.close(); }
});

test("in-tree Git metadata has its own ownership row without running repository code", async () => {
  const f = fixture(); mkdirSync(join(f.brain, ".git")); mkdirSync(join(f.brain, ".git", "objects"));
  writeFileSync(join(f.brain, ".git", "config"), "[include]\npath = /unapproved-host-config\n");
  try {
    const result = await collectStorage({ brainPath: f.brain, salt: "odysseus", stores: [] }, "git-metadata", new AbortController().signal);
    const git = result.summary.roots.find(root => root.category === "git");
    expect(git, "STORAGE_GIT_OWNER_CATEGORY").toBeDefined();
    expect(result.entries.find(entry => entry.name === "config")?.rootId).toBe(git!.id);
    expect(result.summary.errors).toEqual([]);
  } finally { f.close(); }
});

test("directory metadata does not erase known regular-file logical totals", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-logical-"));
  mkdirSync(join(root, ".brain", "scratch"), { recursive: true });
  writeFileSync(join(root, ".brain", "scratch", "chart.txt"), "Ithaca map");
  linkSync(join(root, ".brain", "scratch", "chart.txt"), join(root, ".brain", "scratch", "alias.txt"));
  try {
    const result = await collectStorage({ brainPath: root, stores: [], salt: "odysseus" }, "logical-union", new AbortController().signal);
    expect(result.summary.roots.find(value => value.category === "scratch")?.logical, "STORAGE_FILE_UNION_EXCLUDES_DIRECTORY_METADATA").toBe(10);
    expect(result.summary.totals.brain.logical).toBe(10);
    expect(result.summary.roots.find(value => value.category === "content")?.logical).toBe(0);
    expect(result.summary.totals.all.coverage).toBe("complete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
