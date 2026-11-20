/** Existing Linux/Btrfs native identity, read from the actual held descriptor. */
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync } from "node:fs";
import * as kernel from "./reference-owner-root-kernel.js";
export interface ReferenceOwnerNativeIdentity { fsid: string; uuid: string }
export interface ReferenceOwnerRoot { path: string; device: number; inode: number; native: ReferenceOwnerNativeIdentity }
export type ReferenceOwnerExpectedRoot = { fsid: string; brainUuid: string };
const unavailable = () => ({ root: undefined, close() {} });
/** Qualification is host configuration, never a model-selected identity. */
export async function createReferenceOwnerContinuity(path: string, expected?: ReferenceOwnerExpectedRoot): Promise<{ root: Readonly<ReferenceOwnerRoot> | undefined; close(): void }> {
  if (!expected || !/^[a-f0-9-]{36}$/u.test(expected.fsid) || !/^[a-f0-9]{32}$/u.test(expected.brainUuid)) return unavailable();
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const held = fstatSync(fd);
    const unchanged = () => {
      const named = lstatSync(canonical), current = fstatSync(fd!);
      return realpathSync(path) === canonical && named.isDirectory() && named.dev === held.dev && named.ino === held.ino
        && current.dev === held.dev && current.ino === held.ino;
    };
    if (!unchanged()) throw Error("Changed policy root");
    // Open precedes the lazy native-library wait; only this descriptor is inspected.
    const actual = await kernel.inspectPinnedReferenceRoot(fd);
    if (!unchanged() || actual.fsid !== expected.fsid || actual.uuid !== expected.brainUuid || actual.readOnly
      || actual.receivedUuid !== "0".repeat(32) || actual.devices !== 1) throw Error("Unqualified native policy root");
    const root = Object.freeze({ path: canonical, device: held.dev, inode: held.ino,
      native: Object.freeze({ fsid: actual.fsid, uuid: actual.uuid }) });
    return { root, close() { if (fd !== undefined) { closeSync(fd); fd = undefined; } } };
  } catch { if (fd !== undefined) closeSync(fd); return unavailable(); }
}
