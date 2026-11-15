// A "server" for identity-gate-holder-crash.test.ts (#3402). It runs the
// real separate-identity launch, whose coordinator holds bubblewrap's
// --block-fd gate writer, against a same-UID stand-in helper, and stops at
// one point before release. It prints `armed` with the coordinator's PID and
// the launch's processes there, and blocks until the test kills it.
//
//   bun identity-gate-holder-crash-server.ts <brain> setup
//     blocks inside populateState: the state is mounted and verified.
//   bun identity-gate-holder-crash-server.ts <brain> release[-async|-stateless]
//     blocks in place of the coordinator's release, after every setup step.
//   bun identity-gate-holder-crash-server.ts <brain> run
//     the released control: the payload lists its descriptors and copies its
//     stdin; prints the exit code and output once it has ended.
import { spyOn } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as identity from "../../src/server/worker-identity.js";
import type { WorkerSteps } from "../../src/server/worker-steps.js";

const [brain, mode] = process.argv.slice(2) as [string, string];
const HELPER = join(import.meta.dir, "identity-gate-helper.py");

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
function armed(): never {
  if (supervisor === undefined) throw new Error("no coordinator was spawned");
  processes = tree(supervisor);
  writeSync(1, `${JSON.stringify({ armed: true, supervisor: processes[0], launch: processes })}\n`);
  for (;;) Bun.sleepSync(60_000);
}

const spawn = Bun.spawn;
spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
  const child = (spawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
  if (supervisor === undefined && (args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) supervisor = child.pid;
  return child;
}) as typeof Bun.spawn);

// The host's trusted helper is root-owned; this stand-in is selected directly.
spyOn(identity, "workerIdentityHelper").mockReturnValue(HELPER);
const prepare = identity.prepareWorkerIdentity;
spyOn(identity, "prepareWorkerIdentity").mockImplementation(((...args: Parameters<typeof prepare>) => {
  const broker = prepare(...args);
  const requestSteps = broker.requestSteps;
  if (mode.startsWith("release")) broker.requestSteps = function* <T extends object>(operation: string, input?: object): WorkerSteps<T> {
    if (operation === "release") armed();
    return yield* requestSteps<T>(operation, input);
  } as typeof requestSteps;
  return broker;
}) as typeof prepare);

const { launchAgentWorker, launchAgentWorkerAsync, prepareWorkerSandbox } = await import("../../src/server/worker-launcher.js");
mkdirSync(join(brain, "context/policies"), { recursive: true });
writeFileSync(join(brain, "context/policies/governance.md"), "Athena sets the policy.\n");
const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
if (sandbox.profile !== "governed") throw new Error(`governed sandbox unavailable: ${sandbox.fallbackReason}`);
if (mode === "run") {
  // An external `ls` with no redirection, which would make dash save a descriptor of its own.
  const worker = launchAgentWorker({ brainPath: brain, sandbox, env: {}, stateBytes: 1024 * 1024,
    command: ["/bin/sh", "-c", 'ls /proc/$$/fd; printf Odysseus >> payload-started.md; cat > payload-stdin.md'] });
  // A gate line and bytes a line reader would stop at, all for the payload.
  worker.stdin.end(Buffer.concat([Buffer.from("go\nPenelope weaves\n"), Buffer.from([0x00, 0xff, 0x0a]), Buffer.from("Ithaca")]));
  const drain = async (stream: NodeJS.ReadableStream) => { let text = ""; for await (const chunk of stream) text += String(chunk); return text; };
  const output = Promise.all([drain(worker.stdout), drain(worker.stderr)]);
  const exit = await worker.exited;
  // The coordinator shares the streams and ends once the last handle is released.
  worker.state?.close();
  const [out, err] = await output;
  writeSync(1, `${JSON.stringify({ exit, out, err })}\n`);
  process.exit(0);
}
// `release-stateless` launches without runtime state, so no stdin gate is in its argv already.
const launch = { brainPath: brain, sandbox, env: {}, ...(mode === "release-stateless" ? {} : { stateBytes: 1024 * 1024 }),
  ...(mode === "setup" ? { populateState: () => armed() } : {}),
  command: ["/bin/sh", "-c", "printf Odysseus >> payload-started.md"] };
if (mode === "release-async") await launchAgentWorkerAsync(launch);
else launchAgentWorker(launch);
throw new Error("the launch released its gate");
