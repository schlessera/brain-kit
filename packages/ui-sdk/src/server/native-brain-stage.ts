/** Fixed privileged OverlayFS setup and metadata inspection for the native broker. */
import { readFileSync } from "node:fs";
import { NativeBrainManagerError, NATIVE_CONTROL_BYTES, type NativeStage, type NativeStageChange } from "./native-brain-manager-protocol.js";

// No repository code, caller program, environment, path discovery or shell
// evaluation. Mount authority exists only during this root-owned setup.
const STAGE_PROGRAM = String.raw`import ctypes,json,os,pathlib,stat,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
parent=os.getppid()
if libc.prctl(1,9,0,0,0)!=0 or os.getppid()!=parent:raise RuntimeError("stage parent-death containment failed")
mount,lower,uid,gid,allowance=sys.argv[1:]
uid=int(uid);gid=int(gid);allowance=int(allowance)
if os.geteuid()!=0 or open("/proc/self/uid_map").read().split()!=["0","0","4294967295"]:
 raise RuntimeError("trusted stage setup requires root in the initial user namespace")
def command(argv):
 result=subprocess.run(argv,env={},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if result.returncode:raise RuntimeError(result.stderr.decode(errors="replace"))
def identity(pid):
 text=open("/proc/"+str(pid)+"/stat").read();return text[text.rfind(")")+2:].split()[19]
command(["/usr/bin/mount","-i","-n","-t","tmpfs","-o","size="+str(allowance)+",mode=700,uid="+str(uid)+",gid="+str(gid)+",nosuid,nodev","tmpfs",mount])
for name in ("upper","work","merged"):
 os.mkdir(mount+"/"+name,0o700);os.chown(mount+"/"+name,uid,gid)
command(["/usr/bin/mount","-i","-n","-t","overlay","overlay","-o","lowerdir="+lower+",upperdir="+mount+"/upper,workdir="+mount+"/work,redirect_dir=nofollow,metacopy=off,index=off",mount+"/merged"])
keeper_program="import os,sys,json; print(json.dumps({'pid':os.getpid()}),flush=True);sys.stdin.buffer.read()"
keeper=subprocess.Popen(["/usr/bin/setpriv","--reuid="+str(uid),"--regid="+str(gid),"--clear-groups","--inh-caps=-all","--ambient-caps=-all","--no-new-privs","--pdeathsig=KILL","/usr/bin/unshare","--user","--map-root-user","--mount","--net","--ipc","--uts","--fork","--kill-child=SIGKILL","/usr/bin/python3","-I","-S","-c",keeper_program],env={},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
 line=keeper.stdout.readline(65537)
 if not line or len(line)>65536:raise RuntimeError("stage keeper did not prove readiness")
 pid=json.loads(line)["pid"];info=os.stat(mount);space=os.statvfs(mount)
 if space.f_blocks*space.f_frsize!=allowance:raise RuntimeError("stage allowance differs from actual tmpfs capacity")
 print(json.dumps({"pid":pid,"start":identity(pid),"device":str(info.st_dev),"inode":str(info.st_ino)}),flush=True)
 for line in sys.stdin.buffer:
  if line==b"release\n":break
  if line!=b"inspect\n":raise RuntimeError("invalid fixed stage control")
  count=0
  def emit(parts,kind):
   global count
   count+=1
   if count>200000:raise RuntimeError("stage exceeds existing 200000 entry bound")
   row=json.dumps({"pathHex":b"/".join(parts).hex(),"kind":kind},separators=(",",":"))
   if len(row.encode())>65536:raise RuntimeError("stage path exceeds control bound")
   print(row,flush=True)
  def walk(fd,parts,depth):
   if depth>256:raise RuntimeError("stage exceeds existing directory depth bound")
   for item in os.scandir(fd):
    name=item.name
    raw=os.fsencode(name);path="/proc/self/fd/"+str(fd)+"/"+name
    info=os.stat(name,dir_fd=fd,follow_symlinks=False);next_parts=parts+[raw]
    for attribute in ("trusted.overlay.redirect","trusted.overlay.metacopy"):
     try:os.getxattr(path,attribute,follow_symlinks=False)
     except OSError as error:
      if error.errno!=61:raise
     else:raise RuntimeError("unexpected redirect/metacopy in qualified stage")
    whiteout=stat.S_ISCHR(info.st_mode) and info.st_rdev==0
    if stat.S_ISREG(info.st_mode) and info.st_size==0:
     try:whiteout=os.getxattr(path,"trusted.overlay.whiteout",follow_symlinks=False)==b"y"
     except OSError as error:
      if error.errno!=61:raise
    if whiteout:emit(next_parts,"whiteout");continue
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
     raise RuntimeError("stage contains a socket, FIFO or unsupported device")
    emit(next_parts,"entry")
    if stat.S_ISDIR(info.st_mode):
     try:opaque=os.getxattr(path,"trusted.overlay.opaque",follow_symlinks=False)
     except OSError as error:
      if error.errno!=61:raise
      opaque=None
     if opaque not in (None,b"x",b"y"):raise RuntimeError("unexpected opaque marker")
     if opaque==b"y":emit(next_parts,"opaque")
     child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
     try:walk(child,next_parts,depth+1)
     finally:os.close(child)
  fd=os.open(mount+"/upper",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:walk(fd,[],0)
  finally:os.close(fd)
  print(json.dumps({"done":True,"entries":count}),flush=True)
finally:
 keeper.stdin.close()
 try:keeper.wait(timeout=5)
 except subprocess.TimeoutExpired:keeper.kill();keeper.wait()
 command(["/usr/bin/umount",mount+"/merged"])
 command(["/usr/bin/umount",mount])
`;

function processStart(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]!;
}

/** The response identifies a fixed keeper, never a requester-selected PID or mount. */
export async function startNativeStage(options: { id: string; checkpointId: string; checkpointUuid: string; sourceUuid: string;
  path: string; lower: string; appUid: number; appGid: number; allowanceBytes: number; timeoutMs: number; signal?: AbortSignal }) {
  if (/[,:\\]/.test(options.path) || /[,:\\]/.test(options.lower))
    throw new NativeBrainManagerError("unsupported", "Trusted OverlayFS requires managed paths without mount-option delimiters.");
  const child = Bun.spawn(["/usr/bin/unshare", "--mount", "/usr/bin/python3", "-I", "-S", "-c", STAGE_PROGRAM,
    options.path, options.lower, String(options.appUid), String(options.appGid), String(options.allowanceBytes)], {
    cwd: "/", env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader(); let pending = new Uint8Array(0), closed = false, failed = false;
  const errors = new Response(child.stderr).text(); void errors.catch(() => {});
  async function line(): Promise<string> {
    for (;;) {
      const at = pending.indexOf(10);
      if (at >= 0) { if (at > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("capacity", "Trusted stage metadata line exceeded its bound."); const bytes = pending.slice(0, at); pending = pending.slice(at + 1); return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      if (pending.byteLength > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("capacity", "Trusted stage metadata line exceeded its bound.");
      const item = await reader.read();
      if (item.done) throw new NativeBrainManagerError("unavailable", `Trusted stage helper exited before completion: ${(await errors).slice(0, 300)}`);
      const joined = new Uint8Array(pending.byteLength + item.value.byteLength); joined.set(pending); joined.set(item.value, pending.byteLength); pending = joined;
    }
  }
  async function bounded<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      stop = () => { failed = true; child.kill("SIGKILL"); reject(new NativeBrainManagerError("unknown", "Trusted stage operation was interrupted; outputs are unavailable until ownership cleanup.")); };
      timer = setTimeout(stop, options.timeoutMs); signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
    try { return await Promise.race([fn(), failure]); }
    finally { clearTimeout(timer); if (stop) signal?.removeEventListener("abort", stop); }
  }
  let stage: NativeStage;
  try {
    const ready = JSON.parse(await bounded(line, options.signal));
    if (!Number.isSafeInteger(ready.pid) || ready.pid <= 0 || !/^[1-9][0-9]*$/.test(ready.start) || processStart(ready.pid) !== ready.start)
      throw new NativeBrainManagerError("unavailable", "Stage keeper identity could not be verified in this PID namespace.");
    if (!/^[1-9][0-9]*$/.test(ready.device) || !/^[1-9][0-9]*$/.test(ready.inode))
      throw new NativeBrainManagerError("unknown", "Stage helper did not return its fixed mounted-root identity.");
    stage = { id: options.id, checkpointId: options.checkpointId, checkpointUuid: options.checkpointUuid, sourceUuid: options.sourceUuid,
      path: options.path, namespacePid: ready.pid, namespaceStart: ready.start, appUid: options.appUid, appGid: options.appGid,
      allowanceBytes: options.allowanceBytes, rootDevice: ready.device, rootInode: ready.inode };
  } catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
  return { stage,
    async *inspect(signal?: AbortSignal): AsyncGenerator<NativeStageChange> {
      if (closed || failed || processStart(stage.namespacePid) !== stage.namespaceStart)
        throw new NativeBrainManagerError("unavailable", "Trusted stage keeper is unavailable; discard outputs and reconcile its ownership.");
      await child.stdin.write("inspect\n"); let entries = 0, complete = false;
      try { for (;;) {
        const raw = await bounded(line, signal), row = JSON.parse(raw);
        if (row.done === true) { if (row.entries !== entries) throw Error("Stage inspection count mismatch"); complete = true; return; }
        if (++entries > 200_000 || Object.keys(row).sort().join(",") !== "kind,pathHex" || !["entry", "whiteout", "opaque"].includes(row.kind)
          || typeof row.pathHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(row.pathHex)) throw Error("Invalid stage metadata");
        yield row;
      } } finally { if (!complete) { failed = true; child.kill("SIGKILL"); await child.exited; } }
    },
    async close() {
      if (closed) return; closed = true;
      if (!failed) { try { await child.stdin.write("release\n"); await child.stdin.end(); } catch { child.kill("SIGKILL"); } }
      else child.kill("SIGKILL");
      const code = await bounded(() => child.exited); await reader.cancel();
      if (!failed && code !== 0) throw new NativeBrainManagerError("unknown", `Trusted stage cleanup exited ${code}: ${(await errors).slice(0,300)}`);
    },
  };
}
