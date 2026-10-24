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
 * only entries the filesystem left untyped are stat'ed. Up to 32 directories
 * are read at once, so a cold disk is not read one block at a time.
 * Workers receive the source of `within` and the three functions from here
 * on, so they refer to nothing else.
 */
async function walkSockets(files: typeof fs, descend: (path: string) => boolean) {
  const sockets: string[] = [], queue = ["/"];
  let entries = 0, active = 0;
  const typed = (entry: fs.Dirent) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink() || entry.isSocket()
    || entry.isFIFO() || entry.isCharacterDevice() || entry.isBlockDevice();
  const read = async (path: string) => {
    let list: fs.Dirent[];
    try { list = await files.promises.readdir(path, { withFileTypes: true }); } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) return;
      throw error;
    }
    for (const entry of list) {
      const child = path === "/" ? "/" + entry.name : path + "/" + entry.name;
      entries++;
      let kind: { isDirectory(): boolean; isSocket(): boolean } = entry;
      if (!typed(entry)) {
        try { kind = await files.promises.lstat(child); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (kind.isDirectory()) { if (child !== "/proc" && child !== "/sys" && descend(child)) queue.push(child); }
      else if (kind.isSocket()) sockets.push(child);
    }
  };
  await new Promise<void>((done, fail) => {
    const pump = () => {
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
copyFileSync(process.execPath, runtime);
writeFileSync(input, "Odysseus reaches Ithaca");
const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 1024 * 1024, observe() {} });
const workers: Record<string, unknown> = {};
let walk: unknown;
try {
  for (const path of paths) await listen(path);
  const hostControls = await Promise.all(paths.map(reach));
  const controlPath = join(root, "unmasked.sock"), controlServer = await listen(controlPath);
  // A real worker, using the same host-root layout, reaches an unmasked socket.
  const controlLaunch: WorkerLaunch = { brainPath: brain, sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [], readPaths: [runtime] },
    env: {}, command: [runtime, "--no-env-file", "-e", `const s=require("node:net").connect(${JSON.stringify(controlPath)});s.on("connect",()=>{s.destroy();console.log("connected")});s.on("error",e=>{throw e});`] };
  const control = Bun.spawnSync(workerCommand(controlLaunch), { env: {}, stdout: "pipe", stderr: "pipe" });
  if (control.exitCode !== 0) throw Error(control.stderr.toString());
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
  const views = profiles.map(profile => profile === "governed" ? undefined : createFixtureWorkerStartupView(brain));
  try {
    // Only the mounts a worker changes can show it something the fixture's own
    // view does not. The fixture walks its view once, wherever some profile
    // inherits it; each worker reads only the subtrees below its changed mount
    // points and lstats the baseline's sockets everywhere else (#2674).
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    const changed = profiles.map((profile, index) => {
      const probe = Bun.spawnSync(workerCommand(launch(profile, views[index],
        `process.stdout.write(require("node:fs").readFileSync("/proc/self/mountinfo","utf8"))`)), { env: {}, stdout: "pipe", stderr: "pipe" });
      if (probe.exitCode !== 0) throw Error(`${profile} mount probe: ${probe.stderr.toString()}`);
      return changedMounts(probe.stdout.toString(), mountinfo);
    });
    const skipped: string[] = [];
    const inherited = (path: string) => changed.some(points => !points.some(point => within(path, point))) || (skipped.push(path), false);
    const baseline = { mountinfo, skipped, ...await walkSockets(fs, inherited) };
    writeFileSync(join(root, "walk-baseline.json"), JSON.stringify(baseline));
    // A worker refuses a baseline that skipped anything its own mounts leave
    // as the fixture sees it.
    const program = `const fs=require("node:fs"), net=require("node:net");
      const reach=path=>new Promise(done=>{const s=net.connect(path);s.once("connect",()=>{s.destroy();done(true)});s.once("error",e=>done(e.code))});
      const within=${within}, walkSockets=${walkSockets}, mountStacks=${mountStacks}, changedMounts=${changedMounts}, started=performance.now();
      const baseline=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "walk-baseline.json"))},"utf8")), mountinfo=fs.readFileSync("/proc/self/mountinfo","utf8");
      const changed=changedMounts(mountinfo,baseline.mountinfo);
      const uncovered=baseline.skipped.filter(path=>!changed.some(point=>within(path,point)));
      if(uncovered.length)throw Error("WALK_BASELINE_SKIPPED_INHERITED_PATHS "+uncovered.join(" "));
      const walked=await walkSockets(fs,path=>changed.some(point=>within(path,point)||within(point,path)));
      const sockets=new Set(walked.sockets);let checked=0;
      for(const path of baseline.sockets)if(!changed.some(point=>within(path,point))){checked++;
        try{if(fs.lstatSync(path).isSocket())sockets.add(path)}catch(e){if(!["EACCES","ENOENT","ENOTDIR"].includes(e.code))throw e}}
      const walk={changed:changed.length,entries:walked.entries,checked,ms:Math.round(performance.now()-started)};
      let runtimeWrite;try{fs.writeFileSync(${JSON.stringify(input)},"attack");runtimeWrite="writable"}catch(e){runtimeWrite=e.code}
      console.log(JSON.stringify({runtime:fs.readFileSync(${JSON.stringify(input)},"utf8"),runtimeWrite,
        hostSockets:await Promise.all(${JSON.stringify(paths)}.map(reach)),
        cups:${existsSync(cups) ? `await reach(${JSON.stringify(cups)})` : "null"},sockets:[...sockets],walk}));`;
    // The three profiles are independent: run them together.
    await Promise.all(profiles.map(async (profile, index) => {
      const child = Bun.spawn(workerCommand(launch(profile, views[index], program)), { env: {}, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      workers[profile] = { exit, stderr, ...(exit === 0 ? JSON.parse(stdout.trim()) : { stdout }) };
    }));
    walk = { entries: baseline.entries, skipped: skipped.length, sockets: baseline.sockets.length };
  } finally { for (const view of views) view?.cleanup(); }
  console.log(JSON.stringify({ control: control.stdout.toString().trim() === "connected", hostControls, workers, baseline: walk }));
} finally { proxy.stop(); for (const server of servers) server.close(); }
