import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox } from "../src/server/worker-launcher.js";

// The start gate's only writer belongs to the server. When the server dies
// before release, the kernel closes that writer; the gated payload must still
// never start (#3392). Each case runs the real status-gated governed launch
// in a separate "server" process, waits for it to stop before release with an
// authenticated sandbox, SIGKILLs it, and waits until every process of the
// launch is dead before looking for the payload's marker.
const SERVER = join(import.meta.dir, "fixtures/gate-holder-crash-server.ts");
const DEATH_MS = 10_000;

const roots: string[] = [];
const owned: Array<{ pid: number; start: string }> = [];
afterEach(() => {
  for (const process_ of owned.splice(0)) if (alive(process_)) try { process.kill(process_.pid, "SIGKILL"); } catch { /* gone */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stat(pid: number): string[] | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" "); } catch { return undefined; }
}
function alive(target: { pid: number; start: string }): boolean {
  const fields = stat(target.pid);
  return fields !== undefined && fields[19] === target.start && !["Z", "X", "x"].includes(fields[0]!);
}
async function readLine(stream: ReadableStream<Uint8Array>, deadline: number): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const)]);
      if (next === "timeout") throw new Error("the server did not arm in time");
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
  } finally { reader.releaseLock(); }
  return text.split("\n")[0]!;
}

async function crashBeforeRelease(mode: string, token?: string, eof?: "eof"): Promise<{ brain: string; launch: number }> {
  const brain = mkdtempSync(join(tmpdir(), "gate-holder-crash-")); roots.push(brain);
  const server = Bun.spawn([process.execPath, SERVER, brain, mode, ...token === undefined ? [] : [JSON.stringify(token)], ...eof ? [eof] : []],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  owned.push({ pid: server.pid, start: stat(server.pid)?.[19] ?? "" });
  const line = await readLine(server.stdout, Date.now() + 15_000).catch(async error => {
    server.kill("SIGKILL"); await server.exited;
    throw new Error(`${String(error)}: ${await new Response(server.stderr).text()}`);
  });
  // The launch's processes before any gate write: bubblewrap and its
  // sandbox's PID 1, which outlives the gate shell it forks.
  const { armed, launch } = JSON.parse(line) as { armed: boolean; launch: Array<{ pid: number; start: string }> };
  expect(armed).toBe(true);
  expect(launch.length, "the launch's sandbox was waiting at its gate").toBeGreaterThanOrEqual(2);
  owned.push(...launch);
  server.kill("SIGKILL");
  await server.exited;
  expect(server.signalCode, "the gate holder died by SIGKILL").toBe("SIGKILL");
  const deadline = Date.now() + DEATH_MS;
  while (launch.some(alive) && Date.now() < deadline) await Bun.sleep(5);
  expect(launch.filter(alive), "every process of the launch ended after the holder's death").toEqual([]);
  return { brain, launch: launch.length };
}

test("a gate holder killed during setup never starts the payload", async () => {
  const { brain } = await crashBeforeRelease("setup");
  expect(existsSync(join(brain, "payload-started.md")), "HOLDER_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a gate holder killed after setup, before release, never starts the payload", async () => {
  const { brain } = await crashBeforeRelease("release");
  expect(existsSync(join(brain, "payload-started.md")), "HOLDER_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("an asynchronous launch's gate holder killed before release never starts the payload", async () => {
  const { brain } = await crashBeforeRelease("release-async");
  expect(existsSync(join(brain, "payload-started.md")), "HOLDER_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

for (const [token, name] of [["g", "PARTIAL_BYTE"], ["go", "PARTIAL_LINE"], ["goo\n", "WRONG_LINE"], ["Go\n", "WRONG_CASE"]] as const) {
  test(`a gate written ${JSON.stringify(token)}, then its holder's death, never starts the payload`, async () => {
    const { brain } = await crashBeforeRelease("release", token);
    expect(existsSync(join(brain, "payload-started.md")), `${name}_PAYLOAD_NEVER_STARTS`).toBe(false);
  }, 30_000);
}

// A dead server also kills bubblewrap (--die-with-parent) and with it the
// sandbox's PID namespace, often before the gate shell runs again. These
// cases close the gate's writer while the server lives, so only the gate's
// own refusal of end-of-file and of an incomplete line keeps the payload out.
for (const [token, name] of [["", "WRITER_EOF"], ["g", "WRITER_EOF_AFTER_BYTE"], ["go", "WRITER_EOF_AFTER_PARTIAL_LINE"]] as const) {
  test(`a gate whose writer closes after ${JSON.stringify(token)} never starts the payload`, async () => {
    const { brain } = await crashBeforeRelease("release", token, "eof");
    expect(existsSync(join(brain, "payload-started.md")), `${name}_PAYLOAD_NEVER_STARTS`).toBe(false);
  }, 30_000);
}

test("a released gate starts the payload once, with no gate descriptor and its stdin intact", async () => {
  const brain = mkdtempSync(join(tmpdir(), "gate-holder-crash-")); roots.push(brain);
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "Athena sets the policy.\n");
  mkdirSync(join(brain, "group/private"), { recursive: true });
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
  expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  // The payload's own descriptor table, listed by an external `ls` with no
  // redirection, which would make dash save a descriptor of its own.
  const worker = launchAgentWorker({ brainPath: brain, sandbox, env: {}, stateBytes: 1024 * 1024,
    command: ["/bin/sh", "-c", 'ls /proc/$$/fd; printf Odysseus >> payload-started.md; cat > payload-stdin.md'] });
  // A gate line and bytes a line reader would stop at, all for the payload.
  const input = Buffer.concat([Buffer.from("go\nPenelope weaves\n"), Buffer.from([0x00, 0xff, 0x0a]), Buffer.from("Ithaca")]);
  worker.stdin.end(input);
  const drain = async (stream: NodeJS.ReadableStream) => { let text = ""; for await (const chunk of stream) text += String(chunk); return text; };
  const [exit, out, err] = await Promise.all([worker.exited, drain(worker.stdout), drain(worker.stderr)]);
  expect(exit, out + err).toBe(0);
  expect(readFileSync(join(brain, "payload-started.md"), "utf8"), "RELEASED_PAYLOAD_STARTS_ONCE").toBe("Odysseus");
  expect(out.trim().split("\n"), "PAYLOAD_HOLDS_NO_GATE_DESCRIPTOR").toEqual(["0", "1", "2"]);
  expect(readFileSync(join(brain, "payload-stdin.md")), "PAYLOAD_STDIN_BYTE_IDENTICAL").toEqual(input);
}, 30_000);
