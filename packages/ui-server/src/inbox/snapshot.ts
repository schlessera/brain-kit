/** Complete operational backup. Content Markdown and brain.db are never opened. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { pauseRestoredSchedules, validateScheduleRelations } from "../schedules/recovery.js";
import { inboxItemSchema, v1ResolutionEffectSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../db/client.js";
import { createInboxStore } from "./store.js";
import { failInboxWork, inboxIdentity } from "./actions.js";
import { settleInboxBudgetRun } from "./budget.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bytesSchema = z.object({ data: z.string(), sha256: digestSchema }).strict();
const snapshotSchema = z.object({
  format: z.literal("brain-ui-operational-backup"), version: z.literal(1),
  createdAt: z.number().int().nonnegative().safe(), recoveryPointHours: z.literal(24),
  database: bytesSchema,
  directories: z.array(z.string()),
  files: z.array(bytesSchema.extend({ path: z.string() }).strict()),
  checksum: digestSchema,
}).strict();
export type InboxBackup = z.infer<typeof snapshotSchema>;
const ID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const directoryPattern = new RegExp(`^(?:${ID}|\\.${ID}\\.partial)$`);

function decode(value: z.infer<typeof bytesSchema>): Buffer {
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data || hash(bytes) !== value.sha256)
    throw new Error("inbox_snapshot_checksum");
  return bytes;
}
function encode(bytes: Uint8Array): z.infer<typeof bytesSchema> {
  return { data: Buffer.from(bytes).toString("base64"), sha256: hash(bytes) };
}
function image(db: Database): Buffer {
  const bytes = db.transaction(() => db.serialize())();
  // sqlite3_deserialize cannot open WAL images. Normalize only this copy, as
  // documented by https://www.sqlite.org/c3ref/deserialize.html; live WAL stays intact.
  bytes[18] = bytes[19] = 1;
  return bytes;
}
function schema(db: Database): unknown[] {
  return db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}
function logicalState(db: Database): unknown[] {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'inbox_recovery_state' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}
function validateDatabase(db: Database): void {
  const expected = createUiDb(":memory:");
  try {
    if (JSON.stringify(schema(db)) !== JSON.stringify(schema(expected)) ||
        JSON.stringify(db.query("SELECT filename FROM _migrations ORDER BY filename").all()) !==
        JSON.stringify(expected.query("SELECT filename FROM _migrations ORDER BY filename").all()))
      throw new Error("inbox_snapshot_schema");
  } finally { expected.close(); }
  if (JSON.stringify(db.query("PRAGMA integrity_check").all()) !== '[{"integrity_check":"ok"}]' ||
      db.query("PRAGMA foreign_key_check").all().length)
    throw new Error("inbox_snapshot_relations");
  const store = createInboxStore(db), state = store.exportState();
  store.snapshot();
  const items = new Map(state.inbox_items.map(row => [row.id, inboxItemSchema.parse(JSON.parse(row.data_json as string))]));
  for (const row of state.inbox_items) {
    const item = items.get(row.id)!;
    const pairs = { id: item.id, thread_id: item.threadId, dedup_key: item.dedupKey,
      queue: item.queue, type: item.type, status: item.status, version: item.version,
      expires_at: item.expiresAt, wait_until: item.waitUntil ?? null, run_id: item.runId ?? null,
      ...(item.queue === "queue" ? { attempts: item.attempts, max_attempts: item.maxAttempts,
        claimed_at: item.claimedAt ?? null, lease_until: item.leaseUntil ?? null, blocked_by_item_id: item.blockedByItemId ?? null } : {}) };
    if (Object.entries(pairs).some(([key, value]) => row[key] !== value)) throw new Error("inbox_snapshot_projection");
    if (item.queue === "queue" && item.status === "blocked") {
      const blocker = items.get(item.blockedByItemId!);
      if (!blocker || blocker.queue !== "actions" || blocker.type === "fyi" ||
          blocker.threadId !== item.threadId || !["pending", "snoozed"].includes(blocker.status))
        throw new Error("inbox_snapshot_relations");
    }
    if (row.deleted_at === null && item.queue === "queue" && item.type !== "cleanup_pending" && item.status === "claimed" &&
        !state.inbox_budget_reservations.some(r => r.run_id === item.runId && r.status === "active"))
      throw new Error("inbox_snapshot_reservation");
  }
  for (const row of state.inbox_action_contexts) {
    const action = items.get(row.item_id);
    if (!action || action.queue !== "actions" || JSON.stringify(action.options) !== row.options_json)
      throw new Error("inbox_snapshot_relations");
  }
  for (const row of state.inbox_resolutions) {
    const action = items.get(row.item_id);
    const effect = v1ResolutionEffectSchema.parse(JSON.parse(row.effect_json as string));
    if (!action || action.queue !== "actions" || !["resolved", "dismissed"].includes(action.status) ||
        JSON.stringify(action.options.find(o => o.id === row.option_id)?.effect) !== JSON.stringify(effect))
      throw new Error("inbox_snapshot_relations");
    if (effect.kind === "enqueue") {
      const id = inboxIdentity("follow-up", action.id, row.option_id as string), followUp = items.get(id);
      if (!followUp || followUp.dedupKey !== id || followUp.threadId !== action.threadId ||
          followUp.queue !== "queue" || followUp.type !== "execute" || JSON.stringify(followUp.payload) !== JSON.stringify(effect.payload))
        throw new Error("inbox_snapshot_relations");
    }
  }
  for (const item of items.values()) {
    if (item.queue === "actions" && item.type !== "fyi" && ["resolved", "dismissed"].includes(item.status) &&
        !state.inbox_resolutions.some(row => row.item_id === item.id)) throw new Error("inbox_snapshot_relations");
  }
  for (const row of state.inbox_budget_reservations) {
    if (row.status === "active" && row.run_id && state.inbox_budget_reservations.filter(r => r.run_id === row.run_id).length !== 1)
      throw new Error("inbox_snapshot_reservation");
  }
  const counters = db.query("SELECT thread_id, MAX(seq) AS seq FROM inbox_changes GROUP BY thread_id ORDER BY thread_id").all();
  if (JSON.stringify(counters) !== JSON.stringify(db.query("SELECT thread_id, seq FROM inbox_thread_sequences ORDER BY thread_id").all()))
    throw new Error("inbox_snapshot_relations");
  validateScheduleRelations(db);
}
function requiredStaging(db: Database): Set<string> {
  const state = createInboxStore(db).exportState(), active = new Set<string>();
  for (const row of state.inbox_items) {
    const item = inboxItemSchema.parse(JSON.parse(row.data_json as string));
    if (row.deleted_at === null && (item.queue === "queue" && item.type !== "cleanup_pending" &&
        ["scheduled", "ready", "claimed", "blocked", "failed"].includes(item.status) ||
        item.queue === "actions" && item.type !== "fyi" && ["pending", "snoozed"].includes(item.status))) active.add(item.threadId);
  }
  const ids = new Set<string>();
  for (const row of state.inbox_items) {
    const item = inboxItemSchema.parse(JSON.parse(row.data_json as string));
    if (item.queue === "queue" && item.type === "triage" && active.has(item.threadId)) ids.add(item.payload.stagingId);
  }
  return ids;
}
async function stagingRoot(brainRoot: string): Promise<string> {
  const brain = await realpath(brainRoot), parent = join(brain, ".brain-ui");
  try { if (await realpath(parent) !== parent) throw new Error("inbox_staging_symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const root = join(brain, SHARE_STAGING_DIR);
  try { if (await realpath(root) !== root) throw new Error("inbox_staging_symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return root;
}
async function readRegular(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("inbox_staging_file");
    const bytes = await file.readFile(), after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size)
      throw new Error("inbox_snapshot_changed");
    return bytes;
  } finally { await file.close(); }
}
async function collect(root: string): Promise<Pick<InboxBackup, "directories" | "files">> {
  let directories: string[];
  try { directories = (await readdir(root)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directories: [], files: [] }; throw error; }
  const files: InboxBackup["files"] = [];
  for (const directory of directories) {
    const dir = join(root, directory);
    if (!directoryPattern.test(directory) || !(await lstat(dir)).isDirectory() || await realpath(dir) !== dir)
      throw new Error("inbox_staging_directory");
    for (const name of (await readdir(dir)).sort()) files.push({ ...encode(await readRegular(join(dir, name))), path: `${directory}/${name}` });
  }
  return { directories, files };
}
function checkStaging(db: Database, staging: Pick<InboxBackup, "directories" | "files">): void {
  const paths = new Set<string>();
  if (new Set(staging.directories).size !== staging.directories.length || staging.directories.some(d => !directoryPattern.test(d)))
    throw new Error("inbox_snapshot_staging");
  if (JSON.stringify(staging.directories) !== JSON.stringify([...staging.directories].sort()) ||
      JSON.stringify(staging.files.map(f => f.path)) !== JSON.stringify(staging.files.map(f => f.path).sort()))
    throw new Error("inbox_snapshot_staging");
  for (const file of staging.files) {
    const [dir, name, extra] = file.path.split("/");
    if (!staging.directories.includes(dir) || !name || name === "." || name === ".." || extra !== undefined ||
        name.includes("\\") || name.includes("\u0000") || paths.has(file.path)) throw new Error("inbox_snapshot_staging");
    paths.add(file.path); decode(file);
  }
  for (const id of requiredStaging(db)) {
    const meta = staging.files.find(f => f.path === `${id}/meta.json`);
    if (!staging.directories.includes(id) || !meta) throw new Error("inbox_snapshot_missing_staging");
    const manifest = JSON.parse(decode(meta).toString("utf8")) as { id: string; dir: string; files: { name: string; path: string; bytes: number }[] };
    if (manifest.id !== id || manifest.dir !== `${SHARE_STAGING_DIR}/${id}` || !Array.isArray(manifest.files) ||
        manifest.files.some(f => {
          const file = staging.files.find(entry => entry.path === `${id}/${f.name}`);
          return !file || f.name !== basename(f.name) || f.path !== `${manifest.dir}/${f.name}` || decode(file).length !== f.bytes;
        })) throw new Error("inbox_snapshot_missing_staging");
  }
}
export async function exportInboxSnapshot(db: Database, brainRoot: string, at = Date.now()): Promise<InboxBackup> {
  assertInboxRecoveryReady(db);
  const database = image(db), copy = Database.deserialize(database);
  try {
    validateDatabase(copy);
    const root = await stagingRoot(brainRoot), staging = await collect(root);
    checkStaging(copy, staging);
    // Do not hold SQLite's write lock over filesystem I/O. Changed input fails
    // visibly and the daily host can retry without publishing a partial backup.
    if (hash(image(db)) !== hash(database) || JSON.stringify(await collect(root)) !== JSON.stringify(staging))
      throw new Error("inbox_snapshot_changed");
    const body = snapshotSchema.omit({ checksum: true }).parse({
      format: "brain-ui-operational-backup", version: 1, createdAt: at,
      recoveryPointHours: 24, database: encode(database), ...staging });
    return snapshotSchema.parse({ ...body, checksum: hash(JSON.stringify(body)) });
  } finally { copy.close(); }
}
function validateSnapshot(input: unknown): { snapshot: InboxBackup; db: Database } {
  if (typeof input === "object" && input !== null && "version" in input && input.version !== 1)
    throw new Error("inbox_snapshot_version");
  const snapshot = snapshotSchema.parse(input), { checksum, ...body } = snapshot;
  if (hash(JSON.stringify(body)) !== checksum) throw new Error("inbox_snapshot_checksum");
  const db = Database.deserialize(decode(snapshot.database));
  try { validateDatabase(db); assertInboxRecoveryReady(db); checkStaging(db, snapshot); return { snapshot, db }; }
  catch (error) { db.close(); throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function publish(path: string, bytes: Uint8Array, replace: boolean): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.partial`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
export async function writeInboxSnapshot(db: Database, brainRoot: string, path: string): Promise<InboxBackup> {
  // Rename addresses the final directory entry, so canonicalize its parent
  // without following the destination's final symlink. Protect both the
  // source entry and its physical database when the source itself is a link.
  const requested = resolve(path), sourcePath = resolve(db.filename), staging = await stagingRoot(brainRoot);
  const target = join(await realpath(dirname(requested)), basename(requested));
  const sources = [join(await realpath(dirname(sourcePath)), basename(sourcePath)), await realpath(sourcePath)];
  if (sources.flatMap(source => [source, `${source}-wal`, `${source}-shm`, `${source}-journal`]).includes(target) ||
      target === staging || target.startsWith(staging + sep))
    throw new Error("inbox_snapshot_destination");
  const snapshot = await exportInboxSnapshot(db, brainRoot);
  await publish(target, Buffer.from(JSON.stringify(snapshot) + "\n"), true);
  return snapshot;
}
export async function restoreInboxSnapshot(input: unknown, dbPath: string, brainRoot: string, at = Date.now()): Promise<{ recovered: number; resumed: boolean }> {
  const checked = validateSnapshot(input), { snapshot } = checked;
  let db = checked.db, resumed = false;
  try {
    const root = await stagingRoot(brainRoot), brain = await realpath(brainRoot), target = resolve(dbPath);
    if (at < snapshot.createdAt) throw new Error("inbox_restore_clock");
    try {
      if (!(await lstat(target)).isFile()) throw new Error("inbox_restore_nonempty");
      const existing = new Database(target, { readwrite: true });
      try {
        const state = existing.query("SELECT * FROM inbox_recovery_state WHERE id = 1").get() as { status: string; snapshot_checksum: string; brain_root: string } | null;
        if (state?.status !== "pending" || state.snapshot_checksum !== snapshot.checksum || state.brain_root !== brain)
          throw new Error("inbox_restore_nonempty");
        validateDatabase(existing);
        if (JSON.stringify(logicalState(existing)) !== JSON.stringify(logicalState(db)))
          throw new Error("inbox_restore_nonempty");
      } catch { existing.close(); throw new Error("inbox_restore_nonempty"); }
      db.close(); db = existing; resumed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try { await lstat(target + suffix); throw new Error("inbox_restore_nonempty"); }
        catch (sidecarError) { if ((sidecarError as NodeJS.ErrnoException).code !== "ENOENT") throw sidecarError; }
      }
      try { if ((await readdir(root)).length) throw new Error("inbox_restore_nonempty"); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
      db.query("INSERT INTO inbox_recovery_state VALUES (1, ?, ?, 'pending', NULL) ON CONFLICT(id) DO UPDATE SET snapshot_checksum = excluded.snapshot_checksum, brain_root = excluded.brain_root, status = 'pending', restored_at = NULL")
        .run(snapshot.checksum, brain);
      await publish(target, image(db), false);
      db.close(); db = new Database(target, { readwrite: true });
    }
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of snapshot.directories) {
      const path = join(root, directory);
      await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error("inbox_staging_symlink");
      // Only this pending restore could have produced these private temp files
      // in an initially empty staging root. Reap a crash mid-publication before
      // retrying its no-clobber write; preserve every other arriving file.
      for (const file of snapshot.files.filter(file => file.path.startsWith(directory + "/"))) {
        const prefix = `.${basename(file.path)}.`;
        for (const name of await readdir(path)) {
          if (name.startsWith(prefix) && new RegExp(`^${ID}\\.partial$`).test(name.slice(prefix.length))) {
            if (!(await lstat(join(path, name))).isFile()) throw new Error("inbox_restore_staging_changed");
            await rm(join(path, name));
          }
        }
      }
    }
    for (const file of snapshot.files) {
      const path = join(root, file.path), bytes = decode(file);
      try { await publish(path, bytes, false); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readRegular(path)) !== file.sha256) throw error;
      }
    }
    if (JSON.stringify(await collect(root)) !== JSON.stringify({ directories: snapshot.directories, files: snapshot.files }))
      throw new Error("inbox_restore_staging_changed");
    if (await stagingRoot(brainRoot) !== root) throw new Error("inbox_staging_symlink");
    await syncDirectory(root); await syncDirectory(dirname(root));
    const recovered = db.transaction(() => {
      const rows = db.query("SELECT run_id, id FROM inbox_budget_reservations WHERE status = 'active' ORDER BY id").all() as { run_id: string | null; id: string }[];
      for (const row of rows) {
        if (row.run_id) settleInboxBudgetRun(db, row.run_id, "released", at);
        else db.query("UPDATE inbox_budget_reservations SET status = 'released', charged_cost_usd = reserved_cost_usd, charged_turns = reserved_turns, settled_at = ? WHERE id = ?").run(at, row.id);
      }
      const store = createInboxStore(db, { now: () => at });
      const claims = db.query("SELECT id FROM inbox_items WHERE queue = 'queue' AND status = 'claimed' AND deleted_at IS NULL ORDER BY id").all() as { id: string }[];
      for (const row of claims) failInboxWork(db, row.id, (store.getItem(row.id) as InboxQueueItem).version, at);
      pauseRestoredSchedules(db, at);
      db.query("UPDATE inbox_recovery_state SET status = 'ready', restored_at = ? WHERE id = 1").run(at);
      return claims.length;
    }).immediate();
    return { recovered, resumed };
  } finally { db.close(); }
}
