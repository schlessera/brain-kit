/** Same fixed kernel UAPI as the native manager and retained startup guard. */
import { fstatSync } from "node:fs";
async function load() {
  if (process.platform !== "linux") throw Error("Native root identity unavailable");
  const { dlopen } = await import("bun:ffi");
  return dlopen("libc.so.6", { ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" } });
}
let pending: ReturnType<typeof load> | undefined;
export async function inspectPinnedReferenceRoot(fd: number) {
  const selected = pending ??= load();
  let libc: Awaited<typeof selected>;
  try { libc = await selected; } catch (error) { if (pending === selected) pending = undefined; throw error; }
  const held = fstatSync(fd, { bigint: true });
  if (!held.isDirectory() || held.ino !== 256n) throw Error("Policy root is not a native subvolume root");
  const subvolume = Buffer.alloc(504), filesystem = Buffer.alloc(1024);
  if (libc.symbols.ioctl(fd, 0x81f8943c, subvolume) < 0 || libc.symbols.ioctl(fd, 0x8400941f, filesystem) < 0)
    throw Error("Policy root kernel identity unavailable");
  const current = fstatSync(fd, { bigint: true });
  if (current.dev !== held.dev || current.ino !== held.ino) throw Error("Changed policy root descriptor");
  const hex = filesystem.subarray(16, 32).toString("hex");
  return { fsid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    uuid: subvolume.subarray(296, 312).toString("hex"), receivedUuid: subvolume.subarray(328, 344).toString("hex"),
    readOnly: !!(subvolume.readBigUInt64LE(288) & 1n), devices: Number(filesystem.readBigUInt64LE(8)) };
}
