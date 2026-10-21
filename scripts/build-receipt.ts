/** Owner-local build measurements, outside package outputs and shipped files. */
import { closeSync, constants, ftruncateSync, writeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { observedBuildContext, observedBuildOutputs } from "./build-repeat-observation.ts";

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
  let observerFd: number | undefined, observerUnavailable = false, observerKey: string | undefined;
  let observerNs = 0n, observerCalls = 0;
  function snapshot(bytes: string) {
    const output = process.env.BRAIN_HOSTED_OBSERVER_DIR;
    if (!output || observerUnavailable) return;
    const observationStarted = process.hrtime.bigint();
    try {
      if (observerFd === undefined) {
        for (let slot = 0; slot < 128; slot++) {
          try { observerFd = openSync(join(output, `build-${slot}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        if (observerFd === undefined) throw new Error("build slots exhausted");
      }
      if (!observerKey) {
        const stat = readFileSync("/proc/self/stat", "utf8");
        observerKey = `${process.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
      }
      const metadata = JSON.stringify({ epochMs: Date.now(), ns: observationStarted.toString(), cpu: process.cpuUsage(),
        key: observerKey, root, observerCalls: ++observerCalls, observerNsBefore: observerNs.toString() });
      const value = metadata.slice(0, -1) + ',"receipt":' + bytes + "}";
      if (Buffer.byteLength(value) > 262144) throw new Error("build snapshot exhausted");
      // Use a positional write and truncate to retain one bounded current snapshot.
      writeSync(observerFd, value, 0, "utf8"); ftruncateSync(observerFd, Buffer.byteLength(value));
    } catch {
      observerUnavailable = true;
      try { console.error("HOSTED_OBSERVER_INCOMPLETE build snapshot"); } catch {}
    } finally { observerNs += process.hrtime.bigint() - observationStarted; }
  }
  function save() {
    receipt.elapsedMs = elapsed();
    // Each actual build owns one file. Readers never see a half-written JSON value.
    const bytes = JSON.stringify(receipt);
    writeFileSync(`${path}.writing`, bytes);
    renameSync(`${path}.writing`, path);
    snapshot(bytes);
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
  const beforeStarted = performance.now();
  const before = available ? observedBuildContext(root, options.packages) : { state: "unknown" as const };
  const beforeMs = performance.now() - beforeStarted;
  observe(() => { Object.assign(receipt, { repeat: { scope: "fixed-observed-workload", state: "unknown", before,
    observationMs: { before: beforeMs } } }); });
  const executionStarted = performance.now();
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
    finish(code: number) {
      const executionMs = performance.now() - executionStarted;
      observe(() => {
        const afterStarted = performance.now();
        const after = observedBuildContext(root, options.packages);
        const afterMs = performance.now() - afterStarted;
        const outputStarted = performance.now();
        const output = code === 0 ? observedBuildOutputs(root, options.packages) : { state: "unknown" as const };
        const outputMs = performance.now() - outputStarted;
        const known = before.state === "known" && after.state === "known" && before.sha256 === after.sha256 && output.state === "known";
        Object.assign(receipt, { repeat: { scope: "fixed-observed-workload", state: known ? "known" : "unknown",
          before, after, output, executionMs, observationMs: { before: beforeMs, after: afterMs, output: outputMs } } });
        receipt.state = "complete"; receipt.success = code === 0; receipt.code = code;
      });
      if (observerFd !== undefined) { try { closeSync(observerFd); } catch {} observerFd = undefined; }
    },
  };
}
