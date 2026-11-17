/** Owned socket controls in private mount/network namespaces; no service receives bytes. */
import * as fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { startEgressProxy } from "../../src/server/egress-proxy.js";
import { workerCommand, type WorkerLaunch } from "../../src/server/worker-launcher.js";
import { maintenanceLaunch } from "../../src/server/maintenance-worker.js";
import { createFixtureWorkerStartupView, type WorkerStartupView } from "../helpers/worker-startup-view-fixture.js";

const root = "/opt/odysseus-var-fixture", brain = join(root, "brain"), walkControl = join(root, "inherited/walk-control.sock");
const cups = "/var/snap/cups/common/run/cups.sock";
const paths = ["/var/tmp/odysseus/host.sock", "/var/spool/odysseus/host.sock", "/var/snap/odysseus/host.sock",
  "/var/lib/odysseus-runtime/host.sock"];
/** Whether `path` is `top` or below it. */
function within(path: string, top: string) {
  return path === top || path.startsWith(top === "/" ? "/" : top + "/");
}

/**
 * Every socket in the visible tree outside `/proc` and `/sys`, entering only
 * the directories `descend` admits. Each entry's type comes from `readdir`;
 * only entries the filesystem left untyped, and the mount points in the
 * walking process's `/proc/self/mountinfo`, are stat'ed. A mount does not
 * change the type `readdir` reports for its mount point, so a socket
 * bind-mounted onto a file path reads as that regular file (#2745). Up to 32
 * directories are read at once, so a cold disk is not read one block at a time.
 * `progress`, when given, holds the directories being read and the entries
 * seen so far, so a walk that overruns its deadline names where it is (#3545).
 * Workers receive the source of `within` and the three functions from here
 * on, so they refer to nothing else.
 */
async function walkSockets(files: typeof fs, descend: (path: string) => boolean,
  progress: { reading: Set<string>; entries: number; queued: number } = { reading: new Set(), entries: 0, queued: 0 }) {
  const sockets: string[] = [], queue = ["/"];
  let entries = 0, active = 0;
  const points = new Set(files.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n")
    .map(line => line.split(" ")[4]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))));
  const typed = (entry: fs.Dirent) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink() || entry.isSocket()
    || entry.isFIFO() || entry.isCharacterDevice() || entry.isBlockDevice();
  const read = async (path: string) => {
    let list: fs.Dirent[];
    progress.reading.add(path);
    try { list = await files.promises.readdir(path, { withFileTypes: true }); } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) return;
      throw error;
    } finally { progress.reading.delete(path); }
    for (const entry of list) {
      const child = path === "/" ? "/" + entry.name : path + "/" + entry.name;
      progress.entries = ++entries;
      let kind: { isDirectory(): boolean; isSocket(): boolean } = entry;
      if (!typed(entry) || points.has(child)) {
        progress.reading.add(child);
        try { kind = await files.promises.lstat(child); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        } finally { progress.reading.delete(child); }
      }
      if (kind.isDirectory()) { if (child !== "/proc" && child !== "/sys" && descend(child)) queue.push(child); }
      else if (kind.isSocket()) sockets.push(child);
    }
  };
  await new Promise<void>((done, fail) => {
    const pump = () => {
      progress.queued = queue.length;
      if (queue.length === 0 && active === 0) return done();
      while (active < 32 && queue.length > 0) { active++; read(queue.pop()!).then(() => { active--; pump(); }, fail); }
    };
    pump();
  });
  return { sockets, entries };
}

/**
 * Each mount point's stack, bottom first, as what each mount shows: device,
 * root within it, type and source. A stack that is not one chain maps to
 * undefined, which matches nothing.
 */
function mountStacks(mountinfo: string) {
  const unescape = (text: string) => text.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = mountinfo.trim().split("\n").map(line => {
    const [id, parent, device, root, point] = line.split(" ");
    const [type, source] = line.slice(line.indexOf(" - ") + 3).split(" ");
    return { id, parent, point: unescape(point!), shows: [device, unescape(root!), type, source].join(" ") };
  });
  const stacks = new Map<string, string | undefined>();
  for (const point of new Set(mounts.map(mount => mount.point))) {
    const here = mounts.filter(mount => mount.point === point), ids = new Set(here.map(mount => mount.id)), stack: string[] = [];
    for (let mount = here.find(base => !ids.has(base.parent)); mount; mount = here.find(next => next.parent === mount!.id)) stack.push(mount.shows);
    stacks.set(point, stack.length === here.length ? stack.join("\n") : undefined);
  }
  return stacks;
}

/**
 * The mount points, outside `/proc` and `/sys`, whose stacks differ between
 * two views. Looking up a path that is not one of these points or below one
 * crosses the same mounts in both views, so both show the same entry there.
 */
function changedMounts(view: string, base: string) {
  const mine = mountStacks(view), theirs = mountStacks(base);
  return [...new Set([...mine.keys(), ...theirs.keys()])].filter(point => !within(point, "/proc") && !within(point, "/sys")
    && (mine.get(point) === undefined || mine.get(point) !== theirs.get(point))).sort();
}

/**
 * Every step below runs under its own deadline (#3545). One that overruns
 * fails with `VAR_SOCKET_PHASE_DEADLINE <phase>` and what it was doing,
 * rather than running silently into the test's deadline. Each phase's start
 * and duration go to stderr as it happens, so a run stopped from outside
 * still shows how far it got. The budgets bound a stall well above any
 * hosted pass; they do not set the expected speed.
 */
const began = performance.now();
const since = (start: number) => Math.round(performance.now() - start);
async function phase<T>(name: string, limitMs: number, work: () => Promise<T>, detail: () => unknown = () => null): Promise<T> {
  const started = performance.now();
  console.error("VAR_SOCKET_PHASE_START " + JSON.stringify({ phase: name, at: since(began) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(Error(`VAR_SOCKET_PHASE_DEADLINE ${name} exceeded ${limitMs} ms: ${JSON.stringify(detail())}`)), limitMs);
    })]);
  } finally {
    clearTimeout(timer);
    console.error("VAR_SOCKET_PHASE " + JSON.stringify({ phase: name, ms: since(started), at: since(began) }));
  }
}

/** A stream's text so far, and all of it once the stream ends. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text += decoder.decode();
  })();
  return { text: () => text, done };
}

/**
 * Runs one worker without blocking this process's event loop, under its own
 * deadline. An overrun kills the worker's bubblewrap, which takes the worker
 * with it (`--die-with-parent`), and fails with `VAR_SOCKET_CHILD_DEADLINE`,
 * the worker's last stage and whatever it printed.
 */
async function run(name: string, command: string[], limitMs: number) {
  const child = Bun.spawn(command, { env: {}, stdout: "pipe", stderr: "pipe" });
  const stdout = collect(child.stdout), stderr = collect(child.stderr), started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([Promise.all([stdout.done, stderr.done, child.exited]).then(([, , code]) => code),
    new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), limitMs); })]);
  clearTimeout(timer);
  if (exit === undefined) {
    child.kill("SIGKILL");
    throw Error(`VAR_SOCKET_CHILD_DEADLINE ${name} exceeded ${limitMs} ms: `
      + JSON.stringify({ stdout: stdout.text().slice(-2000), stderr: stderr.text().slice(-4000) }));
  }
  console.error("VAR_SOCKET_CHILD " + JSON.stringify({ child: name, exit, ms: since(started) }));
  return { exit, stdout: stdout.text(), stderr: stderr.text() };
}

const servers: Server[] = [];
async function listen(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(socket => { socket.on("error", () => {}); socket.end(); });
  servers.push(server);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  return server;
}
const reach = (path: string) => new Promise<boolean | string>(done => {
  const socket = connect(path);
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", error => done((error as NodeJS.ErrnoException).code!));
});
const runtime = "/var/lib/odysseus-runtime/bun", input = "/var/lib/odysseus-runtime/ithaca.txt";
mkdirSync(dirname(runtime), { recursive: true });
const copyStarted = performance.now();
copyFileSync(process.execPath, runtime);
writeFileSync(input, "Odysseus reaches Ithaca");
console.error("VAR_SOCKET_PHASE " + JSON.stringify({ phase: "runtime copy", ms: since(copyStarted), at: since(began) }));
const proxy = await phase("egress proxy", 30_000, () => startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 1024 * 1024, observe() {} }));
const workers: Record<string, unknown> = {};
let walk: unknown;
try {
  const hostControls = await phase("host sockets", 30_000, async () => {
    for (const path of paths) await listen(path);
    return Promise.all(paths.map(reach));
  });
  const controlPath = join(root, "unmasked.sock"), controlServer = await listen(controlPath);
  // A real worker, using the same host-root layout, reaches an unmasked socket.
  const controlLaunch: WorkerLaunch = { brainPath: brain, sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [], readPaths: [runtime] },
    env: {}, command: [runtime, "--no-env-file", "-e", `const s=require("node:net").connect(${JSON.stringify(controlPath)});s.on("connect",()=>{s.destroy();console.log("connected")});s.on("error",e=>{throw e});`] };
  const control = await phase("unmasked control", 60_000, () => run("unmasked control", workerCommand(controlLaunch), 50_000));
  if (control.exit !== 0) throw Error(control.stderr);
  await new Promise<void>((done, reject) => controlServer.close(error => error ? reject(error) : done()));
  await listen(join(proxy.dir, "inference.sock"));
  // The walk's own positive control: a socket every profile inherits unmasked,
  // in a directory no worker mount touches, so only the baseline can show it.
  await listen(walkControl);
  const profiles = ["governed", "strict", "maintenance"] as const;
  const launch = (profile: typeof profiles[number], view: WorkerStartupView | undefined, program: string): WorkerLaunch => profile === "maintenance"
    ? maintenanceLaunch({ brainPath: brain, startupView: view, credentials: false, readPaths: [runtime, input], env: {}, command: [runtime, "--no-env-file", "-e", program] })
    : { brainPath: brain, ...(view ? { startupView: view } : {}), env: {}, command: [runtime, "--no-env-file", "-e", program], egress: { proxyDir: proxy.dir },
      sandbox: { brain, profile, restricted: false, areas: [], scratchAliasesRemoved: [], readPaths: [runtime, input] } };
  const viewsStarted = performance.now();
  const views = profiles.map(profile => profile === "governed" ? undefined : createFixtureWorkerStartupView(brain));
  console.error("VAR_SOCKET_PHASE " + JSON.stringify({ phase: "startup views", ms: since(viewsStarted), at: since(began) }));
  try {
    // Only the mounts a worker changes can show it something the fixture's own
    // view does not. The fixture walks its view once, wherever some profile
    // inherits it; each worker reads only the subtrees below its changed mount
    // points and lstats the baseline's sockets everywhere else (#2674).
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    const changed = await phase("mount probes", 60_000, () => Promise.all(profiles.map(async (profile, index) => {
      const probe = await run(`${profile} mount probe`, workerCommand(launch(profile, views[index],
        `process.stdout.write(require("node:fs").readFileSync("/proc/self/mountinfo","utf8"))`)), 50_000);
      if (probe.exit !== 0) throw Error(`${profile} mount probe: ${probe.stderr}`);
      return changedMounts(probe.stdout, mountinfo);
    })));
    const skipped: string[] = [];
    const inherited = (path: string) => changed.some(points => !points.some(point => within(path, point))) || (skipped.push(path), false);
    const progress = { reading: new Set<string>(), entries: 0, queued: 0 };
    const baseline = { mountinfo, skipped, ...await phase("baseline walk", 120_000, () => walkSockets(fs, inherited, progress),
      () => ({ entries: progress.entries, queued: progress.queued, reading: [...progress.reading].slice(0, 32) })) };
    writeFileSync(join(root, "walk-baseline.json"), JSON.stringify(baseline));
    // A worker refuses a baseline that skipped anything its own mounts leave
    // as the fixture sees it. It reports each stage on stderr, so a worker
    // stopped at its deadline shows which stage it was in.
    const program = `const fs=require("node:fs"), net=require("node:net");
      const stage=name=>console.error("VAR_SOCKET_WORKER_STAGE "+JSON.stringify({stage:name,ms:Math.round(performance.now()-started)}));
      const reach=path=>new Promise(done=>{const s=net.connect(path);s.once("connect",()=>{s.destroy();done(true)});s.once("error",e=>done(e.code))});
      const within=${within}, walkSockets=${walkSockets}, mountStacks=${mountStacks}, changedMounts=${changedMounts}, started=performance.now();
      stage("started");
      const baseline=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "walk-baseline.json"))},"utf8")), mountinfo=fs.readFileSync("/proc/self/mountinfo","utf8");
      const changed=changedMounts(mountinfo,baseline.mountinfo);
      const uncovered=baseline.skipped.filter(path=>!changed.some(point=>within(path,point)));
      if(uncovered.length)throw Error("WALK_BASELINE_SKIPPED_INHERITED_PATHS "+uncovered.join(" "));
      stage("walk");
      const walked=await walkSockets(fs,path=>changed.some(point=>within(path,point)||within(point,path)));
      stage("inherited sockets");
      const sockets=new Set(walked.sockets);let checked=0;
      for(const path of baseline.sockets)if(!changed.some(point=>within(path,point))){checked++;
        try{if(fs.lstatSync(path).isSocket())sockets.add(path)}catch(e){if(!["EACCES","ENOENT","ENOTDIR"].includes(e.code))throw e}}
      const walk={changed:changed.length,entries:walked.entries,checked,ms:Math.round(performance.now()-started)};
      stage("runtime input");
      let runtimeWrite;try{fs.writeFileSync(${JSON.stringify(input)},"attack");runtimeWrite="writable"}catch(e){runtimeWrite=e.code}
      const runtimeText=fs.readFileSync(${JSON.stringify(input)},"utf8");
      stage("connections");
      console.log(JSON.stringify({runtime:runtimeText,runtimeWrite,
        hostSockets:await Promise.all(${JSON.stringify(paths)}.map(reach)),
        cups:${existsSync(cups) ? `await reach(${JSON.stringify(cups)})` : "null"},sockets:[...sockets],walk}));
      stage("done");`;
    // The three profiles are independent: run them together.
    await phase("profile workers", 90_000, () => Promise.all(profiles.map(async (profile, index) => {
      const { exit, stdout, stderr } = await run(`${profile} worker`, workerCommand(launch(profile, views[index], program)), 80_000);
      workers[profile] = { exit, stderr, ...(exit === 0 ? JSON.parse(stdout.trim()) : { stdout }) };
    })));
    walk = { entries: baseline.entries, skipped: skipped.length, sockets: baseline.sockets.length };
  } finally { for (const view of views) view?.cleanup(); }
  console.log(JSON.stringify({ control: control.stdout.trim() === "connected", hostControls, workers, baseline: walk }));
} finally { proxy.stop(); for (const server of servers) server.close(); }
console.error("VAR_SOCKET_PHASE " + JSON.stringify({ phase: "cleanup", ms: 0, at: since(began) }));
