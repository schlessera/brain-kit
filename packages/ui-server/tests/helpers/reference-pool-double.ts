/**
 * A directory-backed stand-in for the native reference pool (#2429). It keeps
 * the manager's observable contract: roots live in `roots/` until published,
 * publication moves a sealed root into its view once and swaps one name by
 * rename, and release removes a root's names first. Btrfs allocation, quotas
 * and read-only roots are qualified by the native pool proof, not here.
 * Worktree checkpoints (#2430) are timestamp-preserving copies whose deltas use
 * the journal fixture's send encoder; access generations are directories a
 * worktree is renamed into and out of.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NativeBrainManagerError, type NativePoolCheckpoint, type NativePoolRecord, type NativePoolStatus } from "@schlessera/brain-ui-sdk/internal";
import type { ReferencePool } from "../../src/brain/reference-source";
import type { ReferenceWorktreePool } from "../../src/brain/reference-worktrees";
import { fixtureDelta, inventory, type Entry } from "./native-journal-fixture";

export interface PoolEvent { at: number; operation: string; id?: string; view?: string; name?: string }

export function referencePoolDouble(root: string, options: { capacityRoots?: number; operationBytes?: number } = {}) {
  const roots = join(root, "roots"), views = join(root, "views"), access = join(root, "access");
  mkdirSync(roots, { recursive: true }); mkdirSync(views, { recursive: true }); mkdirSync(access, { recursive: true });
  const checkpoints = new Map<string, { entries: Map<string, Entry>; transaction: string }>();
  // Copies lack Btrfs inode lineage: reserve each checkpoint file's inode so a
  // later copy cannot reuse it and manufacture a hardlink candidate.
  const pins = join(root, "inode-pins"); mkdirSync(pins, { recursive: true });
  let transactions = 0, pinned = 0;
  const records = new Map<string, NativePoolRecord>();
  const events: PoolEvent[] = [];
  let clock = 0;
  const note = (event: Omit<PoolEvent, "at">) => events.push({ at: ++clock, ...event });
  const location = (record: NativePoolRecord) => record.access ? join(access, record.access, record.id) : record.view ? join(views, record.view, record.id) : join(roots, record.id);
  const live = () => [...records.values()].filter(record => record.state === "writable" || record.state === "sealed");
  const fail = (code: ConstructorParameters<typeof NativeBrainManagerError>[0], message: string) => { throw new NativeBrainManagerError(code, message); };
  const checkpointRecord = (record: NativePoolRecord): NativePoolCheckpoint =>
    ({ ...record, purpose: "checkpoint", state: "sealed", transaction: checkpoints.get(record.id)!.transaction, readOnly: true });
  const pool: ReferencePool & ReferenceWorktreePool & { records: typeof records; events: PoolEvent[]; capacityRoots: number } = {
    records, events, capacityRoots: options.capacityRoots ?? 64,
    async poolStatus() {
      return { qualified: true, refusal: null, fsid: "00000000-0000-4000-8000-000000002429",
        limits: { combinedBytes: 64 * 1024 ** 2, operationBytes: options.operationBytes ?? 8 * 1024 ** 2, emergencyBytes: 4096, physicalFloorBytes: 4096, maxIdentities: 4096 },
        accounting: null, physical: null, counts: { reserved: 0, writable: 0, sealed: 0, deleting: 0, deleted: 0, reclaimed: 0 }, identities: records.size } as NativePoolStatus;
    },
    async poolCreate(id, purpose, from, allowanceBytes) {
      note({ operation: "create", id });
      const existing = records.get(id);
      if (existing && ["deleting", "deleted", "reclaimed"].includes(existing.state)) fail("released", "This reference pool identity was released; it cannot be recreated.");
      if (existing) return existing;
      if (live().length >= pool.capacityRoots) fail("capacity", "Reference pool combined allowance cannot reserve its allowance; nothing was admitted.");
      const record: NativePoolRecord = { id, purpose, from, allowanceBytes, state: "writable", root: { rootId: String(256 + records.size), uuid: createHash("sha256").update(id).digest("hex").slice(0, 32), otransid: "1" },
        path: join(roots, id), ownerBytes: 0, reason: null, view: null, access: null };
      if (from) { const source = records.get(from); if (!source || source.state !== "sealed") fail("unknown", "A reference snapshot requires one retained sealed pool root."); cpSync(location(source!), record.path!, { recursive: true, verbatimSymlinks: true }); }
      else mkdirSync(record.path!);
      records.set(id, record);
      return record;
    },
    async poolSeal(id) {
      const record = records.get(id);
      if (!record || record.state !== "writable") fail("released", "Only a writable reference pool root can be sealed.");
      note({ operation: "seal", id });
      record!.state = "sealed";
      return record!;
    },
    async poolPublish(id, view, name) {
      const record = records.get(id);
      if (!record || record.purpose !== "source") fail("unknown", "Only a recorded reference source root can be published.");
      if (record!.state !== "sealed") fail("invalid", "Only a sealed reference source root can be published.");
      if (record!.view && record!.view !== view) fail("invalid", "A published reference root belongs to exactly one view.");
      mkdirSync(join(views, view), { recursive: true });
      if (!record!.view) { renameSync(join(roots, id), join(views, view, id)); record!.view = view; record!.path = location(record!); }
      const temporary = join(views, view, `.${name}.${id}`);
      symlinkSync(id, temporary); renameSync(temporary, join(views, view, name));
      note({ operation: "publish", id, view, name });
      return record!;
    },
    async poolUnpublish(view, name) {
      const path = join(views, view, name);
      let removed = false;
      try { if (lstatSync(path).isSymbolicLink()) { unlinkSync(path); removed = true; } } catch { /* absent */ }
      note({ operation: "unpublish", view, name });
      return { view, name, removed };
    },
    async poolWithdraw(id) {
      const record = records.get(id);
      if (!record || record.purpose !== "source") fail("unknown", "Only a recorded reference source root can be withdrawn.");
      note({ operation: "withdraw", id });
      if (!record!.view) return record!;
      for (const entry of readdirSync(join(views, record!.view))) {
        const path = join(views, record!.view, entry);
        if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === id) unlinkSync(path);
      }
      renameSync(location(record!), join(roots, id));
      record!.view = null; record!.path = join(roots, id);
      return record!;
    },
    async poolRelease(id) {
      const record = records.get(id);
      note({ operation: "release", id });
      if (!record) {
        // Like the manager, fence an identity whose create never recorded anything.
        const fenced: NativePoolRecord = { id, purpose: "source", from: null, allowanceBytes: 4096, state: "deleted", root: null, path: null, ownerBytes: 0, reason: "Released before any reservation was recorded.", view: null, access: null };
        records.set(id, fenced);
        return fenced;
      }
      if (record!.view && existsSync(join(views, record!.view)))
        for (const entry of readdirSync(join(views, record!.view))) {
          const path = join(views, record!.view, entry);
          if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === id) unlinkSync(path);
        }
      rmSync(location(record!), { recursive: true, force: true });
      record!.state = "reclaimed"; record!.path = null;
      return record!;
    },
    async listPoolRecovery() { return { records: [...records.values()], next: null }; },
    async poolCheckpoint(id, from) {
      note({ operation: "checkpoint", id });
      const existing = records.get(id);
      if (existing?.state === "sealed" && existing.from === from) return checkpointRecord(existing);
      if (existing) fail("released", "This reference pool identity was released; it cannot be recreated.");
      const worktree = records.get(from);
      if (!worktree || worktree.purpose !== "worktree" || worktree.state !== "writable") fail("unknown", "A worktree checkpoint requires one retained writable worktree root.");
      const path = join(roots, id);
      cpSync(location(worktree!), path, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      const entries = inventory(path);
      for (const [relative, entry] of entries) if (entry.kind === "file") linkSync(join(path, relative), join(pins, String(++pinned)));
      checkpoints.set(id, { entries, transaction: String(++transactions) });
      const record: NativePoolRecord = { id, purpose: "checkpoint", from, allowanceBytes: 1024 * 1024, state: "sealed",
        root: { rootId: String(256 + records.size), uuid: createHash("sha256").update(id).digest("hex").slice(0, 32), otransid: "1" }, path, ownerBytes: 0, reason: null, view: null, access: null };
      records.set(id, record);
      return checkpointRecord(record);
    },
    async poolDelta(from, to) {
      note({ operation: "delta", id: to });
      const before = records.get(from), after = records.get(to);
      if (before?.purpose !== "checkpoint" || after?.purpose !== "checkpoint" || before.state !== "sealed" || after.state !== "sealed") fail("unknown", "Worktree checkpoint reading requires one retained sealed checkpoint identity.");
      if (before!.from !== after!.from) fail("invalid", "A worktree delta compares two checkpoints of the same worktree.");
      return fixtureDelta({ uuid: before!.root!.uuid, transaction: checkpoints.get(from)!.transaction, entries: checkpoints.get(from)!.entries },
        { uuid: after!.root!.uuid, transaction: checkpoints.get(to)!.transaction, entries: checkpoints.get(to)!.entries }, to);
    },
    async poolAccessOpen(generation) {
      note({ operation: "access-open", id: generation });
      mkdirSync(join(access, generation), { recursive: true });
      return { access: generation, path: join(access, generation), roots: [...records.values()].filter(record => record.access === generation).map(record => record.id) };
    },
    async poolAccess(id, generation) {
      const record = records.get(id);
      if (!record || record.purpose !== "worktree") fail("unknown", "Only a recorded worktree root can be made accessible.");
      if (record!.state !== "writable") fail("released", "Only a writable worktree can be made accessible.");
      if (record!.access === generation) return record!;
      if (record!.access) fail("invalid", "This worktree is held by another access generation; park it first.");
      if (!existsSync(join(access, generation))) fail("unavailable", "This access generation is not open.");
      note({ operation: "access", id, view: generation });
      renameSync(location(record!), join(access, generation, id));
      record!.access = generation; record!.path = location(record!);
      return record!;
    },
    async poolPark(id) {
      const record = records.get(id);
      if (!record || record.purpose !== "worktree") fail("unknown", "Only a recorded worktree root can be parked.");
      if (!record!.access) return record!;
      note({ operation: "park", id });
      renameSync(location(record!), join(roots, id));
      record!.access = null; record!.path = location(record!);
      return record!;
    },
    async poolAccessClose(generation) {
      note({ operation: "access-close", id: generation });
      const held = [...records.values()].filter(record => record.access === generation && record.state === "writable").map(record => record.id);
      for (const id of held) await pool.poolPark(id);
      if (existsSync(join(access, generation))) rmdirSync(join(access, generation));
      return { access: generation, path: join(access, generation), roots: held };
    },
  };
  return pool;
}
