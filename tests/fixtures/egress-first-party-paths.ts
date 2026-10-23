/**
 * First-party egress measurement (#1665). Runs inside the caller's private
 * network namespace, whose /etc/hosts names the fixture origin and whose /run
 * holds a host socket. Every upstream is a loopback fixture in that namespace;
 * no provider, registry or public host is reachable.
 *
 * Usage: bun egress-first-party-paths.ts <root> [chromium]
 */
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, Socket, type Server } from "node:net";
import { join, normalize, resolve } from "node:path";
import { startEgressProxy, type EgressRecord } from "../../packages/ui-sdk/src/server/egress-proxy.js";
import type { WorkerSandbox } from "../../packages/ui-sdk/src/server/worker-sandbox.js";
import { HOST_MASKS } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { launchFixtureAgentWorker } from "../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";

export const ORIGIN_HOST = "ithaca.odysseus.test";
export const HOST_RUN_SOCKET = "/run/odysseus-host.sock";

const [root, chromium] = process.argv.slice(2) as [string, string | undefined];
const ROOT = resolve(import.meta.dir, "../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const git = "/usr/bin/git", ssh = "/usr/bin/ssh", sshd = "/usr/sbin/sshd";
const brain = join(root, "brain"), keys = join(root, "keys"), repository = join(root, "voyage.git");
for (const path of [brain, keys]) mkdirSync(path, { recursive: true, mode: 0o700 });

function run(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const child = Bun.spawnSync(argv, { cwd: options.cwd, env: { PATH: "/usr/bin:/bin", HOME: root, ...options.env }, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString();
}

// Fixture CA-signed origin certificate for the fictional host name.
const ca = join(keys, "ca.pem"), caKey = join(keys, "ca-key.pem");
const cert = join(keys, "origin.pem"), certKey = join(keys, "origin-key.pem"), csr = join(keys, "origin.csr");
run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Odysseus fixture CA",
  "-keyout", caKey, "-out", ca]);
run(["/usr/bin/openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${ORIGIN_HOST}`, "-keyout", certKey, "-out", csr]);
writeFileSync(join(keys, "san.ext"), `subjectAltName=DNS:${ORIGIN_HOST}\n`);
run(["/usr/bin/openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1",
  "-extfile", join(keys, "san.ext"), "-out", cert]);
// The worker reads only the public CA certificate, through the brain.
const workerCa = join(brain, "fixture-ca.pem");
writeFileSync(workerCa, readFileSync(ca));

// A bare repository served by both transports.
const seed = join(root, "seed");
const identity = { GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_AUTHOR_DATE: "2026-07-12T09:00:00Z",
  GIT_COMMITTER_DATE: "2026-07-12T09:00:00Z" };
run([git, "init", "-q", "-b", "main", seed]);
writeFileSync(join(seed, "ithaca.md"), "Odysseus charts the return to Ithaca.\n");
run([git, "-C", seed, "add", "ithaca.md"]);
run([git, "-C", seed, "commit", "-qm", "Chart the return"], { env: identity });
run([git, "clone", "-q", "--bare", seed, repository]);
run([git, "-C", repository, "update-server-info"]);

// One TLS origin: Git dumb HTTP, a page for Chromium and the Gemini embedding routes.
const calls: string[] = [];
const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(cert), key: readFileSync(certKey) },
  async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === "/voyage") return new Response("<html><body><p id=voyage>Odysseus reaches Ithaca</p></body></html>",
      { headers: { "content-type": "text/html" } });
    if (path.startsWith("/voyage.git/")) {
      const file = normalize(join(repository, path.slice("/voyage.git/".length)));
      if (!file.startsWith(`${repository}/`)) return new Response("outside", { status: 404 });
      try { if (statSync(file).isFile()) return new Response(Bun.file(file)); } catch { /* absent */ }
      return new Response("absent", { status: 404 });
    }
    const body = request.method === "POST" ? await request.json() as { requests?: unknown[] } : {};
    if (path.endsWith(":batchEmbedContents")) {
      return Response.json({ embeddings: (body.requests ?? []).map(() => ({ values: Array(16).fill(0.25) })) });
    }
    if (path.endsWith(":embedContent")) return Response.json({ embedding: { values: Array(16).fill(0.25) } });
    return new Response("Unexpected fixture route", { status: 404 });
  } });

// Loopback sshd for Git over SSH. The worker holds a fixture key; the daemon
// accepts only it and serves the bare repository through git-upload-pack.
const hostKey = join(keys, "ssh-host"), userKey = join(keys, "ssh-user");
run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "odysseus", "-f", userKey]);
writeFileSync(join(keys, "authorized_keys"), readFileSync(`${userKey}.pub`));
const workerKey = join(brain, "fixture-ssh-key");
writeFileSync(workerKey, readFileSync(userKey), { mode: 0o600 });
const sshPort = await new Promise<number>(done => { const probe = createServer().listen(0, "127.0.0.1", () => {
  const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
writeFileSync(join(keys, "sshd_config"), [
  `Port ${sshPort}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `AuthorizedKeysFile ${join(keys, "authorized_keys")}`,
  `PidFile ${join(keys, "sshd.pid")}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no",
  "StrictModes no", "PubkeyAuthentication yes", "AllowTcpForwarding no", "X11Forwarding no", "PermitTTY no",
  `SetEnv PATH=/usr/bin:/bin`, "",
].join("\n"));
const daemon = Bun.spawn([sshd, "-D", "-e", "-f", join(keys, "sshd_config")], { stdout: "ignore", stderr: "pipe" });
const daemonErrors = new Response(daemon.stderr).text();
for (let attempt = 0; ; attempt++) {
  const ready = await new Promise<boolean>(done => {
    const socket = connect({ host: "127.0.0.1", port: sshPort });
    socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false));
  });
  if (ready) break;
  if (attempt > 100 || daemon.exitCode !== null) throw new Error(`sshd did not start: ${await daemonErrors}`);
  await Bun.sleep(50);
}

// Host sockets a worker must not reach: one under /run, one under a home.
let hostConnections = 0;
const listen = (path: string, count = true) => new Promise<Server>(done => {
  const server = createServer(socket => { if (count) hostConnections++; socket.on("error", () => {}); socket.end("host bytes"); });
  server.listen(path, () => done(server));
});
const hostSockets = [await listen(HOST_RUN_SOCKET), await listen(join(root, "host-home.sock"))];

const records: EgressRecord[] = [];
const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [],
  maxBytes: 256 * 1024 * 1024, observe: record => records.push(record) });
// The turn runner links its inference relay socket beside the proxy socket.
const relay = await listen(join(proxy.dir, "inference.sock"), false);

const sandbox = (profile: "governed" | "strict"): WorkerSandbox => ({ brain, restricted: false, profile, areas: [], scratchAliasesRemoved: [],
  ...(profile === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) });
const baseEnv = { PATH: "/usr/bin:/bin", HOME: "/tmp/odysseus", LANG: "C.UTF-8" };

async function worker(name: string, command: string[], options: { env?: Record<string, string>; profile?: "governed" | "strict" } = {}) {
  const from = records.length, started = performance.now();
  const launched = launchFixtureAgentWorker({ brainPath: brain, command, env: { ...baseEnv, ...options.env },
    sandbox: sandbox(options.profile ?? "governed"), egress: { proxyDir: proxy.dir }, turnTempBytes: 256 * 1024 * 1024 });
  try {
    launched.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([launched.exited, new Response(launched.stdout as never).text(),
      new Response(launched.stderr as never).text()]);
    return { name, exit, stdout, stderr: stderr.slice(-4000), seconds: (performance.now() - started) / 1000,
      records: records.slice(from).map(({ method, host, port, bytes, outcome, accounting }) => ({ method, host, port, bytes, outcome, accounting })) };
  } finally { launched.turnTemp?.close(); }
}

const originPort = origin.port;
const page = `https://${ORIGIN_HOST}:${originPort}/voyage`;
const results: Record<string, Awaited<ReturnType<typeof worker>>> = {};
// Keep the fictional authority in TLS and CONNECT records, but give the host
// transport concrete loopback addresses before the offline guard sees them.
// Only these two owned listeners are mapped; all other destinations still
// pass through the saved guarded method. The namespace also has no route out.
const connectDescriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "connect")!;
Object.defineProperty(Socket.prototype, "connect", { ...connectDescriptor, value: function (this: Socket, ...args: unknown[]) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0] as { host?: string; port?: number } | undefined;
  if (options?.host === ORIGIN_HOST && (options.port === originPort || options.port === sshPort)) {
    args = [{ ...options, host: "127.0.0.1" }, ...values.slice(1)];
  }
  return Reflect.apply(connectDescriptor.value, this, args);
} });
try {
  results.curl = await worker("curl", ["/usr/bin/curl", "--silent", "--show-error", "--fail", "--max-time", "20", "--cacert", workerCa, page]);
  results.gitHttps = await worker("git-https", ["/bin/sh", "-c",
    `${git} -c http.sslCAInfo=${workerCa} clone -q https://${ORIGIN_HOST}:${origin.port}/voyage.git /tmp/https-clone && cat /tmp/https-clone/ithaca.md`]);
  results.gitSsh = await worker("git-ssh", ["/bin/sh", "-c", [
    "mkdir -p \"$HOME/.ssh\"", `cp ${workerKey} "$HOME/.ssh/id_ed25519"`, "chmod 700 \"$HOME/.ssh\"", "chmod 600 \"$HOME/.ssh/id_ed25519\"",
    // OpenSSH reads ~/.ssh from the passwd home, which the worker masks; options and key are explicit.
    `GIT_SSH_COMMAND="$GIT_SSH_COMMAND -F /dev/null -i $HOME/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" ${git} clone -q ssh://${run(["/usr/bin/id", "-un"]).trim()}@${ORIGIN_HOST}:${sshPort}${repository} /tmp/ssh-clone`,
    "cat /tmp/ssh-clone/ithaca.md"].join(" && ")]);
  // The real CLI's Gemini embedding provider, with its native endpoint override.
  symlinkSync(join(ROOT, "node_modules"), join(brain, "node_modules"));
  mkdirSync(join(brain, "notes"));
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini", dimensions: 16, apiKeyEnv: "ODYSSEUS_PROVIDER_KEY" } }));
  results.brainProvider = await worker("brain-provider", [process.execPath, BRAIN_CLI, "index", "--embeddings", "--json"], { env: {
    BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file", ODYSSEUS_PROVIDER_KEY: "odysseus-fixture-key",
    GOOGLE_GEMINI_BASE_URL: `https://${ORIGIN_HOST}:${origin.port}`, GOOGLE_GENAI_USE_VERTEXAI: "false",
    GOOGLE_GENAI_USE_ENTERPRISE: "false", NODE_EXTRA_CA_CERTS: workerCa } });
  if (chromium) {
    // Chromium has no fixture CA store here; certificate checks are not what this row measures.
    results.chromium = await worker("chromium", [chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
      "--ignore-certificate-errors", "--user-data-dir=/tmp/odysseus/chromium", "--dump-dom", page]);
  }
  // Every visible socket, from inside each profile's worker.
  // Reachability first, then every mask root completely (each is a small
  // empty tmpfs plus runtime binds), then the rest of the visible filesystem
  // under a deadline, for sockets outside the masks.
  const walk = `
    const { lstatSync, readdirSync, realpathSync } = require("node:fs");
    const net = require("node:net");
    const reach = path => new Promise(done => { const socket = net.connect(path);
      socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", error => done(error.code)); });
    const result = { run: await reach(${JSON.stringify(HOST_RUN_SOCKET)}), home: await reach(${JSON.stringify(join(root, "host-home.sock"))}) };
    const roots = [...new Set(${JSON.stringify(HOST_MASKS)}.flatMap(path => { try { return [realpathSync(path)]; } catch { return []; } }))];
    const deadline = Date.now() + 60000;
    let complete = true;
    const visit = (path, into, skip, bounded) => {
      if (bounded && Date.now() > deadline) { complete = false; return; }
      let entries; try { entries = readdirSync(path); } catch { return; }
      for (const name of entries) {
        const child = path === "/" ? "/" + name : path + "/" + name;
        if (skip(child)) continue;
        let info; try { info = lstatSync(child); } catch { continue; }
        if (info.isSocket()) into.push(child);
        else if (info.isDirectory()) visit(child, into, skip, bounded);
      }
    };
    result.masked = [];
    for (const root of roots) visit(root, result.masked, () => false, false);
    result.outside = [];
    visit("/", result.outside, child => child === "/proc" || child === "/sys" || roots.includes(child), true);
    result.complete = complete;
    // Connect and close at once: reachability only, no bytes to a host service.
    result.reachable = {};
    for (const path of result.outside) result.reachable[path] = await reach(path);
    console.log(JSON.stringify(result));`;
  for (const profile of ["governed", "strict"] as const) {
    results[`socketWalk_${profile}`] = await worker(`socket-walk-${profile}`, [process.execPath, "-e", walk], { profile });
  }
} finally {
  Object.defineProperty(Socket.prototype, "connect", connectDescriptor);
  proxy.stop(); origin.stop(true); daemon.kill(); relay.close();
  for (const server of hostSockets) server.close();
}
console.log(JSON.stringify({ originPort, sshPort, calls, hostConnections, results }));
