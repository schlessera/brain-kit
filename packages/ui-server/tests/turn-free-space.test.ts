import { describe, expect, test } from "bun:test";
import { requireTurnFreeSpace, TurnFixtureFreeSpaceError } from "./helpers/turn-free-space.js";

const GiB = 1024 ** 3;
const brain = "/tmp/odysseus/brain";
const stats = (total: number, available: number) => ({ blocks: total, bsize: 1, bavail: available });

describe("turn fixture free-space prerequisite", () => {
  test("just below the 2 GiB floor refuses with path, bytes and a TMPDIR remedy", () => {
    let failure: unknown;
    try { requireTurnFreeSpace(brain, () => stats(3 * GiB, 2 * GiB - 1)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TurnFixtureFreeSpaceError);
    expect(failure).toMatchObject({ name: "TurnFixtureFreeSpaceError", brainPath: brain,
      availableBytes: 2 * GiB - 1, requiredBytes: 2 * GiB });
    expect((failure as Error).message).toContain(brain);
    expect((failure as Error).message).toContain("2147483647 available bytes");
    expect((failure as Error).message).toContain("at least 2147483648 bytes");
    expect((failure as Error).message).toContain("Point TMPDIR");
    expect((failure as Error).message).toContain("more free space");
  });

  test("at the 2 GiB floor passes", () => {
    expect(() => requireTurnFreeSpace(brain, () => stats(3 * GiB, 2 * GiB))).not.toThrow();
  });

  test("5% dominates on a large filesystem even with more than 2 GiB available", () => {
    expect(() => requireTurnFreeSpace(brain, () => stats(100 * GiB, 3 * GiB)), "5% dominates")
      .toThrow(TurnFixtureFreeSpaceError);
  });

  test("at the 5% floor passes", () => {
    expect(() => requireTurnFreeSpace(brain, () => stats(100 * GiB, 5 * GiB))).not.toThrow();
  });

  test("stats the brain path and counts available blocks with their block size", () => {
    const paths: string[] = [];
    expect(() => requireTurnFreeSpace(brain, path => {
      paths.push(path);
      return { blocks: 3 * GiB / 4096, bsize: 4096, bavail: 2 * GiB / 4096 - 1 };
    })).toThrow("2147479552 available bytes");
    expect(paths).toEqual([brain]);
  });

  test("statfs failure propagates instead of claiming capacity", () => {
    const failure = new Error("Odysseus brain is unavailable");
    expect(() => requireTurnFreeSpace(brain, () => { throw failure; })).toThrow(failure);
  });
});
