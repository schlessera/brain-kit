/** Explicit disposable-container proof; never installs a helper on the host. */
import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { launchAgentWorker, prepareWorkerSandbox, probeWorkerHost, WORKER_STATE, type LaunchedWorker } from "../src/server/worker-launcher.js";
import { prepareRecoveredWorkerFile, prepareRecoveredWorkerFiles, recoveredWorkerFile, recoveredWorkerFiles } from "../src/server/worker-identity-reader.js";
import { processStateLedger } from "../src/server/worker-state-budget.js";
import { hostOutputStagingLimits } from "../src/server/worker-state-limits.js";

if (process.getuid?.() !== 21001 || !existsSync("/usr/local/bin/identity-helper")) throw Error("IDENTITY_QUALIFICATION_REQUIRES_DISPOSABLE_CONTAINER_SERVER_UID");
const root = mkdtempSync("/identity-fixture/case-");
chmodSync(root, 0o2775);
const brain = join(root, "brain"); mkdirSync(brain, { mode: 0o2775 }); chmodSync(brain, 0o2775);
const MIB = 1024 * 1024;
let cases = 0;
const sleep = (ms: number) => Bun.sleep(ms);
async function until(condition: () => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() >= deadline) throw Error(label); await sleep(20); }
}
function workerPids(): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { const status = readFileSync(`/proc/${name}/status`, "utf8"); return /^Uid:\s+21002\s/m.test(status) && !/^State:\s+Z/m.test(status) ? [Number(name)] : []; } catch { return []; }
  });
}
const ownedStreams = new WeakMap<LaunchedWorker, Promise<unknown>>();
async function collect(stream: NodeJS.ReadableStream, append: (text: string) => void): Promise<void> { for await (const chunk of stream as AsyncIterable<Buffer>) append(chunk.toString()); }
function launch(program: string, overrides: Partial<Parameters<typeof launchAgentWorker>[0]> = {}) {
  const worker = launchAgentWorker({ brainPath: brain,
    sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
    stateBytes: MIB, turnTempBytes: MIB, env: { HOME: WORKER_STATE },
    command: ["/usr/bin/python3", "-I", "-S", "-c", program], ...overrides });
  worker.stdin.end();
  // Own streams from launch, so EOF cleanup is observed on every outcome.
  let outputText = "", errorText = "";
  ownedStreams.set(worker, Promise.all([collect(worker.stdout, text => { outputText += text; }), collect(worker.stderr, text => { errorText += text; })]));
  return { worker, output: () => outputText, errors: () => errorText };
}
async function close(worker: LaunchedWorker) {
  try { await worker.exited; } catch { /* Caller asserts the particular failed outcome. */ }
  worker.state?.close(); worker.state?.close(); worker.turnTemp?.close(); worker.turnTemp?.close();
  await ownedStreams.get(worker);
  await until(() => workerPids().length === 0, "IDENTITY_OWNED_WORKER_TREE_REMAINS");
}
async function check(name: string, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([run(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error(`IDENTITY_CASE_TIMED_OUT: ${name}`)), 20000); })]); }
  finally { clearTimeout(timer); }
  cases++; console.log(JSON.stringify({ case: name, result: "pass" }));
}

try {
  await check("nested server-owned 0700 parent masks launch and conceal private files and sockets", async () => {
    const directory = "/identity-server-private/nested-mask-state";
    mkdirSync(directory, { mode: 0o700 });
    const alias = "/identity-fixture/nested-private-alias"; symlinkSync(directory, alias);
    mkdirSync(join(directory, "nested"));
    const secret = join(directory, "private.txt"), socket = join(directory, "private.sock");
    writeFileSync(secret, "Odysseus private operational state");
    let contacts = 0;
    const listener = Bun.serve({ unix: socket, fetch() { contacts++; return new Response("Ithaca"); } });
    try {
      const positive = createConnection({ path: socket });
      try {
        await once(positive, "connect");
        positive.end("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        let reply = "";
        for await (const data of positive) reply += data.toString();
        expect(reply).toContain("Ithaca");
      } finally { positive.destroy(); }
      const program = `import os,json,socket
try: value=open(${JSON.stringify(secret)}).read()
except (PermissionError,FileNotFoundError): value='REFUSED'
s=socket.socket(socket.AF_UNIX);s.settimeout(1)
try: s.connect(${JSON.stringify(socket)}); connected=True
except OSError: connected=False
finally: s.close()
print(json.dumps(dict(uid=os.getuid(),value=value,connected=connected)))`;
      for (const profile of ["governed"] as const) {
        let launched: ReturnType<typeof launch> | undefined;
        expect(() => { launched = launch(program, { sandbox: { brain, profile, restricted: false, areas: [], scratchAliasesRemoved: [], maskPaths: [alias, join(directory, "nested"), directory] } }); },
          `NESTED_PRIVATE_PARENT_LAUNCH_${profile}`).not.toThrow();
        const { worker, output, errors } = launched!;
        try {
          const code = await worker.exited;
          if (code !== 0) await close(worker);
          expect(code, `NESTED_PRIVATE_PARENT_LAUNCH_${profile}: ${errors()}`).toBe(0);
          await until(() => output().includes("\n"), "NESTED_PRIVATE_PARENT_RECEIPT");
          expect(JSON.parse(output())).toEqual({ uid: 21002, value: "REFUSED", connected: false });
          expect(contacts, "NESTED_PRIVATE_SOCKET_NEVER_CONTACTED").toBe(1);
        } finally { await close(worker); }
      }
      expect(readFileSync(secret, "utf8")).toBe("Odysseus private operational state");
    } finally { try { listener.stop(true); } finally { rmSync(alias, { force: true }); rmSync(directory, { recursive: true, force: true }); } }
  });
  await check("shared-group 0701 parent uses group search permission before other search", async () => {
    const parent = join(root, "group-no-search"), directory = join(parent, "state");
    mkdirSync(parent, { mode: 0o701 }); chmodSync(parent, 0o701);
    mkdirSync(directory, { mode: 0o700 });
    const secret = join(directory, "private.txt"); writeFileSync(secret, "Odysseus private operational state");
    expect(statSync(parent).gid).toBe(process.getgid!());
    let launched: ReturnType<typeof launch> | undefined;
    try {
      expect(() => { launched = launch(`import os,json
try: value=open(${JSON.stringify(secret)}).read()
except (PermissionError,FileNotFoundError): value='REFUSED'
print(json.dumps(dict(uid=os.getuid(),value=value)))`, { sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [], maskPaths: [directory] } }); },
        "SHARED_GROUP_0701_PARENT_MUST_LAUNCH").not.toThrow();
      const { worker, output, errors } = launched!;
      const code = await worker.exited;
      if (code !== 0) await close(worker);
      expect(code, `SHARED_GROUP_0701_PARENT_MUST_LAUNCH: ${errors()}`).toBe(0);
      await until(() => output().includes("\n"), "SHARED_GROUP_0701_RECEIPT");
      expect(JSON.parse(output())).toEqual({ uid: 21002, value: "REFUSED" });
    } finally { try { if (launched) await close(launched.worker); } finally { rmSync(parent, { recursive: true, force: true }); } }
  });
  await check("private-parent promotion refuses brain and required runtime intersections before payload", async () => {
    const marker = join(brain, "mask-overlap-must-not-run");
    const parent = join(root, "runtime-parent"), directory = join(parent, "private"), runtime = join(parent, "runtime.txt");
    mkdirSync(parent, { mode: 0o700 }); mkdirSync(directory); writeFileSync(runtime, "Odysseus runtime");
    const alias = join(root, "runtime-alias"); symlinkSync(runtime, alias);
    const refused = async (readPaths: string[] | undefined, label: string) => {
      let unexpected: ReturnType<typeof launch> | undefined;
      try {
        expect(() => { unexpected = launch(`open(${JSON.stringify(marker)},'w').write('unexpected')`, { sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [],
          ...(readPaths ? { readPaths } : {}), maskPaths: [directory] } }); }, label).toThrow("overlaps the brain or required runtime");
      } finally { if (unexpected) await close(unexpected.worker); }
    };
    try {
      await refused(["/usr/bin/python3", alias], "PRIVATE_PARENT_RUNTIME_COLLISION_REFUSED");
      expect(existsSync(marker)).toBe(false);
      chmodSync(root, 0o700);
      await refused(undefined, "PRIVATE_PARENT_BRAIN_COLLISION_REFUSED");
      expect(existsSync(marker)).toBe(false);
      await until(() => workerPids().length === 0, "PRIVATE_PARENT_COLLISION_LEFT_WORKER");
    } finally { chmodSync(root, 0o2775); rmSync(alias, { force: true }); rmSync(parent, { recursive: true, force: true }); }
  });
  await check("same-UID unmasked sentinel control and explicit no-helper database-directory mask", async () => {
    const configured = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    try {
      for (const masked of [false, true]) {
        const { worker, output } = launch(`import os,json
try: value=open('/identity-server-private/sentinel').read()
except (PermissionError,FileNotFoundError): value='REFUSED'
print(json.dumps(dict(uid=os.getuid(),value=value)))`, {sandbox:{brain,profile:"governed",restricted:false,areas:[],scratchAliasesRemoved:[],...(masked?{maskPaths:["/identity-server-private"]}:{})}});
        try {
          expect(await worker.exited).toBe(0);await until(()=>output().includes("\n"),"IDENTITY_SAME_UID_RECEIPT_MISSING");
          const receipt=JSON.parse(output());expect(receipt.uid).toBe(21001);
          expect(receipt.value).toBe(masked?"REFUSED":"Odysseus private server sentinel");
        } finally { await close(worker); }
      }
    } finally { if(configured!==undefined)process.env.BRAIN_UI_WORKER_IDENTITY_HELPER=configured; }
  });
  await check("real host probes qualify separate UID, sentinel and positive controls in governed and strict",async()=>{
    for(const profile of ["governed","strict"] as const)expect(probeWorkerHost(brain,{profile,stateBytes:MIB,turnTempBytes:MIB})).toMatchObject({ok:true,identity:"separate_uid",workerUid:21002});
  });
  await check("unobservable separate-UID folder mounts keep the payload gate closed", async () => {
    mkdirSync(join(brain, "group/private"), { recursive: true, mode: 0o2775 });
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
    expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
    const marker = join(brain, "unqualified-folder-payload");
    expect(() => launch(`open('${marker}','w').write('unexpected')`, { sandbox }),
      "UNOBSERVABLE_SECOND_UID_FOLDERS_KEEP_GATE_CLOSED").toThrow("provider folder topology could not be qualified before payload start");
    expect(existsSync(marker)).toBe(false);
    await until(() => workerPids().length === 0, "UNQUALIFIED_FOLDER_LEFT_WORKER");
  });
  await check("a non-dropping helper cannot start a same-UID payload", async () => {
    const configured = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "/usr/local/bin/identity-helper-non-dropping";
    const marker = join(brain, "same-uid-payload-must-not-run");
    let launched: ReturnType<typeof launch> | undefined;
    try {
      try { launched = launch(`import os;open('${marker}','w').write(str(os.getuid()))`); }
      catch (error) { expect(String(error)).toContain("worker_identity_wrong_uid"); return; }
      expect(await launched.worker.exited).toBe(0);
      expect(existsSync(marker), "NON_DROPPING_HELPER_STARTED_SAME_UID_PAYLOAD").toBe(false);
    } finally {
      if (launched) await close(launched.worker);
      if (configured !== undefined) process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = configured;
    }
  });
  await check("missing, malformed, refusing and genuinely non-dropping helpers cannot qualify or run payload",async()=>{
    const configured=process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    const marker=join(brain,"bad-helper-payload");
    try {
      for(const helper of ["relative-helper --prefix","/usr/local/bin/absent-identity-helper","/usr/local/bin/identity-helper-refuses","/usr/local/bin/identity-helper-non-dropping"]) {
        process.env.BRAIN_UI_WORKER_IDENTITY_HELPER=helper;
        const probe=probeWorkerHost(brain,{profile:"governed",stateBytes:MIB,turnTempBytes:MIB});
        expect(probe.ok).toBe(false);
        if(!probe.ok&&helper.endsWith("non-dropping"))expect(probe.requirement).toContain("worker_identity_wrong_uid");
        expect(()=>launch(`open('${marker}','w').write('unexpected')`)).toThrow();
        expect(existsSync(marker)).toBe(false);await until(()=>workerPids().length===0,"IDENTITY_BAD_HELPER_LEFT_WORKER");
      }
    } finally {if(configured!==undefined)process.env.BRAIN_UI_WORKER_IDENTITY_HELPER=configured;}
  });
  await check("malformed status and substituted helper identity or descriptors refuse before payload execution", async () => {
    const configured = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    try {
      const expectedReasons: Record<string, string> = {
        "malformed-status": "Expecting value", "wrong-pid": "/proc/2147483647/stat",
        "wrong-namespace": "wrong_pid_namespace", "wrong-uid": "worker_identity_wrong_uid", "wrong-root-identity": "worker_identity_substituted_mount",
        "wrong-allowance": "worker_identity_substituted_mount", "wrong-type": "worker_identity_substituted_mount",
        "extra-fd": "worker_identity_unexpected_mount_handles",
      };
      for (const fault of Object.keys(expectedReasons)) {
        process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = `/usr/local/bin/identity-helper-fault-${fault}`;
        const marker = join(brain, `fault-payload-${fault}`);
        expect(() => launch(`open('${marker}','w').write('unexpected')`),
          `MALFORMED_HELPER_${fault}_MUST_REFUSE`).toThrow(expectedReasons[fault]);
        expect(existsSync(marker), `MALFORMED_HELPER_${fault}_MUST_KEEP_GATE_CLOSED`).toBe(false);
        await until(() => workerPids().length === 0, `MALFORMED_HELPER_${fault}_LEFT_WORKER`);
      }
    } finally { if (configured !== undefined) process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = configured; }
  });
  await check("helper final exec resets inherited ignored signals and pipelines stay quiet", async () => {
    for(const [command,verify] of [
      [["/usr/bin/cat","/proc/self/status"],(output:string)=>expect(output.match(/^SigIgn:\s+([0-9a-f]+)$/m)?.[1]).toBe("0000000000000000")],
      [["/bin/sh","-c","/usr/bin/yes | /usr/bin/head -1"],(output:string)=>expect(output).toBe("y\n")],
    ] as const) {
      const {worker,output,errors}=launch("",{command});
      try { expect(await worker.exited).toBe(0);await close(worker);verify(output());expect(errors()).toBe(""); }
      finally { await close(worker); }
    }
  });
  await check("setup population failure keeps the payload gate closed and releases the owned tree",async()=>{
    const marker=join(brain,"setup-must-not-run");
    expect(()=>launch(`open('${marker}','w').write('unexpected')`,{populateState(){throw Error("fixture_setup_cancelled");}})).toThrow("fixture_setup_cancelled");
    await until(()=>workerPids().length===0,"IDENTITY_SETUP_FAILURE_LEFT_WORKER");expect(existsSync(marker)).toBe(false);
    // A fresh admitted launch proves a failed setup did not poison the next gate.
    const {worker}=launch("pass");try{expect(await worker.exited).toBe(0);}finally{await close(worker);}
  });
  await check("cross-uid private sentinel, bounded populated state/temp and payload descriptor filter", async () => {
    const { worker, output, errors } = launch(`import json,os,subprocess
status=open('/proc/self/status').read()
try: open('/identity-server-private/sentinel').read(); sentinel='READABLE'
except PermissionError: sentinel='EACCES'
open('${brain}/governed-write','w').write('Odysseus')
open('/tmp/positive','w').write('Telemachus')
os.mkdir(os.environ['HOME']+'/private',0o700)
open(os.environ['HOME']+'/private/result','w').write('The homecoming relay')
os.chmod(os.environ['HOME']+'/private/result',0o600)
fds=[]
for fd in os.listdir('/proc/self/fd'):
 try: fds.append(os.readlink('/proc/self/fd/'+fd))
 except FileNotFoundError: pass
helper_attempt=subprocess.run(['/usr/local/bin/identity-helper','--brain-worker-identity-v1','signal','0'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
print(json.dumps(dict(uid=os.getuid(),gid=os.getgid(),map=open('/proc/self/uid_map').read(),sentinel=sentinel,initial=open(os.environ['HOME']+'/initial').read(),status=status,fds=fds,environment=dict(os.environ),helperAttempt=helper_attempt)))`, {
      populateState(path) { writeFileSync(join(path, "initial"), "Ithaca"); },
    });
    try {
      expect(await worker.exited).toBe(0); expect(errors()).toBe("");
      await until(() => output().includes("\n"), "IDENTITY_WORKER_RECEIPT_MISSING");
      const receipt = JSON.parse(output());
      expect(receipt.uid).toBe(21002); expect(receipt.gid).toBe(21001); expect(receipt.map).toMatch(/21002/);
      expect(receipt.sentinel).toBe("EACCES"); expect(receipt.initial).toBe("Ithaca");
      expect(receipt.status).toMatch(/^CapEff:\s+0000000000000000$/m); expect(receipt.status).toMatch(/^NoNewPrivs:\s+1$/m);
      expect(receipt.environment.BRAIN_UI_WORKER_IDENTITY_HELPER).toBeUndefined();
      expect(receipt.helperAttempt).toBe(125);
      expect(receipt.fds.every((fd: string) => !fd.startsWith("socket:") && !fd.includes("brain-worker-identity-") && !fd.includes("brain-identity-mounts"))).toBe(true);
      expect(worker.state!.space().total).toBe(MIB); expect(worker.turnTemp!.space().total).toBe(MIB);
      expect(readFileSync(join(brain, "governed-write"), "utf8")).toBe("Odysseus");
      expect(recoveredWorkerFile(worker.turnTemp!.root + "/positive", 100)?.toString()).toBe("Telemachus");
      expect(() => readFileSync(worker.state!.root + "/private/result")).toThrow();
      expect(recoveredWorkerFile(worker.state!.root + "/private/result", 100)?.toString()).toBe("The homecoming relay");
      expect(recoveredWorkerFiles(worker.state!.root)).toContain("private/result");
      expect(() => recoveredWorkerFile(worker.state!.root + "/private/result", 2)).toThrow();
    } finally { await close(worker); }
  });

  await check("actual helper protocol rejects wrong launch PID/start owners and unsolicited SCM_RIGHTS",async()=>{
    const pulse=join(brain,"protocol-ready");
    const {worker}=launch(`import time
open('${pulse}','w').write('ready')
while True:time.sleep(.02)`);
    try {
      await until(()=>existsSync(pulse),"IDENTITY_PROTOCOL_WORKER_DID_NOT_START");
      const args=readFileSync(`/proc/${worker.pid}/cmdline`,"utf8").split("\0").filter(Boolean),config=JSON.parse(args.at(-1)!);
      const fields=readFileSync(`/proc/${worker.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ");
      const base={version:1,launch:config.launch,server:config.server,supervisor:{pid:worker.pid,start:fields[19]},signal:"KILL"};
      const invalid=[
        {name:"server PID",patch:{server:{...base.server,pid:worker.pid}},reason:"wrong_launch_owner"},
        {name:"server start",patch:{server:{...base.server,start:"0"}},reason:"wrong_launch_owner"},
        {name:"supervisor PID",patch:{supervisor:{...base.supervisor,pid:process.pid}},reason:"wrong_launch_owner"},
        {name:"supervisor start",patch:{supervisor:{...base.supervisor,start:"0"}},reason:"wrong_launch_owner"},
        {name:"unknown launch",patch:{launch:crypto.randomUUID()},reason:"No such file"},
        {name:"unsolicited descriptors",patch:{},rights:true,reason:"unexpected_descriptors"},
      ];
      for(const attempt of invalid) {
        const script=`import array,json,os,socket,subprocess
left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
child=subprocess.Popen(['/usr/local/bin/identity-helper','--brain-worker-identity-v1','signal',str(right.fileno())],pass_fds=(right.fileno(),),env={},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
right.close()
request=${JSON.stringify(JSON.stringify({...base,...attempt.patch}))}
control=[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[os.open('/dev/null',os.O_RDONLY)]))] if ${attempt.rights?"True":"False"} else []
left.sendmsg([request.encode()],control)
reply=json.loads(left.recv(65536));out,error=child.communicate(timeout=5)
print(json.dumps(dict(reply=reply,code=child.returncode)))`;
        const child=Bun.spawnSync(["/usr/bin/python3","-I","-S","-c",script],{env:{},stdout:"pipe",stderr:"pipe",timeout:7000});
        expect(child.exitCode,attempt.name+": "+child.stderr.toString()).toBe(0);
        const result=JSON.parse(child.stdout.toString());expect(result.code).toBe(125);expect(result.reply.ok).toBe(false);expect(result.reply.reason).toContain(attempt.reason);
      }
      worker.kill("SIGKILL");expect(await worker.exited).toBe(137);
    } finally { try{worker.kill("SIGKILL");}catch{}await close(worker); }
  });

  await check("recovery refuses a known live writer and follows neither aliases nor unauthorized roots", async () => {
    const pulse = join(brain, "live-ready");
    const { worker, errors } = launch(`import os,time
os.mkdir(os.environ['HOME']+'/private',0o700)
open(os.environ['HOME']+'/private/result','w').write('Odysseus retained bytes')
os.chmod(os.environ['HOME']+'/private/result',0o600)
os.symlink('/identity-server-private/sentinel',os.environ['HOME']+'/alias')
open('${pulse}','w').write('ready')
while True: time.sleep(.02)`);
    const outcome = worker.exited.then(code => ({ code }), error => ({ error: String(error) }));
    try {
      await until(() => existsSync(pulse), "IDENTITY_LIVE_WRITER_DID_NOT_START");
      expect(() => recoveredWorkerFile(worker.state!.root + "/private/result", 100)).toThrow();
      const refused = await outcome; expect(refused).toHaveProperty("error"); expect((refused as {error:string}).error).toContain("recovery_before_termination");
      await until(() => workerPids().length === 0, "IDENTITY_READER_REFUSAL_LEFT_WRITER");
      expect(errors()).toBe("");
      expect(recoveredWorkerFile(worker.state!.root + "/private/result", 100)?.toString()).toBe("Odysseus retained bytes");
      expect(() => recoveredWorkerFile(worker.state!.root + "/alias", 100)).toThrow();
      expect(recoveredWorkerFile("/identity-server-private/sentinel", 100)).toBeUndefined();
      const alias = worker.state!.root; worker.state!.close();
      expect(recoveredWorkerFile(alias + "/private/result", 100)).toBeUndefined();
    } finally { try { worker.kill("SIGKILL"); } catch {} await close(worker); }
  });

  await check("post-exit reader rejects hardlinks, symlinks, nonregular files, aliases and byte overruns", async () => {
    const {worker}=launch(`import os
root=os.environ['HOME']
open(root+'/regular','w').write('Odysseus')
open(root+'/hard-source','w').write('Circe')
os.link(root+'/hard-source',root+'/hard-alias')
os.symlink('/identity-server-private/sentinel',root+'/symlink')
os.mkfifo(root+'/fifo',0o600)`);
    try {
      expect(await worker.exited).toBe(0);
      expect(recoveredWorkerFile(worker.state!.root+"/regular",8)?.toString()).toBe("Odysseus");
      for(const name of ["hard-source","hard-alias","symlink","fifo"]) expect(()=>recoveredWorkerFile(worker.state!.root+"/"+name,100)).toThrow();
      expect(()=>recoveredWorkerFiles(worker.state!.root)).toThrow();
      for(const suffix of ["/./regular","/../regular","//regular"]) expect(()=>recoveredWorkerFile(worker.state!.root+suffix,100)).toThrow("path_alias_refused");
      for(const bound of [-1,0,7,NaN,Infinity]) expect(()=>recoveredWorkerFile(worker.state!.root+"/regular",bound)).toThrow();
      expect(recoveredWorkerFile("/identity-server-private/sentinel",100)).toBeUndefined();
    } finally { await close(worker); }
  });

  await check("bounded async private-file recovery can be cancelled without publishing a partial cache", async () => {
    for(const allFiles of [false,true]) {
      const {worker}=launch(`import os
os.mkdir(os.environ['HOME']+'/private',0o700)
open(os.environ['HOME']+'/private/large','wb').write(b'x'*524288)
os.chmod(os.environ['HOME']+'/private/large',0o600)`);
      try {
        expect(await worker.exited).toBe(0);
        const controller=new AbortController();let observedOffset=0;
        // Observe this server's own fixed RPC client argv; seeing its second
        // data packet proves copy-out started before cancellation.
        const timer=setInterval(()=>{
          for(const pid of readdirSync("/proc").filter(name=>/^\d+$/.test(name))) {
            try { const args=readFileSync(`/proc/${pid}/cmdline`,"utf8").split("\0").filter(Boolean);const request=JSON.parse(args.at(-1)!);
              if(request.operation==="read"&&request.path==="private/large"&&request.offset>=32768){observedOffset=request.offset;controller.abort();}
            } catch { /* Unrelated processes do not carry a broker request. */ }
          }
        },5);
        try {
          const recovery=allFiles?prepareRecoveredWorkerFiles(worker.state!.root,controller.signal):prepareRecoveredWorkerFile(worker.state!.root+"/private/large",MIB,controller.signal);
          await expect(recovery).rejects.toMatchObject({name:"AbortError"});expect(observedOffset).toBeGreaterThanOrEqual(32768);
          // Cancelled preparation must not expose a captured prefix as completed bytes.
          expect(()=>recoveredWorkerFile(worker.state!.root+"/private/large",MIB)).toThrow();
        } finally { clearTimeout(timer); }
      } finally { await close(worker); }
    }
  });

  await check("retained-root recovery refuses an actual foreign nested mount", async () => {
    const configured = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "/usr/local/bin/identity-helper-fault-foreign-mount";
    let worker: LaunchedWorker | undefined;
    try {
      const launched = launch(`import os,json
root=os.environ['HOME']
open(root+'/foreign/result','w').write('Odysseus foreign mount')
print(json.dumps(dict(root=os.stat(root).st_dev,foreign=os.stat(root+'/foreign').st_dev)))`);
      worker = launched.worker;
      expect(await worker.exited).toBe(0);
      await until(() => launched.output().includes("\n"), "FOREIGN_MOUNT_RECEIPT_MISSING");
      const receipt = JSON.parse(launched.output());
      expect(receipt.foreign, "NEGATIVE_CONTROL_REQUIRES_A_REAL_DISTINCT_MOUNT").not.toBe(receipt.root);
      expect(() => recoveredWorkerFile(worker!.state!.root + "/foreign/result", 100),
        "FOREIGN_MOUNT_BYTES_MUST_NOT_BE_RECOVERED").toThrow("unexpected_mount");
    } finally {
      if (worker) await close(worker);
      if (configured !== undefined) process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = configured;
    }
  });
  await check("closing a root aborts pending recovery and retains its reservation until confirmed cleanup", async () => {
    const { worker } = launch("import os;open(os.environ['HOME']+'/result','wb').write(b'x'*262144)");
    const ledger = processStateLedger(), baseline = ledger.outputStagingHeld;
    try {
      expect(await worker.exited).toBe(0);
      const outcome = prepareRecoveredWorkerFile(worker.state!.root + "/result", MIB)
        .then(() => ({ success: true }), error => ({ success: false, error: String(error) }));
      expect(ledger.outputStagingHeld, "PENDING_COPY_RESERVES_ROOT_ALLOWANCE").toBe(baseline + MIB);
      worker.state!.close();
      expect(ledger.outputStagingHeld, "CLOSED_ROOT_RESERVATION_REMAINS_UNTIL_HELPER_ACK").toBe(baseline + MIB);
      expect((await outcome).success, "CLOSED_ROOT_MUST_NOT_PUBLISH_ASYNC_COPY").toBe(false);
      await close(worker);
      expect(ledger.outputStagingHeld, "COPY_RESERVATION_RELEASED_ONCE_AFTER_DRAIN_AND_ACK").toBe(baseline);
    } finally { await close(worker); }
  });
  await check("whole-root and single-file recovery exclude each other in either start order", async () => {
    for (const fullFirst of [true, false]) {
      const { worker } = launch(`import os
open(os.environ['HOME']+'/result','wb').write(b'x'*262144)`);
      let first: Promise<unknown> | undefined;
      try {
        expect(await worker.exited).toBe(0);
        first = fullFirst ? prepareRecoveredWorkerFiles(worker.state!.root)
          : prepareRecoveredWorkerFile(worker.state!.root + "/result", MIB);
        const second = fullFirst ? prepareRecoveredWorkerFile(worker.state!.root + "/result", MIB)
          : prepareRecoveredWorkerFiles(worker.state!.root);
        await expect(second, "MIXED_RECOVERY_START_ORDER_MUST_NOT_OVERLAP").rejects.toThrow("already_in_progress");
        await first;
        expect(recoveredWorkerFile(worker.state!.root + "/result", MIB)?.length).toBe(262144);
      } finally { await first?.catch(() => {}); await close(worker); }
    }
  });
  await check("sparse private files cannot exceed the root aggregate recovery cache allowance", async () => {
    const { worker } = launch(`import os
for name in ('first', 'second'):
 with open(os.environ['HOME']+'/'+name,'wb') as output: output.truncate(${3 * MIB / 4})`);
    try {
      expect(await worker.exited).toBe(0);
      expect(await prepareRecoveredWorkerFile(worker.state!.root + "/first", MIB)).toBe(3 * MIB / 4);
      await expect(prepareRecoveredWorkerFile(worker.state!.root + "/second", MIB),
        "SPARSE_FILES_CANNOT_EXCEED_RESERVED_RECOVERY_MEMORY").rejects.toThrow();
    } finally { await close(worker); }
  });
  await check("zero-byte private file remains readable with a zero-byte maximum", async () => {
    const { worker } = launch("import os;open(os.environ['HOME']+'/empty','wb').close()");
    try {
      expect(await worker.exited).toBe(0);
      expect(recoveredWorkerFile(worker.state!.root + "/empty", 0)?.length,
        "EMPTY_FILE_NEEDS_NO_RECOVERY_BYTES").toBe(0);
    } finally { await close(worker); }
  });
  await check("known recovery memory holds its full allowance and busy aggregate capacity refuses explicitly",async()=>{
    const ledger=processStateLedger(),baseline=ledger.outputStagingHeld,limits=hostOutputStagingLimits();
    const {worker}=launch(`import os
open(os.environ['HOME']+'/result','w').write('Odysseus recovery budget')
os.chmod(os.environ['HOME']+'/result',0o600)`);
    try {
      expect(await worker.exited).toBe(0);
      const busy=ledger.reserve(undefined,undefined,{allowanceBytes:limits.budgetBytes-baseline,budgetBytes:limits.budgetBytes});
      try {await expect(prepareRecoveredWorkerFile(worker.state!.root+"/result",100)).rejects.toThrow("worker_identity_recovery_capacity_unavailable");}
      finally {busy.release();}
      expect(await prepareRecoveredWorkerFile(worker.state!.root+"/result",100)).toBe(24);
      expect(ledger.outputStagingHeld).toBe(baseline+MIB);
      expect(recoveredWorkerFile(worker.state!.root+"/result",100)?.toString()).toBe("Odysseus recovery budget");
    } finally {await close(worker);}
    expect(ledger.outputStagingHeld).toBe(baseline);
  });

  await check("STOP and CONT cover a genuinely nested PID namespace, then abort terminates it", async () => {
    const pulse = join(brain, "nested-pulse");
    const payload = `import os,time
with open(${JSON.stringify(pulse)},'a',buffering=1) as out:
 while True: out.write('x');out.flush();time.sleep(.02)`;
    const { worker, errors } = launch(`import subprocess,time
child=subprocess.Popen(['/usr/bin/unshare','--user','--map-root-user','--pid','--fork','--mount-proc','/usr/bin/python3','-I','-S','-c',${JSON.stringify(payload)}])
raise SystemExit(child.wait())`);
    try {
      await until(() => existsSync(pulse) && statSync(pulse).size > 2, "IDENTITY_NESTED_PID_DID_NOT_START");
      expect(workerPids().length).toBeGreaterThan(1);
      worker.freeze(); const frozen = statSync(pulse).size; await sleep(160); expect(statSync(pulse).size).toBe(frozen);
      worker.resume(); await until(() => statSync(pulse).size > frozen + 2, "IDENTITY_NESTED_PID_DID_NOT_RESUME");
      worker.kill("SIGKILL"); expect(await worker.exited).toBe(137); expect(errors()).toBe("");
      const ended = statSync(pulse).size; await sleep(100); expect(statSync(pulse).size).toBe(ended);
    } catch (error) { console.error("Nested PID fixture stderr:", errors()); throw error; }
    finally { try { worker.kill("SIGKILL"); } catch {} await close(worker); }
  });

  for (const mode of ["supervisor-kill", "control-disconnect"] as const) await check(`${mode} fails the turn and independently ends its writer`, async () => {
    const pulse = join(brain, mode);
    const { worker, errors } = launch(`import time
with open('${pulse}','a',buffering=1) as out:
 while True: out.write('x');out.flush();time.sleep(.02)`);
    // Attach rejection before killing supervision; it must remain a failed turn.
    const outcome = worker.exited.then(code => ({ code }), error => ({ error: String(error) }));
    try {
      await until(() => existsSync(pulse) && statSync(pulse).size > 2, "IDENTITY_SUPERVISION_WRITER_DID_NOT_START");
      if (mode === "supervisor-kill") process.kill(worker.pid, "SIGKILL");
      else {
        const args = readFileSync(`/proc/${worker.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const config = JSON.parse(args.at(-1)!); rmSync(config.socket);
      }
      const result = await outcome; expect(result).toHaveProperty("error"); expect(String((result as { error: string }).error)).toMatch(/supervisor|control|supervision/);
      console.log(JSON.stringify({ supervisionMode: mode, outcome: result, stderr: errors() }));
      await until(() => workerPids().length === 0, "IDENTITY_SUPERVISION_LOSS_LEFT_WRITER").catch(error => { console.error("Surviving worker processes", workerPids().map(pid => ({pid, status:readFileSync(`/proc/${pid}/status`,"utf8").split("\n").filter(line=>/^(Name|State|PPid|Uid):/.test(line))}))); throw error; });
      const ended = statSync(pulse).size; await sleep(100); expect(statSync(pulse).size).toBe(ended);
    } finally { await close(worker); }
  });

  for(const duringSetup of [false,true]) await check(`server death ${duringSetup?"during setup":"during execution"} independently terminates its real worker tree`,async()=>{
    const pulse=join(brain,duringSetup?"server-setup-pulse":"server-death-pulse");
    const mustNotRun=join(brain,"cancelled-setup-payload");
    const payload=`import time
with open('${pulse}','a',buffering=1) as out:
 while True: out.write('x');out.flush();time.sleep(.02)`;
    const program=`import {launchAgentWorker,WORKER_STATE} from '/repo/packages/ui-sdk/src/server/worker-launcher.ts';
const brain=${JSON.stringify(brain)};
const worker=launchAgentWorker({brainPath:brain,sandbox:{brain,profile:'governed',restricted:false,areas:[],scratchAliasesRemoved:[]},stateBytes:${MIB},turnTempBytes:${MIB},env:{HOME:WORKER_STATE},${duringSetup?`populateState(){require('node:fs').writeFileSync(${JSON.stringify(pulse)},'setup-ready');Bun.sleepSync(10000);},`:""}command:['/usr/bin/python3','-I','-S','-c',${JSON.stringify(duringSetup?`open('${mustNotRun}','w').write('unexpected')`:payload)}]});
worker.stdin.end();worker.stdout.resume();worker.stderr.resume();
await worker.exited;`;
    const server=Bun.spawn([process.execPath,"--preload","/repo/scripts/test-network-child-preload.ts","-e",program],{env:{PATH:"/usr/bin:/bin",BRAIN_UI_WORKER_IDENTITY_HELPER:"/usr/local/bin/identity-helper"},stdout:"pipe",stderr:"pipe"});
    const stdout=new Response(server.stdout).text(),stderr=new Response(server.stderr).text();
    try {
      await until(()=>existsSync(pulse)&&statSync(pulse).size>2,"IDENTITY_CHILD_SERVER_WORKER_DID_NOT_START");
      server.kill("SIGKILL");expect(await server.exited).toBe(137);
      await until(()=>workerPids().length===0,"IDENTITY_SERVER_DEATH_LEFT_WORKER");
      const ended=statSync(pulse).size;await sleep(100);expect(statSync(pulse).size).toBe(ended);if(duringSetup)expect(existsSync(mustNotRun)).toBe(false);
      await stdout;expect(await stderr).toBe("");
    } finally { if(server.exitCode===null)server.kill("SIGKILL");await server.exited; }
  });
  await import("./egress-identity-qualification.native.js");
  console.log(JSON.stringify({ identityQualification: "pass", cases, serverUid: process.getuid(), workerUid: 21002, limits: "owned-tree cleanup and best-effort observed-byte recovery; external references are not globally excluded" }));
} finally { rmSync(root, { recursive: true, force: true }); }

await import("../../ui-backend-claude/tests/sdk-host-relay-identity.native.js");
