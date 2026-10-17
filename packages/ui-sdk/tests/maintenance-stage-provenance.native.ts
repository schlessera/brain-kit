/** Observe only the existing disposable manager's stage and reader authority. */
import { createHash } from "node:crypto";
import { expect } from "bun:test";
import { chmodSync, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import { launchMaintenanceWorker, prepareMaintenanceGitInput, prepareMaintenanceWorker, runMaintenanceWorker, type MaintenanceCommand } from "../src/server/maintenance-worker.js";
import { probeWorkerHost, verifiedWorkerIdentity } from "../src/server/worker-launcher.js";
import type { NativeStage } from "../src/server/native-brain-manager-protocol.js";

export async function captureMaintenanceStage(brain: string) {
  if (process.getuid?.() !== 21001 || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper")
    throw Error("MAINTENANCE_STAGE_PROVENANCE_REQUIRES_DISPOSABLE_IDENTITY_FIXTURE");
  const probe = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
  if (!probe.ok) throw Error(`MAINTENANCE_STAGE_REAL_IDENTITY_PROBE_REFUSED: ${probe.requirement}`);
  const client = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
  let stage: NativeStage | undefined;
  const manager = { ...client, async prepareStage(...args: Parameters<typeof client.prepareStage>) {
    stage = await client.prepareStage(...args); return stage;
  } };
  const aliases = [".env.relative-proof", ".env.absolute-proof", ".env.parent-proof"];
  const secretRoot = `${brain}/odysseus-mask-proof`;
  mkdirSync(secretRoot, { mode: 0o755 }); mkdirSync(`${secretRoot}/actual`, { mode: 0o755 });
  for (const name of ["relative", "absolute", "actual/secret"]) writeFileSync(`${secretRoot}/${name}`, "Odysseus fictional secret", { mode: 0o644 });
  symlinkSync("actual", `${secretRoot}/parent-alias`);
  symlinkSync("odysseus-mask-proof/relative", `${brain}/${aliases[0]}`);
  symlinkSync(`${secretRoot}/absolute`, `${brain}/${aliases[1]}`);
  symlinkSync("odysseus-mask-proof/parent-alias/secret", `${brain}/${aliases[2]}`);
  const modules = `${brain}/.git/modules`, suppliedModulesTarget = !existsSync(modules);
  if (suppliedModulesTarget) mkdirSync(modules, { mode: 0o755 });
  let view: Awaited<ReturnType<typeof prepareNativeWorkerStartupView>>;
  try { view = await prepareNativeWorkerStartupView(brain, manager); }
  finally { if (suppliedModulesTarget) rmSync(modules, { recursive: true }); }
  console.log(JSON.stringify({ adapterProbeMountTargets: "existing in disposable checkpoint", originalAbsentModulesRestored: suppliedModulesTarget }));
  let outputs: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
  const attempt = <T>(read: () => T): { value: T } | { error: string } => {
    try { return { value: read() }; } catch (error) { return { error: (error as NodeJS.ErrnoException).code ?? String(error) }; }
  };
  const metadata = (info: NonNullable<ReturnType<typeof lstatSync>>) => ({ uid: Number(info.uid), gid: Number(info.gid),
    mode: (Number(info.mode) & 0o7777).toString(8), dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() });
  try {
    outputs = await prepareNativeWorkerOutput(brain, { startupView: view, areas: [".brain-maintenance-probe"] });
    if (!stage) throw Error("MAINTENANCE_STAGE_RECEIPT_MISSING");
    const held = stage, source = outputs.output.source, fd = Number(/^\/proc\/\d+\/fd\/(\d+)\/merged$/.exec(source)?.[1]);
    if (!Number.isSafeInteger(fd)) throw Error("MAINTENANCE_STAGE_DESCRIPTOR_MISSING");
    const identity = verifiedWorkerIdentity(brain);
    if (!identity) throw Error("MAINTENANCE_STAGE_QUALIFIED_IDENTITY_MISSING");
    const row = {
      kind: "maintenance-stage-provenance", server: { pid: process.pid, uid: process.getuid(), gid: process.getgid?.(), groups: process.getgroups?.() },
      qualifiedWorker: identity, stage: held, descriptor: fd, source,
      descriptorRoot: metadata(fstatSync(fd)), merged: attempt(() => metadata(lstatSync(source))),
      descriptorTarget: attempt(() => readlinkSync(`/proc/${process.pid}/fd/${fd}`)),
      keeper: { status: attempt(() => readFileSync(`/proc/${held.namespacePid}/status`, "utf8").split("\n").filter(line => /^(Uid|Gid|Groups|NSpid):/.test(line))),
        start: attempt(() => readFileSync(`/proc/${held.namespacePid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]),
        mountNamespace: attempt(() => readlinkSync(`/proc/${held.namespacePid}/ns/mnt`)) },
      directEnumeration: attempt(() => readdirSync(source)),
    };
    console.log(JSON.stringify(row));
    console.log(JSON.stringify({ kind: "maintenance-stage-authorized-reader",
      stat: await client.statStage(held.id, "brain.config.ts", identity.workerUid),
      memberKinds: (await client.listStage(held.id, "", identity.workerUid)).map(item => item.kind),
    }));
    const base = (): MaintenanceCommand => ({ brainPath: brain, startupView: outputs!.view,
      output: { ...outputs!.output, target: "/tmp/brain-maintenance-output" },
      command: ["/bin/true"], env: { PATH: "/usr/bin:/bin" }, credentials: false });
    const gitTopology = await runMaintenanceWorker({ ...base(), command: ["/usr/bin/python3", "-I", "-S", "-c", String.raw`
import json,os,stat,subprocess
root=os.environ["BRAIN_ROOT"]+"/.git"
def info(path):
 s=os.stat(path); return {"uid":s.st_uid,"gid":s.st_gid,"mode":oct(stat.S_IMODE(s.st_mode)),"writable":os.access(path,os.W_OK)}
r={"workerUid":os.getuid(),"workerGid":os.getgid(),"groups":os.getgroups(),"git":info(root),"objects":info(root+"/objects"),"config":info(root+"/config")}
try:
 os.mkdir(root+"/odysseus-writability-probe"); os.rmdir(root+"/odysseus-writability-probe"); r["mkdir"]="written-and-removed"
except OSError as e: r["mkdir"]={"errno":e.errno}
git=subprocess.run(["/usr/bin/git","-c","safe.directory="+os.environ["BRAIN_ROOT"],"-C",os.environ["BRAIN_ROOT"],"hash-object","-w","--stdin"],input=b"Odysseus private object probe "+os.urandom(16),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
r["gitObjectWrite"]={"code":git.returncode,"stderr":git.stderr.decode()[-500:]}
print(json.dumps(r))
`] });
    expect(gitTopology.exitCode, "ACTUAL_STAGE_GIT_TOPOLOGY_OBSERVED").toBe(0);
    console.log(JSON.stringify({ actualStageGitTopology: JSON.parse(gitTopology.stdout) }));
    const refusedBeforePayload = async (label: string, action: () => unknown | Promise<unknown>) => {
      const descriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!, original = Bun.spawn;
      let payload = false;
      Object.defineProperty(Bun, "spawn", { ...descriptor, value: (...args: any[]) => {
        const options = Array.isArray(args[0]) ? args[1] : args[0];
        if (options?.env?.BRAIN_WORKER_LAUNCH) payload = true;
        return Reflect.apply(original, Bun, args);
      } });
      try {
        let refusal: unknown;
        try { await action(); } catch (error) { refusal = error; }
        expect(refusal, label).toBeDefined(); expect(payload, `${label}_BEFORE_PAYLOAD`).toBe(false);
      } finally { Object.defineProperty(Bun, "spawn", descriptor); }
      console.log(JSON.stringify({ nativeMaintenanceRefusal: label, beforePayload: true }));
    };
    await refusedBeforePayload("UNPREPARED_NATIVE_MAINTENANCE", () => launchMaintenanceWorker(base()));
    await refusedBeforePayload("FOREIGN_NATIVE_MAINTENANCE_STORAGE", () => prepareMaintenanceWorker({ ...base(),
      output: { ...base().output!, storage: { ...outputs!.output.storage } } }));
    await refusedBeforePayload("OMITTED_NATIVE_MAINTENANCE_VIEW", () => prepareMaintenanceWorker({ ...base(), startupView: undefined }));
    const stale = base(); await prepareMaintenanceWorker(stale);
    expect((await runMaintenanceWorker({ ...base(), command: ["/bin/sh", "-c", 'printf unpublished > "$BRAIN_ROOT/.brain-maintenance-unpublished"'] })).exitCode,
      "FRESH_NATIVE_MAINTENANCE_COMMAND").toBe(0);
    await refusedBeforePayload("STALE_NATIVE_MAINTENANCE_GENERATION", () => launchMaintenanceWorker(stale));
    const changed = base(); await prepareMaintenanceWorker(changed); changed.command = ["/bin/false"];
    await refusedBeforePayload("CHANGED_NATIVE_MAINTENANCE_COMMAND", () => launchMaintenanceWorker(changed));
    const replay = base(); await prepareMaintenanceWorker(replay);
    const once = launchMaintenanceWorker(replay); void once.input("");
    expect((await Promise.all([once.exited, new Response(once.stdout).text(), new Response(once.stderr).text()]))[0], "ONCE_NATIVE_MAINTENANCE").toBe(0);
    await refusedBeforePayload("REPLAYED_NATIVE_MAINTENANCE_PREPARATION", () => launchMaintenanceWorker(replay));
    const abort = new AbortController(); abort.abort();
    await refusedBeforePayload("ABORTED_NATIVE_MAINTENANCE_PREPARATION", () => prepareMaintenanceWorker(base(), abort.signal));
    const gitConfig = JSON.stringify({ marker: "Odysseus return to Ithaca" });
    const probeGitInput = async (stageOutput: Awaited<ReturnType<typeof prepareNativeWorkerOutput>>) => {
      const gitRoot = stageOutput.output.source.replace(/\/merged$/, "/git-adapter");
      mkdirSync(gitRoot, { mode: 0o700 }); mkdirSync(`${gitRoot}/bin`, { mode: 0o700 }); mkdirSync(`${gitRoot}/hooks`, { mode: 0o700 });
      writeFileSync(`${gitRoot}/config.json`, gitConfig, { mode: 0o600 }); writeFileSync(`${gitRoot}/empty-config`, "", { mode: 0o600 });
      writeFileSync(`${gitRoot}/bin/git`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return prepareMaintenanceGitInput({ ...base(), startupView: stageOutput.view, output: { ...stageOutput.output, target: "/tmp/brain-maintenance-output" },
        git: { source: gitRoot, target: "/tmp/brain-maintenance-git", entry: Bun.resolveSync("../src/server/maintenance-git-entry", import.meta.dir), binary: "/usr/bin/git" } });
    };
    const privateGit = await probeGitInput(outputs);
    const privateRelative = privateGit.source.split("/").at(-1)!;
    const concealment = await runMaintenanceWorker({ ...base(), git: privateGit,
      command: ["/usr/bin/python3", "-I", "-S", "-c", String.raw`
import hashlib,json,os,sys
fixed="/tmp/brain-maintenance-git/config.json"; alias=os.environ["BRAIN_ROOT"]+"/"+sys.argv[1]; r={}
def attempt(name,operation):
 try: operation(); r[name]="allowed"
 except OSError as e: r[name]={"errno":e.errno}
r["initialDigest"]=hashlib.sha256(open(fixed,"rb").read()).hexdigest()
attempt("readOnlyWrite",lambda:open(fixed,"wb").close())
attempt("readOnlyChmod",lambda:os.chmod(fixed,0o600))
attempt("readOnlyRename",lambda:os.rename(fixed,os.environ["BRAIN_ROOT"]+"/odysseus-config-renamed"))
attempt("readOnlyHardlink",lambda:os.link(fixed,os.environ["BRAIN_ROOT"]+"/odysseus-config-linked"))
attempt("writableAliasRead",lambda:open(alias+"/config.json","rb").read())
attempt("writableAliasWrite",lambda:open(alias+"/config.json","wb").write(b"changed"))
attempt("writableAliasRename",lambda:os.rename(alias,os.environ["BRAIN_ROOT"]+"/odysseus-input-renamed"))
r["finalDigest"]=hashlib.sha256(open(fixed,"rb").read()).hexdigest()
print(json.dumps(r))
`, privateRelative] });
    expect(concealment.exitCode, "ACTUAL_PRIVATE_GIT_INPUT_CONSUMER").toBe(0);
    const concealed = JSON.parse(concealment.stdout), expectedDigest = createHash("sha256").update(gitConfig).digest("hex");
    console.log(JSON.stringify({ actualPrivateGitInputConcealment: concealed }));
    expect(concealed.initialDigest, "ACTUAL_PRIVATE_GIT_INPUT_BYTES").toBe(expectedDigest);
    expect(concealed.readOnlyWrite, "ACTUAL_PRIVATE_GIT_INPUT_READ_ONLY_WRITE").toEqual({ errno: 30 });
    expect(concealed.readOnlyChmod, "ACTUAL_PRIVATE_GIT_INPUT_READ_ONLY_CHMOD").toEqual({ errno: 30 });
    expect([18, 30], "ACTUAL_PRIVATE_GIT_INPUT_RENAME_REFUSED").toContain(concealed.readOnlyRename.errno);
    expect(concealed.readOnlyHardlink, "ACTUAL_PRIVATE_GIT_INPUT_HARDLINK_REFUSED").toEqual({ errno: 18 });
    expect(concealed.writableAliasRead, "ACTUAL_PRIVATE_GIT_WRITABLE_ALIAS_CONCEALED").toEqual({ errno: 2 });
    expect([2, 13, 30], "ACTUAL_PRIVATE_GIT_WRITABLE_ALIAS_WRITE_REFUSED").toContain(concealed.writableAliasWrite.errno);
    expect(concealed.writableAliasRename, "ACTUAL_PRIVATE_GIT_WRITABLE_ALIAS_RENAME_REFUSED").toEqual({ errno: 16 });
    expect(concealed.finalDigest, "ACTUAL_PRIVATE_GIT_INPUT_REMAINS_FROZEN").toBe(expectedDigest);
    await refusedBeforePayload("FOREIGN_PRIVATE_GIT_INPUT_OBJECT", () => runMaintenanceWorker({ ...base(), git: { ...privateGit } }));
    const staleGit = { ...base(), git: privateGit }; await prepareMaintenanceWorker(staleGit);
    await prepareMaintenanceGitInput({ ...base(), git: privateGit });
    await refusedBeforePayload("STALE_PRIVATE_GIT_INPUT_PREPARATION", () => launchMaintenanceWorker(staleGit));
    // The listener remains in the fixture server namespace. SO_PEERCRED measures
    // the connecting payload principal independently of its namespace-local IDs.
    const peerRoot = mkdtempSync("/identity-fixture/odysseus-maintenance-peer-");
    chmodSync(peerRoot, 0o750);
    mkdirSync(`${peerRoot}/private`, { mode: 0o700 });
    writeFileSync(`${peerRoot}/private/sentinel`, "Odysseus private fixture", { mode: 0o600 });
    const peerSocket = `${peerRoot}/peer.sock`, ready = `${peerRoot}/ready`;
    const listenerCode = String.raw`
import json,os,socket,struct,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(15)
s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o660)
s.listen(1)
open(sys.argv[2],"w").close()
for _ in range(2):
 c,_=s.accept(); c.settimeout(10)
 pid,uid,gid=struct.unpack("3i",c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
 data=b""
 while not data.endswith(b"\n"):
  chunk=c.recv(4096)
  if not chunk or len(data)>16384: raise RuntimeError("bounded peer receipt missing")
  data+=chunk
 print(json.dumps({"kind":"maintenance-payload-peer","peer":{"pid":pid,"uid":uid,"gid":gid},"payload":json.loads(data)}),flush=True)
 c.sendall(b"ok"); c.close()
s.close()
`;
    const payloadCode = String.raw`
import json,os,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5); s.connect(sys.argv[1])
def masked(name):
 try: return len(open(os.environ.get("BRAIN_WORKER_CONFIG_ROOT",sys.argv[3])+"/"+name).read())
 except OSError as e: return {"errno":e.errno}
r={"envMaskLengths":[masked(name) for name in [".env.relative-proof",".env.absolute-proof",".env.parent-proof"]],"uid":os.getuid(),"gid":os.getgid(),"groups":os.getgroups(),"uidMap":open("/proc/self/uid_map").read(),"gidMap":open("/proc/self/gid_map").read(),"namespaces":{k:os.readlink("/proc/self/ns/"+k) for k in ["user","mnt","pid"]}}
try:
 open(sys.argv[2]).read(); r["privateSentinel"]="readable"
except OSError as e: r["privateSentinel"]={"errno":e.errno}
try:
 if "BRAIN_ROOT" in os.environ:
  with open(os.environ["BRAIN_ROOT"]+"/.brain-maintenance-probe","w") as f: f.write("qualified")
  r["declaredOutput"]="written"
 else: r["declaredOutput"]="not-requested"
except OSError as e: r["declaredOutput"]={"errno":e.errno}
s.sendall(json.dumps(r).encode()+b"\n"); s.recv(2); s.close()
print(json.dumps(r),flush=True)
sys.exit(0 if r["declaredOutput"] in ["written","not-requested"] else 2)
`;
    const listener = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", listenerCode, peerSocket, ready],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const peerStdout = new Response(listener.stdout).text(), peerStderr = new Response(listener.stderr).text();
    let result: unknown;
    try {
      const deadline = Date.now() + 5000;
      while (!attempt(() => lstatSync(ready)).hasOwnProperty("value")) {
        if (Date.now() > deadline || listener.exitCode !== null) throw Error("MAINTENANCE_PEER_LISTENER_NOT_READY");
        await Bun.sleep(10);
      }
    try {
      const readable = await runMaintenanceWorker({ brainPath: brain, startupView: outputs.view,
        command: ["/usr/bin/python3", "-I", "-S", "-c", payloadCode, peerSocket, `${peerRoot}/private/sentinel`, brain],
        readPaths: [peerRoot], env: { PATH: "/usr/bin:/bin" }, credentials: false, timeoutMs: 5000 });
      console.log(JSON.stringify({ kind: "readable-maintenance-launch", result: readable }));
      expect(readable.exitCode, "ACTUAL_READABLE_HELPER_MAINTENANCE").toBe(0);
      result = await runMaintenanceWorker({ brainPath: brain, startupView: outputs.view,
        output: { ...outputs.output, target: "/tmp/brain-maintenance-output" },
        command: ["/usr/bin/python3", "-I", "-S", "-c", payloadCode, peerSocket, `${peerRoot}/private/sentinel`, brain],
        readPaths: [peerRoot],
        env: { PATH: "/usr/bin:/bin" }, credentials: false, timeoutMs: 5000 });
    } catch (error) { result = { error: String(error), code: (error as NodeJS.ErrnoException).code }; }
      console.log(JSON.stringify({ kind: "maintenance-stage-launch-before-peer", result }));
      const peerExit = await listener.exited;
      const peerOutput = await peerStdout; console.log(peerOutput);
      const peerError = await peerStderr;
      if (peerExit !== 0) throw Error(`MAINTENANCE_PEER_LISTENER_FAILED: ${peerExit}: ${peerError}`);
      const [readablePeer, receipt] = peerOutput.trim().split("\n").map(line => JSON.parse(line));
      expect(readablePeer.peer, "ACTUAL_READABLE_MAINTENANCE_SEPARATE_PRINCIPAL").toMatchObject({ uid: 21002, gid: 21001 });
      expect(readablePeer.payload.privateSentinel, "ACTUAL_READABLE_MAINTENANCE_SENTINEL_REFUSED").toEqual({ errno: 13 });
      expect(readablePeer.payload.envMaskLengths.every((value: unknown) => value === 0 || JSON.stringify(value) === '{"errno":13}'), "ACTUAL_READABLE_MAINTENANCE_ENV_ALIASES_MASKED").toBe(true);
      expect(readablePeer.payload.declaredOutput, "ACTUAL_READABLE_MAINTENANCE_NO_OUTPUT").toBe("not-requested");
      expect(receipt.peer, "ACTUAL_MAINTENANCE_SEPARATE_PRINCIPAL").toMatchObject({ uid: 21002, gid: 21001 });
      expect(receipt.payload.privateSentinel, "ACTUAL_MAINTENANCE_PRIVATE_SENTINEL_REFUSED").toEqual({ errno: 13 });
      expect(receipt.payload.declaredOutput, "ACTUAL_MAINTENANCE_DECLARED_OUTPUT_WRITTEN").toBe("written");
      expect(receipt.payload.envMaskLengths.every((value: unknown) => value === 0 || JSON.stringify(value) === '{"errno":13}'), "ACTUAL_MAINTENANCE_STAGE_ENV_ALIASES_MASKED").toBe(true);

    } finally {
      if (listener.exitCode === null) listener.kill();
      await listener.exited;
      await Promise.all([peerStdout, peerStderr]);
      rmSync(peerRoot, { recursive: true, force: true });
    }
    await outputs.publish();
    expect(readFileSync(`${brain}/.brain-maintenance-probe`, "utf8"), "ACTUAL_MAINTENANCE_DECLARED_OUTPUT_PUBLISHED").toBe("qualified");
    expect(existsSync(`${brain}/.brain-maintenance-unpublished`), "ACTUAL_MAINTENANCE_UNDECLARED_OUTPUT_UNPUBLISHED").toBe(false);
    rmSync(`${brain}/.brain-maintenance-probe`);
    expect((await runMaintenanceWorker({ ...base(), command: ["/bin/sh", "-c", 'chmod 000 "$BRAIN_ROOT"'] })).exitCode,
      "ACTUAL_MAINTENANCE_UNREADABLE_STAGE_CONTROL").toBe(0);
    await refusedBeforePayload("UNREADABLE_NATIVE_MAINTENANCE_METADATA", () => prepareMaintenanceWorker(base()));
    await outputs.cleanup();
    await refusedBeforePayload("CLOSED_NATIVE_MAINTENANCE_OWNER", () => prepareMaintenanceWorker(base()));
    const publication = await prepareNativeWorkerOutput(brain, { startupView: view });
    let publicationControl: string | undefined;
    try {
      const input = await probeGitInput(publication); publicationControl = input.source.split("/").at(-1)!;
      const written = await runMaintenanceWorker({ ...base(), startupView: publication.view,
        output: { ...publication.output, target: "/tmp/brain-maintenance-output" },
        command: ["/bin/sh", "-c", 'printf qualified > "$BRAIN_ROOT/.brain-maintenance-publication-probe"'] });
      expect(written.exitCode, "ACTUAL_PRIVATE_GIT_DEFAULT_SCOPE_WRITER").toBe(0);
      await publication.publish();
      expect(readFileSync(`${brain}/.brain-maintenance-publication-probe`, "utf8"), "ACTUAL_PRIVATE_GIT_DEFAULT_SCOPE_PUBLISHED").toBe("qualified");
      expect(existsSync(`${brain}/${publicationControl}`), "ACTUAL_PRIVATE_GIT_CONTROL_UNPUBLISHED_WITH_DEFAULT_SCOPE").toBe(false);
      console.log(JSON.stringify({ privateGitDefaultPublication: "declared output published; private control excluded" }));
    } finally {
      await publication.cleanup(); rmSync(`${brain}/.brain-maintenance-publication-probe`, { force: true });
      if (publicationControl) rmSync(`${brain}/${publicationControl}`, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ kind: "maintenance-stage-launch", result }));
    return { row, result };
  } finally { try { await outputs?.cleanup(); } finally { await view.cleanup();
    for (const alias of aliases) rmSync(`${brain}/${alias}`, { force: true });
    rmSync(secretRoot, { recursive: true, force: true });
  } }
}

/** Separate provenance for the disposable database published by the fresh app. */
export async function captureWarmMaintenanceDatabase(brain: string) {
  const qualified = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
  if (!qualified.ok) throw Error("WARM_DATABASE_REAL_IDENTITY_PROBE_REFUSED");
  const manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
  const view = await prepareNativeWorkerStartupView(brain, manager);
  let output: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
  try {
    const host = lstatSync(`${brain}/brain.db`);
    output = await prepareNativeWorkerOutput(brain, { startupView: view });
    const result = await runMaintenanceWorker({ brainPath: brain, startupView: output.view,
      output: { ...output.output, target: "/tmp/brain-maintenance-output" }, credentials: false, env: { PATH: "/usr/bin:/bin" },
      command: ["/usr/bin/python3", "-I", "-S", "-c", String.raw`
import json,os,sqlite3,stat
path=os.environ["BRAIN_ROOT"]+"/brain.db"; s=os.stat(path)
r={"uid":os.getuid(),"gid":os.getgid(),"groups":os.getgroups(),"database":{"uid":s.st_uid,"gid":s.st_gid,"mode":oct(stat.S_IMODE(s.st_mode)),"writable":os.access(path,os.W_OK)}}
db=sqlite3.connect(path)
try:
 r["queryOnly"]=db.execute("PRAGMA query_only").fetchone()[0]
 db.execute("CREATE TABLE IF NOT EXISTS odysseus_stage_probe(value TEXT)"); db.commit(); r["write"]="written"
except sqlite3.Error as e: r["write"]={"error":str(e),"code":getattr(e,"sqlite_errorcode",None)}
finally: db.close()
print(json.dumps(r))
`], timeoutMs: 5000 });
    expect(result.exitCode, "ACTUAL_WARM_DATABASE_PROVENANCE").toBe(0);
    console.log(JSON.stringify({ actualWarmMaintenanceDatabase: { host: { uid: host.uid, gid: host.gid, mode: (host.mode & 0o7777).toString(8) },
      worker: JSON.parse(result.stdout) } }));
  } finally { try { await output?.cleanup(); } finally { await view.cleanup(); } }
}
