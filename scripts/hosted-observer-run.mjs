/** Finite Linux diagnostic wrapper. It never changes a test selector or deadline. */
import { spawn, spawnSync } from "node:child_process";
import { constants, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { runtimeIdentity } from "./hosted-observer-runtime.mjs";

const [directoryArg, secondsArg, separator, ...command] = process.argv.slice(2);
const seconds = Number(secondsArg);
if (!directoryArg || separator !== "--" || !command.length ||
    !Number.isInteger(seconds) || seconds < 1 || seconds > 1700) throw Error("Expected Linux Node 24 and OUTPUT SECONDS(1..1700) -- COMMAND ARGS");
const directory = resolve(directoryArg);
mkdirSync(directory, { mode: 0o700 }); // Exclusive invocation; never append to another run.
const runtime = runtimeIdentity();
writeFileSync(join(directory, "runtime.json"), JSON.stringify(runtime, null, 2));
if (!runtime.supported) { console.error("HOSTED_OBSERVER_INCOMPLETE requires Linux Node 24 before workload", JSON.stringify(runtime)); process.exit(1); }
const started = performance.now(), cpuStart = process.cpuUsage();
const errors = [], seen = new Map();
let errorCount = 0;
const problem = value => { errorCount++; if (errors.length < 128) errors.push(value); };
let samplingNs = 0n, samples = 0, child, childKey, finished = false, interrupted, watchdog = false, forceTimer;
let childExit, childClosed = false;
const eof = { stdout: false, stderr: false };
const writers = [];
function writer(name, cap) {
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let bytes = 0, stopped = false;
  const write = value => {
    if (stopped) return;
    try {
      const line = JSON.stringify(value) + "\n", size = Buffer.byteLength(line);
      if (bytes + size > cap) throw Error("byte cap");
      if (writeSync(fd, line) !== size) throw Error("short write");
      bytes += size;
    } catch (error) { stopped = true; problem(`${name}: ${error.message}`); }
  };
  writers.push({ name, close: () => { try { closeSync(fd); } catch (error) { stopped = true; problem(`${name} close: ${error.code}`); } return { name, bytes, stopped }; } });
  return write;
}
const resource = writer("resources.jsonl", 64 * 1024 * 1024);
const output = writer("output.jsonl", 32 * 1024 * 1024);
function stat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), ppid: Number(fields[1]), key: `${pid}:${fields[19]}`, raw };
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) problem(`stat ${pid}: ${error.code}`);
  }
}
function read(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { return { unavailable: error.code }; }
}
function sample() {
  const start = process.hrtime.bigint();
  try {
    const ids = readdirSync("/proc").filter(name => /^\d+$/.test(name));
    if (ids.length > 4096) throw Error("PID inventory exceeds 4096");
    const all = ids.map(stat).filter(Boolean), byParent = new Map(), selected = new Map();
    for (const item of all) {
      const list = byParent.get(item.ppid) ?? []; list.push(item); byParent.set(item.ppid, list);
    }
    const queue = all.filter(item => item.key === childKey || seen.get(item.pid) === item.key);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (selected.has(item.pid)) continue;
      if (!seen.has(item.pid) && seen.size >= 65536) throw Error("Owned PID history exceeds 65536");
      selected.set(item.pid, item); seen.set(item.pid, item.key);
      queue.push(...(byParent.get(item.pid) ?? []));
    }
    resource({ epochMs: Date.now(), ns: start.toString(), observerCpu: process.cpuUsage(cpuStart),
      processes: [...selected.values()].map(item => ({ ...item, io: read(`/proc/${item.pid}/io`), status: read(`/proc/${item.pid}/status`) })),
      vm: Object.fromEntries(["stat", "meminfo", "vmstat", "loadavg", "pressure/cpu", "pressure/io", "pressure/memory"].map(name => [name, read(`/proc/${name}`)])) });
    samples++;
  } catch (error) { problem(`sample: ${error.message}`); }
  finally { samplingNs += process.hrtime.bigint() - start; }
}
function stop(signal) {
  if (finished || interrupted) return;
  interrupted = signal;
  child.kill(signal); // Let the existing runner perform its own cancellation/cleanup.
  forceTimer = setTimeout(() => {
    // The tick sampler already owns PID discovery. Check only retained identities here.
    // Only the bounded outer watchdog owns this final cleanup, never a testcase timeout.
    for (const [pid, key] of [...seen].reverse()) {
      if (stat(pid)?.key === key) try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") problem(`kill: ${error.code}`); }
    }
    // EOF is not guaranteed if an unseen/reparented process holds a pipe. Bound the
    // wrapper anyway, explicitly retaining missing EOF and any surviving identity.
    setImmediate(() => {
      child.stdout.destroy(); child.stderr.destroy();
      finish(true);
    });
  }, 10000);
}
child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, BRAIN_HOSTED_OBSERVER_DIR: directory } });
childKey = stat(child.pid)?.key;
if (!childKey) problem("child PID/start unavailable; descendant coverage incomplete");
const kernelUnits = {};
for (const name of ["CLK_TCK", "PAGESIZE"]) {
  const result = spawnSync("getconf", [name], { encoding: "utf8", timeout: 1000 });
  kernelUnits[name] = result.status === 0 ? Number(result.stdout.trim()) : null;
}
writeFileSync(join(directory, "invocation.json"), JSON.stringify({ command, pid: child.pid, observerPid: process.pid, seconds,
  startedAt: Date.now(), runtime, kernelUnits, bootId: read("/proc/sys/kernel/random/boot_id"), childKey,
  scope: "PID/start-keyed descendants at one-second ticks; VM includes unrelated work. Short processes/peaks may be missed. No env or command-line scan." }, null, 2));
for (const [name, stream, target] of [["stdout", child.stdout, process.stdout], ["stderr", child.stderr, process.stderr]]) {
  let markerTail = "", forwarding = true;
  target.on("error", error => { forwarding = false; problem(`${name} forwarding: ${error.code}`); stream.resume(); });
  stream.on("data", bytes => {
    const text = markerTail + bytes.toString("utf8");
    if (text.includes("HOSTED_OBSERVER_INCOMPLETE")) problem("phase/build writer incomplete; see output");
    markerTail = text.slice(-24);
    output({ epochMs: Date.now(), ns: process.hrtime.bigint().toString(), stream: name, base64: bytes.toString("base64") });
    if (forwarding && !target.write(bytes)) { stream.pause(); target.once("drain", () => stream.resume()); }
  });
  stream.on("error", error => problem(`${name} pipe: ${error.code}`));
  stream.on("end", () => { eof[name] = true; output({ epochMs: Date.now(), stream: name, eof: true }); });
}
child.on("error", error => problem(`spawn: ${error.message}`));
child.on("exit", (code, signal) => { childExit = { code, signal }; output({ epochMs: Date.now(), exit: childExit }); });
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = signals.map(signal => { const handler = () => stop(signal); process.on(signal, handler); return [signal, handler]; });
sample();
const interval = setInterval(sample, 1000);
const cap = setTimeout(() => { watchdog = true; stop("SIGTERM"); }, seconds * 1000);
// Inspect finite files for malformed/truncated evidence and swallowed listing markers.
function inspectTraceFiles() {
  for (let slot = 0; slot < 128; slot++) {
    for (const [name, cap] of [[`phase-${slot}.jsonl`, 1048576], [`build-${slot}.json`, 262144]]) {
      try {
        const path = join(directory, name), bytes = readFileSync(path);
        if (bytes.length > cap || !bytes.length) throw Error("empty or oversized trace");
        if (name.endsWith("jsonl")) {
          const text = bytes.toString("utf8");
          if (!text.endsWith("\n")) throw Error("partial phase record");
          for (const line of text.trimEnd().split("\n")) {
            const value = JSON.parse(line);
            if (value?.data?.data?.observerIncomplete) throw Error("listing observer incomplete");
          }
        } else JSON.parse(bytes.toString("utf8"));
      } catch (error) { if (error.code !== "ENOENT") problem(`${name}: ${error.message}`); }
    }
  }
}
function finish(forced = false) {
  if (finished) return;
  finished = true;
  clearInterval(interval); clearTimeout(cap); clearTimeout(forceTimer);
  for (const [name, handler] of handlers) process.off(name, handler);
  sample();
  const survivors = [...seen].filter(([pid, key]) => stat(pid)?.key === key).map(([pid, key]) => ({ pid, key }));
  if (forced) problem("outer cleanup deadline reached; EOF/descendant coverage may be incomplete");
  if (!eof.stdout || !eof.stderr) problem("missing output EOF");
  if (!childClosed) problem("missing child close");
  inspectTraceFiles();
  const files = writers.map(writer => writer.close());
  const code = childExit?.code ?? null, signal = childExit?.signal ?? null;
  const signalCode = name => 128 + ({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[name] ?? 1);
  // A timed-out or cancelled zero-exiting child cannot turn its wrapper green.
  const exitCode = code && code > 0 ? code : watchdog ? 124 : interrupted ? signalCode(interrupted) : code === 0 ? 0 : signal ? signalCode(signal) : 1;
  const receipt = { code, signal, exitCode, interrupted, watchdog, forced, eof, childClosed, elapsedMs: performance.now() - started,
    observerCpu: process.cpuUsage(cpuStart), samplingNs: samplingNs.toString(), samples, survivors, files, errors, errorCount,
    captureComplete: !errors.length && !survivors.length && !watchdog && !interrupted,
    scope: "Wrapper self CPU includes sampling and log forwarding, excludes waited child CPU. Phase/build writers measured separately. Sampled survivors are not containment. Capture completeness is not qualifying proof." };
  try { writeFileSync(join(directory, "result.json"), JSON.stringify(receipt, null, 2)); }
  catch (error) { console.error("HOSTED_OBSERVER_INCOMPLETE result publication", error.message); }
  if (errorCount || survivors.length) console.error("HOSTED_OBSERVER_INCOMPLETE wrapper capture; inspect result.json");
  process.exitCode = exitCode;
  // At the absolute cleanup deadline even a stuck direct child cannot retain us.
  if (forced) process.exit(exitCode);
}
child.on("close", (code, signal) => {
  childClosed = true;
  childExit ??= { code, signal };
  finish();
});
