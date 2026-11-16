import { describe, expect, test } from "bun:test";
import { deviceNumbers, parsePoolIo, poolIoDelta } from "../scripts/native-proof/pool-io.ts";

// makedev(7, 2429): the reference pool fixture's loop device (scripts/native-proof/reference-pool-fixture.py).
const POOL_RDEV = (2429 & 0xff) | (7 << 8) | ((2429 & ~0xff) << 12);
const DISKSTATS = [
  "   7    125 loop125 1 0 8 0 2 0 16 0 0 0 0 0 0 0 0 0 0",
  "   7   2429 loop2429 40 2 800 11 90 5 4096 30 0 41 41 0 0 0 0 7 3",
  " 259      0 nvme0n1 5 0 10 1 6 0 12 1 0 2 2 0 0 0 0 0 0",
].join("\n");
const SELF_IO = "rchar: 9000\nwchar: 7000\nsyscr: 30\nsyscw: 20\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n";

describe("pool I/O counters (#3513)", () => {
  test("decodes a loop minor above 255 from its dev_t", () => {
    expect(deviceNumbers(POOL_RDEV)).toEqual({ major: 7, minor: 2429 });
    expect(deviceNumbers((125 & 0xff) | (7 << 8))).toEqual({ major: 7, minor: 125 });
  });

  test("reads the pool device's row, not a device sharing its low minor bits", () => {
    expect(parsePoolIo(POOL_RDEV, DISKSTATS, SELF_IO)).toEqual({
      device: { readOps: 40, readBytes: 800 * 512, writeOps: 90, writeBytes: 4096 * 512 },
      process: { readBytes: 4096, writeBytes: 8192, rchar: 9000, wchar: 7000 },
    });
  });

  test("is null rather than zero when a counter is missing", () => {
    expect(parsePoolIo(POOL_RDEV, DISKSTATS.split("\n").filter(line => !line.includes("loop2429")).join("\n"), SELF_IO)).toBeNull();
    expect(parsePoolIo(POOL_RDEV, DISKSTATS, "rchar: 1\nwchar: 2\n")).toBeNull();
  });

  test("reports each step's own I/O as the difference of two readings", () => {
    const before = parsePoolIo(POOL_RDEV, DISKSTATS, SELF_IO)!;
    const after = parsePoolIo(POOL_RDEV, DISKSTATS.replace("loop2429 40 2 800 11 90 5 4096", "loop2429 41 2 808 11 95 5 6144"), SELF_IO.replace("write_bytes: 8192", "write_bytes: 12288"))!;
    expect(poolIoDelta(after, before)).toEqual({ device: { readOps: 1, readBytes: 8 * 512, writeOps: 5, writeBytes: 2048 * 512 }, process: { readBytes: 0, writeBytes: 4096, rchar: 0, wchar: 0 } });
    expect(poolIoDelta(after, null)).toBeNull();
  });
});
