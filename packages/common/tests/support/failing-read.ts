/**
 * A read of one file that fails once, as a disk error would: the next
 * `readSync` on a descriptor open on `path` throws `EIO`, with the path in
 * its text, and every later one reads normally. It counts every read of the
 * file, so a test can tell whether the file was read again.
 *
 * Linux only: a descriptor is named through `/proc/self/fd`. `restore` puts
 * `readSync` back; call it in the test's teardown.
 */
import { spyOn } from "bun:test";
import * as fs from "node:fs";

export interface FailingRead {
  /** Reads of the file so far, the failed one included. */
  reads(): number;
  restore(): void;
}

export function failNextRead(path: string): FailingRead {
  const target = fs.realpathSync(path);
  const real = fs.readSync;
  let armed = true;
  let reads = 0;
  const spy = spyOn(fs, "readSync").mockImplementation(((fd: number, ...rest: unknown[]) => {
    let named: string | null = null;
    try { named = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* not a descriptor this process can name */ }
    if (named === target) {
      reads++;
      if (armed) {
        armed = false;
        throw Object.assign(new Error(`EIO: i/o error, read '${target}'`), { code: "EIO", path: target });
      }
    }
    return Reflect.apply(real, fs, [fd, ...rest]);
  }) as typeof fs.readSync);
  return { reads: () => reads, restore: () => spy.mockRestore() };
}
