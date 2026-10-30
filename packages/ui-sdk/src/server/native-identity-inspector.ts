/**
 * One long-lived root identity inspector per native manager (#2872).
 *
 * Each inspection runs the same fixed program, with the same single path
 * argument, that a fresh `python3 -I -S -c` launch ran before; only the
 * interpreter start is shared. The program text is compiled once and executed
 * in fresh globals per request, so no inspection reuses another's state or
 * result. The manager applies its unchanged checks and refusals to the output.
 */
import { NativeBrainManagerError } from "./native-brain-manager-protocol.js";

/** Kernel UAPI: GET_SUBVOL_INFO supplies ctransid independently of generation/otransid. */
export const NATIVE_ROOT_INSPECTION = `import os,sys,fcntl,struct,json,uuid
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 s=os.fstat(fd)
 if s.st_ino!=256: raise RuntimeError("not a subvolume root")
 root=bytearray(504); fcntl.ioctl(fd,0x81f8943c,root,True)
 fs=bytearray(1024); fcntl.ioctl(fd,0x8400941f,fs,True)
 q=lambda offset: str(struct.unpack_from("<Q",root,offset)[0])
 u=lambda offset: bytes(root[offset:offset+16]).hex()
 print(json.dumps({"rootId":q(0),"uuid":u(296),"parentUuid":u(312),"receivedUuid":u(328),"transaction":q(344),"readOnly":bool(int(q(288))&1),"fsid":str(uuid.UUID(bytes=bytes(fs[16:32]))),"devices":struct.unpack_from("<Q",fs,8)[0]}))
finally: os.close(fd)
`;
export const NATIVE_LOOP_INSPECTION = `import os,sys,fcntl,struct,json
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)
try:
 info=bytearray(232); fcntl.ioctl(fd,0x4c05,info,True)
 print(json.dumps({"device":str(struct.unpack_from("<Q",info,0)[0]),"inode":str(struct.unpack_from("<Q",info,8)[0])}))
finally: os.close(fd)
`;
/**
 * Reads one JSON request per line and answers one JSON line: the program's
 * stdout, exit status and stderr as a fresh launch reported them. The
 * traceback omits this loop's own frame, and `SystemExit` maps to the status
 * the interpreter would have exited with.
 */
// Python 3.14 caches the outer -c source under the same filename/qualname/first
// line as both compiled programs. Supply active source through FrameSummary's
// public constructor instead of CPython's private code cache. The startup stack
// probes whether this interpreter's fresh -c tracebacks show source at all
// (3.12 does not). Preserve that presentation, including column indicators.
const INSPECTOR = `import sys,json,io,traceback
show_source=bool(traceback.extract_stack()[-1].line)
sources={"root":sys.argv[1].splitlines(True),"loop":sys.argv[2].splitlines(True)}
programs={"root":compile(sys.argv[1],"<string>","exec"),"loop":compile(sys.argv[2],"<string>","exec")}
reply=sys.stdout
for line in sys.stdin:
 request=json.loads(line); out=io.StringIO(); code=0; errors=""
 try:
  sys.stdout=out; sys.argv=["-c",request["path"]]
  exec(programs[request["program"]],{"__name__":"__main__"})
 except SystemExit as error:
  if error.code is None: code=0
  elif isinstance(error.code,int): code=error.code
  else: code=1; errors=str(error.code)+"\\n"
 except BaseException as error:
  code=1
  diagnostic=traceback.TracebackException(type(error),error,error.__traceback__.tb_next,lookup_lines=False,compact=True)
  for index,frame in enumerate(diagnostic.stack):
   if frame.filename=="<string>":
    source="".join(sources[request["program"]][frame.lineno-1:frame.end_lineno or frame.lineno]) if show_source else ""
    diagnostic.stack[index]=traceback.FrameSummary(frame.filename,frame.lineno,frame.name,line=source,end_lineno=frame.end_lineno,colno=frame.colno,end_colno=frame.end_colno)
  errors="".join(diagnostic.format())
 finally:
  sys.stdout=reply
 reply.write(json.dumps({"code":code,"text":out.getvalue(),"errors":errors})+"\\n"); reply.flush()
`;

export type NativeInspection = "root" | "loop";
export interface NativeIdentityInspectorOptions {
  python: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Bound on one reply, the same bound a fresh launch's output had. */
  maximumBytes: number;
}

export function createNativeIdentityInspector(options: NativeIdentityInspectorOptions) {
  type Running = { child: Bun.Subprocess<"pipe", "pipe", "pipe">; reader: ReadableStreamDefaultReader<Uint8Array>; buffered: Uint8Array; errors: Promise<string> };
  let running: Running | undefined, queue: Promise<unknown> = Promise.resolve(), closed = false, launches = 0;
  const current = new Set<AbortController>(), retiring = new Set<Promise<unknown>>();
  /** Kills the interpreter; resolves once every interpreter stopped so far has exited. */
  function stop(): Promise<unknown> {
    const stopping = running; running = undefined;
    if (stopping) {
      stopping.child.kill("SIGKILL");
      void stopping.reader.cancel().catch(() => {});
      const exited = stopping.child.exited.finally(() => retiring.delete(exited));
      retiring.add(exited);
    }
    return Promise.allSettled([...retiring]);
  }
  function start(): Running {
    const child = Bun.spawn([options.python, "-I", "-S", "-c", INSPECTOR, NATIVE_ROOT_INSPECTION, NATIVE_LOOP_INSPECTION],
      { env: options.env, cwd: "/", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    launches++;
    const errors = (async () => {
      // Startup failures only; inspections report their own tracebacks in-band.
      const reader = child.stderr.getReader(), pieces: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const item = await reader.read(); if (item.done) break; if (bytes < options.maximumBytes) { pieces.push(item.value); bytes += item.value.byteLength; } } }
      catch { /* A killed inspector's stderr may close abruptly. */ }
      return new TextDecoder().decode(Buffer.concat(pieces)).slice(0, options.maximumBytes);
    })();
    return { child, reader: child.stdout.getReader(), buffered: new Uint8Array(0), errors };
  }
  async function line(process: Running, aborted: Promise<never>): Promise<Uint8Array> {
    for (;;) {
      const end = process.buffered.indexOf(10);
      if ((end >= 0 ? end : process.buffered.byteLength) > options.maximumBytes) throw new NativeBrainManagerError("unavailable", "Native manager command output exceeded its bound.");
      if (end >= 0) {
        const result = process.buffered.slice(0, end); process.buffered = process.buffered.slice(end + 1);
        return result;
      }
      const item = await Promise.race([process.reader.read(), aborted]);
      if (item.done) {
        const detail = (await process.errors).trim();
        throw new NativeBrainManagerError("unavailable", `Native command refused: identity inspector exited${detail ? `: ${detail}` : ""}`);
      }
      const joined = new Uint8Array(process.buffered.byteLength + item.value.byteLength);
      joined.set(process.buffered); joined.set(item.value, process.buffered.byteLength); process.buffered = joined;
    }
  }
  async function ask(program: NativeInspection, path: string, signal?: AbortSignal): Promise<{ code: number; text: string; errors: string }> {
    if (closed) throw new NativeBrainManagerError("unavailable", "Native manager is closing.");
    // A request cancelled before it starts throws its own reason, as a launch refused before spawning did.
    signal?.throwIfAborted();
    const controller = new AbortController(); current.add(controller);
    const stopRequest = () => controller.abort(signal?.reason); signal?.addEventListener("abort", stopRequest, { once: true });
    if (signal?.aborted) stopRequest();
    const timer = setTimeout(() => controller.abort(new Error("Native manager transport operation timeout exceeded; configure operationTimeoutMs for this host workload.")), options.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail(); else controller.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {});
    let writing = false;
    try {
      controller.signal.throwIfAborted();
      running ??= start();
      const process = running, stdin = process.child.stdin;
      // A write to an interpreter that died can fail asynchronously; it fails this request.
      writing = true;
      await Promise.race([Promise.resolve(stdin.write(JSON.stringify({ program, path }) + "\n")).then(() => stdin.flush()), aborted]);
      writing = false;
      const bytes = await line(process, aborted);
      const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { code: unknown; text: unknown; errors: unknown };
      if (typeof reply.code !== "number" || typeof reply.text !== "string" || typeof reply.errors !== "string")
        throw new NativeBrainManagerError("unavailable", "Native identity inspector reply is malformed.");
      return { code: reply.code, text: reply.text, errors: reply.errors };
    } catch (error) {
      // An interrupted, oversized or malformed exchange leaves no reusable
      // stream position: the next inspection starts a new interpreter.
      // As a failed launch was reaped before its outcome was reported.
      await stop();
      if (controller.signal.aborted) throw new NativeBrainManagerError("unknown", `Native manager command was interrupted; reconcile recorded intent. ${String(controller.signal.reason)}`);
      if (writing && error instanceof Error && "code" in error && error.code === "EPIPE")
        throw new NativeBrainManagerError("unavailable", "Native command refused: identity inspector write failed (EPIPE).");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", stopRequest); current.delete(controller); }
  }
  return {
    /** Serialized: one request and its reply at a time on the shared interpreter. */
    run(program: NativeInspection, path: string, signal?: AbortSignal) {
      const result = queue.then(() => ask(program, path, signal));
      queue = result.catch(() => {});
      return result;
    },
    /** Interpreter launches so far; a healthy inspector launches once. */
    get launches() { return launches; },
    /** Stops the interpreter and resolves once it has exited. */
    async close(): Promise<void> {
      closed = true;
      for (const controller of current) controller.abort(new Error("Native manager is closing."));
      await stop();
    },
  };
}
