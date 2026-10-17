import { describe, expect, test } from "bun:test";
import { createWorkerStatusPipe, verifiedWorkerPid } from "../src/server/worker-status.js";
import { launchFixtureAgentWorker } from "./helpers/worker-startup-view-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

async function reported(raw: string, check: (channel: ReturnType<typeof createWorkerStatusPipe>, pid: number) => void) {
  const channel = createWorkerStatusPipe();
  const child = Bun.spawn(["/bin/sh", "-c", 'exec 3>"$1"; printf "%s\n" "$2" >&3; exec /bin/sleep 5', "worker-status-fixture", channel.source, raw],
    { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  try { check(channel, child.pid); }
  finally { child.kill("SIGKILL"); await child.exited; channel.close(); }
}

function privateWorker() {
  const channel = createWorkerStatusPipe();
  const child = Bun.spawn(["/bin/sh", "-c", 'exec 3>"$1"; shift; exec "$@"', "worker-status-fixture", channel.source,
    Bun.which("bwrap")!, "--json-status-fd", "3", "--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--", "/bin/sleep", "30"],
    { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  try {
    const pid = channel.childPid(child.pid, Date.now() + 5000);
    channel.closeWriter();
    return { child, pid, async close() { child.kill("SIGKILL"); await child.exited; channel.close(); } };
  } catch (error) { child.kill("SIGKILL"); channel.close(); throw error; }
}

describe("trusted bubblewrap worker status", () => {
  test("accepts a real bubblewrap child and rejects an unrelated private-namespace child", async () => {
    const first = privateWorker();
    let second: ReturnType<typeof privateWorker> | undefined;
    try {
      second = privateWorker();
      expect(verifiedWorkerPid(first.child.pid, first.pid)).toBe(first.pid);
      expect(() => verifiedWorkerPid(second!.child.pid, first.pid)).toThrow("does not descend from its supervisor");
    } finally { await first.close(); await second?.close(); }
  });

  test.each([0, -1, 1.5, "42", null])("refuses an invalid reported PID (%j)", async pid => {
    await reported(JSON.stringify({ "child-pid": pid }), (channel, supervisor) => {
      expect(() => channel.childPid(supervisor, Date.now() + 1000)).toThrow("child PID is invalid");
    });
  });

  test("refuses a same-namespace descendant rather than treating it as a sandbox", async () => {
    const channel = createWorkerStatusPipe();
    const child = Bun.spawn(["/bin/sh", "-c", `exec 3>"$1"; /bin/sleep 30 & child=$!; printf '{"child-pid":%s}\\n' "$child" >&3; wait`, "same-namespace-fixture", channel.source],
      { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true });
    try { expect(() => channel.childPid(child.pid, Date.now() + 1000)).toThrow("private PID namespace"); }
    finally { process.kill(-child.pid, "SIGKILL"); await child.exited; channel.close(); }
  });

  test.each(["not-json", "null", '{"exit-code":0}', "x".repeat(4097)])("refuses malformed or oversized status (%#)", async raw => {
    await reported(raw, (channel, supervisor) => {
      expect(() => channel.childPid(supervisor, Date.now() + 1000)).toThrow();
    });
  });

  test("missing status has a bounded setup refusal", async () => {
    const channel = createWorkerStatusPipe();
    try { expect(() => channel.childPid(process.pid, Date.now())).toThrow("did not report authenticated bubblewrap status"); }
    finally { channel.close(); }
  });

  test("the payload waits until private-state population finishes", async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const root = mkdtempSync(join(ROOT, "tmp/worker-status-gate-")), brain = join(root, "brain"); mkdirSync(brain);
    let state: ReturnType<typeof launchFixtureAgentWorker>["state"];
    try {
      const child = launchFixtureAgentWorker({ brainPath: brain, env: {}, stateBytes: 1024 * 1024,
        populateState(path) { Bun.sleepSync(100); expect(existsSync(join(path, "started")), "payload ran before population completed").toBe(false); },
        command: ["/bin/sh", "-c", 'printf "Odysseus" > /tmp/brain-worker-state/started'] });
      state = child.state; child.stdin.end();
      const drain = async (stream: NodeJS.ReadableStream) => { for await (const _ of stream as AsyncIterable<Buffer>) { /* drain */ } };
      const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
      expect(code).toBe(0); expect(existsSync(join(state!.root, "started"))).toBe(true);
    } finally { state?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("status and gate descriptors are absent from the actual launcher payload", async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const root = mkdtempSync(join(ROOT, "tmp/worker-status-")), brain = join(root, "brain"); mkdirSync(brain);
    try {
      const child = launchFixtureAgentWorker({ brainPath: brain, env: {}, command: ["/bin/sh", "-c",
        'for fd in 3 4; do if /usr/bin/readlink /proc/self/fd/$fd; then exit 17; fi; done; printf "status-is-private\n"'] });
      child.stdin.end();
      const collect = async (stream: NodeJS.ReadableStream) => { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; };
      const [code, output, errors] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
      expect(errors).toBe(""); expect(code).toBe(0); expect(output).toBe("status-is-private\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
