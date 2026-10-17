/** Actual helper/Unix/HTTP qualification; invoked only inside the disposable identity fixture. */
import { expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchAgentWorker, type LaunchedWorker } from "../src/server/worker-launcher.js";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";

if (process.getuid?.() !== 21001 || !existsSync("/usr/local/bin/identity-helper") || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper") {
  throw Error("EGRESS_IDENTITY_QUALIFICATION_REQUIRES_DISPOSABLE_CONTAINER");
}
const root = mkdtempSync("/identity-fixture/odysseus-egress-"); chmodSync(root, 0o2775);
const brain = join(root, "brain"); mkdirSync(brain, { mode: 0o2775 }); chmodSync(brain, 0o2775);
const helper = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
const collect = async (stream: NodeJS.ReadableStream) => {
  let text = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString();
  return text;
};
async function run(proxyDir: string, program: string) {
  let worker: LaunchedWorker | undefined, settled = false;
  let output: Promise<string> | undefined, errors: Promise<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = launchAgentWorker({ brainPath: brain,
      sandbox: { brain, restricted: false, profile: "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] } },
      command: ["/usr/bin/python3", "-I", "-S", "-c", program], env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      egress: { proxyDir }, stateBytes: 1024 * 1024, turnTempBytes: 1024 * 1024 });
    worker.stdin.end(); output = collect(worker.stdout); errors = collect(worker.stderr);
    timer = setTimeout(() => worker?.kill("SIGKILL"), 10000);
    const exit = await worker.exited; settled = true;
    // The real supervisor retains pipe writers while these handles remain held.
    worker.state?.close(); worker.turnTemp?.close();
    return { exit, output: await output, errors: await errors };
  } finally {
    clearTimeout(timer);
    if (worker && !settled) {
      worker.kill("SIGKILL");
      await worker.exited;
    }
    worker?.state?.close(); worker?.turnTemp?.close();
    await Promise.allSettled([output, errors].filter((value): value is Promise<string> => value !== undefined));
  }
}
let cases = 0;
try {
  for (const separate of [true, false]) {
    if (separate) process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
    else delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    const records: EgressRecord[] = [];
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Odysseus reaches Ithaca") });
    const priorTemp = process.env.TMPDIR;
    let proxy: Awaited<ReturnType<typeof startEgressProxy>>;
    try {
      // An inherited setgid parent must not choose the worker's IPC group.
      if (separate) {
        const inherited = lstatSync("/identity-fixture/egress-setgid-temp");
        expect(inherited.gid, "EGRESS_FOREIGN_PARENT_GROUP_CONTROL").toBe(21002);
        expect(inherited.mode & 0o2000, "EGRESS_SETGID_PARENT_CONTROL").toBe(0o2000);
        process.env.TMPDIR = "/identity-fixture/egress-setgid-temp";
      }
      proxy = await startEgressProxy({ mode: "allowlist", allow: ["127.0.0.1"], deny: [], outwardHosts: [], maxBytes: 65536, observe: row => records.push(row) });
    } finally {
      if (priorTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTemp;
    }
    try {
      expect(lstatSync(proxy.dir).mode & 0o7777, "EGRESS_IDENTITY_DIRECTORY_MODE").toBe(separate ? 0o750 : 0o700);
      expect(lstatSync(proxy.socketPath).mode & 0o7777, "EGRESS_IDENTITY_SOCKET_MODE").toBe(separate ? 0o660 : 0o600);
      expect(lstatSync(proxy.dir).uid).toBe(21001); expect(lstatSync(proxy.socketPath).uid).toBe(21001);
      if (separate) { expect(lstatSync(proxy.dir).gid, "EGRESS_HELPER_GROUP_IS_SERVER_GROUP").toBe(21001); expect(lstatSync(proxy.socketPath).gid).toBe(21001); }
      const program = `import errno,json,os,socket,urllib.request
s=socket.socket(socket.AF_UNIX)
try: s.connect('/run/brain-egress/proxy.sock'); ipc='CONNECTED'
except OSError as e: ipc=errno.errorcode[e.errno]
finally: s.close()
s=socket.socket();s.settimeout(1)
try: s.connect(('127.0.0.1',${origin.port})); direct=True
except OSError: direct=False
finally: s.close()
try:
 with open('/identity-server-private/sentinel','rb') as f: f.read(1); sentinel='READABLE'
except OSError: sentinel='REFUSED'
client=urllib.request.build_opener(urllib.request.ProxyHandler({'http':os.environ['HTTP_PROXY']}))
with client.open(${JSON.stringify(origin.url.href)},timeout=3) as response: body=response.read().decode()
print(json.dumps(dict(uid=os.getuid(),gid=os.getgid(),ipc=ipc,direct=direct,sentinel=sentinel,body=body)))`;
      const result = await run(proxy.dir, program);
      expect(result.exit, result.errors).toBe(0); expect(result.errors).toBe("");
      const receipt = JSON.parse(result.output);
      expect(receipt.uid, "EGRESS_ACTUAL_WORKER_UID").toBe(separate ? 21002 : 21001);
      expect(receipt.ipc, "CROSS_UID_EGRESS_UNIX_SOCKET_REACHABLE").toBe("CONNECTED");
      expect(receipt.body, "EGRESS_REAL_HTTP_REACHES_ONLY_PROXY").toBe("Odysseus reaches Ithaca");
      expect(receipt.direct, "EGRESS_IDENTITY_PRIVATE_NETWORK").toBe(false);
      if (separate) expect(receipt.sentinel, "EGRESS_IDENTITY_SERVER_SENTINEL_PRIVATE").toBe("REFUSED");
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ method: "GET", host: "127.0.0.1", outcome: "completed" });
      expect(records[0]!.bytes).toBeGreaterThan(0);
      console.log(JSON.stringify({ egressIdentity: separate ? "separate" : "same", result: "pass", ...receipt })); cases++;
    } finally { proxy.stop(); origin.stop(true); }
  }
  process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
  const proxy = await startEgressProxy({ mode: "allowlist", allow: [], deny: [], outwardHosts: [], maxBytes: 65536, observe() {} });
  const refuse = async (directory: string, name: string) => {
    let refused = false;
    try { await run(directory, "print('unexpected payload')"); }
    catch (error) { refused = error instanceof Error && error.message.includes("egress transport requires its private server-owned proxy directory and socket"); }
    expect(refused, `EGRESS_IPC_${name}_REFUSED_BEFORE_EXECUTION`).toBe(true);
    console.log(JSON.stringify({ egressIdentityRefusal: name, result: "pass" })); cases++;
  };
  try {
    for (const [directoryMode, socketMode, name] of [
      [0o755, 0o660, "WORLD_DIRECTORY"], [0o770, 0o660, "GROUP_WRITABLE_DIRECTORY"],
      [0o700, 0o660, "OWNER_ONLY_DIRECTORY"], [0o750, 0o600, "OWNER_ONLY_SOCKET"], [0o750, 0o666, "WORLD_SOCKET"],
    ] as const) {
      chmodSync(proxy.dir, directoryMode); chmodSync(proxy.socketPath, socketMode);
      try { await refuse(proxy.dir, name); } finally { chmodSync(proxy.dir, 0o750); chmodSync(proxy.socketPath, 0o660); }
    }
    const alias = join(root, "proxy-alias"); symlinkSync(proxy.dir, alias);
    try { await refuse(alias, "DIRECTORY_SYMLINK"); } finally { unlinkSync(alias); }
    const held = `${proxy.socketPath}.held`; renameSync(proxy.socketPath, held);
    try {
      await refuse(proxy.dir, "MISSING_SOCKET");
      writeFileSync(proxy.socketPath, "Odysseus fixture"); chmodSync(proxy.socketPath, 0o660);
      try { await refuse(proxy.dir, "NON_SOCKET"); } finally { unlinkSync(proxy.socketPath); }
      symlinkSync(held, proxy.socketPath);
      try { await refuse(proxy.dir, "SOCKET_SYMLINK"); } finally { unlinkSync(proxy.socketPath); }
    } finally { renameSync(held, proxy.socketPath); }
    await refuse("/identity-fixture/egress-foreign-owner", "FOREIGN_OWNER");
    await refuse("/identity-fixture/egress-foreign-group", "FOREIGN_GROUP");
  } finally { proxy.stop(); }
  console.log(JSON.stringify({ egressIdentityQualification: "pass", cases }));
} finally {
  if (helper === undefined) delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
  else process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
  rmSync(root, { recursive: true, force: true });
}
