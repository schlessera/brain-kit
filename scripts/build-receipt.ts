/** Owner-local build measurements, outside package outputs and shipped files. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Compiler = "tsc" | "css";
type Child = { compiler: Compiler; pid: number; startedAt: number; elapsedMs?: number; code?: number };
type Package = { name: string; state: "pending" | "running" | "complete" | "failed"; startedAt?: number; elapsedMs?: number; children: Child[] };

export function buildReceipt(root: string, options: { jobs: number; subset: boolean; packages: readonly string[] }) {
  if (![1, 2].includes(options.jobs) || options.packages.length > 128 ||
      new Set(options.packages).size !== options.packages.length ||
      options.packages.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new Error("Invalid bounded build receipt inventory");
  }
  const directory = join(root, "tmp");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `build-${process.pid}-${randomUUID()}-probe.json`);
  const started = performance.now();
  const packages: Package[] = options.packages.map(name => ({ name, state: "pending", children: [] }));
  const receipt = { schemaVersion: 1, kind: "workspace-build", pid: process.pid, startedAt: Date.now(),
    mode: options.subset ? "subset" : "full", jobs: options.jobs,
    state: "running" as "running" | "complete", elapsedMs: 0, success: false, code: null as number | null, packages };
  const elapsed = () => performance.now() - started;
  function save() {
    receipt.elapsedMs = elapsed();
    // Each actual build owns one file. Readers never see a half-written JSON value.
    writeFileSync(`${path}.writing`, JSON.stringify(receipt));
    renameSync(`${path}.writing`, path);
  }
  function pkg(name: string) {
    const value = packages.find(pkg => pkg.name === name);
    if (!value) throw new Error("Unknown build receipt package");
    return value;
  }
  save();
  return {
    packageStart(name: string) { const value = pkg(name); value.state = "running"; value.startedAt = elapsed(); save(); },
    childStart(name: string, compiler: Compiler, pid: number) {
      pkg(name).children.push({ compiler, pid, startedAt: elapsed() }); save();
    },
    childExit(name: string, compiler: Compiler, code: number) {
      const child = pkg(name).children.find(child => child.compiler === compiler && child.code === undefined);
      if (!child) throw new Error("Missing build receipt child");
      child.code = code; child.elapsedMs = elapsed() - child.startedAt; save();
    },
    packageEnd(name: string, success: boolean) {
      const value = pkg(name); value.state = success ? "complete" : "failed";
      value.elapsedMs = elapsed() - value.startedAt!; save();
    },
    finish(code: number) { receipt.state = "complete"; receipt.success = code === 0; receipt.code = code; save(); },
  };
}
