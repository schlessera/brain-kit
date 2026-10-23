/**
 * A directory-backed stand-in for the native reference pool (#2429). It keeps
 * the manager's observable contract: roots live in `roots/` until published,
 * publication moves a sealed root into its view once and swaps one name by
 * rename, and release removes a root's names first. Btrfs allocation, quotas
 * and read-only roots are qualified by the native pool proof, not here.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NativeBrainManagerError, type NativePoolRecord, type NativePoolStatus } from "@schlessera/brain-ui-sdk/internal";
import type { ReferencePool } from "../../src/brain/reference-source";

export interface PoolEvent { at: number; operation: string; id?: string; view?: string; name?: string }

export function referencePoolDouble(root: string, options: { capacityRoots?: number; operationBytes?: number } = {}) {
  const roots = join(root, "roots"), views = join(root, "views");
  mkdirSync(roots, { recursive: true }); mkdirSync(views, { recursive: true });
  const records = new Map<string, NativePoolRecord>();
  const events: PoolEvent[] = [];
  let clock = 0;
  const note = (event: Omit<PoolEvent, "at">) => events.push({ at: ++clock, ...event });
  const location = (record: NativePoolRecord) => record.view ? join(views, record.view, record.id) : join(roots, record.id);
  const live = () => [...records.values()].filter(record => record.state === "writable" || record.state === "sealed");
  const fail = (code: ConstructorParameters<typeof NativeBrainManagerError>[0], message: string) => { throw new NativeBrainManagerError(code, message); };
  const pool: ReferencePool & { records: typeof records; events: PoolEvent[]; capacityRoots: number } = {
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
      const record: NativePoolRecord = { id, purpose, from, allowanceBytes, state: "writable", root: { rootId: String(256 + records.size), uuid: "a".repeat(32), otransid: "1" },
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
  };
  return pool;
}
