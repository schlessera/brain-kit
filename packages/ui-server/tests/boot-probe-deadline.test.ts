/** Real subprocess regressions for the five-second boot deadline (#286). */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVersionCommand } from "../../ui-sdk/src/server/version-probe";
import { probeClaudeRuntime } from "../../ui-backend-claude/src/runtime-probe";
import { probeBrainCliVersion } from "../src/brain/client";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createRecordingObservability } from "../src/observability";

const dirs: string[] = [];
const inheritedDirs = new Set<string>();
async function cleanupFixtures(): Promise<void> {
  const errors: unknown[] = [];
  for (const dir of dirs.splice(0)) {
    try {
      if (inheritedDirs.delete(dir)) await cleanupDescendant(dir);
    } catch (error) { errors.push(error); }
    for (const name of ["probe.pid", "descendant.pid", "helper.pid"]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const pid = Number(readFileSync(path, "utf8"));
      if (!(pid > 0)) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* Possibly not a group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  if (errors.length) throw new AggregateError(errors, "Inherited-pipe fixture cleanup failed");
}
afterEach(async () => {
  const active = controller;
  controller = undefined;
  try { if (active) await active.dispose(cleanupFixtures); else await cleanupFixtures(); }
  finally { active?.assertRestored(); }
});

function descendantPid(dir: string): number {
  // Independent cleanup receipt: even a missing/wrong primary marker must not
  // prevent teardown from finding the child whose publication assertion failed.
  const pid = Number(readFileSync(join(dir, "descendant.owner.pid"), "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
  return pid;
}
function inheritedEndpoints(dir: string, pid: number): void {
  for (const fd of [1, 2]) {
    const original = readFileSync(join(dir, `${fd}.endpoint`), "utf8").trim();
    expect(original).toMatch(/^(pipe|socket):\[\d+\]$/);
    expect(readlinkSync(`/proc/${pid}/fd/${fd}`)).toBe(original);
  }
}
async function cleanupDescendant(dir: string, terminate: (pid: number) => void = pid => { process.kill(pid, "SIGKILL"); }): Promise<void> {
  const pid = descendantPid(dir);
  const entry = `/proc/${pid}`;
  if (existsSync(entry)) {
    // Identify the actual inherited endpoints before signalling a non-child PID.
    inheritedEndpoints(dir, pid);
    terminate(pid);
  }
  const until = Date.now() + 1_000;
  while (existsSync(entry) && Date.now() < until) await Bun.sleep(10);
  // This observes non-child disappearance; it is not a direct-child wait/reap.
  expect(existsSync(entry), "owned inherited-pipe descendant disappears after teardown").toBe(false);
}

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function fixture(output: string, body: string | ((dir: string) => string) = 'exec sleep 8') {
  const dir = mkdtempSync(join(tmpdir(), "boot-deadline-"));
  dirs.push(dir);
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const path = executable(join(bin, "brain"), `echo $$ > '${dir}/probe.pid'\nprintf '%s\\n' \"$@\" > '${dir}/argv.log'\ntrap '' TERM\necho '${output}'\n${typeof body === "function" ? body(dir) : body}`);
  const wrapper = executable(join(dir, "wrapper"), 'exec "$@"');
  return { dir, path, wrapper, output } as { dir: string; path: string; wrapper?: string; output: string };
}
/** File-local pass-through observations; native controls never replace timers. */
class PrimaryDeadline {
  private restores: (() => void)[] = [];
  private snapshots: [object, PropertyKey, PropertyDescriptor | undefined][] = [];
  private processes: Bun.Subprocess[] = [];
  private primary?: { callback: () => void; handle: ReturnType<typeof setTimeout>; cleared: boolean; fired: number };
  private timers: { owner: string; delay: number; fired: number; cleared: boolean; handle?: ReturnType<typeof setTimeout> }[] = [];
  private nativeReads: Promise<unknown>[] = [];
  private pending = [0, 0];
  private reads = [0, 0];
  private eof = [false, false];
  private stdout = "";
  private target?: Bun.Subprocess;
  private exited = false;
  settled = false;
  polls = 0;
  work?: Promise<unknown>;
  private nativeSet = globalThis.setTimeout;
  private nativeClear = globalThis.clearTimeout;

  constructor(private f: ReturnType<typeof fixture>, readonly controlled: boolean) {
    try {
      if (controlled) {
        // Explicit owner/callback binding; a new owner fails closed. Duration
        // alone cannot select this timer. Re-derive its line after harmless moves.
        const lines = readFileSync(new URL("../../ui-sdk/src/server/version-probe.ts", import.meta.url), "utf8").split("\n");
        const site = lines.findIndex(line => line.includes("timer = setTimeout(() => resolve({ timedOut: true }), VERSION_PROBE_TIMEOUT_MS)"));
        expect(site, "source-owned primary registration exists").toBeGreaterThan(0);
        expect(lines.filter(line => line.includes("timer = setTimeout(")).length, "exactly one primary owner").toBe(1);
        expect(lines[site - 1]).toContain("const deadline = new Promise<Outcome>");
        const owner = `version-probe.ts:${site + 1}:`;
        this.replace(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
          const stack = new Error().stack ?? "";
          const caller = stack.match(/\/ui-sdk\/src\/server\/((?:version-probe|exec-wrapper)\.ts:\d+:)/)?.[1];
          const fromPrimary = caller === owner;
          const fromProbe = caller?.startsWith("version-probe.ts:") ?? false;
          const fromHelper = caller?.startsWith("exec-wrapper.ts:") ?? false;
          if (!fromPrimary && !fromProbe && !fromHelper) return this.nativeSet(callback, delay, ...args);
          const record = { owner: fromPrimary ? "primary" : fromProbe ? "cleanup" : "helper", delay, fired: 0, cleared: false, handle: undefined as ReturnType<typeof setTimeout> | undefined };
          this.timers.push(record);
          if (fromPrimary) {
            expect(this.primary, "no extra primary registration").toBeUndefined();
            const handle = {} as ReturnType<typeof setTimeout>;
            record.handle = handle;
            this.primary = { callback: () => { record.fired++; callback(...args); }, handle, cleared: false, fired: 0 };
            return handle;
          }
          record.handle = this.nativeSet(() => { record.fired++; callback(...args); }, delay);
          return record.handle;
        }) as typeof setTimeout);
        this.replace(globalThis, "clearTimeout", ((handle: ReturnType<typeof setTimeout>) => {
          const record = this.timers.find(timer => timer.handle === handle);
          if (record) record.cleared = true;
          if (this.primary?.handle === handle) { this.primary.cleared = true; return; }
          this.nativeClear(handle);
        }) as typeof clearTimeout);
      }
      const spawn = Bun.spawn;
      this.replace(Bun, "spawn", ((...args: Parameters<typeof Bun.spawn>) => {
        const proc = Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
        this.processes.push(proc);
        const argv = args[0];
        if (argv?.includes(f.path)) {
          expect(this.target, "one actual version subprocess").toBeUndefined();
          this.target = proc;
          void proc.exited.then(() => { this.exited = true; });
          if (controlled) for (const [index, stream] of [proc.stdout, proc.stderr].entries()) {
            if (!stream || typeof stream === "number") throw new Error("native pipe required");
            const getReader = stream.getReader;
            this.replace(stream, "getReader", (...readerArgs: unknown[]) => {
              const reader = Reflect.apply(getReader, stream, readerArgs) as ReadableStreamDefaultReader<Uint8Array>;
              const read = reader.read;
              this.replace(reader, "read", () => {
                this.reads[index]!++;
                this.pending[index]!++;
                const promise = read.call(reader);
                this.nativeReads.push(promise);
                void promise.then(chunk => {
                  this.pending[index]!--;
                  if (chunk.done) this.eof[index] = true;
                  else if (index === 0) this.stdout += new TextDecoder().decode(chunk.value);
                }, () => { this.pending[index]!--; });
                return promise; // Actual native promise/result, never a replacement.
              });
              return reader;
            });
          }
        }
        return proc;
      }) as typeof Bun.spawn);
    } catch (error) {
      for (const restore of this.restores.reverse()) restore();
      throw error;
    }
  }

  private replace(object: object, key: PropertyKey, value: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    this.snapshots.push([object, key, descriptor]);
    Object.defineProperty(object, key, { configurable: descriptor?.configurable ?? true, writable: true, enumerable: descriptor?.enumerable ?? false, value });
    this.restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key));
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.work = work;
    void work.then(() => { this.settled = true; }, () => { this.settled = true; });
    return work;
  }
  async ready(): Promise<void> {
    const until = Date.now() + 2_000;
    while (Date.now() < until) {
      const pipeReady = this.stdout.includes(this.f.output) && this.reads[0]! >= 2 && this.pending.every(n => n === 1) && this.eof.every(done => !done);
      let nativeReady = false;
      if (this.target && pipeReady) {
        if (inheritedDirs.has(this.f.dir)) {
          if (this.exited && existsSync(join(this.f.dir, "descendant.owner.pid"))) {
            const pid = descendantPid(this.f.dir);
            inheritedEndpoints(this.f.dir, pid);
            nativeReady = existsSync(`/proc/${pid}`);
          }
        } else {
          try { nativeReady = readlinkSync(`/proc/${this.target.pid}/exe`).endsWith("/sleep"); } catch { /* Await native exec. */ }
        }
      }
      if (pipeReady && nativeReady || this.settled) break;
      this.polls++;
      await Bun.sleep(1);
    }
    expect(this.settled, "native pending work cannot complete before deadline").toBe(false);
    expect(this.stdout, "actual version bytes delivered").toContain(this.f.output);
    expect(this.reads[0], "stdout entered its subsequent read").toBeGreaterThanOrEqual(2);
    expect(this.pending, "both actual native reads remain pending").toEqual([1, 1]);
    expect(this.eof, "neither native stream has reached EOF").toEqual([false, false]);
    expect(this.target, "actual target was observed").toBeDefined();
    if (inheritedDirs.has(this.f.dir)) {
      expect(this.exited, "inherited-pipe parent exited before advancement").toBe(true);
      inheritedEndpoints(this.f.dir, descendantPid(this.f.dir));
    } else expect(readlinkSync(`/proc/${this.target!.pid}/exe`), "target completed trap/output and exec").toMatch(/\/sleep$/);
    this.checkTimers();
    expect(this.primary, "actual primary registration captured").toBeDefined();
  }
  advance(milliseconds: number): void {
    const primary = this.primary;
    expect(primary, "actual primary registration captured").toBeDefined();
    if (milliseconds >= 5_000 && !primary!.cleared && primary!.fired === 0) {
      primary!.fired++;
      primary!.callback();
    }
  }
  async deadline(): Promise<number> {
    await this.ready();
    this.advance(4_999);
    await Promise.resolve();
    expect(this.primary!.fired, "no primary delivery at 4999").toBe(0);
    expect(this.settled, "no probe completion at 4999").toBe(false);
    const started = Date.now();
    this.advance(5_000);
    this.advance(5_001);
    expect(this.primary!.fired, "one primary delivery at 5000").toBe(1);
    return started;
  }
  checkTimers(): void {
    for (const timer of this.timers) expect(timer.delay, `${timer.owner} default milliseconds`).toBe(timer.owner === "primary" ? 5_000 : timer.owner === "cleanup" ? 250 : 200);
    expect(this.timers.filter(timer => timer.owner === "primary").length, "one primary registration").toBe(1);
  }
  assertCancelled(): void {
    expect(this.primary?.cleared, "successful completion clears primary").toBe(true);
    this.advance(5_001);
    expect(this.primary!.fired, "cancelled primary cannot deliver").toBe(0);
  }
  async dispose(cleanup: () => Promise<void>): Promise<void> {
    // Cleanup failures cannot bypass joining native work or descriptor restoration.
    try { await cleanup(); }
    finally {
      try {
        for (const proc of this.processes) if (proc.exitCode === null) {
          try { process.kill(-proc.pid, "SIGKILL"); } catch { /* Not a group leader. */ }
          try { proc.kill("SIGKILL"); } catch { /* Already exited. */ }
        }
        await Promise.all(this.processes.map(proc => proc.exited));
        await this.work?.catch(() => {});
        await Promise.allSettled(this.nativeReads);
        expect(this.pending, "all observed native read promises settled").toEqual([0, 0]);
        for (const proc of this.processes) expect(existsSync(`/proc/${proc.pid}`), "owned direct child disappears after awaited exit").toBe(false);
        if (this.controlled) {
          this.checkTimers();
          for (const timer of this.timers) expect(timer.cleared || timer.fired === 1, `${timer.owner} settles natively or clears`).toBe(true);
        }
      } finally {
        try {
          for (const timer of this.timers) if (timer.owner !== "primary") this.nativeClear(timer.handle);
          this.primary = undefined;
          this.timers.length = 0;
        } finally { for (const restore of this.restores.reverse()) restore(); }
      }
    }
  }
  assertRestored(): void {
    expect(this.primary, "captured callback discarded").toBeUndefined();
    expect(this.timers, "owned timer handles discarded").toEqual([]);
    for (const [object, key, descriptor] of this.snapshots) expect(Object.getOwnPropertyDescriptor(object, key), `restored ${String(key)} descriptor`).toEqual(descriptor);
    expect(this.work === undefined || this.settled, "pending probe settled before restoration").toBe(true);
  }
}
let controller: PrimaryDeadline | undefined;

async function probe(kind: "brain" | "claude", f: ReturnType<typeof fixture>, killer?: string, controlled = true) {
  const clock = new PrimaryDeadline(f, controlled);
  controller = clock;
  const observability = createRecordingObservability();
  let error: unknown;
  const started = Date.now();
  const work = clock.track((async () => {
    try {
      // The host path of the probe, which a server takes where no governed turn can run (#1648).
      if (kind === "brain") await probeBrainCliVersion(f.dir, observability.logger("brain"), { exec: { wrapper: f.wrapper, killer },
        boundary: createHostBoundary({ brainPath: f.dir, exec: { wrapper: f.wrapper, killer }, workerHost: () => ({ ok: false, requirement: "host-path fixture" }) }) });
      else await probeClaudeRuntime({ claudeCodePath: f.path, brainPath: f.dir, env: { PATH: process.env.PATH }, exec: { wrapper: f.wrapper, killer } });
    } catch (caught) { error = caught; }
  })());
  const settlementStarted = controlled ? await clock.deadline() : started;
  await work;
  // Controlled elapsed is explicit logical primary time plus native settlement.
  // The three native controls continue to measure the whole wall-clock interval.
  return { elapsed: (controlled ? 5_000 : 0) + Date.now() - settlementStarted, error, logs: observability.logs.find({ severity: "WARN" }) };
}

// 1.5 s permits loaded CI scheduling, not the fixture's eight-second lifetime.
const SETTLEMENT_MARGIN_MS = 1_500;
describe("boot probe deadline", () => {
  test("brain rejects a printed version when a TERM-ignoring command outlives its deadline", async () => {
    const f = fixture("0.42.0");
    // Also exercise the ordinary, unwrapped CLI launch.
    delete f.wrapper;
    const result = await probe("brain", f, undefined, false);
    expect(result.logs.map(log => String(log.body)).join("\n")).toContain("within 5 s");
    expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
    expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
  });
  for (const kind of ["brain", "claude"] as const) {
    for (const mode of ["missing", "failing", "hung", "noop"] as const) {
      test(`${kind} bounds cleanup with a ${mode} killer`, async () => {
        const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)");
        const killer = mode === "missing" ? join(f.dir, "absent") : executable(join(f.dir, "killer"),
          mode === "failing" ? "exit 3" : mode === "noop" ? "exit 0" : `echo $$ > '${f.dir}/helper.pid'\nexec sleep 8`);
        const result = await probe(kind, f, killer, mode !== "hung");
        expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
        expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
        const text = kind === "brain" ? result.logs.map(log => String(log.body)).join("\n") : String(result.error);
        expect(text).toContain("within 5 s");
        expect(text).toContain(mode === "missing" ? "could not be run" : mode === "failing" ? "exited 3" : mode === "hung" ? "helper cleanup is unconfirmed" : "Giving up waiting");
        if (mode === "noop") {
          const pid = Number(readFileSync(join(f.dir, "probe.pid"), "utf8"));
          // A zero helper exit is not proof that the target stopped.
          expect(() => process.kill(pid, 0)).not.toThrow();
        }
        if (mode === "hung") {
          const pid = Number(readFileSync(join(f.dir, "helper.pid"), "utf8"));
          expect(pid).toBeGreaterThan(0);
          const until = Date.now() + 500;
          let alive = true;
          while (alive && Date.now() < until) {
            try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
          }
          expect(alive).toBe(false);
        }
      });
    }
    test(`${kind} bounds inherited output pipes after the probe process exits`, async () => {
      const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)", dir =>
        `stdout_endpoint=$(readlink /proc/$$/fd/1)\nstderr_endpoint=$(readlink /proc/$$/fd/2)\nprintf '%s\\n' \"$stdout_endpoint\" > '${dir}/1.endpoint'\nprintf '%s\\n' \"$stderr_endpoint\" > '${dir}/2.endpoint'\nsleep 8 &\necho $! > '${dir}/descendant.owner.pid'\necho $! > '${dir}/descendant.pid'\nexit 0`);
      inheritedDirs.add(f.dir);
      delete f.wrapper;
      const result = await probe(kind, f);
      const pid = descendantPid(f.dir);
      const parent = Number(readFileSync(join(f.dir, "probe.pid"), "utf8"));
      expect(existsSync(`/proc/${parent}`), "the original probe parent has exited").toBe(false);
      inheritedEndpoints(f.dir, pid);
      expect(existsSync(join(f.dir, "descendant.pid")), "the descendant publishes its fixture-owned PID marker").toBe(true);
      expect(Number(readFileSync(join(f.dir, "descendant.pid"), "utf8"))).toBe(pid);
      const text = kind === "brain" ? result.logs.map(log => String(log.body)).join("\n") : String(result.error);
      expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
      expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
      expect(text).toContain("within 5 s");
      expect(text).toContain("Giving up waiting");
    });
    test(`${kind} calls the group killer at the deadline while the probe is alive`, async () => {
      const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)");
      const killer = executable(join(f.dir, "killer"), `state=dead\nkill -0 "$1" 2>/dev/null && state=alive\necho "$1 $2 $state" > '${f.dir}/killer.log'\nkill -"$2" -"$1"`);
      const result = await probe(kind, f, killer);
      const pid = readFileSync(join(f.dir, "probe.pid"), "utf8").trim();
      const record = join(f.dir, "killer.log");
      const until = Date.now() + 500;
      while (!existsSync(record) && Date.now() < until) await Bun.sleep(10);
      expect(existsSync(record)).toBe(true);
      expect(readFileSync(record, "utf8").trim()).toBe(`${pid} KILL alive`);
      expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
      expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
      expect(readFileSync(join(f.dir, "argv.log"), "utf8").trim().split("\n")).toEqual(["--version"]);
      if (kind === "claude") expect(String(result.error)).toContain("within 5 s");
      else expect(result.logs.map(log => String(log.body)).join("\n")).toContain("within 5 s");
    });
  }
});


describe("primary deadline ownership and restoration", () => {
  test("successful native exit and EOF cancel the captured primary", async () => {
    const f = fixture("0.42.0", "exit 0");
    delete f.wrapper;
    const clock = new PrimaryDeadline(f, true);
    controller = clock;
    const result = await clock.track(probeVersionCommand([f.path, "--version"], { cwd: f.dir, env: { PATH: process.env.PATH }, exec: {} }));
    expect(result.stdout.trim()).toBe("0.42.0");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    clock.checkTimers();
    clock.assertCancelled();
  });

  test("cleanup disappearance failure still settles native work and restores descriptors", async () => {
    const f = fixture("0.42.0", dir =>
      `stdout_endpoint=$(readlink /proc/$$/fd/1)\nstderr_endpoint=$(readlink /proc/$$/fd/2)\nprintf '%s\\n' "$stdout_endpoint" > '${dir}/1.endpoint'\nprintf '%s\\n' "$stderr_endpoint" > '${dir}/2.endpoint'\nsleep 8 &\necho $! > '${dir}/descendant.owner.pid'\necho $! > '${dir}/descendant.pid'\nexit 0`);
    inheritedDirs.add(f.dir);
    delete f.wrapper;
    const clock = new PrimaryDeadline(f, true);
    controller = clock;
    clock.track(probeVersionCommand([f.path, "--version"], { cwd: f.dir, env: { PATH: process.env.PATH }, exec: {} }));
    await clock.ready();
    expect(clock.settled, "failure witness starts with pending native work").toBe(false);
    controller = undefined;
    try {
      // Leave the positively identified native descendant alive so the real
      // disappearance assertion fails, rather than throwing a synthetic error.
      await expect(clock.dispose(async () => {
        try { await cleanupDescendant(f.dir, () => {}); }
        finally { await cleanupDescendant(f.dir); }
      })).rejects.toThrow("owned inherited-pipe descendant disappears after teardown");
      clock.assertRestored();
      expect(existsSync(`/proc/${descendantPid(f.dir)}`), "failure witness descendant finally disappeared").toBe(false);
    } finally { await cleanupDescendant(f.dir); }
  });
});


test("assertion failure joins pending native work before restoring the clock", async () => {
  const f = fixture("0.42.0");
  delete f.wrapper;
  const clock = new PrimaryDeadline(f, true);
  controller = clock;
  clock.track(probeVersionCommand([f.path, "--version"], { cwd: f.dir, env: { PATH: process.env.PATH }, exec: {} }));
  let failure: unknown;
  try {
    await clock.ready();
    expect(clock.settled).toBe(false);
    expect("deliberate assertion failure").toBe("passing control");
  } catch (error) { failure = error; }
  finally {
    controller = undefined;
    try { await clock.dispose(cleanupFixtures); }
    finally { clock.assertRestored(); }
  }
  expect(String(failure)).toContain("passing control");
});
