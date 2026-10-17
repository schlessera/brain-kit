/** Owner-local build measurements, outside package outputs and shipped files. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Compiler = "tsc" | "css";
type Child = { compiler: Compiler; pid: number; startedAt: number; elapsedMs?: number; code?: number };
type Package = { name: string; state: "pending" | "running" | "complete" | "failed"; startedAt?: number; elapsedMs?: number; children: Child[] };

export function buildReceipt(root: string, options: { jobs: number; subset: boolean; packages: readonly string[] }) {
  let available = true;
  function unavailable() {
    if (!available) return;
    available = false;
    // Diagnostics never replace the builder's exit or abandon its live child.
    try { console.error(JSON.stringify({ kind: "workspace-build-receipt-unavailable", pid: process.pid })); } catch {}
  }
  const directory = join(root, "tmp");
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
  function observe(update: () => void) {
    if (!available) return;
    try { update(); save(); } catch { unavailable(); }
  }
  observe(() => {
    if (![1, 2].includes(options.jobs) || packages.length > 128 ||
        new Set(options.packages).size !== packages.length ||
        options.packages.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      throw new Error("Invalid bounded build receipt inventory");
    }
    mkdirSync(directory, { recursive: true });
  });
  return {
    packageStart(name: string) { observe(() => { const value = pkg(name); value.state = "running"; value.startedAt = elapsed(); }); },
    childStart(name: string, compiler: Compiler, pid: number) {
      observe(() => { pkg(name).children.push({ compiler, pid, startedAt: elapsed() }); });
    },
    childExit(name: string, compiler: Compiler, code: number) {
      observe(() => {
        const child = pkg(name).children.find(child => child.compiler === compiler && child.code === undefined);
        if (!child) throw new Error("Missing build receipt child");
        child.code = code; child.elapsedMs = elapsed() - child.startedAt;
      });
    },
    packageEnd(name: string, success: boolean) {
      observe(() => {
        const value = pkg(name); value.state = success ? "complete" : "failed";
        value.elapsedMs = elapsed() - value.startedAt!;
      });
    },
    finish(code: number) { observe(() => { receipt.state = "complete"; receipt.success = code === 0; receipt.code = code; }); },
  };
}
