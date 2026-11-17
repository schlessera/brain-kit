// Host-wide admission for heavy local commands (#2943): separate worktrees on
// one machine share a limited number of slots instead of timing out together.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { admissionLimit, admissionOrder, PREEMPTED_EXIT, readHistory, testLedgerFor, type AdmissionEntry } from "../scripts/host-admission.mjs";
import { processIdentity } from "../scripts/workspace-lease.mjs";
import { heavyTestReason, HEAVY_TEST_FILE_SECONDS } from "../scripts/test";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/host-admission.mjs");
const scratch: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  // A killed wrapper leaves its detached command group for the next ledger
  // pass to reclaim; a failed test must not leave that group running.
  for (const dir of scratch) for (const entry of entries(join(dir, "ledger"))) {
    if (entry.child) { try { process.kill(-entry.child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-host-admission-"));
  scratch.push(dir);
  const ledger = join(dir, "ledger"), timings = join(dir, "timings");
  // Two separate checkouts of Ithaca's harbour plan share one host.
  for (const name of ["ithaca", "ogygia"]) mkdirSync(join(dir, name));
  return { dir, ledger, timings };
}

/** Never inherit the caller's slot, worker or orchestrator identity. */
function env(ledger: string, extra: Record<string, string> = {}) {
  return { PATH: process.env.PATH!, HOME: process.env.HOME ?? tmpdir(), BRAIN_HOST_ADMISSION_DIR: ledger, BRAIN_HOST_ADMISSION_LIMIT: "1", ...extra };
}

function admit(cwd: string, ledger: string, timings: string, command: string, extra: Record<string, string> = {}, flags: string[] = []) {
  const child = Bun.spawn([process.execPath, SCRIPT, "run", "--poll-ms", "20", "--timings-out", timings, ...flags, "--", "sh", "-c", command],
    { cwd, env: env(ledger, extra), stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([out, err]) => out + err);
  return { child, output };
}

function entries(ledger: string): AdmissionEntry[] {
  try { return JSON.parse(readFileSync(join(ledger, "state.json"), "utf8")).entries; } catch { return []; }
}

async function until(condition: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const holding = (ledger: string) => entries(ledger).filter(entry => entry.state === "holding" && entry.child);
const queued = (ledger: string) => entries(ledger).filter(entry => entry.state === "queued");

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("host admission ledger", () => {
  test("with the limit at 1, heavy commands from two worktrees run one after the other and neither times out", async () => {
    const { dir, ledger, timings } = fixture();
    const log = join(dir, "log");
    // Each command fails if another is running. It holds its slot until the
    // test writes its release file (at most 10 s), so the second command is
    // queued behind the first by construction rather than by a race against a
    // fixed sleep, which a loaded host can lose.
    const heavy = (name: string) => `if ! mkdir ${dir}/running 2>/dev/null; then echo OVERLAP-${name} >> ${log}; exit 9; fi; ` +
      `echo start-${name} >> ${log}; i=0; while [ ! -e ${dir}/release-${name} ] && [ $i -lt 1000 ]; do sleep 0.01; i=$((i+1)); done; ` +
      `echo end-${name} >> ${log}; rmdir ${dir}/running`;
    const first = admit(join(dir, "ithaca"), ledger, timings, heavy("ithaca"));
    await until(() => holding(ledger).length === 1, "the first holder");
    const second = admit(join(dir, "ogygia"), ledger, timings, heavy("ogygia"));
    await until(() => queued(ledger).length === 1, "the second command queued behind the first");
    writeFileSync(join(dir, "release-ithaca"), "");
    writeFileSync(join(dir, "release-ogygia"), "");
    const deadline = Bun.sleep(8_000).then(() => "timed out");
    expect(await Promise.race([Promise.all([first.child.exited, second.child.exited]), deadline])).toEqual([0, 0]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start-ithaca", "end-ithaca", "start-ogygia", "end-ogygia"]);
    const waiting = await second.output;
    expect(waiting).toContain("Waiting for a host admission slot (1 on this host): position 1 of 1; holders: h1-");
    expect(waiting).toContain("worker host-");

    // The wait is recorded as one wait-started/wait-finished pair.
    const events = readdirSync(timings).filter(name => name.startsWith("event-"))
      .map(name => JSON.parse(readFileSync(join(timings, name), "utf8")))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    expect(events.map(event => event.kind)).toEqual(["wait-started", "wait-finished"]);
    expect(new Set(events.map(event => `${event.worker}/${event.task}/${event.reason}`)).size).toBe(1);
    expect(events[0].reason).toBe("other");
    expect(events[0].task).toMatch(/^admission-h2-/);
    expect(entries(ledger)).toEqual([]);
  });

  test("with no orchestrator, the host slots still limit concurrent heavy commands", async () => {
    const { dir, ledger, timings } = fixture();
    const marks = join(dir, "marks");
    mkdirSync(marks);
    const runs = ["a", "b", "c"].map(name => admit(join(dir, "ithaca"), ledger, timings,
      `touch ${marks}/${name}; n=$(ls ${marks} | wc -l); echo $n > ${dir}/peak-${name}; sleep 0.3; rm ${marks}/${name}`,
      { BRAIN_HOST_ADMISSION_LIMIT: "2" }));
    expect(await Promise.all(runs.map(run => run.child.exited))).toEqual([0, 0, 0]);
    const peaks = ["a", "b", "c"].map(name => Number(readFileSync(join(dir, `peak-${name}`), "utf8")));
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
    expect(readHistory(ledger).filter(event => event.kind === "admitted").every(event => event.orchestrator === null)).toBe(true);
  });

  test("a crashed holder's slot is reclaimed, including its orphaned command group", async () => {
    const { dir, ledger, timings } = fixture();
    const holder = admit(join(dir, "ithaca"), ledger, timings, `echo $$ > ${dir}/orphan; exec sleep 30`);
    await until(() => holding(ledger).length === 1 && existsSync(join(dir, "orphan")), "the holder");
    const orphan = Number(readFileSync(join(dir, "orphan"), "utf8"));
    holder.child.kill("SIGKILL");
    await holder.child.exited;
    expect(alive(orphan), "the detached command survives its killed wrapper").toBe(true);
    const next = admit(join(dir, "ogygia"), ledger, timings, "echo PENELOPE_ADMITTED");
    // A failure maximum: a slot that is never reclaimed blocks this admission.
    // On success the exit settles first and the deadline is cleared.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const blocked = new Promise<string>((resolve) => { deadline = setTimeout(() => resolve("blocked"), 8_000); });
    try { expect(await Promise.race([next.child.exited, blocked])).toBe(0); }
    finally { clearTimeout(deadline); }
    expect(await next.output).toContain("PENELOPE_ADMITTED");
    expect(alive(orphan), "reclaiming the slot stops the orphaned group").toBe(false);
    expect(readHistory(ledger).map(event => event.kind)).toContain("reclaimed");
  });

  test("a red-main fix queued later is admitted ahead of an ordinary waiter", async () => {
    const { dir, ledger, timings } = fixture();
    const log = join(dir, "log");
    const holder = admit(join(dir, "ithaca"), ledger, timings, `while [ ! -e ${dir}/release ]; do sleep 0.02; done; echo holder >> ${log}`);
    await until(() => holding(ledger).length === 1, "the holder");
    const ordinary = admit(join(dir, "ithaca"), ledger, timings, `echo ordinary >> ${log}`);
    await until(() => queued(ledger).length === 1, "the ordinary waiter");
    const fix = admit(join(dir, "ogygia"), ledger, timings, `echo fix >> ${log}`, { BRAIN_RED_MAIN_FIX: "42" });
    await until(() => queued(ledger).length === 2, "the fix waiter");
    expect(admissionOrder(entries(ledger)).map(entry => entry.priority)).toEqual(["red-main-fix", "ordinary"]);
    // The running holder is not preempted by priority alone.
    expect(holding(ledger)).toHaveLength(1);
    Bun.write(join(dir, "release"), "");
    expect(await Promise.all([holder.child.exited, ordinary.child.exited, fix.child.exited])).toEqual([0, 0, 0]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["holder", "fix", "ordinary"]);
    expect(readHistory(ledger).find(event => event.kind === "queued" && event.priority === "red-main-fix")?.fixPR).toBe(42);
  });

  test("preemption lets the holder's cleanup finish before the slot is reassigned, and records preempted", async () => {
    const { dir, ledger, timings } = fixture();
    const crew = { BRAIN_ORCHESTRATOR_ID: "odysseus", BRAIN_WORKER_ID: "eurylochus" };
    // The holder's cleanup (a stand-in for unmounting and removing a tmpfs)
    // takes a while and writes a marker when it is done.
    const holder = admit(join(dir, "ithaca"), ledger, timings,
      // The command exits at once and leaves the cleanup to another group member.
      `trap '(sleep 0.3; echo cleaned > ${dir}/cleanup) & exit 143' TERM; while true; do sleep 0.02; done`, crew);
    await until(() => holding(ledger).length === 1, "the holder");
    const slot = holding(ledger)[0]!.id;
    const fix = admit(join(dir, "ogygia"), ledger, timings, `test -e ${dir}/cleanup && echo FIX_AFTER_CLEANUP`, { BRAIN_RED_MAIN_FIX: "7" });
    await until(() => queued(ledger).length === 1, "the fix waiter");
    const preempt = Bun.spawnSync([process.execPath, SCRIPT, "preempt", slot, "--reason", "red-main-fix", "--grace-ms", "5000"],
      { env: env(ledger, { BRAIN_ORCHESTRATOR_ID: "odysseus" }), stdout: "pipe", stderr: "pipe" });
    expect(preempt.exitCode, preempt.stderr.toString()).toBe(0);
    expect(JSON.parse(preempt.stdout.toString())).toEqual({ slot, reason: "red-main-fix", preempted: true, forced: false });
    expect(await holder.child.exited).toBe(PREEMPTED_EXIT);
    expect(await holder.output).toContain("neither passed nor failed");
    expect(readFileSync(join(dir, "cleanup"), "utf8")).toBe("cleaned\n");
    expect(await fix.child.exited).toBe(0);
    expect(await fix.output).toContain("FIX_AFTER_CLEANUP");
    const kinds = readHistory(ledger).filter(event => event.slot === slot).map(event => event.kind);
    expect(kinds).toEqual(["queued", "admitted", "preempt-requested", "preempted"]);
    const admittedFix = readHistory(ledger).find(event => event.kind === "admitted" && event.priority === "red-main-fix")!;
    expect(Date.parse(admittedFix.at as string)).toBeGreaterThanOrEqual(statSync(join(dir, "cleanup")).mtimeMs - 5);
  });

  test("preempt refuses a slot held under a different orchestrator, and any reason but a red-main fix", async () => {
    const { dir, ledger, timings } = fixture();
    const holder = admit(join(dir, "ithaca"), ledger, timings, `while [ ! -e ${dir}/release ]; do sleep 0.02; done`,
      { BRAIN_ORCHESTRATOR_ID: "circe" });
    await until(() => holding(ledger).length === 1, "the holder");
    const slot = holding(ledger)[0]!.id;
    const fix = admit(join(dir, "ogygia"), ledger, timings, "true", { BRAIN_RED_MAIN_FIX: "7", BRAIN_ORCHESTRATOR_ID: "odysseus" });
    await until(() => queued(ledger).length === 1, "the fix waiter");
    const attempt = (orchestrator: string, reason: string) => Bun.spawnSync([process.execPath, SCRIPT, "preempt", slot, "--reason", reason],
      { env: env(ledger, { BRAIN_ORCHESTRATOR_ID: orchestrator }), stdout: "pipe", stderr: "pipe" });
    const foreign = attempt("odysseus", "red-main-fix");
    expect(foreign.exitCode).toBe(2);
    expect(foreign.stderr.toString()).toContain("outside the caller's orchestrator subtree");
    const unruled = attempt("circe", "faster-feedback");
    expect(unruled.exitCode).toBe(2);
    expect(unruled.stderr.toString()).toContain("only permitted to admit a red-main fix");
    expect(holding(ledger)[0]?.preempt).toBeUndefined();
    expect(readHistory(ledger).some(event => event.kind === "preempt-requested")).toBe(false);
    Bun.write(join(dir, "release"), "");
    expect(await Promise.all([holder.child.exited, fix.child.exited])).toEqual([0, 0]);
  });

  test("a descendant whose environment lost the slot marker still inherits its ancestor's slot", async () => {
    const { dir, ledger, timings } = fixture();
    // The nested heavy command's caller replaced its environment (as test
    // fixtures and sandbox wrappers do), dropping BRAIN_HOST_ADMISSION.
    const nested = `env -u BRAIN_HOST_ADMISSION ${process.execPath} -e 'const m = await import("${SCRIPT}"); ` +
      `const code = await m.ensureHostAdmission("nested"); console.log(code === undefined ? "NESTED_INHERITED" : "NESTED_QUEUED"); process.exit(code ?? 0)'`;
    const holder = admit(join(dir, "ithaca"), ledger, timings, nested);
    expect(await Promise.race([holder.child.exited, Bun.sleep(8_000).then(() => "deadlocked")])).toBe(0);
    expect(await holder.output).toContain("NESTED_INHERITED");
  });

  test("a descendant without a ledger directory finds its test process's private ledger", () => {
    const own = testLedgerFor(process.pid, processIdentity(process.pid)!.start);
    expect(existsSync(own), "the test preload creates this process's private ledger").toBe(true);
    const child = Bun.spawnSync([process.execPath, "-e", `console.log((await import(${JSON.stringify(SCRIPT)})).ledgerDir({}))`],
      { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
    expect(child.stdout.toString().trim(), child.stderr.toString()).toBe(own);
  });

  test("the admitted command receives the workspace lease descriptor, not only its marker", async () => {
    // This test runs under the real workspace lease; a command in a nested
    // user namespace can prove that inheritance only through the descriptor.
    const { dir, ledger, timings } = fixture();
    // Node, unlike Bun, gets no offline-harness child preload, which would
    // itself forward the lease and hide a wrapper that dropped it.
    const node = Bun.which("node");
    if (!node) throw new Error("Lease forwarding proof requires node, as the browser wrapper does");
    const child = Bun.spawn([node, SCRIPT, "run", "--poll-ms", "20", "--timings-out", timings, "--", "sh", "-c",
      'echo "LEASE=$BRAIN_WORKSPACE_LEASE"; for f in /proc/$$/fd/*; do echo "FD $(basename $f) $(readlink $f)"; done'],
      { cwd: dir, env: { ...process.env, ...env(ledger) }, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, err).toBe(0);
    const lease = JSON.parse(out.match(/^LEASE=(.*)$/m)![1]!);
    const lock = realpathSync(join(ROOT, "tmp/workspace-operation/output.lock"));
    expect(out, "LEASE_DESCRIPTOR_REACHES_THE_ADMITTED_COMMAND").toContain(`FD ${lease.fd} ${lock}`);
  });

  test("the limit defaults from the CPU count and is overridden by BRAIN_HOST_ADMISSION_LIMIT", () => {
    expect(admissionLimit({}, 16)).toBe(4);
    expect(admissionLimit({}, 2)).toBe(1);
    expect(admissionLimit({ BRAIN_HOST_ADMISSION_LIMIT: "3" }, 16)).toBe(3);
    expect(() => admissionLimit({ BRAIN_HOST_ADMISSION_LIMIT: "0" }, 16)).toThrow("positive integer");
  });
});

describe("which test runs are heavy", () => {
  const costs = { "tests/raft.test.ts": HEAVY_TEST_FILE_SECONDS, "tests/oar.test.ts": 1 };
  test("the integrated suite, runtime-host, native and long files need admission; a focused file does not", () => {
    expect(heavyTestReason(ROOT, ROOT, [], costs)).toBe("integrated suite");
    expect(heavyTestReason(ROOT, ROOT, ["--timeout", "30000"], costs)).toBe("integrated suite");
    expect(heavyTestReason(ROOT, ROOT, ["packages/ui-react/tests/draft-runtime.test.ts"], costs)).toBe("runtime-host tests");
    expect(heavyTestReason(ROOT, ROOT, ["scripts/native-proof/reference-pool.native.ts"], costs)).toBe("native tests");
    expect(heavyTestReason(ROOT, ROOT, ["./tests/raft.test.ts"], costs)).toBe("long test file tests/raft.test.ts");
    expect(heavyTestReason(ROOT, ROOT, ["./tests"], costs)).toBe("long test file tests/raft.test.ts");
    expect(heavyTestReason(ROOT, ROOT, ["./tests/oar.test.ts"], costs)).toBeUndefined();
  });
});
