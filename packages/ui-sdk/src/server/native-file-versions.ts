/** Session-owned observations, never an authority supplied by a tool argument. */
import { createHash } from "node:crypto";
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
  beginRead(toolUseId: string, key: string, before: NativeFileVersion): void {
    this.pendingReads.set(toolUseId, { key, before });
  }
  finishRead(toolUseId: string, after: NativeFileVersion, success: boolean): void {
    const pending = this.pendingReads.get(toolUseId); this.pendingReads.delete(toolUseId);
    if (!pending || !success) return;
    // A changing read is not an observation of a known version. It must not
    // silently teach the session a newer hash than the bytes it was shown.
    this.observed.set(pending.key, same(pending.before, after) ? after : { status: "unavailable" });
  }
  remember(key: string, hash: string): void { this.observed.set(key, { status: "known", hash }); }
  finishWrite(key: string, after: NativeFileVersion): void { this.observed.set(key, after); }
  hasObservation(key: string): boolean { return this.observed.has(key); }
  check(key: string, current: NativeFileVersion): string | null {
    const prior = this.observed.get(key);
    // Explicit issue ruling: a path this session never read remains writable.
    return prior === undefined || same(prior, current) ? null : STALE_NATIVE_WRITE;
  }
  cancelPending(): void { this.pendingReads.clear(); }
}
