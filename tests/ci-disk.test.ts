import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskSampler, floorProblem, headroomProblem, PROOF_RESERVE_BYTES, readDisk, reclaim, RECLAIMABLE, TURN_FREE_BYTES, turnFreeSpaceFloor } from "../scripts/ci-disk";
import { SCOPE_FREE_BYTES } from "../packages/ui-server/src/brain/turn-scope";
import { requireTurnFreeSpace, TurnFixtureFreeSpaceError } from "../packages/ui-server/tests/helpers/turn-free-space";

// Run 41505209464, unit (1): the root filesystem the fixture brains used.
const CI_TOTAL = 76_887_154_688, CI_FLOOR = 3_844_357_734.4, CI_FIXTURE_AVAILABLE = 2_665_242_624, CI_TURN_AVAILABLE = 2_618_183_680;
const statfsOf = (total: number, available: number) => () => ({ blocks: total / 4096, bsize: 4096, bavail: available / 4096 });

describe("the runner disk floor is the turn fixtures' floor", () => {
  test("TURN_FREE_BYTES is the production minimum", () => {
    expect(TURN_FREE_BYTES).toBe(SCOPE_FREE_BYTES);
  });
  test("the floor matches requireTurnFreeSpace at, just below and above its boundary", () => {
    expect(turnFreeSpaceFloor(CI_TOTAL)).toBe(CI_FLOOR);
    for (const [total, available] of [[CI_TOTAL, 3_844_358_144], [CI_TOTAL, CI_FIXTURE_AVAILABLE], [8 * 1024 ** 3, TURN_FREE_BYTES], [8 * 1024 ** 3, TURN_FREE_BYTES - 4096]]) {
      const reading = readDisk("/odysseus/brain", statfsOf(total, available));
      let helperRefused = false;
      try { requireTurnFreeSpace("/odysseus/brain", statfsOf(total, available)); }
      catch (error) { helperRefused = error instanceof TurnFixtureFreeSpaceError; }
      expect(reading.availableBytes < reading.floorBytes, `${total}/${available}`).toBe(helperRefused);
    }
  });
});

describe("attribution", () => {
  test("the CI receipt is named as runner disk exhaustion, not a product result", () => {
    const problem = floorProblem("/tmp", CI_TURN_AVAILABLE, CI_FLOOR);
    expect(problem).toContain("fell to 2618183680 available bytes");
    expect(problem).toContain("below the turn-fixture free-space floor of 3844357734.4 bytes");
    expect(problem).toContain("runner disk exhaustion (#3256)");
    expect(floorProblem("/tmp", CI_FLOOR, CI_FLOOR)).toBeUndefined();
  });
  test("setup refuses the CI runner's free space before proof starts", () => {
    const failing = readDisk("/tmp", statfsOf(CI_TOTAL, CI_FIXTURE_AVAILABLE));
    expect(headroomProblem(failing)).toContain("runner provisioning failure, not a test result");
    const exact = readDisk("/tmp", statfsOf(CI_TOTAL, 0));
    expect(headroomProblem({ ...exact, availableBytes: CI_FLOOR + PROOF_RESERVE_BYTES })).toBeUndefined();
    expect(headroomProblem({ ...exact, availableBytes: CI_FLOOR + PROOF_RESERVE_BYTES - 1 })).toBeDefined();
  });
  test("the proof sampler keeps the minimum across a dip and a transient statfs failure", () => {
    const values = [20e9, CI_TURN_AVAILABLE, -1, 15e9];
    let index = 0;
    const sampler = diskSampler("/tmp", () => {
      const available = values[Math.min(index++, values.length - 1)]!;
      if (available < 0) throw new Error("transient");
      return statfsOf(CI_TOTAL, available)();
    });
    for (let i = 0; i < 3; i++) sampler.sample();
    expect(sampler.summary()).toEqual({ path: "/tmp", totalBytes: CI_TOTAL, floorBytes: CI_FLOOR, startAvailableBytes: 20e9,
      minimumAvailableBytes: CI_TURN_AVAILABLE, endAvailableBytes: 15e9, samples: 3, belowFloor: true });
  });
});

describe("reclaim", () => {
  test("removes only present reclaimable toolchains and records before/after", async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-disk-"));
    try {
      const removed: string[][] = [];
      let available = CI_FIXTURE_AVAILABLE;
      const record = await reclaim({ root, path: "/tmp", exists: path => path !== "/usr/share/swift",
        statfs: () => statfsOf(CI_TOTAL, available)(),
        remove: async paths => { removed.push(paths); available += 30 * 1024 ** 3; } });
      expect(removed).toEqual([RECLAIMABLE.filter(path => path !== "/usr/share/swift")]);
      expect(record.reclaimedBytes).toBe(30 * 1024 ** 3);
      expect(record.problem).toBeNull();
      expect(JSON.parse(readFileSync(join(root, "tmp/runner-disk.json"), "utf8")).after.availableBytes).toBe(available);
      const short = await reclaim({ root, path: "/tmp", exists: () => false, statfs: statfsOf(CI_TOTAL, CI_FIXTURE_AVAILABLE), remove: async () => {} });
      expect(short.problem).toContain("runner provisioning failure");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("never removes a path the proof uses", () => {
    for (const path of RECLAIMABLE) {
      expect(path).toMatch(/^\/(usr|opt)\//);
      for (const kept of ["/usr/bin", "/usr/lib", "/opt/google", "/usr/local/bin", "/var/lib/docker", "/opt/hostedtoolcache/node"])
        expect(kept.startsWith(path) || path === kept).toBe(false);
    }
  });
});

describe("wiring", () => {
  const root = join(import.meta.dir, "..");
  test("unit setup reclaims and requires headroom before installing packages; native setup does not", () => {
    const setup = readFileSync(join(root, "scripts/ci-runtime-setup.sh"), "utf8");
    const reclaimAt = setup.indexOf("bun scripts/ci-disk.ts reclaim");
    expect(reclaimAt).toBeGreaterThan(0);
    expect(reclaimAt).toBeLessThan(setup.indexOf("sudo apt-get update"));
    expect(setup.lastIndexOf('if [ "${1:-}" != "--native" ]; then', reclaimAt)).toBeGreaterThan(0);
  });
  test("proof records the fixtures' disk and names a dip below the floor", () => {
    const proof = readFileSync(join(root, "scripts/ci-proof.ts"), "utf8");
    expect(proof).toContain("disk: disk.summary()");
    expect(proof).toContain("floorProblem(resources.disk.path, resources.disk.minimumAvailableBytes, resources.disk.floorBytes)");
  });
});
