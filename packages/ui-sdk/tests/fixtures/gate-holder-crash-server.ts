// A "server" for gate-holder-crash.test.ts (#3392). It runs the real
// status-gated governed launch and stops, holding the start gate's only
// writer, at one point before the gate is released. It prints `armed` with
// its launch's processes there (bubblewrap's tree, taken before any gate
// write) and blocks until the test SIGKILLs it.
//
//   bun gate-holder-crash-server.ts <brain> setup
//     blocks inside populateState: the state is mounted, folder
//     qualification has not run.
//   bun gate-holder-crash-server.ts <brain> release[-async] <token-json> [eof]
//     blocks inside release(), after every setup step, having written
//     <token-json> (a JSON string, possibly empty) into the gate. With `eof`
//     it then closes every gate writer it holds while it lives on, so the
//     gate reads end-of-file with no parent-death cascade behind it.
import { spyOn } from "bun:test";
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as status from "../../src/server/worker-status.js";

const [brain, mode, token, eof] = process.argv.slice(2) as [string, string, string | undefined, string | undefined];
const TOKEN_SETTLE_MS = 300;

let supervisor: number | undefined;
let processes: Array<{ pid: number; start: string }> = [];
/** A process and all its descendants, by PID and start time. */
function tree(pid: number): Array<{ pid: number; start: string }> {
  let start: string | undefined, children: number[] = [];
  try {
    start = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19];
    children = readdirSync(`/proc/${pid}/task`).flatMap(task =>
      readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
  } catch { /* exited meanwhile */ }
  return start === undefined ? [] : [{ pid, start }, ...children.flatMap(tree)];
}
function snapshot() {
  if (supervisor === undefined) throw new Error("no supervisor was spawned");
  processes = tree(supervisor);
}
function armed(): never {
  writeSync(1, `${JSON.stringify({ armed: true, launch: processes })}\n`);
  for (;;) Bun.sleepSync(60_000);
}

const spawn = Bun.spawn;
spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
  const child = (spawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
  if (supervisor === undefined && (args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) supervisor = child.pid;
  return child;
}) as typeof Bun.spawn);

const create = status.createWorkerStatusPipeSteps;
spyOn(status, "createWorkerStatusPipeSteps").mockImplementation(function* () {
  const channel = yield* create();
  if (mode.startsWith("release")) channel.release = () => {
    snapshot();
    const written = JSON.parse(token ?? '""') as string;
    if (written) {
      // A second writer on the same unlinked FIFO; it dies with this process too.
      const gate = openSync(channel.gateSource, constants.O_WRONLY);
      writeSync(gate, written);
      closeSync(gate);
    }
    if (eof === "eof") {
      // The channel's own writer: the same FIFO as the gate source, open for writing.
      const gate = readlinkSync(channel.gateSource);
      for (const fd of readdirSync("/proc/self/fd").map(Number)) {
        try {
          if (readlinkSync(`/proc/self/fd/${fd}`) === gate && (parseInt(/^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))![1]!, 8) & 3) === constants.O_WRONLY) closeSync(fd);
        } catch { /* the listing's own descriptor */ }
      }
    }
    // Time for a gate that wrongly accepts this to start the payload while
    // its server still lives, rather than racing --die-with-parent.
    if (written || eof === "eof") Bun.sleepSync(TOKEN_SETTLE_MS);
    armed();
  };
  return channel;
} as typeof create);

const { launchAgentWorker, launchAgentWorkerAsync, prepareWorkerSandbox } = await import("../../src/server/worker-launcher.js");
mkdirSync(join(brain, "context/policies"), { recursive: true });
writeFileSync(join(brain, "context/policies/governance.md"), "Athena sets the policy.\n");
mkdirSync(join(brain, "group/private"), { recursive: true });
const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
if (sandbox.profile !== "governed") throw new Error(`governed sandbox unavailable: ${sandbox.fallbackReason}`);
const launch = { brainPath: brain, sandbox, env: {}, stateBytes: 1024 * 1024,
  ...(mode === "setup" ? { populateState: () => { snapshot(); armed(); } } : {}),
  command: ["/bin/sh", "-c", "printf Odysseus >> payload-started.md"] };
if (mode === "release-async") await launchAgentWorkerAsync(launch);
else launchAgentWorker(launch);
throw new Error("the launch released its gate");
