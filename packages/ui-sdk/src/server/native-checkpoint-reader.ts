/** Short-lived root control/FD transfer; file access happens only after dropping UID. */
import { dirname, join } from "node:path";
import { NativeBrainManagerError } from "./native-brain-manager-protocol.js";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface NativeCheckpointReadRequest {
  action: "file" | "stat" | "list";
  path: string;
  maximum: number;
}
export interface NativeCheckpointReadTicket {
  id: string;
  socketPath: string;
  workerUid: number;
  maximum: number;
}
export interface NativeStageAuthorityMetadata {
  version: 1; kind: "brain-worker-stage"; id: string; appUid: number; appGid: number;
  keeper: { pid: number; start: string; mountNamespaceInode: string };
  root: { path: string; dev: string; ino: string };
  checkpoint: { path: string; dev: string; ino: string; uuid: string };
  allowanceBytes: number;
}

// The privileged parent never opens a relative file or reads its pipe. The
// child has only root FD 3/output FD 1 when it begins descriptor-relative IO.
export const NATIVE_CHECKPOINT_READER_PROGRAM = String.raw`import array,ctypes,fcntl,json,os,signal,socket,stat,struct,sys
os.chdir("/");os.environ.clear()
channel,token,app_uid,worker_uid,gid,timeout,request,*root_descriptor=sys.argv[1:]
if root_descriptor:
 original=int(root_descriptor[0]);os.dup2(original,3)
 if original!=3:os.close(original)
app_uid=int(app_uid);worker_uid=int(worker_uid);gid=int(gid);timeout=float(timeout);request=json.loads(request)
if os.geteuid()!=0 or worker_uid in (0,app_uid):raise RuntimeError("fixed separate reader identity required")
if not stat.S_ISDIR(os.fstat(3).st_mode):raise RuntimeError("authorized root descriptor required")
libc=ctypes.CDLL(None,use_errno=True);manager_pid=os.getppid();helper_pid=os.getpid()
if libc.prctl(1,15,0,0,0) or os.getppid()!=manager_pid:raise RuntimeError("checkpoint control parent disappeared")
listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);child=None;bound=False
def stop(signum,frame):
 if child:
  try:os.kill(child,signal.SIGKILL)
  except ProcessLookupError:pass
 raise RuntimeError("checkpoint reader cancelled or timed out")
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGALRM,stop);signal.setitimer(signal.ITIMER_REAL,timeout)
def write_all(fd,data):
 while data:
  count=os.write(fd,data);data=data[count:]
def read_child(output):
 os.dup2(output,1);os.closerange(4,os.sysconf("SC_OPEN_MAX"))
 try:os.close(0)
 except OSError:pass
 try:os.close(2)
 except OSError:pass
 os.setgroups([gid]);os.setgid(gid);os.setuid(worker_uid)
 if os.geteuid()!=worker_uid or os.getuid()!=worker_uid:os._exit(125)
 if libc.prctl(38,1,0,0,0) or libc.prctl(1,9,0,0,0) or os.getppid()!=helper_pid:os._exit(125)
 signal.signal(signal.SIGPIPE,signal.SIG_DFL)
 maximum=request["maximum"];path=request["path"];action=request["action"]
 # Linux statx mount identity is required: OverlayFS regular files can expose
 # the backing device while still belonging to the same authorized mount.
 def mount_identity(fd,name="",flags=0x1000):
  result=ctypes.create_string_buffer(256)
  if libc.statx(ctypes.c_int(fd),ctypes.c_char_p(os.fsencode(name)),ctypes.c_int(flags),ctypes.c_uint(0x1000),ctypes.byref(result)):
   error=ctypes.get_errno();raise OSError(error,os.strerror(error))
  if not struct.unpack_from("=I",result.raw,0)[0]&0x1000:raise RuntimeError("kernel did not return checkpoint mount identity")
  return struct.unpack_from("=Q",result.raw,144)[0]
 root_mount=mount_identity(3)
 def parts(value):
  result=value.split("/") if value else []
  if value.startswith("/") or "\0" in value or len(result)>256 or any(p in ("",".","..") for p in result):raise ValueError("invalid relative checkpoint path")
  return result
 def directory(names):
  fd=os.dup(3)
  try:
   for name in names:
    next_fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    if mount_identity(next_fd)!=root_mount:os.close(next_fd);raise PermissionError("foreign checkpoint mount refused")
    os.close(fd);fd=next_fd
   return fd
  except:os.close(fd);raise
 def metadata(fd,name,relative):
  info=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if mount_identity(fd,name,0x900)!=root_mount:raise PermissionError("foreign checkpoint mount refused")
  relative.encode("utf-8",errors="strict")
  kind="directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
  value={"path":relative,"kind":kind,"mode":stat.S_IMODE(info.st_mode),"bytes":info.st_size,"inode":str(info.st_ino),"stamp":str(info.st_ino)+":"+str(info.st_size)+":"+str(info.st_mtime_ns)+":"+str(info.st_ctime_ns)}
  if kind=="symlink":
   value["target"]=os.readlink(name,dir_fd=fd);value["target"].encode("utf-8",errors="strict")
  return value
 header_sent=False
 try:
  names=parts(path)
  if action=="file":
   if not names:raise ValueError("regular file required")
   parent=directory(names[:-1])
   try:fd=os.open(names[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
   finally:os.close(parent)
   try:
    info=os.fstat(fd)
    if mount_identity(fd)!=root_mount or not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise PermissionError("reader requires one regular unaliased file on its authorized checkpoint mount")
    if info.st_size>maximum:raise ValueError("checkpoint file exceeds read bound")
    write_all(1,json.dumps({"ok":True,"size":info.st_size,"uid":os.geteuid()},separators=(",",":")).encode()+b"\n");header_sent=True
    remaining=info.st_size
    while remaining:
     data=os.read(fd,min(65536,remaining))
     if not data:raise RuntimeError("sealed file ended early")
     write_all(1,data);remaining-=len(data)
    if os.read(fd,1):raise RuntimeError("sealed file grew")
   finally:os.close(fd)
  else:
   if action=="stat":
    if not names:raise ValueError("metadata requires a relative entry")
    parent=None
    try:
     parent=directory(names[:-1]);value=metadata(parent,names[-1],path)
    except FileNotFoundError:value=None
    finally:
     if parent is not None:os.close(parent)
   elif action=="list":
    fd=directory(names)
    try:
     rows=[];length=2
     for item in os.scandir(fd):
      name=item.name
      if len(rows)>=200000:raise ValueError("checkpoint directory exceeds entry bound")
      row=json.dumps(metadata(fd,name,path+"/"+name if path else name),ensure_ascii=True,separators=(",",":")).encode()
      length+=len(row)+(1 if rows else 0)
      if length>maximum:raise ValueError("checkpoint metadata exceeds read bound")
      rows.append((os.fsencode(name),row))
     data=b"["+b",".join(row for name,row in sorted(rows))+b"]"
    finally:os.close(fd)
   else:raise ValueError("invalid reader action")
   if action=="stat":data=json.dumps(value,ensure_ascii=True,separators=(",",":")).encode()
   if len(data)>maximum:raise ValueError("checkpoint metadata exceeds read bound")
   write_all(1,json.dumps({"ok":True,"size":len(data),"uid":os.geteuid()},separators=(",",":")).encode()+b"\n");header_sent=True;write_all(1,data)
  os._exit(0)
 except Exception as error:
  if not header_sent:
   write_all(1,json.dumps({"ok":False,"unreadable":isinstance(error,PermissionError),"message":str(error)[:500]},separators=(",",":")).encode()+b"\n")
  os._exit(1)
try:
 listener.bind(channel);bound=True;os.chown(channel,app_uid,gid);os.chmod(channel,0o600);listener.listen(1)
 print(json.dumps({"ready":True}),flush=True)
 connection,_=listener.accept()
 try:
  pid,uid,peer_gid=struct.unpack("3i",connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if uid!=app_uid or connection.recv(128)!=token.encode():raise RuntimeError("unauthorized checkpoint reader peer")
  if request["action"]=="authority":
   # Root-owned sealed control metadata only; never user-file bytes.
   descriptor=os.memfd_create("brain-worker-stage",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
   try:
    payload=json.dumps(request["authority"],separators=(",",":")).encode()
    if len(payload)>65536:raise RuntimeError("stage authority exceeds control bound")
    write_all(descriptor,payload);os.fchmod(descriptor,0o444);os.lseek(descriptor,0,os.SEEK_SET)
    fcntl.fcntl(descriptor,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
    connection.sendmsg([b"R"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[descriptor]))])
   finally:os.close(descriptor);os.close(3)
  else:
   input_fd,output_fd=os.pipe2(os.O_CLOEXEC);child=os.fork()
   if child==0:
    connection.close();listener.close();os.close(input_fd);read_child(output_fd)
   os.close(output_fd);os.close(3)
   try:connection.sendmsg([b"R"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[input_fd]))])
   finally:os.close(input_fd)
 finally:connection.close();listener.close()
 if child:
  _,status=os.waitpid(child,0);child=None
  if status:raise RuntimeError("checkpoint reader did not complete")
finally:
 if child:
  try:os.kill(child,signal.SIGKILL)
  except ProcessLookupError:pass
  os.waitpid(child,0)
 if bound:
  try:os.unlink(channel)
  except FileNotFoundError:pass
`;

export const NATIVE_CHECKPOINT_CLIENT_PROGRAM = String.raw`import array,fcntl,json,os,socket,stat,struct,sys
os.chdir("/");os.environ.clear()
channel,token,expected_uid,maximum=sys.argv[1:];expected_uid=int(expected_uid);maximum=int(maximum)
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);received=[]
try:
 connection.connect(channel)
 if struct.unpack("3i",connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=0:raise RuntimeError("checkpoint control peer is not root")
 connection.sendall(token.encode())
 data,ancillary,flags,address=connection.recvmsg(1,socket.CMSG_SPACE(16),socket.MSG_CMSG_CLOEXEC)
 for level,kind,raw in ancillary:
  if level!=socket.SOL_SOCKET or kind!=socket.SCM_RIGHTS:raise RuntimeError("unexpected checkpoint control message")
  descriptors=array.array("i");descriptors.frombytes(raw);received.extend(descriptors)
 if data!=b"R" or flags & (socket.MSG_TRUNC|socket.MSG_CTRUNC) or len(received)!=1:raise RuntimeError("expected exactly one checkpoint output pipe")
 fd=received[0]
 if not stat.S_ISFIFO(os.fstat(fd).st_mode) or fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE!=os.O_RDONLY:raise RuntimeError("checkpoint output descriptor is not a read pipe")
 connection.close();header=b""
 while not header.endswith(b"\n"):
  if len(header)>4096:raise RuntimeError("checkpoint reader header exceeds bound")
  data=os.read(fd,1)
  if not data:raise RuntimeError("checkpoint reader omitted header")
  header+=data
 receipt=json.loads(header)
 if receipt.get("ok") is not True:
  sys.stderr.write(json.dumps({"unreadable":receipt.get("unreadable") is True,"message":receipt.get("message","checkpoint read failed")}));sys.exit(1)
 size=receipt.get("size")
 if type(size)!=int or size<0 or size>maximum or receipt.get("uid")!=expected_uid or sorted(receipt)!=["ok","size","uid"]:raise RuntimeError("checkpoint reader identity or size mismatch")
 remaining=size
 while remaining:
  data=os.read(fd,min(65536,remaining))
  if not data:raise RuntimeError("checkpoint output ended early")
  remaining-=len(data)
  while data:
   count=os.write(1,data);data=data[count:]
 if os.read(fd,1):raise RuntimeError("checkpoint output exceeds sealed size")
 sys.stderr.write(json.dumps({"ok":True,"bytes":size,"workerUid":expected_uid}))
finally:
 connection.close()
 for fd in received:
  try:os.close(fd)
  except OSError:pass
`;

export function nativeCheckpointReaderPath(socketPath: string, id: string): string {
  return join(dirname(socketPath), `.read-${id}`);
}

/** The manager opens only a verified checkpoint root, never a requested file. */
export async function startNativeCheckpointRead(options: NativeCheckpointReadTicket & {
  token: string; rootFd: number; appUid: number; appGid: number; timeoutMs: number;
  request: NativeCheckpointReadRequest | { action: "authority"; authority: NativeStageAuthorityMetadata };
}) {
  const child = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", NATIVE_CHECKPOINT_READER_PROGRAM,
    options.socketPath, options.token, String(options.appUid), String(options.workerUid), String(options.appGid), String(options.timeoutMs / 1000), JSON.stringify(options.request)], {
    cwd: "/", env: {}, stdio: ["ignore", "pipe", "pipe", options.rootFd],
  });
  const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  const finished = child.exited.then(async code => {
    const detail = await errors;
    if (code !== 0) throw new NativeBrainManagerError("unavailable", `Checkpoint reader control failed: ${detail.slice(0, 500)}`);
  });
  void finished.catch(() => {});
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let ready = "";
    while (!ready.endsWith("\n")) {
      const first = await reader.read();
      if (first.done || ready.length + first.value.byteLength > 1024)
        throw new NativeBrainManagerError("unavailable", "Checkpoint reader did not establish its control channel.");
      ready += new TextDecoder().decode(first.value);
    }
    if (ready.trim() !== '{"ready": true}') throw new NativeBrainManagerError("unavailable", "Malformed checkpoint reader readiness.");
    // No privileged byte channel remains: stdout carries readiness only.
    void (async () => { while (!(await reader.read()).done) throw new Error("Unexpected checkpoint reader control output"); })().catch(() => child.kill("SIGTERM"));
    return { finished, async close() { child.kill("SIGTERM"); await finished.catch(() => {}); } };
  } catch (error) { child.kill("SIGTERM"); await finished.catch(() => {}); throw error; }
}

const STAGE_AUTHORITY_CLIENT = String.raw`import array,fcntl,json,os,socket,stat,struct,sys
os.chdir("/");os.environ.clear();channel,token=sys.argv[1:];received=[]
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:
 connection.connect(channel)
 if struct.unpack("3i",connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=0:raise RuntimeError("stage authority control peer is not root")
 connection.sendall(token.encode());data,ancillary,flags,address=connection.recvmsg(1,socket.CMSG_SPACE(16),socket.MSG_CMSG_CLOEXEC)
 for level,kind,raw in ancillary:
  if level!=socket.SOL_SOCKET or kind!=socket.SCM_RIGHTS:raise RuntimeError("unexpected stage authority control message")
  values=array.array("i");values.frombytes(raw);received.extend(values)
 if data!=b"R" or flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) or len(received)!=1:raise RuntimeError("exactly one stage authority descriptor required")
 fd=received[0];info=os.fstat(fd);seals=fcntl.fcntl(fd,fcntl.F_GET_SEALS)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=0 or info.st_size>65536 or stat.S_IMODE(info.st_mode)!=0o444 or seals&15!=15:raise RuntimeError("stage authority is not root-owned sealed control metadata")
 connection.close();print(json.dumps({"fd":fd}),flush=True);sys.stdin.buffer.read()
finally:
 connection.close()
 for fd in received:
  try:os.close(fd)
  except OSError:pass
`;

/** Unprivileged bridge duplicates one root-owned sealed metadata capability. */
export async function consumeNativeStageAuthority(ticket: { socketPath: string; token: string }, expectedStageId: string, signal?: AbortSignal): Promise<{ fd: number; close(): void }> {
  const child = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", STAGE_AUTHORITY_CLIENT, ticket.socketPath, ticket.token],
    { cwd: "/", env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stop = () => child.kill("SIGTERM"); signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  const errors = new Response(child.stderr).text();
  let result: number | undefined;
  try {
    const reader = child.stdout.getReader(); let text = "";
    while (!text.endsWith("\n")) {
      const next = await reader.read(); if (next.done || text.length + next.value.length > 1024) throw Error("Stage authority bridge did not prove bounded readiness");
      text += new TextDecoder().decode(next.value);
    }
    const receipt = JSON.parse(text);
    if (!Number.isSafeInteger(receipt.fd) || receipt.fd < 3 || Object.keys(receipt).join(",") !== "fd") throw Error("Malformed stage authority bridge receipt");
    signal?.throwIfAborted();
    result = openSync(`/proc/${child.pid}/fd/${receipt.fd}`, constants.O_RDONLY);
    const info = fstatSync(result);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 0 || info.size > 65536 || (info.mode & 0o777) !== 0o444) throw Error("Transferred stage authority metadata changed");
    const bytes = Buffer.alloc(info.size);
    if (readSync(result, bytes, 0, bytes.length, 0) !== bytes.length) throw Error("Stage authority metadata ended early");
    const value = JSON.parse(bytes.toString("utf8"));
    const decimal = (item: unknown) => typeof item === "string" && /^[1-9][0-9]*$/.test(item);
    const root = (item: any) => item && Object.keys(item).sort().join(",") === "dev,ino,path" &&
      typeof item.path === "string" && item.path.startsWith("/") && !item.path.includes("\0") && decimal(item.dev) && decimal(item.ino);
    if (value.version !== 1 || value.kind !== "brain-worker-stage" || value.id !== expectedStageId ||
      value.appUid !== process.getuid?.() || !Number.isSafeInteger(value.appGid) || value.appGid < 0 ||
      !Number.isSafeInteger(value.allowanceBytes) || value.allowanceBytes <= 0 ||
      !value.keeper || Object.keys(value.keeper).sort().join(",") !== "mountNamespaceInode,pid,start" ||
      !Number.isSafeInteger(value.keeper.pid) || value.keeper.pid <= 0 || !decimal(value.keeper.start) || !decimal(value.keeper.mountNamespaceInode) ||
      !root(value.root) || !value.checkpoint || !/^[0-9a-f]{32}$/.test(value.checkpoint.uuid) ||
      Object.keys(value.checkpoint).sort().join(",") !== "dev,ino,path,uuid" ||
      !root({ path: value.checkpoint.path, dev: value.checkpoint.dev, ino: value.checkpoint.ino }) ||
      Object.keys(value).sort().join(",") !== "allowanceBytes,appGid,appUid,checkpoint,id,keeper,kind,root,version")
      throw Error("Stage authority metadata does not match its manager-owned stage or app identity");
    let closed = false;
    return { fd: result, close() { if (closed) return; closed = true; closeSync(result!); } };
  } catch (error) { if (result !== undefined) closeSync(result); throw error; }
  finally { stop(); await child.exited; await errors; signal?.removeEventListener("abort", stop); }
}

export function consumeNativeCheckpointRead(ticket: NativeCheckpointReadTicket & { token: string }, signal?: AbortSignal) {
  const child = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", NATIVE_CHECKPOINT_CLIENT_PROGRAM,
    ticket.socketPath, ticket.token, String(ticket.workerUid), String(ticket.maximum)], { cwd: "/", env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = () => child.kill("SIGTERM"); signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  const completed = child.exited.then(async code => {
    const text = await new Response(child.stderr).text();
    let receipt: { ok?: boolean; bytes?: number; workerUid?: number; unreadable?: boolean; message?: string } = {};
    try { receipt = JSON.parse(text); } catch { /* Malformed control never qualifies bytes. */ }
    if (code !== 0 || receipt.ok !== true || receipt.workerUid !== ticket.workerUid || !Number.isSafeInteger(receipt.bytes) || receipt.bytes! < 0 || receipt.bytes! > ticket.maximum) {
      if (receipt.unreadable) throw Object.assign(new Error(receipt.message ?? "Worker checkpoint input remains unreadable"), { code: "EACCES" });
      throw new NativeBrainManagerError("unavailable", `Checkpoint reader completion failed: ${text.slice(0, 500)}`);
    }
    return { bytes: receipt.bytes!, workerUid: ticket.workerUid };
  }).finally(() => signal?.removeEventListener("abort", stop));
  void completed.catch(() => {});
  return { stream: child.stdout as ReadableStream<Uint8Array>, completed, cancel() { stop(); } };
}
