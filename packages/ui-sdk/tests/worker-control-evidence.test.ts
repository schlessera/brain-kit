import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
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
    writeFileSync(join(group.path, "cgroup.events"), "populated 1\nfrozen 0\n");
    expect(group.resume()).toBe(true);
    writeFileSync(join(group.path, "cgroup.procs"), "2147483647");
    expect(group.frozen(), "GONE_MEMBERS_INVALIDATE_STOP_PROOF").toBe(false);
    expect(group.resume()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


for (const unreadable of ["proc", "members"]) test(`unreadable ${unreadable} timing evidence never blocks freeze or thaw`, () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-control-evidence-"));
  const group = createWorkerCgroup({ available: true, workers: root, controllers: [] }, {
    processes: null, data: null, file_size: null, open_files: null, memory: null, pids: null, cpu: null, cgroup: true,
  });
  writeFileSync(join(group.path, "cgroup.events"), "frozen 1\n"); writeFileSync(join(group.path, "cgroup.procs"), String(process.pid));
  const original = fs.readFileSync;
  const blocked = unreadable === "proc" ? `/proc/${process.pid}/stat` : join(group.path, "cgroup.procs");
  const reads = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (String(path) === blocked) throw Object.assign(Error("evidence denied"), { code: "EACCES" });
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
  try {
    let freezeResult: boolean | void = undefined;
    expect(() => { freezeResult = group.freeze(); }, "UNREADABLE_EVIDENCE_CANNOT_FAIL_CONFIRMED_FREEZE").not.toThrow();
    expect(freezeResult).toBeUndefined();
    expect(group.frozen()).toBeUndefined();
    writeFileSync(join(group.path, "cgroup.events"), "frozen 0\n");
    let resumeResult: boolean | void = undefined;
    expect(() => { resumeResult = group.resume(); }, "UNREADABLE_EVIDENCE_CANNOT_BLOCK_THAW").not.toThrow();
    expect(resumeResult).toBeUndefined();
    expect(original(join(group.path, "cgroup.freeze"), "utf8")).toBe("0");
  } finally { reads.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("thaw completion is sampled after its request and stays unknown while an ancestor is frozen", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-thaw-"));
  try {
    const group = createWorkerCgroup({ available: true, workers: root, controllers: [] }, {
      processes: null, data: null, file_size: null, open_files: null, memory: null, pids: null, cpu: null, cgroup: true,
    });
    writeFileSync(join(group.path, "cgroup.events"), "frozen 1\n"); writeFileSync(join(group.path, "cgroup.procs"), String(process.pid));
    expect(group.freeze()).toBe(true);
    expect(group.resume(), "PRE_THAW_STATE_IS_NOT_RESUME_EVIDENCE").toBe(false);
    expect(fs.readFileSync(join(group.path, "cgroup.freeze"), "utf8")).toBe("0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
