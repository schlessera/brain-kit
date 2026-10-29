/** Real fork/FIFO ordering controls. Surrogates prove ordering, not historical allocation or frequency. */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { createRequire } from "node:module";
import type { Pointer } from "bun:ffi";
const ffi = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
import { join } from "node:path";
import * as cancellation from "../src/server/maintenance-worker-kill.js";
import { createWorkerPipes, fifoStream } from "../src/server/worker-pipes.js";

type NativeLibrary = { symbols: {
  pidfd_open(pid: number, flags: number): number;
  pidfd_send_signal(fd: number, signal: number, info: null, flags: number): number;
  __errno_location(): Pointer | null;
} };
let nativeLibrary: NativeLibrary | undefined;
type SignalFn = NativeLibrary["symbols"]["pidfd_send_signal"];
let signalHook: ((fd: number, signal: number, info: null, flags: number, real: SignalFn) => number) | undefined;
let dlopenHook: (() => void) | undefined;
function hookSignal(hook: NonNullable<typeof signalHook>) {
  signalHook = hook; restores.push(() => { signalHook = undefined; });
}
const observers = new Map<number, { before(signal: NodeJS.Signals): void; after(signal: NodeJS.Signals): void }>();
const nativeRestores: (() => void)[] = [];
const nativeDlopen = ffi.dlopen;
const loader = spyOn(ffi, "dlopen").mockImplementation(((...args: unknown[]) => {
  dlopenHook?.();
  const library = Reflect.apply(nativeDlopen, ffi, args);
  if (typeof args[1] === "object" && args[1] !== null && "pidfd_open" in args[1]) {
    nativeLibrary = library as unknown as NativeLibrary;
    const original = nativeLibrary.symbols.pidfd_send_signal;
    const spy = spyOn(nativeLibrary.symbols, "pidfd_send_signal").mockImplementation((fd, signal, info, flags) => {
      let observer: ReturnType<typeof observers.get>;
      let name: NodeJS.Signals | undefined;
      if (signal) {
        try {
          const text = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
          const pid = Number(/^Pid:\s+(\d+)/m.exec(text)?.[1]);
          observer = observers.get(pid);
        } catch (error) {
          if (!["ENOENT", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        name = Object.entries(osConstants.signals).find(([, number]) => number === signal)?.[0] as NodeJS.Signals;
        if (observer && name) observer.before(name);
      }
      const result = signalHook ? signalHook(fd, signal, info, flags, original) : original(fd, signal, info, flags);
      if (observer && name && result === 0) observer.after(name);
      return result;
    });
    nativeRestores.push(() => spy.mockRestore());
  }
  return library;
}) as typeof ffi.dlopen);
afterAll(() => { for (const restore of nativeRestores.reverse()) restore(); loader.mockRestore(); });

type Identity = { pid: number; start: string; state: string };
function identity(pid: number): Identity | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? "")) throw Error("Invalid owned process identity");
    return { pid, start: fields[19]!, state: fields[0]! };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
const alive = (id: Identity) => { const now = identity(id.pid); return now?.start === id.start && !["Z", "X"].includes(now.state); };
const receipt = (kind: string, data: unknown) => console.error(JSON.stringify({ kind, data }));
async function until(predicate: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { if (predicate()) return true; await Bun.sleep(2); }
  return predicate();
}
const outerProgram = String.raw`
import os,sys,signal,threading
root=sys.argv[1]
if len(sys.argv)>2:
 threading.Thread(target=lambda:signal.pause(),daemon=True).start()
open(root+'/ready','w').write('ready')
f=os.open(root+'/go',os.O_RDONLY)
os.read(f,1)
child=os.fork()
if child==0:
 open(root+'/child-ready','w').write(str(os.getpid()))
 while True:signal.pause()
open(root+'/forked','w').write(str(child))
os.waitpid(child,0)
sys.exit(37)
`;
type Owner = {
  root?: string; fds: number[]; outer?: ReturnType<typeof Bun.spawn>; parent?: Identity; child?: Identity;
  pipes?: ReturnType<typeof createWorkerPipes>; input?: number; outputs?: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>; disposed?: Promise<void>; stdoutEOF: boolean; stderrEOF: boolean; exited: boolean;
};
const owners: Owner[] = [];
const restores: (() => void)[] = [];
const ownedCleanups: (() => Promise<void>)[] = [];
function dispose(owner: Owner): Promise<void> {
  return owner.disposed ??= (async () => {
    if (owner.timer) clearTimeout(owner.timer);
    const errors: unknown[] = [];
    try {
      if (!owner.child && owner.parent && alive(owner.parent)) {
        const children = fs.readFileSync(`/proc/${owner.parent.pid}/task/${owner.parent.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        for (const pid of children) {
          const id = identity(Number(pid));
          if (id && alive(id)) { receipt("cleanup-discovered-signal", id); process.kill(id.pid, "SIGKILL"); }
        }
      }
    } catch (error) { errors.push(error); }
    for (const id of [owner.child, owner.parent]) {
      try { if (id && alive(id)) { receipt("cleanup-signal", id); process.kill(id.pid, "SIGKILL"); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error); }
    }
    for (const id of [owner.child, owner.parent]) if (id && !await until(() => !alive(id), 1000)) errors.push(Error("Owned process survived cleanup"));
    if (owner.outputs && !await until(() => owner.exited && owner.stdoutEOF && owner.stderrEOF, 1000)) errors.push(Error("Cleanup output join failed"));
    if (owner.outer && owner.exited) receipt("cleanup-exit", { code: await owner.outer.exited, exitCode: owner.outer.exitCode, signalCode: owner.outer.signalCode });
    if (owner.input !== undefined) { try { fs.closeSync(owner.input); } catch (error) { errors.push(error); } }
    for (const fd of owner.fds.splice(0)) { try { fs.closeSync(fd); } catch (error) { errors.push(error); } }
    try { owner.pipes?.cleanup(); } catch (error) { errors.push(error); }
    if (owner.root) fs.rmSync(owner.root, { recursive: true, force: true });
    receipt("cleanup-complete", { errors: errors.map(String) });
    if (errors.length) throw new AggregateError(errors, "Owned cancellation fixture cleanup failed");
  })();
}
afterEach(async () => {
  observers.clear();
  for (const restore of restores.splice(0).reverse()) restore();
  await Promise.all(ownedCleanups.splice(0).map(cleanup => cleanup()));
  const errors = await Promise.allSettled(owners.splice(0).map(dispose));
  for (const result of errors) if (result.status === "rejected") throw result.reason;
});
async function fixture(threaded = false, command?: (root: string, go: number) => string[]) {
  const o: Owner = { fds: [], stdoutEOF: false, stderrEOF: false, exited: false };
  owners.push(o);
  o.timer = setTimeout(() => { void dispose(o).catch(error => receipt("watchdog-error", String(error))); }, 12_000);
  o.root = fs.mkdtempSync(join(tmpdir(), "odysseus-cancellation-"));
  const made = Bun.spawnSync(["mkfifo", "--mode=600", join(o.root, "go")]);
  expect(made.exitCode, made.stderr.toString()).toBe(0);
  const go = fs.openSync(join(o.root, "go"), fs.constants.O_RDWR); o.fds.push(go);
  o.pipes = createWorkerPipes();
  const outer = o.outer = Bun.spawn(command ? command(o.root, go) : ["python3", "-I", "-S", "-c", outerProgram, o.root, ...(threaded ? ["threaded"] : [])],
    { stdin: o.pipes.child[0], stdout: o.pipes.child[1], stderr: o.pipes.child[2], ...(command ? { stdio: [...o.pipes.child, go] } : {}) });
  o.parent = identity(outer.pid); expect(o.parent, "OWNED_OUTER_IDENTITY").toBeDefined();
  o.pipes.closeChild();
  const ends = o.pipes.take(); o.input = ends.stdin;
  o.outputs = Promise.all([new Response(fifoStream(ends.stdout)).text().then(value => { o.stdoutEOF = true; return value; }),
    new Response(fifoStream(ends.stderr)).text().then(value => { o.stderrEOF = true; return value; })]);
  void outer.exited.then(code => { o.exited = true; receipt("outer-exit", { code, exitCode: outer.exitCode, signalCode: outer.signalCode }); });
  if (!command) expect(await until(() => fs.existsSync(join(o.root!, "ready")), 3000), "OUTER_READY").toBe(true);
  return { o, outer, go };
}
function injectFork(f: Awaited<ReturnType<typeof fixture>>): void {
  fs.writeSync(f.go, Buffer.from("g"));
  const deadline = performance.now() + 500;
  while (!fs.existsSync(join(f.o.root!, "child-ready")) && performance.now() < deadline) Bun.sleepSync(1);
  expect(fs.existsSync(join(f.o.root!, "child-ready")), "FORK_ACK_REQUIRED").toBe(true);
  const pid = Number(fs.readFileSync(join(f.o.root!, "child-ready"), "utf8"));
  f.o.child = identity(pid); expect(f.o.child, "FORK_IDENTITY_REQUIRED").toBeDefined();
  expect(fs.readFileSync(`/proc/${f.outer.pid}/task/${f.outer.pid}/children`, "utf8").trim().split(/\s+/)).toContain(String(pid));
  for (const fd of [1, 2]) {
    const writer = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    expect(fs.statSync(`/proc/${pid}/fd/${fd}`).isFIFO(), "REAL_FIFO_WRITER").toBe(true);
    expect(writer).toBe(fs.readlinkSync(`/proc/${f.outer.pid}/fd/${fd}`));
  }
  receipt("fork-ack", { parent: f.o.parent, child: f.o.child, stdout: fs.readlinkSync(`/proc/${pid}/fd/1`), stderr: fs.readlinkSync(`/proc/${pid}/fd/2`),
    writers: [1, 2].map(fd => { const stat = fs.statSync(`/proc/${pid}/fd/${fd}`); return { fd, dev: stat.dev, ino: stat.ino, fifo: stat.isFIFO() }; }) });
}
function observed(f: Awaited<ReturnType<typeof fixture>>, beforeFirst?: (signal: NodeJS.Signals) => void,
  afterSignal?: (signal: NodeJS.Signals) => void) {
  const signals: NodeJS.Signals[] = [], delivered: NodeJS.Signals[] = [];
  const observer = { before(signal: NodeJS.Signals) { if (!signals.length) beforeFirst?.(signal); signals.push(signal); },
    after(signal: NodeJS.Signals) { delivered.push(signal); afterSignal?.(signal); } };
  observers.set(f.outer.pid, observer);
  const worker = { pid: f.outer.pid, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; },
    get exited() { return f.outer.exited; }, kill(signal: NodeJS.Signals = "SIGTERM") { observer.before(signal); f.outer.kill(signal); observer.after(signal); } };
  return { worker, signals, delivered };
}
const bind = (worker: Parameters<typeof cancellation.killWorker>[0]) => cancellation.registerWorker?.(worker);
const complete = (worker: Parameters<typeof cancellation.killWorker>[0]) => cancellation.workerStopCompletion?.(worker) ?? Promise.resolve();
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const done = await until(() => f.o.exited && f.o.stdoutEOF && f.o.stderrEOF);
  receipt("output-settlement", { done, exited: f.o.exited, stdoutEOF: f.o.stdoutEOF, stderrEOF: f.o.stderrEOF, parent: identity(f.outer.pid), child: f.o.child && identity(f.o.child.pid) });
  expect(done, "SNAPSHOT_FORK_OUTPUT_MUST_SETTLE").toBe(true);
  if (f.o.child) expect(alive(f.o.child), "OWNED_CHILD_MUST_STOP").toBe(false);
}

test("snapshot fork ordering: first signal follows real fork acknowledgement", async () => {
  const f = await fixture(); let heartbeat = false;
  const { worker, signals } = observed(f, () => injectFork(f));
  bind(worker); setTimeout(() => { heartbeat = true; }, 0);
  cancellation.killWorker(worker);
  await settled(f);
  await complete(worker);
  expect(heartbeat, "STOP_CONFIRMATION_MUST_YIELD").toBe(true);
  expect(signals, "SHARED_STOP_PRESERVES_MONITOR").toEqual(["SIGSTOP", "SIGCONT"]);
  expect(await f.outer.exited, "MONITOR_SELF_EXIT").toBe(37);
});

test("repeated cancellation shares one asynchronous stop and monitor exit", async () => {
  const f = await fixture(); let heartbeat = false;
  const { worker, signals } = observed(f, () => injectFork(f));
  bind(worker); setTimeout(() => { heartbeat = true; }, 0);
  cancellation.killWorker(worker); cancellation.killWorker(worker);
  await settled(f);
  await complete(worker);
  expect(heartbeat, "STOP_CONFIRMATION_MUST_YIELD").toBe(true);
  expect(signals, "SHARED_STOP_PRESERVES_MONITOR").toEqual(["SIGSTOP", "SIGCONT"]);
  expect(await f.outer.exited, "MONITOR_SELF_EXIT").toBe(37);
});

test("missing children file uses real PPid fallback", async () => {
  const f = await fixture(); injectFork(f); bind(f.outer);
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (String(path).startsWith(`/proc/${f.outer.pid}/task/`) && String(path).endsWith("/children")) throw Object.assign(Error("missing children fixture"), { code: "ENOENT" });
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
  cancellation.killWorker(f.outer); await settled(f); await complete(f.outer);
  expect(await f.outer.exited).toBe(37);
});

test("every thread must confirm stop before the snapshot", async () => {
  const f = await fixture(true); injectFork(f); bind(f.outer); let heartbeat = false, nonleaderRead = false, prematureSnapshot = false;
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    const name = String(path); const value = Reflect.apply(original, fs, [path, ...args]);
    if (name.startsWith(`/proc/${f.outer.pid}/task/`) && name.endsWith("/stat") && name !== `/proc/${f.outer.pid}/task/${f.outer.pid}/stat`) {
      nonleaderRead = true;
      if (!heartbeat && typeof value === "string") return value.replace(/\) [Tt] /, ") S ");
    }
    if (name.startsWith(`/proc/${f.outer.pid}/task/`) && name.endsWith("/children") && !heartbeat) prematureSnapshot = true;
    return value;
  }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
  setTimeout(() => { heartbeat = true; }, 10);
  cancellation.killWorker(f.outer); await settled(f); await complete(f.outer);
  expect(nonleaderRead && !prematureSnapshot, "ALL_THREADS_CONFIRMED_BEFORE_SNAPSHOT").toBe(true);
});

test("empty outer terminates and a fork request while stopped cannot create a child", async () => {
  const f = await fixture();
  const { worker, signals } = observed(f, undefined, signal => {
    if (signal === "SIGSTOP") {
      const deadline = performance.now() + 500;
      while (identity(f.outer.pid)?.state !== "T" && performance.now() < deadline) Bun.sleepSync(1);
      expect(identity(f.outer.pid)?.state, "REAL_STOP_ACK_BEFORE_FORK_REQUEST").toBe("T");
      fs.writeSync(f.go, Buffer.from("g"));
    }
  });
  bind(worker); cancellation.killWorker(worker); await settled(f); await complete(worker);
  expect(fs.existsSync(join(f.o.root!, "child-ready")), "STOPPED_OUTER_CANNOT_FORK").toBe(false);
  expect(signals).toEqual(["SIGSTOP", "SIGKILL"]);
});

test("known exited worker is a no-op", async () => {
  const f = await fixture(); bind(f.outer); f.outer.kill("SIGKILL"); await f.outer.exited;
  const spy = spyOn(f.outer, "kill"); restores.push(() => spy.mockRestore());
  cancellation.killWorker(f.outer); await complete(f.outer);
  expect(spy, "EXITED_WORKER_MUST_NOT_SIGNAL").not.toHaveBeenCalled();
});

test("changed launch identity cannot signal another owned process", async () => {
  const f = await fixture(), other = await fixture(); let pid = f.outer.pid; const signals: string[] = [];
  const worker = { get pid() { return pid; }, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; }, get exited() { return f.outer.exited; },
    kill(signal?: NodeJS.Signals) { signals.push(signal!); other.outer.kill(signal); } };
  bind(worker); pid = other.outer.pid; cancellation.killWorker(worker); await complete(worker);
  expect(signals, "LAUNCH_IDENTITY_MUST_MATCH").toEqual([]);
  expect(alive(other.o.parent!), "FOREIGN_OWNED_CONTROL_MUST_SURVIVE").toBe(true);
});

test("unconfirmed stop resumes the matching outer and retains a cleanup failure", async () => {
  const f = await fixture(); injectFork(f); const { worker, signals } = observed(f); bind(worker);
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = Reflect.apply(original, fs, [path, ...args]);
    if (String(path).startsWith(`/proc/${f.outer.pid}/task/`) && String(path).endsWith("/stat") && typeof value === "string") return value.replace(/\) [Tt] /, ") S ");
    return value;
  }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
  cancellation.killWorker(worker);
  let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "UNCONFIRMED_STOP_MUST_RETAIN_FAILURE").toBe(true);
  expect(signals, "UNCONFIRMED_STOP_MUST_RESUME").toContain("SIGCONT");
  expect(await until(() => f.o.exited), "UNCONFIRMED_OUTER_MUST_EXIT").toBe(true);
  // Unconfirmed stopping grants no numeric child authority. Confirm and clean
  // this fixture's orphan independently before joining its real FIFO EOF.
  if (f.o.child && alive(f.o.child)) { receipt("unconfirmed-owned-child-cleanup", f.o.child); process.kill(f.o.child.pid, "SIGKILL"); }
  await settled(f);
});

test("non-SIGKILL request retains the original outer signal", async () => {
  const f = await fixture(); bind(f.outer); cancellation.killWorker(f.outer, "SIGTERM"); await complete(f.outer); await settled(f);
  expect(f.outer.signalCode).toBe("SIGTERM");
});

test("normal ungated bwrap keeps init-first monitor exit semantics", async () => {
  const f = await fixture(false, root => ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/", "/", "--bind", root, root, "--proc", "/proc", "--dev", "/dev", "--", "/bin/sh", "-c", `printf ready > '${root}/ready'; exec sleep 30`]);
  expect(await until(() => fs.existsSync(join(f.o.root!, "ready")), 3000), "UNGATED_PAYLOAD_READY").toBe(true);
  const { worker, signals } = observed(f); bind(worker);
  cancellation.killWorker(worker); await settled(f); await complete(worker);
  expect(signals, "BWRAP_MONITOR_MUST_RESUME").toEqual(["SIGSTOP", "SIGCONT"]);
  expect(f.outer.signalCode, "BWRAP_MONITOR_SELF_EXIT").toBeNull();
  expect(f.outer.exitCode).toBe(137);
});


test("a later SIGKILL still escalates an ignored non-SIGKILL request", async () => {
  const program = outerProgram.replace("root=sys.argv[1]", "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nroot=sys.argv[1]");
  const f = await fixture(false, root => ["python3", "-I", "-S", "-c", program, root]);
  expect(await until(() => fs.existsSync(join(f.o.root!, "ready")), 3000)).toBe(true);
  bind(f.outer); cancellation.killWorker(f.outer, "SIGTERM");
  expect(alive(f.o.parent!), "IGNORED_TERM_CONTROL").toBe(true);
  cancellation.killWorker(f.outer, "SIGKILL"); await settled(f); await complete(f.outer);
  expect(f.outer.signalCode, "LATER_SIGKILL_MUST_ESCALATE").toBe("SIGKILL");
});

function pidfds(pid: number): number[] {
  return fs.readdirSync("/proc/self/fd").map(Number).filter(fd => {
    try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === "anon_inode:[pidfd]" && new RegExp(`^Pid:\\s+${pid}$`, "m").test(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
}
async function primeNative() {
  if (!nativeLibrary) {
    const f = await fixture(); bind(f.outer); f.outer.kill("SIGKILL"); await f.outer.exited; await complete(f.outer);
  }
  expect(nativeLibrary, "REAL_PIDFD_API_MUST_LOAD").toBeDefined();
  return nativeLibrary!;
}
function errorNumber(api: NativeLibrary, value: number): -1 {
  const pointer = api.symbols.__errno_location();
  if (!pointer) throw Error("Missing test errno location");
  new Int32Array(ffi.toArrayBuffer(pointer, 0, 4))[0] = value;
  return -1;
}
function failOpen(api: NativeLibrary) {
  const spy = spyOn(api.symbols, "pidfd_open").mockImplementation(() => errorNumber(api, 24));
  restores.push(() => spy.mockRestore());
  return spy;
}

test("native pidfd authority is held and closes once after actual exit and stop", async () => {
  await primeNative();
  const state: { fd?: number; closed: number; dev?: number; ino?: number } = { closed: 0 };
  ownedCleanups.push(async () => {
    if (state.fd !== undefined && !state.closed) {
      const stat = fs.fstatSync(state.fd);
      if (stat.dev === state.dev && stat.ino === state.ino) { receipt("owned-pidfd-cleanup", state); fs.closeSync(state.fd); }
    }
  });
  const f = await fixture(); const before = pidfds(f.outer.pid); bind(f.outer);
  const added = pidfds(f.outer.pid).filter(fd => !before.includes(fd));
  expect(added.length, "NATIVE_PIDFD_AUTHORITY_REQUIRED").toBe(1); state.fd = added[0]!;
  const stat = fs.fstatSync(state.fd); state.dev = stat.dev; state.ino = stat.ino;
  const realClose = fs.closeSync;
  const spy = spyOn(fs, "closeSync").mockImplementation(fd => { if (fd === state.fd) state.closed++; realClose(fd); }); restores.push(() => spy.mockRestore());
  cancellation.killWorker(f.outer); await settled(f); await complete(f.outer);
  expect(state.closed, "PIDFD_RELEASED_AFTER_EXIT").toBe(1);
  // Reuse only a descriptor allocated by this fixture; never overwrite a foreign fd.
  let reused = false;
  for (let i = 0; i < 64; i++) { const fd = fs.openSync("/dev/null", "r"); f.o.fds.push(fd); if (fd === state.fd) { reused = true; break; } if (fd > state.fd) break; }
  expect(reused, "OWNED_DESCRIPTOR_REUSE_PREMISE").toBe(true);
  let calls = 0;
  hookSignal((fd, signal, info, flags, real) => { calls++; return real(fd, signal, info, flags); });
  cancellation.killWorker(f.outer); await complete(f.outer);
  expect(calls, "CLOSED_AUTHORITY_MUST_NOT_SIGNAL_REUSED_FD").toBe(0);
  expect(fs.fstatSync(state.fd).isCharacterDevice(), "REUSED_OWNED_FD_REMAINS_OPEN").toBe(true);
  receipt("pidfd-lifetime", { fd: state.fd, closes: state.closed, reused, lateSignalCalls: calls, status: fs.readFileSync("/proc/self/status", "utf8"), label: fs.readFileSync("/proc/self/attr/current", "utf8") });
});

test("registration observation failure alone preserves normal uncancelled completion", async () => {
  const api = await primeNative();
  for (const kind of ["open", "proc", "missing"] as const) {
    const f = await fixture();
    let hit = 0;
    const originalOpen = api.symbols.pidfd_open, originalRead = fs.readFileSync;
    const open = spyOn(api.symbols, "pidfd_open").mockImplementation((pid, flags) => { if (kind === "open" && pid === f.outer.pid) { hit++; return errorNumber(api, 24); } return originalOpen(pid, flags); });
    const read = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => { if (kind !== "open" && String(path) === `/proc/${f.outer.pid}/stat`) { hit++; throw Object.assign(Error("registration observation"), { code: kind === "missing" ? "ENOENT" : "EMFILE" }); } return Reflect.apply(originalRead, fs, [path, ...args]); }) as typeof fs.readFileSync);
    bind(f.outer); open.mockRestore(); read.mockRestore();
    expect(hit, "REGISTRATION_FAULT_PREMISE").toBeGreaterThan(0);
    injectFork(f); process.kill(f.o.child!.pid, "SIGKILL"); await settled(f);
    let failure: unknown; try { await complete(f.outer); } catch (error) { failure = error; }
    expect(failure, "UNCANCELLED_NORMAL_EXIT_MUST_STAY_CLEAN").toBeUndefined();
    expect(await f.outer.exited).toBe(37);
  }
});

test("cancellation without authority never stops and remains unconfirmed", async () => {
  const api = await primeNative(), f = await fixture(); const { worker, signals } = observed(f);
  failOpen(api); bind(worker);
  cancellation.killWorker(worker);
  expect(signals, "NO_AUTHORITY_MUST_NOT_STOP").toEqual(["SIGKILL"]);
  let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "NO_AUTHORITY_MUST_RETAIN_FAILURE").toBe(true);
  await settled(f);
});

test("changed registration parent cannot acquire authority", async () => {
  await primeNative(); const f = await fixture(); const before = pidfds(f.outer.pid);
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = Reflect.apply(original, fs, [path, ...args]);
    if (String(path) === `/proc/${f.outer.pid}/stat` && typeof value === "string") return value.replace(/\) (\S+) \d+ /, ") $1 1 ");
    return value;
  }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
  bind(f.outer);
  expect(pidfds(f.outer.pid), "FOREIGN_PARENT_MUST_NOT_BIND_AUTHORITY").toEqual(before);
});

for (const fault of ["stop", "scan", "child", "resume"] as const) {
  test(`proc observation ${fault} failure cannot leave the owned outer frozen`, async () => {
    await primeNative(); const f = await fixture(); injectFork(f);
    const { worker, signals, delivered } = observed(f); bind(worker);
    const original = fs.readFileSync; let hit = 0, afterResume = 0, measuring = true;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
      const name = String(path);
      if (fault === "resume" && measuring && (signals.includes("SIGKILL") || signals.includes("SIGCONT")) &&
        name.startsWith("/proc/") && !name.startsWith("/proc/self/")) afterResume++;
      const selected = fault === "child" ? name === `/proc/${f.o.child!.pid}/stat`
        : fault === "scan" ? name.startsWith(`/proc/${f.outer.pid}/task/`) && name.endsWith("/children")
        : name.startsWith(`/proc/${f.outer.pid}/task/`) && name.endsWith("/stat");
      if (selected && signals.includes("SIGSTOP")) { hit++; throw Object.assign(Error("owned proc observation fault"), { code: fault === "scan" ? "EACCES" : "EMFILE" }); }
      return Reflect.apply(original, fs, [path, ...args]);
    }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
    cancellation.killWorker(worker);
    let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
    measuring = false;
    receipt("proc-fault", { fault, hit, signals, delivered, afterResume });
    expect(afterResume, "RESUME_MUST_NOT_READ_PROC").toBe(0);
    expect(hit, "PROC_FAULT_MUST_BE_REACHED").toBeGreaterThan(0);
    expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "PROC_FAILURE_MUST_RETAIN_OWNERSHIP").toBe(true);
    expect(await until(() => f.o.exited), "PROC_FAILURE_OUTER_MUST_EXIT").toBe(true);
    expect(alive(f.o.parent!), "PROC_FAILURE_OUTER_MUST_NOT_STAY_FROZEN").toBe(false);
    expect(signals, "PROC_FAILURE_PIDFD_SEQUENCE").toEqual(["SIGSTOP", "SIGKILL", "SIGCONT"]);
    // A pre-handshake child need not die with its outer. Retain and clean the
    // actual owned child independently; never turn that fallback into clean proof.
    spy.mockRestore();
    if (f.o.child && alive(f.o.child)) { receipt("unconfirmed-owned-child-cleanup", f.o.child); process.kill(f.o.child.pid, "SIGKILL"); }
    await settled(f);
  });
}

test("unexpected pidfd errno falls back and stays unconfirmed", async () => {
  const api = await primeNative(), f = await fixture(); const { worker, signals, delivered } = observed(f); bind(worker);
  let injected = false;
  hookSignal((fd, signal, info, flags, real) => {
    if (signal === osConstants.signals.SIGSTOP && !injected) { injected = true; return errorNumber(api, 22); }
    return real(fd, signal, info, flags);
  });
  cancellation.killWorker(worker, "SIGTERM"); await settled(f);
  let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
  expect(injected, "UNEXPECTED_ERRNO_PREMISE").toBe(true);
  receipt("unexpected-errno", { hit: injected, signals, delivered, afterResume: 0 });
  expect(signals, "UNEXPECTED_ERRNO_ATTEMPTS").toEqual(["SIGSTOP", "SIGKILL"]);
  expect(delivered, "FAILED_STOP_NOT_DELIVERED").toEqual(["SIGKILL"]);
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "UNEXPECTED_ERRNO_REMAINS_UNCONFIRMED").toBe(true);
});

test("actual ESRCH after reap stops all further pidfd signals", async () => {
  const api = await primeNative(), f = await fixture();
  let finish!: (code: number) => void;
  const delayedExit = new Promise<number>(resolve => { finish = resolve; });
  const wrapper = { pid: f.outer.pid, exitCode: null, signalCode: null, exited: delayedExit, kill: f.outer.kill.bind(f.outer) };
  ownedCleanups.push(async () => {
    if (f.o.parent && alive(f.o.parent)) process.kill(f.o.parent.pid, "SIGKILL");
    finish(await f.outer.exited); await complete(wrapper);
  });
  bind(wrapper);
  const originalRead = fs.readFileSync;
  let stopped = false, esrch = false, after = 0;
  const signals: number[] = [], delivered: number[] = [];
  hookSignal((fd, signal, info, flags, real) => {
    if (esrch) after++;
    signals.push(signal);
    const result = real(fd, signal, info, flags);
    const errno = result < 0 ? ffi.read.i32(api.symbols.__errno_location()!, 0) : 0;
    if (errno === 3) esrch = true;
    if (result === 0) delivered.push(signal);
    if (signal === osConstants.signals.SIGSTOP && !stopped) { stopped = true; f.outer.kill("SIGKILL"); }
    return result;
  });
  const read = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = Reflect.apply(originalRead, fs, [path, ...args]);
    if (String(path).startsWith(`/proc/${f.outer.pid}/task/`) && String(path).endsWith("/stat") && typeof value === "string") return value.replace(/\) Z /, ") S ");
    return value;
  }) as typeof fs.readFileSync); restores.push(() => read.mockRestore());
  cancellation.killWorker(wrapper); await settled(f); await complete(wrapper);
  receipt("actual-esrch", { hit: esrch, stopped, after, signals, delivered, afterResume: 0 });
  expect(esrch, "ACTUAL_REAP_MUST_RETURN_ESRCH").toBe(true);
  expect(after, "NO_SIGNAL_AFTER_ESRCH").toBe(0);
  finish(await f.outer.exited); await complete(wrapper);
});

test("non-SIGKILL visible child keeps normal monitor exit", async () => {
  await primeNative(); const f = await fixture(); injectFork(f); const { worker, signals } = observed(f); bind(worker);
  cancellation.killWorker(worker, "SIGTERM"); await complete(worker);
  expect(signals, "VISIBLE_CHILD_MONITOR_SEMANTICS").toEqual(["SIGSTOP", "SIGCONT"]);
  await settled(f);
  expect(await f.outer.exited).toBe(37);
});

for (const scenario of ["open-normal", "proc-normal", "cancel"] as const) {
  const cancel = scenario === "cancel";
  test(`real maintenance registration ${scenario === "proc-normal" ? "proc " : ""}failure ${cancel ? "retains cancelled ownership" : "closes input and releases on normal exit"}`, async () => {
    const api = await primeNative();
    const modulePath = "../src/server/maintenance-worker.js";
    const fixturePath = "./helpers/worker-startup-view-fixture.js";
    const budgetPath = "../src/server/maintenance-temp-budget.js";
    const pipesPath = "../src/server/worker-pipes.js";
    const { launchMaintenanceWorker } = await import(modulePath) as typeof import("../src/server/maintenance-worker.js");
    const { createFixtureMaintenanceHost } = await import(fixturePath) as typeof import("./helpers/worker-startup-view-fixture.js");
    const budget = await import(budgetPath) as typeof import("../src/server/maintenance-temp-budget.js");
    const pipes = await import(pipesPath) as typeof import("../src/server/worker-pipes.js");
    const state: { root?: string; host?: ReturnType<typeof createFixtureMaintenanceHost>; worker?: ReturnType<typeof launchMaintenanceWorker>;
      reservation?: ReturnType<typeof budget.reserveMaintenanceTemp>; identity?: Identity; input?: number; closed: boolean; releases: number; timer?: ReturnType<typeof setTimeout>; } = { closed: false, releases: 0 };
    let cleanupPending: Promise<void> | undefined;
    const cleanup = () => cleanupPending ??= (async () => {
      if (state.timer) clearTimeout(state.timer);
      if (state.identity && alive(state.identity)) { receipt("maintenance-owned-final-kill", state.identity); process.kill(state.identity.pid, "SIGKILL"); }
      if (state.worker) { if (!state.closed) await state.worker.input(""); await state.worker.exited.catch(() => {}); await state.worker.released(); }
      state.reservation?.release(); state.host?.cleanup();
      if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
    })();
    ownedCleanups.push(cleanup);
    state.timer = setTimeout(() => { void cleanup().catch(error => receipt("maintenance-watchdog-error", String(error))); }, 12_000);
    state.root = fs.mkdtempSync(join(tmpdir(), "odysseus-maintenance-owner-"));
    state.host = createFixtureMaintenanceHost(state.root);
    const reserve = budget.reserveMaintenanceTemp;
    const reserveSpy = spyOn(budget, "reserveMaintenanceTemp").mockImplementation((...args) => {
      const reservation = reserve(...args); state.reservation = reservation;
      return { ...reservation, release() { state.releases++; reservation.release(); } };
    }); restores.push(() => reserveSpy.mockRestore());
    const create = pipes.createWorkerPipesSteps;
    const pipeSpy = spyOn(pipes, "createWorkerPipesSteps").mockImplementation(function* () {
      const result = yield* create(); const take = result.take.bind(result);
      result.take = () => { const ends = take(); state.input = ends.stdin; return ends; }; return result;
    }); restores.push(() => pipeSpy.mockRestore());
    const close = fs.closeSync;
    const closeSpy = spyOn(fs, "closeSync").mockImplementation(fd => { if (state.input === fd) state.closed = true; close(fd); }); restores.push(() => closeSpy.mockRestore());
    let registrationPid: number | undefined, registrationFaults = 0;
    const originalOpen = api.symbols.pidfd_open, originalRead = fs.readFileSync;
    const openFault = spyOn(api.symbols, "pidfd_open").mockImplementation((pid, flags) => {
      registrationPid = pid;
      if (scenario !== "proc-normal") { registrationFaults++; return errorNumber(api, 24); }
      return originalOpen(pid, flags);
    }); restores.push(() => openFault.mockRestore());
    const procFault = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (scenario === "proc-normal" && registrationPid !== undefined && String(path) === `/proc/${registrationPid}/stat`) {
        registrationFaults++; throw Object.assign(Error("maintenance registration observation"), { code: "EMFILE" });
      }
      return Reflect.apply(originalRead, fs, [path, ...args]);
    }) as typeof fs.readFileSync); restores.push(() => procFault.mockRestore());
    const worker = state.worker = launchMaintenanceWorker({ ...state.host, brainPath: state.root,
      command: ["/bin/sh", "-c", cancel ? "printf ready; exec sleep 30" : "printf ready; exit 0"], env: { PATH: "/usr/bin:/bin" }, credentials: false });
    procFault.mockRestore();
    expect(registrationPid === worker.pid && registrationFaults > 0, "ACTUAL_MAINTENANCE_REGISTRATION_FAULT").toBe(true);
    state.identity = identity(worker.pid);
    const completion = worker.exited.then(code => ({ code }), error => ({ error }));
    const reader = worker.stdout.getReader(); const first = await reader.read();
    expect(new TextDecoder().decode(first.value), "ACTUAL_MAINTENANCE_PAYLOAD_STARTED").toBe("ready");
    const drain = (async () => { while (!(await reader.read()).done) { /* Drain actual EOF. */ } })();
    const stderr = new Response(worker.stderr).text();
    if (cancel) worker.kill("SIGKILL");
    const outcome = await completion; await Promise.all([drain, stderr]);
    if (cancel) {
      expect("error" in outcome && (outcome.error as { cleanupUnconfirmed?: boolean }).cleanupUnconfirmed, "CANCELLED_NO_AUTHORITY_OWNER_RETAINS_FAILURE").toBe(true);
      expect(state.releases, "CANCELLED_NO_AUTHORITY_RESERVATION_RETAINED").toBe(0);
    } else {
      expect(outcome, "NORMAL_REGISTRATION_ERROR_MUST_NOT_POISON_EXIT").toEqual({ code: 0 });
      expect(state.closed, "NORMAL_EXIT_MUST_CLOSE_INPUT").toBe(true);
      expect(state.releases, "NORMAL_EXIT_MUST_RELEASE_RESERVATION").toBe(1);
    }
    receipt("maintenance-owner-outcome", { cancel, outcome: "code" in outcome ? outcome : { unconfirmed: true }, closed: state.closed, releases: state.releases });
  });
}

test("unavailable lazy FFI remains an unconfirmed no-stop cancellation", async () => {
  const isolatedPath = "../src/server/maintenance-worker-kill.ts?no-native-api";
  const isolated = await import(isolatedPath) as typeof cancellation;
  expect(isolated.registerWorker !== cancellation.registerWorker, "FRESH_LOADER_ISOLATION").toBe(true);
  const f = await fixture(); const { worker, signals } = observed(f); let hit = false;
  dlopenHook = () => { hit = true; throw Error("unavailable FFI fixture"); };
  restores.push(() => { dlopenHook = undefined; });
  const before = pidfds(f.outer.pid);
  isolated.registerWorker(worker);
  expect(pidfds(f.outer.pid), "UNAVAILABLE_FFI_MUST_NOT_BIND").toEqual(before);
  isolated.killWorker(worker);
  expect(hit, "LAZY_FFI_FAILURE_PREMISE").toBe(true);
  expect(signals, "UNAVAILABLE_FFI_MUST_NOT_STOP").toEqual(["SIGKILL"]);
  let failure: unknown; try { await isolated.workerStopCompletion(worker); } catch (error) { failure = error; }
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "UNAVAILABLE_FFI_REMAINS_UNCONFIRMED").toBe(true);
  await settled(f);
});

for (const ignored of [false, true]) {
  test(`no-authority requested SIGTERM ${ignored ? "can later escalate" : "preserves the requested signal"}`, async () => {
    const api = await primeNative();
    const program = ignored ? outerProgram.replace("root=sys.argv[1]", "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nroot=sys.argv[1]") : outerProgram;
    const f = await fixture(false, root => ["python3", "-I", "-S", "-c", program, root]);
    expect(await until(() => fs.existsSync(join(f.o.root!, "ready")), 3000), "NO_AUTHORITY_TERM_READY").toBe(true);
    const { worker, signals, delivered } = observed(f);
    failOpen(api); bind(worker);
    cancellation.killWorker(worker, "SIGTERM");
    let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
    expect(signals, "NO_AUTHORITY_REQUESTED_SIGNAL").toEqual(["SIGTERM"]);
    expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "NO_AUTHORITY_TERM_REMAINS_UNCONFIRMED").toBe(true);
    if (ignored) {
      expect(alive(f.o.parent!), "NO_AUTHORITY_IGNORED_TERM_STILL_LIVE").toBe(true);
      cancellation.killWorker(worker, "SIGKILL");
      try { await complete(worker); } catch { /* The first unconfirmed result remains authoritative. */ }
    }
    await settled(f);
    expect(f.outer.signalCode, "NO_AUTHORITY_FINAL_REQUESTED_SIGNAL").toBe(ignored ? "SIGKILL" : "SIGTERM");
    expect(signals, "NO_AUTHORITY_ESCALATION_SEQUENCE").toEqual(ignored ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
    receipt("no-authority-request", { ignored, signals, delivered, unconfirmed: true });
  });
}

test("negative pidfd open with zero errno cannot bind or signal an invalid descriptor", async () => {
  const api = await primeNative(), f = await fixture();
  let hit = 0, invalidSignals = 0;
  const open = spyOn(api.symbols, "pidfd_open").mockImplementation(() => { hit++; return errorNumber(api, 0); });
  restores.push(() => open.mockRestore());
  hookSignal((fd, signal, info, flags, real) => { if (fd < 0) invalidSignals++; return real(fd, signal, info, flags); });
  const { worker, signals } = observed(f); bind(worker);
  expect(hit, "ZERO_ERRNO_OPEN_FAULT_REACHED").toBe(1);
  expect(invalidSignals, "NEGATIVE_OPEN_MUST_NOT_SIGNAL").toBe(0);
  cancellation.killWorker(worker); await settled(f);
  let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
  expect(signals, "NEGATIVE_OPEN_MUST_NOT_STOP").toEqual(["SIGKILL"]);
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "NEGATIVE_OPEN_REMAINS_UNCONFIRMED").toBe(true);
  receipt("zero-errno-open", { hit, invalidSignals, signals });
});

test("negative pidfd signal with zero errno is a failed delivery", async () => {
  const api = await primeNative(), f = await fixture(); const { worker, signals, delivered } = observed(f); bind(worker);
  let hit = 0;
  hookSignal((fd, signal, info, flags, real) => {
    if (signal === osConstants.signals.SIGSTOP) { hit++; return errorNumber(api, 0); }
    return real(fd, signal, info, flags);
  });
  cancellation.killWorker(worker); await settled(f);
  let failure: unknown; try { await complete(worker); } catch (error) { failure = error; }
  expect(hit, "ZERO_ERRNO_SIGNAL_FAULT_REACHED").toBe(1);
  expect(signals, "NEGATIVE_SIGNAL_MUST_NOT_COUNT_AS_SENT").toEqual(["SIGSTOP", "SIGKILL"]);
  expect(delivered, "NEGATIVE_SIGNAL_NOT_DELIVERED").toEqual(["SIGKILL"]);
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "NEGATIVE_SIGNAL_REMAINS_UNCONFIRMED").toBe(true);
  receipt("zero-errno-signal", { hit, signals, delivered });
});
