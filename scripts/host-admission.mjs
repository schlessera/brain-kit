/**
 * Host-wide admission for heavy local test commands (#2943).
 *
 * Separate worktrees on one machine share nothing through the workspace lease
 * (`scripts/workspace-lease.mjs`), so five checkouts could start five native
 * suites at once and time out together. This ledger admits at most a limited
 * number of heavy commands per host; the rest wait in a priority queue instead
 * of starting. Its state is durable and only ever changed under a short ledger
 * lock by these commands, so a crashed orchestrator or worker leaves nothing an
 * ordinary later caller cannot reconcile: dead holders and waiters are pruned
 * by process identity on every pass.
 *
 *   node scripts/host-admission.mjs run [--red-main-fix <pr>] [--label <text>] -- <command...>
 *   node scripts/host-admission.mjs preempt <slot> --reason red-main-fix [--grace-ms <ms>]
 *   node scripts/host-admission.mjs status
 *
 * Preemption follows the #2938 ruling: only within the caller's own
 * orchestrator subtree, and only to admit a waiting red-main fix. A preempted
 * run is recorded as `preempted`, which is neither a pass nor a failure.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { availableParallelism, constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveAncestor, processIdentity } from "./workspace-lease.mjs";

/** Inherited by an admitted command, so its nested heavy commands do not queue behind themselves. */
export const MARKER = "BRAIN_HOST_ADMISSION";
/** Distinct from a pass (0) and an ordinary failure: EX_TEMPFAIL. */
export const PREEMPTED_EXIT = 75;
export const RED_MAIN_FIX = "red-main-fix";
export const DEFAULT_GRACE_MS = 10_000;
const OPAQUE = /^[A-Za-z0-9_-]{1,100}$/;
const script = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(script), "..");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const now = () => new Date().toISOString();

/** One ledger per host user; worktrees and clones on the machine share it. */
export function ledgerDir(env = process.env) {
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return resolve(env.BRAIN_HOST_ADMISSION_DIR || join(tmpdir(), `brain-host-admission-${user}`));
}

/** Heavy suites each use many cores; by default admit one per four CPUs. */
export function admissionLimit(env = process.env, cpus = availableParallelism()) {
  const raw = env.BRAIN_HOST_ADMISSION_LIMIT;
  if (raw === undefined || raw === "") return Math.max(1, Math.floor(cpus / 4));
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error("BRAIN_HOST_ADMISSION_LIMIT must be a positive integer");
  return Number(raw.trim());
}

function opaque(value, name) {
  if (value === undefined || value === "") return null;
  if (!OPAQUE.test(value)) throw new Error(`${name} must be an opaque ID of letters, digits, '-' or '_'`);
  return value;
}

/** Linux compares process lifetimes, so a reused PID never keeps a slot. */
function alive(pid, start) {
  if (process.platform === "linux") return processIdentity(pid)?.start === start;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

const identity = () => processIdentity(process.pid)?.start ?? "";

function lockOwnerStale(lock) {
  let owner;
  try { owner = readFileSync(join(lock, "owner"), "utf8"); }
  catch {
    // The owner writes its identity right after mkdir; give that gap time.
    try { return Date.now() - statSync(lock).mtimeMs > 2_000; } catch { return false; }
  }
  const [pid, start] = owner.split(" ");
  return !alive(Number(pid), start ?? "");
}

/** Only one caller removes a dead owner's lock; the guard serializes stealers. */
function stealStaleLock(lock) {
  const guard = `${lock}.steal`;
  try { mkdirSync(guard); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { if (Date.now() - statSync(guard).mtimeMs > 5_000) rmSync(guard, { recursive: true, force: true }); } catch { /* raced */ }
    return;
  }
  try { if (lockOwnerStale(lock)) rmSync(lock, { recursive: true, force: true }); }
  finally { rmSync(guard, { recursive: true, force: true }); }
}

function readState(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (state?.version === 1 && Number.isSafeInteger(state.seq) && Array.isArray(state.entries)) return state;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  return { version: 1, seq: 0, entries: [] };
}

function writeState(dir, state) {
  const path = join(dir, "state.json"), staged = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(staged, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(staged, path);
}

export function history(dir, event) {
  appendFileSync(join(dir, "history.jsonl"), JSON.stringify({ at: now(), ...event }) + "\n", { mode: 0o600 });
}

export function readHistory(dir) {
  try { return readFileSync(join(dir, "history.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Run a synchronous ledger transaction under the host-wide lock. */
export async function withLedger(dir, transaction) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "ledger.lock"), me = `${process.pid} ${identity()}`;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock); writeFileSync(join(lock, "owner"), me); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (lockOwnerStale(lock)) stealStaleLock(lock);
    if (attempt > 6_000) throw new Error("The host admission ledger lock stayed unavailable");
    await sleep(5 + Math.floor(Math.random() * 10));
  }
  try {
    const state = readState(dir);
    const result = transaction(state);
    writeState(dir, state);
    return result;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Forget dead waiters and reclaim dead holders. A holder whose wrapper died
 * while its detached command group still runs keeps the slot until that group
 * has been killed and is gone, so the slot is never handed out twice.
 */
export function prune(state, dir) {
  state.entries = state.entries.filter(entry => {
    if (alive(entry.pid, entry.start)) return true;
    if (entry.state === "holding" && entry.child && groupAlive(entry.child.pid)) {
      signalGroup(entry.child.pid, "SIGKILL");
      if (groupAlive(entry.child.pid)) return true;
    }
    history(dir, { kind: entry.state === "holding" ? (entry.preempt ? "preempted" : "reclaimed") : "abandoned",
      slot: entry.id, worker: entry.worker, orchestrator: entry.orchestrator, priority: entry.priority });
    return false;
  });
}

const rank = entry => entry.priority === RED_MAIN_FIX ? 0 : 1;

/** Red-main fixes go ahead of every ordinary waiter; otherwise arrival order. */
export function admissionOrder(entries) {
  return entries.filter(entry => entry.state === "queued").sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
}

function tryAdmit(state, dir, id, limit) {
  prune(state, dir);
  const entry = state.entries.find(candidate => candidate.id === id);
  if (!entry) return { lost: true };
  const holders = state.entries.filter(candidate => candidate.state === "holding");
  const order = admissionOrder(state.entries), position = order.indexOf(entry);
  if (position < limit - holders.length) {
    entry.state = "holding"; entry.admittedAt = now();
    history(dir, { kind: "admitted", slot: id, worker: entry.worker, orchestrator: entry.orchestrator, priority: entry.priority });
    return { admitted: true };
  }
  return { admitted: false, position: position + 1, queued: order.length, limit,
    holders: holders.map(holder => `${holder.id} (${holder.label}, worker ${holder.worker}, ${holder.priority})`) };
}

/** Record a wait boundary through the shared coordination recorder. */
async function recordWait(kind, { worker, task, timingsOut, root, ledger }) {
  const { spawn } = await import("node:child_process");
  const dir = join(ledger, "events");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${task}-${kind}.json`);
    writeFileSync(file, JSON.stringify({ kind, worker, task, reason: "other" }));
    const bun = process.versions.bun ? process.execPath : "bun";
    const code = await new Promise(done => {
      const child = spawn(bun, [join(root, "scripts/ci-timings.ts"), "record", "--event", file, "--out", timingsOut],
        { stdio: ["ignore", "ignore", "inherit"] });
      child.once("error", () => done(1));
      child.once("exit", status => done(status ?? 1));
    });
    rmSync(file, { force: true });
    if (code !== 0) console.error(`Host admission could not record ${kind}; the wait itself is unaffected.`);
  } catch (error) { console.error(`Host admission could not record ${kind}: ${error.message}`); }
}

function exitCode(code, signal) {
  return signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1;
}

/** Wait for a slot, run the command in its own process group, then release. */
export async function runAdmitted(command, options = {}) {
  if (!command.length) throw new Error("Host admission needs a command after --");
  const env = options.env ?? process.env;
  const dir = options.dir ?? ledgerDir(env), limit = options.limit ?? admissionLimit(env);
  const worker = opaque(options.worker ?? env.BRAIN_WORKER_ID, "Worker ID") ?? `host-${process.pid}`;
  const orchestrator = opaque(options.orchestrator ?? env.BRAIN_ORCHESTRATOR_ID, "Orchestrator ID");
  const fix = options.redMainFix ?? env.BRAIN_RED_MAIN_FIX;
  if (fix !== undefined && fix !== "" && !/^[1-9]\d*$/.test(String(fix))) throw new Error("A red-main fix is declared by its PR number");
  const fixPR = fix ? Number(fix) : null, priority = fixPR ? RED_MAIN_FIX : "ordinary";
  const label = String(options.label ?? command.join(" ")).slice(0, 120);
  const pollMs = options.pollMs ?? 500, root = options.root ?? repoRoot;
  const timingsOut = resolve(options.timingsOut ?? join(root, "tmp", "ci-timings"));
  const start = identity();
  let id, child, cancelled;
  await withLedger(dir, state => {
    state.seq += 1;
    id = `h${state.seq}-${randomBytes(4).toString("hex")}`;
    state.entries.push({ id, state: "queued", pid: process.pid, start, worker, orchestrator, priority, fixPR, label, seq: state.seq, queuedAt: now() });
    history(dir, { kind: "queued", slot: id, worker, orchestrator, priority, fixPR });
  });
  const release = async kind => withLedger(dir, state => {
    const entry = state.entries.find(candidate => candidate.id === id);
    state.entries = state.entries.filter(candidate => candidate !== entry);
    const preempted = Boolean(entry?.preempt);
    history(dir, { kind: preempted ? "preempted" : kind, slot: id, worker, orchestrator, priority,
      ...(preempted ? { reason: entry.preempt.reason, by: entry.preempt.by } : {}) });
    return preempted;
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map(signal => () => {
    if (child?.pid) signalGroup(child.pid, signal);
    else cancelled = signal;
  });
  signals.forEach((signal, index) => process.on(signal, listeners[index]));
  const task = `admission-${id}`;
  try {
    let waited = false, last = "";
    for (;;) {
      if (cancelled) { await release("cancelled"); return exitCode(null, cancelled); }
      const result = await withLedger(dir, state => {
        const attempt = tryAdmit(state, dir, id, limit);
        if (attempt.lost) state.entries.push({ id, state: "queued", pid: process.pid, start, worker, orchestrator, priority, fixPR, label, seq: ++state.seq, queuedAt: now() });
        return attempt;
      });
      if (result.admitted) break;
      if (result.lost) continue;
      if (!waited) { waited = true; await recordWait("wait-started", { worker, task, timingsOut, root, ledger: dir }); }
      const line = `Waiting for a host admission slot (${result.limit} on this host): position ${result.position} of ${result.queued}; holders: ${result.holders.join(", ") || "none"}.`;
      if (line !== last) { console.error(line); last = line; }
      await sleep(pollMs);
    }
    if (waited) await recordWait("wait-finished", { worker, task, timingsOut, root, ledger: dir });
    if (cancelled) { await release("cancelled"); return exitCode(null, cancelled); }
    const { spawn } = await import("node:child_process");
    child = spawn(command[0], command.slice(1), { stdio: "inherit", detached: process.platform !== "win32",
      env: { ...env, [MARKER]: JSON.stringify({ slot: id, pid: process.pid, start, dir }) } });
    const exited = new Promise(done => {
      child.once("error", () => done(127));
      child.once("exit", (code, signal) => done(exitCode(code, signal)));
    });
    if (child.pid) {
      const pending = await withLedger(dir, state => {
        const entry = state.entries.find(candidate => candidate.id === id);
        if (entry) entry.child = { pid: child.pid, start: processIdentity(child.pid)?.start ?? "" };
        return entry?.preempt;
      });
      // A preemption requested before the group existed is delivered now.
      if (pending) signalGroup(child.pid, "SIGTERM");
    }
    const code = await exited;
    if (child.pid) {
      const preempt = await withLedger(dir, state => state.entries.find(candidate => candidate.id === id)?.preempt);
      if (preempt) {
        // Let the group's cleanup finish within the preemption's grace period.
        const deadline = Date.parse(preempt.at) + preempt.graceMs;
        while (groupAlive(child.pid) && Date.now() < deadline) await sleep(25);
      }
      signalGroup(child.pid, "SIGKILL");
      while (groupAlive(child.pid)) await sleep(10);
    }
    if (await release("released")) {
      console.error(`Host admission slot ${id} was preempted to admit a red-main fix; this run neither passed nor failed.`);
      return PREEMPTED_EXIT;
    }
    return code;
  } finally {
    signals.forEach((signal, index) => process.off(signal, listeners[index]));
  }
}

/**
 * Cancel a holder in the caller's own orchestrator subtree so a waiting
 * red-main fix can start. Its group gets SIGTERM, then SIGKILL after the grace
 * period; the slot is released only after the group has gone.
 */
export async function preempt(slot, options = {}) {
  const env = options.env ?? process.env, dir = options.dir ?? ledgerDir(env);
  const orchestrator = opaque(options.orchestrator ?? env.BRAIN_ORCHESTRATOR_ID, "Orchestrator ID");
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS, reason = options.reason;
  if (reason !== RED_MAIN_FIX) throw new RefusedError(`Preemption is only permitted to admit a red-main fix (--reason ${RED_MAIN_FIX})`);
  if (!orchestrator) throw new RefusedError("Preemption requires the caller's orchestrator ID (BRAIN_ORCHESTRATOR_ID or --orchestrator)");
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("Grace period must be a non-negative integer of milliseconds");
  const outcome = await withLedger(dir, state => {
    prune(state, dir);
    const entry = state.entries.find(candidate => candidate.id === slot && candidate.state === "holding");
    if (!entry) return { refused: `Slot ${slot} is not held` };
    if (entry.orchestrator !== orchestrator) return { refused: `Slot ${slot} is outside the caller's orchestrator subtree; it yields only through queue priority or the maintainer` };
    if (!state.entries.some(candidate => candidate.state === "queued" && candidate.priority === RED_MAIN_FIX)) return { refused: "No red-main fix is waiting for admission" };
    if (!entry.preempt) {
      entry.preempt = { reason, by: orchestrator, at: now(), graceMs };
      history(dir, { kind: "preempt-requested", slot, orchestrator, reason, graceMs });
    }
    return { child: entry.child };
  });
  if (outcome.refused) throw new RefusedError(outcome.refused);
  if (outcome.child) signalGroup(outcome.child.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let forced = false;
  for (;;) {
    const entry = await withLedger(dir, state => { prune(state, dir); return state.entries.find(candidate => candidate.id === slot); });
    if (!entry) return { slot, reason, preempted: true, forced };
    if (Date.now() >= deadline && entry.child && groupAlive(entry.child.pid)) { signalGroup(entry.child.pid, "SIGKILL"); forced = true; }
    if (Date.now() >= deadline + 30_000) throw new Error(`Slot ${slot} was signalled but its holder has not released it`);
    await sleep(25);
  }
}

export class RefusedError extends Error {}

export async function status(options = {}) {
  const dir = options.dir ?? ledgerDir(options.env);
  return withLedger(dir, state => {
    prune(state, dir);
    return { ledger: dir, limit: admissionLimit(options.env), holders: state.entries.filter(entry => entry.state === "holding"),
      queue: admissionOrder(state.entries) };
  });
}

/** True when an ancestor already holds a slot for this command tree. */
export function inheritedAdmission(env = process.env) {
  try {
    const held = JSON.parse(env[MARKER] ?? "null");
    if (!held || !Number.isSafeInteger(held.pid) || typeof held.start !== "string") return false;
    if (process.platform === "linux") return liveAncestor(held.pid, held.start);
    return alive(held.pid, held.start);
  } catch { return false; }
}

/**
 * Re-enter this heavy command through `run`, unless an ancestor holds a slot.
 * Returns the admitted command's exit code, or undefined to continue inline.
 */
export async function ensureHostAdmission(label) {
  if (inheritedAdmission()) return;
  const { spawn } = await import("node:child_process");
  let child, pending;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map(signal => () => { if (child) child.kill(signal); else pending = signal; });
  signals.forEach((signal, index) => process.on(signal, listeners[index]));
  try {
    child = spawn(process.execPath, [script, "run", "--label", label, "--", process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      { stdio: "inherit" });
    if (pending) child.kill(pending);
    return await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done(exitCode(code, signal)));
    });
  } finally { signals.forEach((signal, index) => process.off(signal, listeners[index])); }
}

function parse(args) {
  const options = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { options.command = args.slice(i + 1); break; }
    const value = () => { if (i + 1 >= args.length) throw new Error(`${arg} needs a value`); return args[++i]; };
    if (arg === "--label") options.label = value();
    else if (arg === "--red-main-fix") options.redMainFix = value();
    else if (arg === "--worker") options.worker = value();
    else if (arg === "--orchestrator") options.orchestrator = value();
    else if (arg === "--reason") options.reason = value();
    else if (arg === "--grace-ms") options.graceMs = Number(value());
    else if (arg === "--poll-ms") options.pollMs = Number(value());
    else if (arg === "--timings-out") options.timingsOut = value();
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else rest.push(arg);
  }
  return { options, rest };
}

const usage = "usage: host-admission.mjs run [--red-main-fix <pr>] [--label <text>] -- <command...> | preempt <slot> --reason red-main-fix [--grace-ms <ms>] | status";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const { options, rest } = parse(args);
    if (mode === "run" && !rest.length) process.exit(await runAdmitted(options.command ?? [], options));
    else if (mode === "preempt" && rest.length === 1 && !options.command) console.log(JSON.stringify(await preempt(rest[0], options)));
    else if (mode === "status" && !rest.length && !options.command) console.log(JSON.stringify(await status(), null, 2));
    else throw new Error(usage);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof RefusedError ? 2 : 1);
  }
}
