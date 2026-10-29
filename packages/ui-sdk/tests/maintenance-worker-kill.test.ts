/** Native diagnostic: visible child cancellation must also settle a gated outer.
 * This forces the child-visible branch, not a historical snapshot/clone race.
 * The startup gate deliberately differs from the production bwrap arguments.
 */
import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killWorker } from "../src/server/maintenance-worker-kill.js";

type Identity = { pid: number; start: string; state: string };
function identity(pid: number): Identity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), end = raw.lastIndexOf(")");
    const fields = raw.slice(end + 2).split(/\s+/);
    if (!raw.startsWith(`${pid} (`) || !/^\d+$/.test(fields[19] ?? "")) throw Error("Invalid process identity");
    return { pid, start: fields[19]!, state: fields[0]! };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function alive(owned: Identity): boolean {
  const current = identity(owned.pid);
  return current?.start === owned.start && !["Z", "X"].includes(current.state);
}
const receipt = (kind: string, data: unknown) => console.error(JSON.stringify({ kind, data }));
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { if (predicate()) return true; await Bun.sleep(5); }
  return predicate();
}

type Owner = {
  root?: string; fds: number[]; outer?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  parent?: Identity; child?: Identity; timer?: ReturnType<typeof setTimeout>;
  stdout?: Promise<string>; stderr?: Promise<string>; cleanup?: Promise<void>;
};
const owners: Owner[] = [];
function dispose(owner: Owner): Promise<void> {
  return owner.cleanup ??= (async () => {
    if (owner.timer) clearTimeout(owner.timer);
    // Discover only direct children of our still-matching outer on setup failure.
    if (owner.parent && alive(owner.parent) && !owner.child) {
      const pids = readFileSync(`/proc/${owner.parent.pid}/task/${owner.parent.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      if (pids.length > 1) throw Error("Unexpected owned child count");
      if (pids[0]) owner.child = identity(Number(pids[0]));
    }
    const errors: unknown[] = [];
    for (const owned of [owner.child, owner.parent]) {
      try {
        if (owned && alive(owned)) {
          receipt("cleanup-signal-intent", { owned, current: identity(owned.pid), signal: "SIGKILL" });
          process.kill(owned.pid, "SIGKILL");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error); }
    }
    for (const owned of [owner.child, owner.parent]) {
      if (owned && !await until(() => !alive(owned), 1000)) errors.push(Error("Owned process survived cleanup"));
    }
    if (owner.outer) {
      const joined = Promise.all([owner.outer.exited, owner.stdout, owner.stderr]);
      let settled = false;
      void joined.then(() => { settled = true; }, () => { settled = true; });
      if (await until(() => settled, 1000)) {
        try { receipt("cleanup-joined", await joined); } catch (error) { errors.push(error); }
      } else errors.push(Error("Owned output did not close during cleanup"));
    }
    for (const fd of owner.fds.splice(0)) { try { closeSync(fd); } catch (error) { errors.push(error); } }
    if (owner.root) rmSync(owner.root, { recursive: true, force: true });
    receipt("cleanup-complete", { parent: owner.parent && identity(owner.parent.pid), child: owner.child && identity(owner.child.pid), errors: errors.map(String) });
    if (errors.length) throw new AggregateError(errors, "Native diagnostic cleanup failed");
  })();
}
afterEach(async () => { for (const owner of owners.splice(0)) await dispose(owner); });

test("maintenance kill settles the outer and output after a visible startup child", async () => {
  const owner: Owner = { fds: [] };
  owners.push(owner); // Cleanup and its independent deadline precede acquisition.
  owner.timer = setTimeout(() => { void dispose(owner).catch(error => receipt("watchdog-cleanup-error", String(error))); }, 10_000);
  owner.root = mkdtempSync(join(tmpdir(), "odysseus-maintenance-kill-"));
  const gate = join(owner.root, "gate"), info = join(owner.root, "info");
  const made = Bun.spawnSync(["mkfifo", "--mode=600", gate]);
  expect(made.exitCode, made.stderr.toString()).toBe(0);
  const gateFd = openSync(gate, constants.O_RDWR);
  owner.fds.push(gateFd);
  const infoFd = openSync(info, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  owner.fds.push(infoFd);
  const command = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--clearenv", "--userns-block-fd", "3", "--info-fd", "4", "--", "/bin/true"];
  // No --disable-userns/--assert-userns-disabled: incompatible with this diagnostic startup gate.
  const outer = Bun.spawn(command, { stdio: ["ignore", "pipe", "pipe", gateFd, infoFd] });
  owner.outer = outer;
  owner.parent = identity(outer.pid);
  expect(owner.parent, "OWNED_OUTER_IDENTITY").toBeDefined();
  let stdoutEOF = false, stderrEOF = false, exited = false;
  owner.stdout = new Response(outer.stdout).text().then(text => { stdoutEOF = true; return text; });
  owner.stderr = new Response(outer.stderr).text().then(text => { stderrEOF = true; return text; });
  void outer.exited.then(() => { exited = true; });
  let reported: number | undefined;
  expect(await until(() => {
    const raw = readFileSync(info, "utf8");
    try { reported = JSON.parse(raw)["child-pid"]; return Number.isSafeInteger(reported); } catch { return false; }
  }, 3000), "NATIVE_GATE_INFO").toBe(true);
  owner.child = identity(reported!);
  expect(owner.child, "OWNED_CHILD_IDENTITY").toBeDefined();
  const child = owner.child!, parent = owner.parent!;
  const children = readFileSync(`/proc/${outer.pid}/task/${outer.pid}/children`, "utf8").trim().split(/\s+/).map(Number);
  expect(children, "VISIBLE_DIRECT_CHILD").toEqual([child.pid]);
  expect(await until(() => identity(parent.pid)?.state === "S" && identity(child.pid)?.state === "S", 1000), "STARTUP_GATE_SLEEP").toBe(true);
  for (const fd of [1, 2]) {
    expect(readlinkSync(`/proc/${child.pid}/fd/${fd}`), "CHILD_HOLDS_OUTER_OUTPUT").toBe(readlinkSync(`/proc/${parent.pid}/fd/${fd}`));
  }
  receipt("premise", { command, uid: process.getuid?.(), gid: process.getgid?.(), parent, child,
    parentStatus: readFileSync(`/proc/${parent.pid}/status`, "utf8"), childStatus: readFileSync(`/proc/${child.pid}/status`, "utf8"),
    parentWchan: readFileSync(`/proc/${parent.pid}/wchan`, "utf8"), childWchan: readFileSync(`/proc/${child.pid}/wchan`, "utf8"),
    children, gateBytesWritten: 0, stdoutEOF, stderrEOF });
  killWorker(outer, "SIGKILL"); // Actual product function; real native process handle.
  const settled = await until(() => exited && stdoutEOF && stderrEOF, 2000);
  receipt("after-actual-kill", { settled, exited, stdoutEOF, stderrEOF, parent: identity(parent.pid), child: identity(child.pid) });
  expect(settled, "MAINTENANCE_KILL_OUTER_AND_OUTPUT_MUST_SETTLE").toBe(true);
  expect(alive(parent), "MAINTENANCE_OUTER_MUST_STOP").toBe(false);
  expect(alive(child), "MAINTENANCE_CHILD_MUST_STOP").toBe(false);
});
