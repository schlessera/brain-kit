/** Session-owned observations, never an authority supplied by a tool argument. */
import { createHash } from "node:crypto";
import { loadNativeObservations, saveNativeObservations, type NativeObservationStorage } from "./native-observation-storage.js";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type NativeFileVersion = { status: "known"; hash: string } | { status: "missing" } | { status: "unavailable" };
export const STALE_NATIVE_WRITE = "File changed since you read it; read it again before writing. Nothing was written.";

/** Callers select a trusted actual-view path; never follows a final symlink or waits on a FIFO. */
export function nativeFileVersion(path: string | undefined): NativeFileVersion {
  if (!path) return { status: "unavailable" };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return nativeFileVersionFromFd(fd);
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** The caller retains and closes its descriptor. */
export function nativeFileVersionFromFd(fd: number): NativeFileVersion {
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return { status: "unavailable" };
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) { const count = readSync(fd, buffer); if (!count) break; hash.update(buffer.subarray(0, count)); }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return { status: "unavailable" };
    return { status: "known", hash: hash.digest("hex") };
  } catch { return { status: "unavailable" }; }
}

const same = (left: NativeFileVersion, right: NativeFileVersion) => left.status === "known" && right.status === "known" && left.hash === right.hash;
/** One instance belongs to one runtime session, including its later turns. */
export class NativeFileVersions {
  private readonly observed = new Map<string, NativeFileVersion>();
  private readonly pendingReads = new Map<string, { key: string; before: NativeFileVersion }>();
  private readonly pendingWrites = new Set<string>();
  private storage?: NativeObservationStorage;
  private incomplete = false;
  private storageFailed = false;
  /** Saves land in call order, so the newest record is the last one written. */
  private saving: Promise<void> = Promise.resolve();
  /** Restore before the first tool; a legacy/missing record cannot establish never-read authority. */
  static async restore(storage: NativeObservationStorage): Promise<NativeFileVersions> {
    const versions = new NativeFileVersions();
    let saved: Awaited<ReturnType<typeof loadNativeObservations>>;
    try { saved = await loadNativeObservations(storage); }
    catch { throw new Error("The host could not restore this session's native file observations. Repair host observation storage before resuming."); }
    versions.incomplete = saved?.incomplete ?? true;
    for (const [key, value] of saved?.observed ?? []) versions.observed.set(key, value);
    versions.storage = storage;
    return versions;
  }
  /** New Claude sessions get their native identity before the first tool. */
  retain(storage: NativeObservationStorage): Promise<void> {
    this.storage = storage;
    return this.persist();
  }
  /**
   * The in-memory change is immediate; the returned promise settles once it
   * is durable. Callers await it before the tool it guards proceeds, and the
   * fsync waits off the event loop (#2416).
   */
  private persist(): Promise<void> {
    if (!this.storage) return Promise.resolve();
    const storage = this.storage, observed = new Map(this.observed);
    // A crash after bytes are supplied but before completion must not forget the read.
    for (const pending of this.pendingReads.values()) observed.set(pending.key, { status: "unavailable" });
    for (const key of this.pendingWrites) observed.set(key, { status: "unavailable" });
    const record = { incomplete: this.incomplete, observed: [...observed] };
    const saved = this.saving.then(() => saveNativeObservations(storage, record)).then(
      () => { this.storageFailed = false; },
      () => { this.storageFailed = true; throw new Error("The host could not retain native file observations. Retry when host observation storage is available."); });
    this.saving = saved.catch(() => undefined);
    return saved;
  }
  /** Settles once every save started so far has; never rejects. A turn awaits it before it settles. */
  settled(): Promise<void> { return this.saving; }
  beginRead(toolUseId: string, key: string, before: NativeFileVersion): Promise<void> {
    this.pendingReads.set(toolUseId, { key, before });
    return this.persist();
  }
  finishRead(toolUseId: string, after: NativeFileVersion, success: boolean): Promise<void> {
    const pending = this.pendingReads.get(toolUseId); this.pendingReads.delete(toolUseId);
    if (!pending) return Promise.resolve();
    if (!success) return this.persist();
    // A changing read is not an observation of a known version. It must not
    // silently teach the session a newer hash than the bytes it was shown.
    this.observed.set(pending.key, same(pending.before, after) ? after : { status: "unavailable" });
    return this.persist();
  }
  /** Persist uncertainty before even a never-read native write can affect bytes. */
  beginWrite(key: string): Promise<void> { this.pendingWrites.add(key); return this.persist(); }
  remember(key: string, hash: string): Promise<void> { this.pendingWrites.delete(key); this.observed.set(key, { status: "known", hash }); return this.persist(); }
  finishWrite(key: string, after: NativeFileVersion): Promise<void> { this.pendingWrites.delete(key); this.observed.set(key, after); return this.persist(); }
  hasObservation(key: string): boolean { return this.observed.has(key); }
  check(key: string, current: NativeFileVersion): string | null {
    const prior = this.observed.get(key);
    // Explicit issue ruling: a path this session never read remains writable.
    return !this.storageFailed && ((prior === undefined && !this.incomplete) || (prior !== undefined && same(prior, current))) ? null : STALE_NATIVE_WRITE;
  }
  cancelPending(): void {
    for (const pending of this.pendingReads.values()) this.observed.set(pending.key, { status: "unavailable" });
    this.pendingReads.clear();
    for (const key of this.pendingWrites) this.observed.set(key, { status: "unavailable" });
    this.pendingWrites.clear();
    // The pending uncertainty is already durable; cleanup cannot make a failed save safe.
  }
}
