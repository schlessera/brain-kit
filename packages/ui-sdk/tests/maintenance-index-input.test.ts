import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMaintenanceIndex } from "../src/server/maintenance-index-input.js";
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "maintenance-index-test-"));
  mkdirSync(join(root, ".brain-index"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function inherited(run: () => void) {
  const getuid = process.getuid!; process.getuid = () => getuid() + 1;
  try { run(); } finally { process.getuid = getuid; }
}
describe("fixed disposable index preparation", () => {
  test("inherited file copy replaces inode, preserves bytes/modes and remains SQLite writable", () => fixture(root => {
    const path = join(root, ".brain-index", "brain.db"), db = new Database(path);
    db.run("CREATE TABLE odysseus(value INTEGER)"); db.run("INSERT INTO odysseus VALUES (11)"); db.close();
    for (const mode of [0o600, 0o640, 0o644]) {
      chmodSync(path, mode); const before = lstatSync(path), bytes = readFileSync(path);
      inherited(() => prepareMaintenanceIndex(root, 1024 ** 2));
      expect(lstatSync(path).ino, "INHERITED_INDEX_IS_COPIED_UP").not.toBe(before.ino);
      expect(lstatSync(path).mode & 0o777).toBe(mode); expect(readFileSync(path)).toEqual(bytes);
      const copy = new Database(path); expect(copy.query("SELECT value FROM odysseus").get()).toEqual({ value: 11 });
      copy.run("CREATE TABLE IF NOT EXISTS worker_write(value TEXT)"); copy.close();
    }
  }));
  test("preserves committed WAL rows with retained and rebuilt SHM", () => fixture(root => {
    const source = join(root, "source"); mkdirSync(join(source, ".brain-index"), { recursive: true }); const db = new Database(join(source, ".brain-index", "brain.db"));
    try {
      db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA wal_autocheckpoint=0");
      db.run("CREATE TABLE odysseus(value INTEGER)"); db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.run("INSERT INTO odysseus VALUES(11),(22),(33)");
      for (const omitShm of [false, true]) {
        const stage = join(root, omitShm ? "rebuild-shm" : "retain-shm"); mkdirSync(join(stage, ".brain-index"), { recursive: true });
        // The source connection is idle, with no transaction; this freezes a
        // complete family before the production preparer touches that copy.
        for (const suffix of ["", "-wal", "-shm"]) if (!(omitShm && suffix === "-shm") && existsSync(join(source, ".brain-index", `brain.db${suffix}`)))
          copyFileSync(join(source, ".brain-index", `brain.db${suffix}`), join(stage, ".brain-index", `brain.db${suffix}`));
        const admitted = ["", "-wal", ...(omitShm ? [] : ["-shm"])].map(suffix => {
          const path = join(stage, ".brain-index", `brain.db${suffix}`); return { path, name: `brain.db${suffix}`, info: lstatSync(path), bytes: readFileSync(path) };
        });
        inherited(() => prepareMaintenanceIndex(stage, 1024 ** 2));
        for (const member of admitted) {
          expect(lstatSync(member.path).ino, `INHERITED_INDEX_MEMBER_IS_COPIED_${member.name}`).not.toBe(member.info.ino);
          expect(lstatSync(member.path).mode & 0o777).toBe(member.info.mode & 0o777);
          expect(readFileSync(member.path)).toEqual(member.bytes);
        }
        const copy = new Database(join(stage, ".brain-index", "brain.db"));
        try {
          expect(copy.query("SELECT count(*) AS count, sum(value) AS sum FROM odysseus").get(), "COMMITTED_WAL_ROWS_SURVIVE").toEqual({ count: 3, sum: 66 });
          expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          copy.run("CREATE TABLE worker_write(value TEXT)");
        } finally { copy.close(); }
      }
    } finally { db.close(); }
  }));
  test("recovers an actual killed writer's hot rollback journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-index-rollback-"));
    mkdirSync(join(root, ".brain-index"));
    const code = `import {Database} from "bun:sqlite";
const db=new Database(process.argv[1]);db.run("PRAGMA journal_mode=DELETE");db.run("PRAGMA cache_size=5");
db.run("CREATE TABLE odysseus(value INTEGER,padding TEXT)");const insert=db.prepare("INSERT INTO odysseus VALUES(1,?)");
db.transaction(()=>{for(let i=0;i<300;i++)insert.run("x".repeat(4000));})();
db.run("BEGIN IMMEDIATE");db.run("UPDATE odysseus SET value=999");console.log("READY");setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", code, join(root, ".brain-index", "brain.db")], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("ROLLBACK_WRITER_READY_TIMEOUT")), 5000); })]);
      expect(new TextDecoder().decode(first.value)).toContain("READY");
      child.kill("SIGKILL"); await child.exited;
      expect(lstatSync(join(root, ".brain-index", "brain.db-journal")).size).toBeGreaterThan(0);
      const journal = join(root, ".brain-index", "brain.db-journal"), journalInfo = lstatSync(journal), journalBytes = readFileSync(journal);
      inherited(() => prepareMaintenanceIndex(root, 4 * 1024 ** 2));
      expect(lstatSync(journal).ino, "HOT_ROLLBACK_JOURNAL_IS_COPIED").not.toBe(journalInfo.ino);
      expect(lstatSync(journal).mode & 0o777).toBe(journalInfo.mode & 0o777); expect(readFileSync(journal)).toEqual(journalBytes);
      const copy = new Database(join(root, ".brain-index", "brain.db"));
      try {
        expect(copy.query("SELECT count(*) AS count, sum(value) AS sum FROM odysseus").get(), "HOT_ROLLBACK_ROWS_RECOVER").toEqual({ count: 300, sum: 300 });
        expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        copy.run("CREATE TABLE worker_write(value TEXT)");
      } finally { copy.close(); }
    } finally {
      if (timer) clearTimeout(timer); child.kill("SIGKILL"); await child.exited;
      await reader.cancel(); await new Response(child.stderr).text(); rmSync(root, { recursive: true, force: true });
    }
  });
  test("owned family is checked without replacing the database", () => fixture(root => {
    const path = join(root, ".brain-index", "brain.db"); writeFileSync(path, "Odysseus index"); const before = lstatSync(path);
    prepareMaintenanceIndex(root, 4096); expect(lstatSync(path).ino).toBe(before.ino);
  }));
  test("refuses alias, hardlink, readonly, oversized and orphan members before replacement", () => {
    for (const kind of ["symlink", "hardlink", "readonly", "oversized", "orphan"] as const) fixture(root => {
      const path = join(root, ".brain-index", "brain.db"); writeFileSync(path, "Odysseus index");
      const bytes = readFileSync(path), before = lstatSync(path);
      if (kind === "symlink") symlinkSync("brain.db", join(root, ".brain-index", "brain.db-wal"));
      if (kind === "hardlink") linkSync(path, join(root, ".brain-index", "brain.db-wal"));
      if (kind === "readonly") chmodSync(path, 0o400);
      if (kind === "oversized") writeFileSync(join(root, ".brain-index", "brain.db-wal"), Buffer.alloc(4096));
      if (kind === "orphan") { rmSync(path); writeFileSync(join(root, ".brain-index", "brain.db-wal"), "Odysseus orphan"); }
      expect(() => inherited(() => prepareMaintenanceIndex(root, 4096)), kind).toThrow();
      if (kind !== "orphan") { expect(lstatSync(path).ino).toBe(before.ino); expect(readFileSync(path)).toEqual(bytes); }
    });
  });
  test("a stage without the index directory has nothing to prepare and creates nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-index-absent-"));
    try {
      inherited(() => prepareMaintenanceIndex(root, 4096));
      expect(existsSync(join(root, ".brain-index")), "ABSENT_INDEX_DIRECTORY_NOT_CREATED").toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a root-level legacy family is not the index and is never copied up", () => fixture(root => {
    writeFileSync(join(root, "brain.db"), "legacy Odysseus index"); const before = lstatSync(join(root, "brain.db"));
    writeFileSync(join(root, ".brain-index", "brain.db"), "Odysseus index"); const current = lstatSync(join(root, ".brain-index", "brain.db"));
    inherited(() => prepareMaintenanceIndex(root, 4096));
    expect(lstatSync(join(root, "brain.db")).ino, "LEGACY_ROOT_INDEX_UNTOUCHED").toBe(before.ino);
    expect(lstatSync(join(root, ".brain-index", "brain.db")).ino, "DIRECTORY_INDEX_COPIED_UP").not.toBe(current.ino);
  }));
  test("an index directory alias is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-index-alias-"));
    try {
      mkdirSync(join(root, "elsewhere")); symlinkSync("elsewhere", join(root, ".brain-index"));
      expect(() => inherited(() => prepareMaintenanceIndex(root, 4096)), "INDEX_DIRECTORY_ALIAS_REFUSED").toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("an index directory the worker cannot write reports its own error, not a cleanup ENOENT", () => fixture(root => {
    writeFileSync(join(root, ".brain-index", "brain.db"), "Odysseus index"); chmodSync(join(root, ".brain-index"), 0o555);
    try {
      expect(() => inherited(() => prepareMaintenanceIndex(root, 4096)), "UNWRITABLE_INDEX_DIRECTORY_ERROR_PRESERVED").toThrow(/EACCES/);
    } finally { chmodSync(join(root, ".brain-index"), 0o755); }
  }));
  test("rejects super-journal trailer without following its name", () => fixture(root => {
    writeFileSync(join(root, ".brain-index", "brain.db"), "Odysseus index");
    const tail = Buffer.alloc(16); tail.writeUInt32BE(56); Buffer.from("d9d505f920a163d7", "hex").copy(tail, 8);
    writeFileSync(join(root, ".brain-index", "brain.db-journal"), Buffer.concat([Buffer.alloc(56), tail]));
    expect(() => inherited(() => prepareMaintenanceIndex(root, 4096))).toThrow("Attached-database");
  }));
});
