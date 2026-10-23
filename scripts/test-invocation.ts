/** Fresh live build authority, with private copies only inside one prepared queue. */
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectBuildPackages } from "./publishable-packages";
import { advanceOutputGeneration, liveAncestor, outputGeneration, processIdentity, workspaceLeaseIdentity } from "./workspace-lease.mjs";
import { invocationChild } from "./test-invocation-child";

const AUTHORITY = "BRAIN_TEST_BUILD_AUTHORITY";
const NONCE = "BRAIN_TEST_INVOCATION_NONCE";
const DELEGATION = "BRAIN_TEST_SPEECH_DELEGATION";
const PREPARED = "BRAIN_TEST_PREPARED_TREE";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const identity = (root: string) => { const path = realpathSync(root), st = statSync(path); return { path, dev: st.dev, ino: st.ino }; };
const event = (event: string, data: Record<string, unknown> = {}) => console.error(JSON.stringify({ kind: "test-invocation", event, pid: process.pid, at: Date.now(), ...data }));

type Authority = { version: 1; nonce: string; ownerPid: number; ownerStart: string; fd: number; dev: number; ino: number; sha256: string };
type CompletedBuild = { schemaVersion: number; kind: string; pid: number; id: string; generation: string; state: string; success: boolean; code: number; jobs: number;
  packages: { name: string; state: string; children: { compiler: string; pid: number; code: number; elapsedMs: number }[] }[] };
type PreparedSource = { target: string; root: string; authority: string; nonce: string };
const preparedTargets = new Map<string, ReturnType<typeof identity>>();
type InvocationRecord = { version: 1; nonce: string; ownerPid: number; ownerStart: string; root: ReturnType<typeof identity>; lease: NonNullable<ReturnType<typeof workspaceLeaseIdentity>>; build: CompletedBuild; preparedSource?: PreparedSource };

class InvocationCleanupFailure extends AggregateError {
  constructor(errors: unknown[]) { super(errors, "Invocation receipt cleanup failed"); }
}

function readRegular(path: string): { bytes: Buffer; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > 1_048_576) throw new Error("Invalid invocation receipt file");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Changed invocation receipt");
    return { bytes, dev: before.dev, ino: before.ino };
  } finally { closeSync(fd); }
}

function completedBuild(root: string, build: CompletedBuild, pid: number, id: string, expected?: readonly string[]): boolean {
  if (!build || build.schemaVersion !== 1 || build.kind !== "workspace-build" || build.pid !== pid || build.id !== id ||
      !positive(pid) || !uuid.test(id) || typeof build.generation !== "string" || !uuid.test(build.generation) ||
      build.generation !== outputGeneration(root) || build.state !== "complete" || build.success !== true || build.code !== 0 || build.jobs !== 1 ||
      !Array.isArray(build.packages) || !build.packages.length || build.packages.length > 128) return false;
  const names = build.packages.map(pkg => pkg?.name);
  if (names.some(name => typeof name !== "string") || new Set(names).size !== names.length ||
      (expected && !same(names, expected)) || !same(names, selectBuildPackages(root, names).map(pkg => pkg.dir))) return false;
  return build.packages.every(pkg => pkg.state === "complete" && Array.isArray(pkg.children) &&
    same(pkg.children.map(child => child.compiler), ["tsc", ...(["ui-react", "ui-kit"].includes(pkg.name) ? ["css"] : [])]) &&
    pkg.children.every(child => positive(child.pid) && child.code === 0 && Number.isFinite(child.elapsedMs) && child.elapsedMs >= 0));
}

/** Check the live owner's descriptor, never a pathname from the environment. */
export function invocationBuild(root: string, directories: readonly string[]): InvocationRecord | undefined {
  return readInvocation(root, directories, true);
}

function readInvocation(root: string, directories: readonly string[], allowPrepared: boolean): InvocationRecord | undefined {
  try {
    if (process.platform !== "linux" || (process.env[AUTHORITY]?.length ?? 0) > 4096) return;
    // Direct Bun watch/hot entrypoints can inherit a live outer locator too.
    if (readFileSync("/proc/self/cmdline", "utf8").split("\0").some(arg => /^(?:--watch|--hot)(?:=|$)/.test(arg))) return;
    const locator = JSON.parse(process.env[AUTHORITY] ?? "null") as Authority | null;
    if (!locator || locator.version !== 1 || !uuid.test(locator.nonce) || locator.nonce !== process.env[NONCE] ||
        !positive(locator.ownerPid) || !positive(locator.fd) || locator.fd < 3 || !/^[0-9a-f]{64}$/.test(locator.sha256) ||
        !liveAncestor(locator.ownerPid, locator.ownerStart)) return;
    const path = `/proc/${locator.ownerPid}/fd/${locator.fd}`;
    const st = statSync(path);
    if (!st.isFile() || st.dev !== locator.dev || st.ino !== locator.ino || st.size < 2 || st.size > 1_048_576) return;
    // /proc's descriptor is deliberately followed; no caller-controlled path is opened.
    const bytes = readFileSync(path);
    if (bytes.length !== st.size || digest(bytes) !== locator.sha256) return;
    const record = JSON.parse(bytes.toString()) as InvocationRecord;
    const lease = workspaceLeaseIdentity(root);
    if (record.version !== 1 || record.nonce !== locator.nonce || record.ownerPid !== locator.ownerPid || record.ownerStart !== locator.ownerStart ||
        !same(record.root, identity(root)) || !lease || lease.mode !== "write" || !same(record.lease, lease) ||
        record.build?.kind !== (record.preparedSource ? "workspace-build-copy" : "workspace-build") ||
        !completedBuild(root, { ...record.build, kind: "workspace-build" }, record.build?.pid, record.build?.id)) return;
    const built = new Set(record.build.packages.map(pkg => pkg.name));
    if (!selectBuildPackages(root, directories).every(pkg => built.has(pkg.dir))) return;
    if (record.preparedSource) {
      if (!allowPrepared || record.preparedSource.target !== record.root.path) return;
      const source = preparedSourceBuild(record.preparedSource);
      if (!source || source.ownerPid === record.ownerPid ||
          !same({ ...record.build, kind: source.build.kind, generation: source.build.generation }, source.build)) return;
    }
    const after = statSync(path);
    // Any later writer of the shared output, even a failed nested one, has
    // advanced the generation and so revoked this receipt.
    if (after.dev !== st.dev || after.ino !== st.ino || after.size !== st.size || after.ctimeMs !== st.ctimeMs ||
        outputGeneration(root) !== record.build.generation || !liveAncestor(locator.ownerPid, locator.ownerStart)) return;
    return record;
  } catch { /* Missing, stale or malformed authority always rebuilds in the hook. */ }
}

function mounts(pid: number | "self") {
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  return readFileSync(`/proc/${pid}/mountinfo`, "utf8").trim().split("\n").map(line => {
    const [before, after] = line.split(" - "), fields = before!.split(" "), filesystem = after!.split(" ");
    return { path: decode(fields[4]!), readonly: fields[5]!.split(",").includes("ro"), type: filesystem[0],
      lower: decode(filesystem[2]!.split(",").find(option => option.startsWith("lowerdir="))?.slice(9) ?? "") };
  });
}

// Only a filesystem Unix socket is used, inside an explicit offline namespace.
// SO_PEERCRED pins the response to the live ancestor that owns the build fd.
const preparedClient = String.raw`import json,os,socket,struct,sys
directory=os.open(os.path.join(sys.argv[1],"tmp"),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
  client.settimeout(10)
  client.connect("/proc/self/fd/"+str(directory)+"/.p.sock")
  peer=struct.unpack("3i",client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[1]!=os.getuid():raise RuntimeError("unexpected prepared build peer")
  client.sendall((json.dumps({"authority":sys.argv[2],"nonce":sys.argv[3],"target":sys.argv[4]})+"\n").encode())
  response=b""
  while b"\n" not in response:
   chunk=client.recv(65536)
   if not chunk:raise RuntimeError("incomplete prepared build response")
   response+=chunk
   if len(response)>1048576:raise RuntimeError("oversized prepared build response")
  print(json.dumps({"peer":peer[0],"record":json.loads(response)}))
finally:os.close(directory)
`;

function preparedSourceBuild(source: PreparedSource): InvocationRecord | undefined {
  try {
    if (!source || ![source.root, source.target, source.authority, source.nonce].every(value => typeof value === "string" && value.length < 8192)) return;
    const locator = JSON.parse(source.authority) as Authority;
    if (locator.version !== 1 || locator.nonce !== source.nonce || !uuid.test(source.nonce) || !positive(locator.ownerPid) ||
        !positive(locator.fd) || locator.fd < 3 || !/^[0-9a-f]{64}$/.test(locator.sha256) || !liveAncestor(locator.ownerPid, locator.ownerStart)) return;
    const child = Bun.spawnSync(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "python3", "-I", "-S", "-B", "-c", preparedClient, source.root, source.authority, source.nonce, source.target],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12_000 });
    if (child.exitCode !== 0 || child.signalCode) return;
    const answer = JSON.parse(new TextDecoder().decode(child.stdout)) as { peer: number; record?: InvocationRecord };
    const record = answer.record;
    if (!record || answer.peer !== locator.ownerPid || record.ownerPid !== locator.ownerPid || record.ownerStart !== locator.ownerStart ||
        record.nonce !== source.nonce || record.preparedSource || digest(JSON.stringify(record)) !== locator.sha256 ||
        !same(record.root, identity(source.root)) || record.root.path === source.target ||
        !completedBuild(source.root, record.build, record.build.pid, record.build.id, selectBuildPackages(source.root).map(pkg => pkg.dir))) return;
    const sourceMount = mounts("self").filter(mount => source.root === mount.path || source.root.startsWith(`${mount.path === "/" ? "" : mount.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return sourceMount?.readonly && liveAncestor(locator.ownerPid, locator.ownerStart) ? record : undefined;
  } catch { /* A missing owner or an unverified peer never grants a build. */ }
}

/** The live owner checks its descriptor and flock; workers never need ptrace. */
export function preparedSourceRecord(root: string, request: { authority?: unknown; nonce?: unknown; target?: unknown }): InvocationRecord | undefined {
  if (request.authority !== process.env[AUTHORITY] || request.nonce !== process.env[NONCE] || typeof request.target !== "string") return;
  const expected = preparedTargets.get(request.target);
  if (!expected || !same(expected, identity(request.target))) return;
  const record = readInvocation(root, selectBuildPackages(root).map(pkg => pkg.dir), false);
  return record?.ownerPid === process.pid ? record : undefined;
}

/** The queue owner advertises only its own fresh, complete, still-live build. */
export function preparedWorkerEnvironment(root: string, target: string): Record<string, string> {
  const record = invocationBuild(root, selectBuildPackages(root).map(pkg => pkg.dir));
  if (!record || record.ownerPid !== process.pid || record.preparedSource) throw new Error("Prepared unit tree needs its live original build owner");
  const destination = identity(target); preparedTargets.set(destination.path, destination);
  return { [PREPARED]: JSON.stringify({ target: destination.path, root: record.root.path,
    authority: process.env[AUTHORITY]!, nonce: process.env[NONCE]! } satisfies PreparedSource) };
}

/** Consume before tests start, so ordinary nested invocations always rebuild. */
export function takePreparedTree(root: string): PreparedSource | undefined {
  const raw = process.env[PREPARED]; delete process.env[PREPARED];
  if (!raw) return;
  if (raw.length > 32_768) throw new Error("Invalid prepared unit tree admission");
  const source = JSON.parse(raw) as PreparedSource;
  return source.target === realpathSync(root) ? source : undefined;
}

export function prepareCopiedInvocation(root: string, source: PreparedSource): { code: number; dispose: () => void } {
  const before = performance.now(), record = preparedSourceBuild(source);
  const view = mounts("self").find(mount => mount.path === realpathSync(root) && mount.type === "overlay");
  // The initial generation comes from the immutable lower tree. Adoption
  // replaces it, so a nested invocation cannot replay this admission.
  if (!record || view?.lower !== source.root || source.target !== realpathSync(root) || outputGeneration(root) !== record.build.generation) {
    throw new Error("Prepared unit tree is not a fresh private view of the live build");
  }
  const build = { ...record.build, kind: "workspace-build-copy", generation: advanceOutputGeneration(root) };
  const dispose = publishInvocation(root, build, source);
  if (!invocationBuild(root, selectBuildPackages(root).map(pkg => pkg.dir))) { dispose(); throw new Error("Unattested prepared unit view"); }
  event("build-copied", { nonce: process.env[NONCE], builderPid: build.pid, buildId: build.id, elapsedMs: performance.now() - before });
  return { code: 0, dispose };
}

/** Only the isolated external-speech wrapper may deliberately borrow this run. */
export function externalSpeechDelegation(root: string): NodeJS.ProcessEnv {
  const record = invocationBuild(root, ["ui-react", "ui-server", "core"]);
  return { ...process.env, [DELEGATION]: record ? JSON.stringify({ nonce: record.nonce, pid: process.pid, start: processIdentity(process.pid)?.start }) : "" };
}

export function acceptsSpeechDelegation(root: string, paths: readonly string[]): boolean {
  try {
    if (process.env.BRAIN_EXTERNAL_SPEECH_WORKER !== "1" || paths.length !== 1 ||
        resolve(root, paths[0]!) !== join(root, "packages/ui-react/tests/external-speech-runtime.test.ts")) return false;
    const request = JSON.parse(process.env[DELEGATION] ?? "null");
    const record = invocationBuild(root, ["ui-react", "ui-server", "core"]);
    return Boolean(record && request?.nonce === record.nonce && liveAncestor(request.pid, request.start));
  } catch { return false; }
}

export function clearInvocation(): string {
  delete process.env[AUTHORITY]; delete process.env[DELEGATION];
  return process.env[NONCE] = randomUUID();
}

function publishInvocation(root: string, build: CompletedBuild, preparedSource?: PreparedSource): () => void {
  const nonce = process.env[NONCE]!;
  let fd: number | undefined;
  let directory: { path: string; dev: number; ino: number } | undefined;
  let named: { path: string; dev: number; ino: number } | undefined;
  const dispose = () => {
    delete process.env[AUTHORITY];
    const errors: unknown[] = [];
    if (fd !== undefined) { try { closeSync(fd); } catch (error) { errors.push(error); } fd = undefined; }
    if (named) {
      try {
        const current = lstatSync(named.path, { throwIfNoEntry: false });
        if (current) {
          if (!current.isFile() || current.dev !== named.dev || current.ino !== named.ino) throw new Error("Replaced invocation receipt; retained scratch");
          unlinkSync(named.path);
        }
        named = undefined;
      } catch (error) { errors.push(error); }
    }
    if (directory) {
      try {
        const current = lstatSync(directory.path, { throwIfNoEntry: false });
        if (current) {
          if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error("Replaced invocation directory; retained scratch");
          // Never recurse: an unrelated entry or failed owned unlink is retained.
          rmdirSync(directory.path);
        }
        directory = undefined;
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new InvocationCleanupFailure(errors);
  };
  try {
    const lease = workspaceLeaseIdentity(root), ownerStart = processIdentity(process.pid)?.start;
    if (!lease || lease.mode !== "write" || !ownerStart || !uuid.test(nonce)) throw new Error("Unattested completed preparation");
    const record: InvocationRecord = { version: 1, nonce, ownerPid: process.pid, ownerStart, root: identity(root), lease, build, ...(preparedSource ? { preparedSource } : {}) };
    const bytes = JSON.stringify(record);
    const scratch = mkdtempSync(join(tmpdir(), "brain-test-invocation-")), dirStat = lstatSync(scratch);
    directory = { path: scratch, dev: dirStat.dev, ino: dirStat.ino };
    const path = join(scratch, "receipt");
    const writer = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const created = fstatSync(writer);
    named = { path, dev: created.dev, ino: created.ino };
    try { writeFileSync(writer, bytes); } finally { closeSync(writer); }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== named.dev || st.ino !== named.ino) throw new Error("Replaced invocation receipt before publication");
    unlinkSync(path); named = undefined;
    rmdirSync(scratch); directory = undefined;
    const locator: Authority = { version: 1, nonce, ownerPid: process.pid, ownerStart, fd, dev: st.dev, ino: st.ino, sha256: digest(bytes) };
    process.env[AUTHORITY] = JSON.stringify(locator);
    return dispose;
  } catch (error) { dispose(); throw error; }
}

/** Called after write admission. Caller forwards cancellation throughout build/test. */
export async function prepareInvocation(root: string, directories: readonly string[] | undefined,
  started: (child: ReturnType<typeof invocationChild>) => void, options: { dropCapabilities?: boolean } = {}): Promise<{ code: number; dispose: () => void }> {
  const nonce = process.env[NONCE]!;
  const selected = selectBuildPackages(root, directories).map(pkg => pkg.dir);
  const buildId = randomUUID(), before = performance.now();
  const argv = [process.execPath, join(root, "scripts/build.ts"), ...(directories ? ["--for", directories.join(",")] : [])];
  const child = invocationChild(options.dropCapabilities ? ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", ...argv] : argv,
    { cwd: root, stdin: "ignore", env: { ...process.env, BRAIN_TEST_BUILD_ID: buildId } });
  started(child);
  await child.ready;
  event("build-start", { nonce, builderPid: child.pid, buildId, packages: selected });
  async function drain(stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") {
    let bytes = 0;
    for await (const chunk of stream) { bytes += chunk.length; process[channel].write(chunk); }
    event(`${channel}-complete`, { nonce, builderPid: child.pid, bytes });
  }
  const results = await Promise.allSettled([child.exited.then(code => { event("build-exit", { nonce, builderPid: child.pid, code, signal: child.signalCode }); return code; }),
    drain(child.stdout as ReadableStream<Uint8Array>, "stdout"), drain(child.stderr as ReadableStream<Uint8Array>, "stderr")]);
  await child.finish();
  const resource = child.resourceUsage();
  const usage = resource ? { cpuUserUs: Number(resource.cpuTime.user), cpuSystemUs: Number(resource.cpuTime.system),
    maxRssBytes: Number(resource.maxRSS) } : undefined;
  const exited = results[0];
  const code = exited.status === "fulfilled" ? exited.value : 1;
  if (code !== 0 || child.signalCode || child.cancelled || results.some(result => result.status === "rejected")) {
    event("preparation-failed", { nonce, builderPid: child.pid, code, usage, elapsedMs: performance.now() - before });
    return { code: code || 1, dispose() {} };
  }
  try {
    const receipt = readRegular(join(root, "tmp", `build-${child.pid}-${buildId}-probe.json`));
    const build = JSON.parse(receipt.bytes.toString()) as CompletedBuild;
    if (!completedBuild(root, build, child.pid, buildId, selected)) throw new Error("Unattested completed preparation");
    const dispose = publishInvocation(root, build);
    event("build-attested", { nonce, builderPid: child.pid, buildId, packages: selected, usage, elapsedMs: performance.now() - before });
    return { code: 0, dispose };
  } catch (error) {
    if (error instanceof InvocationCleanupFailure) throw error;
    event("build-unattested", { nonce, builderPid: child.pid, usage, elapsedMs: performance.now() - before });
    return { code: 0, dispose() {} };
  }
}
