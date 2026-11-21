import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerCgroup } from "../src/server/worker-cgroup";

test("cgroup timestamps use existing control acknowledgements without extra kernel inspection", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-control-"));
  const group = createWorkerCgroup({ available: true, workers: root, controllers: [] }, {
    processes: null, data: null, file_size: null, open_files: null, memory: null, pids: null, cpu: null, cgroup: true,
  });
  writeFileSync(join(group.path, "cgroup.events"), "frozen 1\n");
  const original = fs.readFileSync, seen: string[] = [];
  const reads = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    seen.push(String(path));
    if (String(path).includes("/proc/") || String(path).endsWith("cgroup.procs")) throw Error("No timing-only kernel reads");
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
  try {
    expect(group.freeze(), "CONTROL_ACKNOWLEDGEMENT_DEFINES_STOP").toBe(true);
    const beforeResume = seen.length;
    expect(group.resume(), "CONTROL_ACKNOWLEDGEMENT_DEFINES_RESUME").toBe(true);
    expect(seen.slice(beforeResume), "THAW_HAS_NO_TIMING_ONLY_READS").toEqual([]);
    expect(readFileSync(join(group.path, "cgroup.freeze"), "utf8")).toBe("0");
  } finally { reads.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
