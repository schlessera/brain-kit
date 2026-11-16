/**
 * Block I/O counters for the reference pool proofs (#3513): the pool loop
 * device's cumulative counters from /proc/diskstats (512-byte sectors), and
 * this process's own from /proc/self/io, which include its reaped children.
 * Callers sync before reading, so delayed Btrfs writeback is counted in the
 * step that caused it. Null when a counter cannot be read.
 */
import { readFileSync, statSync } from "node:fs";

/** The fixture's pool loop device (reference-pool-fixture.py). */
export const POOL_DEVICE = "/dev/brain-pool-loop";
export interface PoolIo { device: { readOps: number; readBytes: number; writeOps: number; writeBytes: number }; process: { readBytes: number; writeBytes: number; rchar: number; wchar: number } }

export function poolIo(device = POOL_DEVICE): PoolIo | null {
  try { return parsePoolIo(statSync(device).rdev, readFileSync("/proc/diskstats", "utf8"), readFileSync("/proc/self/io", "utf8")); }
  catch { return null; }
}

/** Linux `dev_t` decoding, so a loop minor above 255 (the fixture's 2429) matches its diskstats row. */
export function deviceNumbers(rdev: number): { major: number; minor: number } {
  return { major: (rdev >> 8) & 0xfff, minor: (rdev & 0xff) | ((rdev >> 12) & 0xfff00) };
}

export function parsePoolIo(rdev: number, diskstats: string, selfIo: string): PoolIo | null {
  const { major, minor } = deviceNumbers(rdev);
  const fields = diskstats.split("\n").map(line => line.trim().split(/\s+/)).find(row => Number(row[0]) === major && Number(row[1]) === minor);
  if (!fields || fields.length < 10) return null;
  const own = Object.fromEntries(selfIo.trim().split("\n").map(line => line.split(": ")).map(([key, value]) => [key, Number(value)]));
  const process = { readBytes: own.read_bytes, writeBytes: own.write_bytes, rchar: own.rchar, wchar: own.wchar };
  if (Object.values(process).some(value => !Number.isFinite(value))) return null;
  return { device: { readOps: Number(fields[3]), readBytes: Number(fields[5]) * 512, writeOps: Number(fields[7]), writeBytes: Number(fields[9]) * 512 },
    process: process as PoolIo["process"] };
}

export function poolIoDelta(now: PoolIo | null, then: PoolIo | null): PoolIo | null {
  if (!now || !then) return null;
  const minus = <K extends string>(a: Record<K, number>, b: Record<K, number>) => Object.fromEntries(Object.keys(a).map(key => [key, a[key as K] - b[key as K]])) as Record<K, number>;
  return { device: minus(now.device, then.device), process: minus(now.process, then.process) };
}
