import { launchFixtureAgentWorker as launchAgentWorker } from "./helpers/worker-startup-view-fixture.js";
/**
 * Each worker's runtime state is a private, size-limited tmpfs (#1625),
 * proved with real bubblewrap workers: the server copies in before the
 * worker's command starts, the worker sees only its own tmpfs, the size is a
 * hard filesystem limit, and the server copies out after the namespace is
 * gone.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeWorkerHost, workerCommand, WORKER_STATE } from "../src/server/worker-launcher";
import { DEFAULT_WORKER_STATE_BYTES, parseWorkerStateBytes, resolveWorkerStateLimits } from "../src/server/worker-state-limits";

const ROOT = resolve(import.meta.dir, "../../..");
const MiB = 1024 * 1024;

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-state-"));
  const brain = join(root, "brain");
  mkdirSync(brain);
  return { root, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}
/** A shell worker: its stdout, stderr and exit, with the state handle kept open for the caller. */
async function run(brain: string, stateBytes: number, script: string, populate?: (root: string) => void) {
  const worker = launchAgentWorker({ brainPath: brain, stateBytes, env: { PATH: "/usr/bin:/bin" },
    command: ["/bin/sh", "-c", script], ...(populate ? { populateState: populate } : {}) });
  worker.stdin.end();
  const [code, out, err] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
  return { code, out, err, state: worker.state! };
}

describe("private runtime-state tmpfs", () => {
  test("copy-in lands before the command starts, the limit is the allowance, and copy-out works after exit", async () => {
    const f = fixture();
    try {
      const r = await run(f.brain, 8 * MiB, `cat "${WORKER_STATE}/in/odyssey.txt"; stat -f -c '%T %b %S' "${WORKER_STATE}";
        head -c ${16 * MiB} /dev/zero > "${WORKER_STATE}/flood" 2>/dev/null; echo "flood=$?"; printf Ithaca > "${WORKER_STATE}/out.txt" || echo out-failed`,
      root => { mkdirSync(join(root, "in")); writeFileSync(join(root, "in/odyssey.txt"), "Odysseus copy-in\n"); });
      try {
        expect(r.code, r.err).toBe(0);
        const [copied, fs, flood] = r.out.trim().split("\n");
        expect(copied).toBe("Odysseus copy-in");
        expect(fs).toBe(`tmpfs ${(8 * MiB) / 4096} 4096`);
        expect(flood, "the flood stops at the allowance").toBe("flood=1");
        // The worker and its namespace are gone; the server still holds the tmpfs.
        expect(readdirSync(r.state.root).sort()).toEqual(["flood", "in", "out.txt"]);
        expect(r.state.space()).toEqual({ total: 8 * MiB, free: 0 });
      } finally { r.state.close(); }
      expect(() => readdirSync(r.state.root), "closed: the server no longer reaches it").toThrow();
    } finally { f.cleanup(); }
  });

  test("two workers' tmpfs mounts are separate: one filling its own leaves the other's allowance whole", async () => {
    const f = fixture();
    try {
      const filler = launchAgentWorker({ brainPath: f.brain, stateBytes: 4 * MiB, env: { PATH: "/usr/bin:/bin" },
        command: ["/bin/sh", "-c", `head -c ${8 * MiB} /dev/zero > "${WORKER_STATE}/flood" 2>/dev/null; sleep 1`] });
      filler.stdin.end();
      await Bun.sleep(300);
      const other = await run(f.brain, 4 * MiB, `head -c ${3 * MiB} /dev/zero > "${WORKER_STATE}/own" && echo own-ok; ls "${WORKER_STATE}"`);
      try {
        expect(other.code, other.err).toBe(0);
        expect(other.out.trim().split("\n")).toEqual(["own-ok", "own"]);
        expect(filler.state!.space().free, "the filler did fill its own").toBe(0);
      } finally { other.state.close(); }
      await Promise.all([filler.exited, collect(filler.stdout), collect(filler.stderr)]);
      filler.state!.close();
    } finally { f.cleanup(); }
  });

  test("an overridden allowance is the actual mounted limit", async () => {
    const f = fixture();
    try {
      for (const bytes of [DEFAULT_WORKER_STATE_BYTES, 2 * MiB]) {
        const r = await run(f.brain, bytes, `stat -f -c '%b %S' "${WORKER_STATE}"; head -c ${bytes + MiB} /dev/zero > "${WORKER_STATE}/x" 2>/dev/null; echo $?`);
        try {
          expect(r.out.trim().split("\n")).toEqual([`${bytes / 4096} 4096`, "1"]);
          expect(r.state.space().total).toBe(bytes);
        } finally { r.state.close(); }
      }
    } finally { f.cleanup(); }
  });

  test("the worker never starts when copy-in fails, and nothing of it is left", async () => {
    const f = fixture();
    try {
      // Only a started worker could write this scratch-visible marker through its own state.
      let root = "";
      expect(() => launchAgentWorker({ brainPath: f.brain, stateBytes: MiB, env: {},
        command: ["/bin/sh", "-c", `echo started > "${WORKER_STATE}/started"`],
        populateState: path => { root = path; throw new Error("Odysseus: copy-in refused"); } })).toThrow("copy-in refused");
      await Bun.sleep(200);
      expect(root).toMatch(/^\/proc\/self\/fd\/\d+$/);
      expect(() => readdirSync(root), "the held descriptor is closed").toThrow();
    } finally { f.cleanup(); }
  });

  test("the start gate needs the server's byte: a closed stdin ends the worker unstarted", async () => {
    const f = fixture();
    try {
      const argv = workerCommand({ brainPath: f.brain, stateBytes: MiB, env: {}, command: ["/bin/echo", "started"] });
      for (const stdin of [undefined, Buffer.from("1\n"), Buffer.from("go")]) {
        const refused = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
        expect(refused.exitCode).toBe(125);
        expect(refused.stdout.toString()).toBe("");
      }
      const opened = Bun.spawnSync(argv, { stdin: Buffer.from("go\n"), stdout: "pipe", stderr: "pipe" });
      expect(opened.exitCode).toBe(0);
      expect(opened.stdout.toString()).toBe("started\n");
    } finally { f.cleanup(); }
  });

  test("the gate takes no PATH lookup: a hostile dd or [ first in PATH cannot open it", () => {
    const f = fixture();
    try {
      const bin = join(f.root, "bin");
      mkdirSync(bin);
      for (const name of ["dd", "[", "read", "test"]) writeFileSync(join(bin, name), "#!/bin/sh\necho go\nexit 0\n", { mode: 0o755 });
      const argv = workerCommand({ brainPath: f.brain, stateBytes: MiB, env: { PATH: `${bin}:/usr/bin:/bin` }, command: ["/bin/echo", "started"] });
      const refused = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(refused.exitCode).toBe(125);
      expect(refused.stdout.toString()).toBe("");
    } finally { f.cleanup(); }
  });

  test("the gate consumes exactly its line; the rest of stdin reaches the worker", async () => {
    const f = fixture();
    try {
      const worker = launchAgentWorker({ brainPath: f.brain, stateBytes: MiB, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/cat"] });
      worker.stdin.end("Odysseus stdin\n");
      const [code, out] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
      worker.state!.close();
      expect(code).toBe(0); expect(out).toBe("Odysseus stdin\n");
    } finally { f.cleanup(); }
  });

  test("runtime state may not overlap the brain or scratch, and its size must be whole pages", () => {
    const f = fixture();
    try {
      expect(() => workerCommand({ brainPath: f.brain, stateBytes: MiB + 1, env: {}, command: ["/bin/true"] })).toThrow("multiple of 4096");
      expect(() => workerCommand({ brainPath: f.brain, stateBytes: 0, env: {}, command: ["/bin/true"] })).toThrow("positive");
      mkdirSync(join(f.root, "tmp-state"));
      expect(() => workerCommand({ brainPath: f.brain, scratchPath: "/tmp", stateBytes: MiB, env: {}, command: ["/bin/true"] }))
        .toThrow();
    } finally { f.cleanup(); }
  });

  test("the host probe mounts the allowance behind the gate and checks its size from inside", () => {
    const f = fixture();
    try {
      expect(probeWorkerHost(f.brain, { stateBytes: 2 * MiB })).toEqual({ ok: true });
      expect(probeWorkerHost(f.brain, { stateBytes: 2 * MiB, restricted: true })).toEqual({ ok: true });
    } finally { f.cleanup(); }
  });
});

describe("runtime-state limits", () => {
  test("default: 64 MiB per worker, budget = allowance × the session cap", () => {
    expect(resolveWorkerStateLimits({ maxConcurrentSessions: 3 })).toEqual({ allowanceBytes: 67_108_864, budgetBytes: 201_326_592 });
    expect(resolveWorkerStateLimits({})).toEqual({ allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB });
    expect(resolveWorkerStateLimits({ maxConcurrentSessions: 5 }).budgetBytes).toBe(320 * MiB);
    // A fractional cap admits up to its ceiling.
    expect(resolveWorkerStateLimits({ maxConcurrentSessions: 2.5 }).budgetBytes).toBe(192 * MiB);
  });
  test("an allowance override derives the budget from it; an explicit budget wins and may admit fewer workers", () => {
    expect(resolveWorkerStateLimits({ allowanceBytes: 32 * MiB, maxConcurrentSessions: 3 })).toEqual({ allowanceBytes: 32 * MiB, budgetBytes: 96 * MiB });
    expect(resolveWorkerStateLimits({ budgetBytes: 128 * MiB, maxConcurrentSessions: 3 })).toEqual({ allowanceBytes: 64 * MiB, budgetBytes: 128 * MiB });
  });
  test("parsing takes digits only and refuses everything else by name", () => {
    expect(parseWorkerStateBytes(undefined, "BRAIN_UI_WORKER_STATE_BYTES")).toBeUndefined();
    expect(parseWorkerStateBytes("  ", "BRAIN_UI_WORKER_STATE_BYTES")).toBeUndefined();
    expect(parseWorkerStateBytes("33554432", "BRAIN_UI_WORKER_STATE_BYTES")).toBe(32 * MiB);
    for (const raw of ["64MiB", "6.4e7", "-4096", "0x1000", "4096.0", "1e400"]) {
      expect(() => parseWorkerStateBytes(raw, "BRAIN_UI_WORKER_STATE_BYTES"), raw).toThrow("BRAIN_UI_WORKER_STATE_BYTES must be a whole number of bytes");
    }
    for (const raw of ["0", "4097", "99999999999999999999"]) {
      expect(() => parseWorkerStateBytes(raw, "BRAIN_UI_WORKER_STATE_BYTES"), raw).toThrow("multiple of 4096");
    }
  });
  test("a budget below one allowance, an invalid cap and an overflowing product refuse", () => {
    expect(() => resolveWorkerStateLimits({ allowanceBytes: 64 * MiB, budgetBytes: 32 * MiB })).toThrow("no worker could ever start");
    expect(() => resolveWorkerStateLimits({ maxConcurrentSessions: 0 })).toThrow("at least 1");
    expect(() => resolveWorkerStateLimits({ allowanceBytes: 2 ** 52, maxConcurrentSessions: 3 })).toThrow("overflows");
    expect(() => resolveWorkerStateLimits({ allowanceBytes: Number.NaN })).toThrow("multiple of 4096");
  });
});
