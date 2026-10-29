/** Real fork/FIFO ordering controls. Surrogates prove ordering, not historical allocation or frequency. */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cancellation from "../src/server/maintenance-worker-kill.js";
import { createWorkerPipes, fifoStream } from "../src/server/worker-pipes.js";

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
  for (const restore of restores.splice(0).reverse()) restore();
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
const bind = (worker: Parameters<typeof cancellation.killWorker>[0]) => cancellation.registerWorker?.(worker);
const complete = (worker: Parameters<typeof cancellation.killWorker>[0]) => cancellation.workerStopCompletion?.(worker) ?? Promise.resolve();
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const done = await until(() => f.o.exited && f.o.stdoutEOF && f.o.stderrEOF);
  receipt("output-settlement", { done, exited: f.o.exited, stdoutEOF: f.o.stdoutEOF, stderrEOF: f.o.stderrEOF, parent: identity(f.outer.pid), child: f.o.child && identity(f.o.child.pid) });
  expect(done, "SNAPSHOT_FORK_OUTPUT_MUST_SETTLE").toBe(true);
  if (f.o.child) expect(alive(f.o.child), "OWNED_CHILD_MUST_STOP").toBe(false);
}

test("snapshot fork ordering: first signal follows real fork acknowledgement", async () => {
  const f = await fixture(); const signals: string[] = []; let heartbeat = false;
  const worker = { pid: f.outer.pid, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; },
    kill(signal?: NodeJS.Signals) { if (!signals.length) injectFork(f); signals.push(signal!); f.outer.kill(signal); } };
  bind(worker); setTimeout(() => { heartbeat = true; }, 0);
  cancellation.killWorker(worker);
  await settled(f);
  await complete(worker);
  expect(heartbeat, "STOP_CONFIRMATION_MUST_YIELD").toBe(true);
  expect(signals, "SHARED_STOP_PRESERVES_MONITOR").toEqual(["SIGSTOP", "SIGCONT"]);
  expect(await f.outer.exited, "MONITOR_SELF_EXIT").toBe(37);
});

test("repeated cancellation shares one asynchronous stop and monitor exit", async () => {
  const f = await fixture(); const signals: string[] = []; let heartbeat = false;
  const worker = { pid: f.outer.pid, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; },
    kill(signal?: NodeJS.Signals) { if (!signals.length) injectFork(f); signals.push(signal!); f.outer.kill(signal); } };
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
  const f = await fixture(); const signals: string[] = [];
  const worker = { pid: f.outer.pid, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; },
    kill(signal?: NodeJS.Signals) { signals.push(signal!); f.outer.kill(signal); if (signal === "SIGSTOP") {
      const deadline = performance.now() + 500;
      while (identity(f.outer.pid)?.state !== "T" && performance.now() < deadline) Bun.sleepSync(1);
      expect(identity(f.outer.pid)?.state, "REAL_STOP_ACK_BEFORE_FORK_REQUEST").toBe("T");
      fs.writeSync(f.go, Buffer.from("g"));
    } } };
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
  const worker = { get pid() { return pid; }, get exitCode() { return f.outer.exitCode; }, get signalCode() { return f.outer.signalCode; },
    kill(signal?: NodeJS.Signals) { signals.push(signal!); other.outer.kill(signal); } };
  bind(worker); pid = other.outer.pid; cancellation.killWorker(worker); await complete(worker);
  expect(signals, "LAUNCH_IDENTITY_MUST_MATCH").toEqual([]);
  expect(alive(other.o.parent!), "FOREIGN_OWNED_CONTROL_MUST_SURVIVE").toBe(true);
});

test("unconfirmed stop resumes the matching outer and retains a cleanup failure", async () => {
  const f = await fixture(); injectFork(f); bind(f.outer); const signals: string[] = [];
  const nativeKill = f.outer.kill.bind(f.outer); const killSpy = spyOn(f.outer, "kill").mockImplementation(signal => { signals.push(String(signal)); nativeKill(signal); });
  restores.push(() => killSpy.mockRestore());
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = Reflect.apply(original, fs, [path, ...args]);
    if (String(path).startsWith(`/proc/${f.outer.pid}/task/`) && String(path).endsWith("/stat") && typeof value === "string") return value.replace(/\) [Tt] /, ") S ");
    return value;
  }) as typeof fs.readFileSync); restores.push(() => spy.mockRestore());
  cancellation.killWorker(f.outer);
  let failure: unknown; try { await complete(f.outer); } catch (error) { failure = error; }
  expect((failure as { cleanupUnconfirmed?: boolean })?.cleanupUnconfirmed, "UNCONFIRMED_STOP_MUST_RETAIN_FAILURE").toBe(true);
  expect(signals, "UNCONFIRMED_STOP_MUST_RESUME").toContain("SIGCONT");
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
  bind(f.outer); const signals: string[] = [];
  const nativeKill = f.outer.kill.bind(f.outer); const spy = spyOn(f.outer, "kill").mockImplementation(signal => { signals.push(String(signal)); nativeKill(signal); }); restores.push(() => spy.mockRestore());
  cancellation.killWorker(f.outer); await settled(f); await complete(f.outer);
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
