/** Owned socket controls in private mount/network namespaces; no service receives bytes. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { startEgressProxy } from "../../src/server/egress-proxy.js";
import { workerCommand, type WorkerLaunch } from "../../src/server/worker-launcher.js";
import { maintenanceLaunch } from "../../src/server/maintenance-worker.js";
import { createFixtureWorkerStartupView } from "../helpers/worker-startup-view-fixture.js";

const root = "/opt/odysseus-var-fixture", brain = join(root, "brain");
const cups = "/var/snap/cups/common/run/cups.sock";
const paths = ["/var/tmp/odysseus/host.sock", "/var/spool/odysseus/host.sock", "/var/snap/odysseus/host.sock",
  "/var/lib/odysseus-runtime/host.sock"];
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
  // The socket walk takes each entry's type from readdir and stats only what the
  // filesystem left untyped: one syscall per directory, not one per file.
  const program = `const fs=require("node:fs"), net=require("node:net");
    const reach=path=>new Promise(done=>{const s=net.connect(path);s.once("connect",()=>{s.destroy();done(true)});s.once("error",e=>done(e.code))});
    const sockets=[];
    function walk(path){let entries;try{entries=fs.readdirSync(path,{withFileTypes:true})}catch(e){if(["EACCES","ENOENT","EPERM"].includes(e.code))return;throw e}
      for(const entry of entries){const child=path==="/"?"/"+entry.name:path+"/"+entry.name;
        if(child==="/proc"||child==="/sys")continue;
        let kind=entry;
        if(![entry.isFile(),entry.isDirectory(),entry.isSymbolicLink(),entry.isSocket(),entry.isFIFO(),entry.isCharacterDevice(),entry.isBlockDevice()].includes(true))
          try{kind=fs.lstatSync(child)}catch(e){if(e.code==="ENOENT")continue;throw e}
        if(kind.isDirectory())walk(child);else if(kind.isSocket())sockets.push(child)}}
    walk("/");let runtimeWrite;try{fs.writeFileSync(${JSON.stringify(input)},"attack");runtimeWrite="writable"}catch(e){runtimeWrite=e.code}
    console.log(JSON.stringify({runtime:fs.readFileSync(${JSON.stringify(input)},"utf8"),runtimeWrite,
      hostSockets:await Promise.all(${JSON.stringify(paths)}.map(reach)),
      cups:${existsSync(cups) ? `await reach(${JSON.stringify(cups)})` : "null"},sockets}));`;
  // The three walks are independent, and each covers the whole visible tree:
  // run them together so the receipt costs one walk of wall time, not three.
  await Promise.all((["governed", "strict", "maintenance"] as const).map(async profile => {
    const view = profile === "governed" ? undefined : createFixtureWorkerStartupView(brain);
    try {
      const launch: WorkerLaunch = profile === "maintenance"
        ? maintenanceLaunch({ brainPath: brain, startupView: view, credentials: false, readPaths: [runtime, input], env: {}, command: [runtime, "--no-env-file", "-e", program] })
        : { brainPath: brain, ...(view ? { startupView: view } : {}), env: {}, command: [runtime, "--no-env-file", "-e", program], egress: { proxyDir: proxy.dir },
          sandbox: { brain, profile, restricted: false, areas: [], scratchAliasesRemoved: [], readPaths: [runtime, input] } };
      const child = Bun.spawn(workerCommand(launch), { env: {}, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      workers[profile] = { exit, stderr, ...(exit === 0 ? JSON.parse(stdout.trim()) : { stdout }) };
    } finally { view?.cleanup(); }
  }));
  console.log(JSON.stringify({ control: control.stdout.toString().trim() === "connected", hostControls, workers }));
} finally { proxy.stop(); for (const server of servers) server.close(); }
