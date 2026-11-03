import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate-identity launch is gated by its coordinator, which holds
// bubblewrap's --block-fd writer. bubblewrap starts the sandbox on that
// gate's end-of-file, so a coordinator that died before release let the
// payload run (#3402). Each case runs the real launcher and coordinator in a
// separate "server" process, against a same-UID stand-in helper, stops before
// release, kills the gate holders, and waits until every process of the
// launch is dead before looking for the payload's marker.
const SERVER = join(import.meta.dir, "fixtures/identity-gate-holder-crash-server.ts");
const DEATH_MS = 10_000;
/** Time for a gate that wrongly opens to start the payload while the server still lives. */
const SETTLE_MS = 500;

type Identity = { pid: number; start: string };
const roots: string[] = [];
const owned: Identity[] = [];
afterEach(() => {
  for (const process_ of owned.splice(0)) if (alive(process_)) try { process.kill(process_.pid, "SIGKILL"); } catch { /* gone */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stat(pid: number): string[] | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" "); } catch { return undefined; }
}
function alive(target: Identity): boolean {
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
function server(brain: string, mode: string) {
  const child = Bun.spawn([process.execPath, SERVER, brain, mode], { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  owned.push({ pid: child.pid, start: stat(child.pid)?.[19] ?? "" });
  return child;
}

/** Kill `victims` ("coordinator", "server" or both) before release; return the brain once the launch is dead. */
async function crashBeforeRelease(mode: string, victims: ReadonlyArray<"coordinator" | "server">): Promise<string> {
  const brain = mkdtempSync(join(tmpdir(), "identity-gate-holder-crash-")); roots.push(brain);
  const child = server(brain, mode);
  const line = await readLine(child.stdout, Date.now() + 15_000).catch(async error => {
    child.kill("SIGKILL"); await child.exited;
    throw new Error(`${String(error)}: ${await new Response(child.stderr).text()}`);
  });
  // The coordinator, bubblewrap and its sandbox's PID 1, before any gate write.
  const { armed, supervisor, launch } = JSON.parse(line) as { armed: boolean; supervisor: Identity; launch: Identity[] };
  expect(armed).toBe(true);
  expect(launch.length, "the launch's sandbox was waiting at its gate").toBeGreaterThanOrEqual(3);
  owned.push(...launch);
  if (victims.includes("coordinator")) process.kill(supervisor.pid, "SIGKILL");
  if (victims.includes("server")) child.kill("SIGKILL");
  if (!victims.includes("server")) {
    // The server still holds every writer it owns, as a live server would.
    await Bun.sleep(SETTLE_MS);
    child.kill("SIGKILL");
  }
  await child.exited;
  expect(child.signalCode, "the server died by SIGKILL").toBe("SIGKILL");
  const deadline = Date.now() + DEATH_MS;
  while (launch.some(alive) && Date.now() < deadline) await Bun.sleep(5);
  expect(launch.filter(alive), "every process of the launch ended after the holders' death").toEqual([]);
  return brain;
}

test("a coordinator killed during setup never starts the payload", async () => {
  const brain = await crashBeforeRelease("setup", ["coordinator"]);
  expect(existsSync(join(brain, "payload-started.md")), "COORDINATOR_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a coordinator killed after setup, before release, never starts the payload", async () => {
  const brain = await crashBeforeRelease("release", ["coordinator"]);
  expect(existsSync(join(brain, "payload-started.md")), "COORDINATOR_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("an asynchronous launch's coordinator killed before release never starts the payload", async () => {
  const brain = await crashBeforeRelease("release-async", ["coordinator"]);
  expect(existsSync(join(brain, "payload-started.md")), "COORDINATOR_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a stateless launch's coordinator killed before release never starts the payload", async () => {
  const brain = await crashBeforeRelease("release-stateless", ["coordinator"]);
  expect(existsSync(join(brain, "payload-started.md")), "STATELESS_COORDINATOR_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a server and coordinator killed together before release never start the payload", async () => {
  const brain = await crashBeforeRelease("release", ["coordinator", "server"]);
  expect(existsSync(join(brain, "payload-started.md")), "HOLDERS_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a server killed before release, its coordinator alive, never starts the payload", async () => {
  const brain = await crashBeforeRelease("release", ["server"]);
  expect(existsSync(join(brain, "payload-started.md")), "SERVER_DEATH_PAYLOAD_NEVER_STARTS").toBe(false);
}, 30_000);

test("a released identity launch starts the payload once, with stdio only and its stdin intact", async () => {
  const brain = mkdtempSync(join(tmpdir(), "identity-gate-holder-crash-")); roots.push(brain);
  const child = server(brain, "run");
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, errors).toBe(0);
  const { exit, out, err } = JSON.parse(output.trim().split("\n").at(-1)!) as { exit: number; out: string; err: string };
  expect(exit, out + err).toBe(0);
  expect(readFileSync(join(brain, "payload-started.md"), "utf8"), "RELEASED_PAYLOAD_STARTS_ONCE").toBe("Odysseus");
  expect(out.trim().split("\n"), "PAYLOAD_HOLDS_NO_GATE_DESCRIPTOR").toEqual(["0", "1", "2"]);
  const input = Buffer.concat([Buffer.from("go\nPenelope weaves\n"), Buffer.from([0x00, 0xff, 0x0a]), Buffer.from("Ithaca")]);
  expect(readFileSync(join(brain, "payload-stdin.md")).equals(input), "PAYLOAD_STDIN_BYTE_IDENTICAL").toBe(true);
}, 30_000);
