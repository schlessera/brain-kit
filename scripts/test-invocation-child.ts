/** Private build/test process-group lifetime. No persistent or product API. */
import { closeSync, readdirSync, readFileSync } from "node:fs";
import { inheritWorkspaceLease, processIdentity } from "./workspace-lease.mjs";

type Usage = { cpuTime: { user: number; system: number }; maxRSS: number } | undefined;
type Message = { kind: "anchor"; start: string } | { kind: "started"; pid: number } |
  { kind: "exit"; code: number; signal: NodeJS.Signals | null; usage: Usage } | { kind: "error"; error: string };

/** The anchor stays alive after the command exits, until both output EOFs are
 * joined. Its IPC channel is also a parent-lifetime pipe: a dead wrapper cannot
 * leave this detached group running. Only this live anchor signals its group.
 */
export function invocationChild(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: "ignore" | "inherit" } = {}) {
  let commandPid = 0, signalCode: NodeJS.Signals | null = null, usage: Usage;
  let started = false, exited = false, released = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveExit!: (code: number) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exit = new Promise<number>(resolve => { resolveExit = resolve; });
  void ready.catch(() => {});
  const anchor = Bun.spawn([process.execPath, import.meta.path, "--anchor", ...command], inheritWorkspaceLease({
    ...options, stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32",
    ipc(message: Message, child: ReturnType<typeof Bun.spawn>) {
      if (message.kind === "error") console.error("Invocation command failed", message.error);
      if (message.kind === "anchor") {
        // The acknowledged anchor cannot exit normally or launch the command
        // before this handshake. Bind its PID/start before granting launch.
        if (process.platform === "linux" && processIdentity(child.pid)?.start !== message.start) { child.kill("SIGKILL"); return; }
        child.send({ kind: "launch" });
      } else if (message.kind === "started") {
        commandPid = message.pid; started = true; resolveReady();
      } else if (message.kind === "exit") {
        signalCode = message.signal; usage = message.usage; exited = true; resolveExit(message.code);
      }
    },
  }));
  void anchor.exited.then(code => {
    if (!started) rejectReady(new Error("Invocation anchor stopped before command startup"));
    if (!exited) { signalCode = anchor.signalCode; resolveExit(code || 1); }
  });
  let settling: Promise<void> | undefined;
  const settled = () => settling ??= (async () => {
    await anchor.exited;
    if (process.platform !== "linux") return;
    // killpg has delivered SIGKILL, but reaping the anchor alone does not prove
    // its last member has stopped yet. Observe the group; never signal a numeric
    // group ID after its anchor died (and might eventually be reused).
    const liveMembers = () => readdirSync("/proc").some(name => {
      if (!/^\d+$/.test(name)) return false;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return !["Z", "X"].includes(fields[0]!) && Number(fields[2]) === anchor.pid && Number(fields[3]) === anchor.pid;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
    });
    const end = Date.now() + 1_000;
    while (liveMembers() && Date.now() < end) await Bun.sleep(10);
    if (liveMembers()) throw new Error("Invocation process group cleanup incomplete");
  })();
  let stopping: Promise<void> | undefined;
  return {
    ready,
    get pid() { return commandPid; },
    get signalCode() { return signalCode; },
    get cancelled() { return stopping !== undefined; },
    stdout: anchor.stdout as ReadableStream<Uint8Array>, stderr: anchor.stderr as ReadableStream<Uint8Array>, exited: exit,
    resourceUsage: () => usage,
    stop(signal: NodeJS.Signals): Promise<void> {
      if (!stopping) {
        if (anchor.exitCode === null && anchor.signalCode === null) anchor.send({ kind: "stop", signal });
        stopping = settled();
      }
      return stopping;
    },
    async finish() {
      if (!released) {
        released = true;
        if (anchor.exitCode === null && anchor.signalCode === null) anchor.send({ kind: "release" });
      }
      await settled();
    },
  };
}

if (import.meta.main && process.argv[2] === "--anchor") {
  if (!process.send) throw new Error("Invocation anchor requires its private lifetime channel");
  const pid = process.pid;
  if (process.platform === "linux") {
    const fields = readFileSync("/proc/self/stat", "utf8").split(") ").at(-1)!.split(" ");
    if (Number(fields[2]) !== pid || Number(fields[3]) !== pid) throw new Error("Invocation anchor requires its own session and process group");
  }
  let stopping = false, launched = false;
  let command: ReturnType<typeof Bun.spawn> | undefined;
  // The anchor, unlike its command, must survive TERM until group escalation.
  const killGroup = (signal: NodeJS.Signals) => {
    if (process.platform === "win32") { command?.kill(signal); process.exit(1); }
    process.kill(-pid, signal);
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    killGroup(signal);
    // Includes children forked by a signal handler after the first signal.
    setTimeout(() => killGroup("SIGKILL"), 1_000);
  };
  const send = (message: Message) => {
    try { process.send!(message); }
    catch { stop("SIGTERM"); } // The parent may die between exit and reporting.
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(signal));
  process.on("disconnect", () => stop("SIGTERM"));
  process.on("message", async (message: { kind: string; signal?: NodeJS.Signals }) => {
    if (message.kind === "stop") { stop(message.signal ?? "SIGTERM"); return; }
    if (message.kind === "release") { killGroup("SIGKILL"); return; }
    if (message.kind !== "launch" || launched || stopping) return;
    launched = true;
    try {
      command = Bun.spawn(process.argv.slice(3), inheritWorkspaceLease({ stdin: "inherit", stdout: "inherit", stderr: "inherit" }));
      send({ kind: "started", pid: command.pid });
      // Keep only the command's output descriptors alive. The parent can now
      // observe actual descendant EOF while this group anchor remains live.
      closeSync(1); closeSync(2);
      const code = await command.exited;
      const resource = command.resourceUsage();
      const usage: Usage = resource ? { cpuTime: { user: Number(resource.cpuTime.user), system: Number(resource.cpuTime.system) }, maxRSS: Number(resource.maxRSS) } : undefined;
      send({ kind: "exit", code, signal: command.signalCode, usage });
    } catch (error) { send({ kind: "error", error: String(error) }); stop("SIGTERM"); }
  });
  send({ kind: "anchor", start: processIdentity(pid)?.start ?? "" });
  // IPC can be unreferenced by the runtime when no message handler is active.
  setInterval(() => {}, 60_000);
}
