import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerCgroup } from "../src/server/worker-cgroup";

test("cgroup confirmation requires a live member and is rechecked before reuse", () => {
  // This models the kernel files only; native signal qualification stays in the native tier.
  const root = mkdtempSync(join(tmpdir(), "ithaca-control-"));
  try {
    const group = createWorkerCgroup({ available: true, workers: root, controllers: [] }, {
      processes: null, data: null, file_size: null, open_files: null, memory: null, pids: null, cpu: null, cgroup: true,
    });
    writeFileSync(join(group.path, "cgroup.events"), "populated 0\nfrozen 1\n");
    writeFileSync(join(group.path, "cgroup.procs"), "");
    expect(group.freeze(), "EMPTY_CGROUP_IS_NOT_A_CONFIRMED_STOP").toBe(false);
    expect(group.resume(), "EMPTY_CGROUP_IS_NOT_A_CONFIRMED_RESUME").toBe(false);
    writeFileSync(join(group.path, "cgroup.procs"), String(process.pid));
    expect(group.freeze()).toBe(true); expect(group.frozen()).toBe(true);
    expect(group.resume()).toBe(true);
    writeFileSync(join(group.path, "cgroup.procs"), "2147483647");
    expect(group.frozen(), "GONE_MEMBERS_INVALIDATE_STOP_PROOF").toBe(false);
    expect(group.resume()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
