import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { hostProcessAlive, hostProcessesWithArg, waitForHostProcesses } from "./helpers/host-processes";

// The Python parent is the only wait owner. WNOWAIT acknowledges actual kernel
// exit while deliberately retaining the zombie, independently of our observer.
const ownerProgram = `
import os, signal, sys, json
signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("owner deadline")))
signal.alarm(15)
r, w = os.pipe()
a, b = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(w); os.close(a)
    os.write(b, b"ready"); os.close(b)
    os.read(r, 1)
    os._exit(23)
os.close(r); os.close(b)
reaped = False
def emit(**v): print(json.dumps(v), flush=True)
try:
    assert os.read(a, 5) == b"ready"
    os.close(a)
    emit(pid=pid, stage="held")
    for line in sys.stdin:
        command = line.strip()
        if command == "stop":
            os.kill(pid, signal.SIGSTOP)
            child, status = os.waitpid(pid, os.WUNTRACED)
            assert child == pid and os.WIFSTOPPED(status)
            emit(stage="stopped")
        elif command == "continue":
            os.kill(pid, signal.SIGCONT)
            emit(stage="continued")
        elif command == "exit":
            os.write(w, b"x")
            result = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
            assert result.si_pid == pid and result.si_status == 23
            emit(stage="exited", status=result.si_status)
        elif command == "reap":
            child, status = os.waitpid(pid, 0)
            reaped = True
            emit(stage="reaped", pid=child, status=os.waitstatus_to_exitcode(status))
            break
        else: raise ValueError(command)
finally:
    if not reaped:
        try:
            os.kill(pid, signal.SIGCONT)
            os.close(w)
            os.waitpid(pid, 0)
        except ProcessLookupError: os.waitpid(pid, 0)
`;

const cleanups = new Set<() => Promise<void>>();
async function drain() {
  const results = await Promise.allSettled([...cleanups].reverse().map(close => close()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "host observer cleanup");
}
afterEach(drain);
afterAll(drain);

async function ownedChild() {
  const marker = `odysseus-proc-observer-${crypto.randomUUID()}`;
  const owner = Bun.spawn(["python3", "-c", ownerProgram, marker], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  // Hook ownership begins before any asynchronous setup. EOF asks the wait owner
  // to release and reap, including on Bun timeouts where finally may not unwind.
  let closing: Promise<void> | undefined;
  const stderr = new Response(owner.stderr).text();
  const reader = owner.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  async function message(): Promise<Record<string, string | number>> {
    while (!buffered.includes("\n")) {
      const part = await reader.read();
      if (part.done) throw new Error(`owner EOF: ${await stderr}`);
      buffered += part.value;
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    return JSON.parse(line);
  }
  const close = () => closing ??= (async () => {
    owner.stdin.end();
    while (!(await reader.read()).done) { /* join stdout EOF */ }
    expect(await owner.exited, await stderr).toBe(0);
    cleanups.delete(close);
  })();
  cleanups.add(close);
  const ready = await message();
  expect(ready.stage).toBe("held");
  const pid = Number(ready.pid);
  const captures = await waitForHostProcesses(marker);
  const process = captures.find(process => (typeof process === "number" ? process : process.pid) === pid);
  expect(process, "ACKNOWLEDGED_NATIVE_CHILD_CAPTURED").toBeDefined();
  const parent = captures.find(process => (typeof process === "number" ? process : process.pid) === owner.pid);
  expect(parent, "WAIT_OWNER_CAPTURED").toBeDefined();
  return { pid, process: process!, parent: parent!, marker, close, async command(command: string) {
    owner.stdin.write(command + "\n");
    await owner.stdin.flush();
    return message();
  } };
}

test("a real held and stopped child fails the exit oracle until its owner joins exit", async () => {
  const child = await ownedChild();
  const exitOracle = () => expect([child.process].filter(hostProcessAlive), "NATIVE_CHILD_EXITED").toEqual([]);
  expect(hostProcessAlive(child.process), "HELD_CHILD_LIVE").toBe(true);
  expect(exitOracle, "OMITTED_JOIN_REJECTED").toThrow();
  expect(await child.command("stop")).toEqual({ stage: "stopped" });
  expect(hostProcessAlive(child.process), "STOPPED_CHILD_LIVE").toBe(true);
  expect(exitOracle).toThrow();
  await child.command("continue");
  expect(hostProcessAlive(child.process)).toBe(true);
  await child.command("exit");
  exitOracle();
  expect(await child.command("reap")).toEqual({ stage: "reaped", pid: child.pid, status: 23 });
  await child.close();
});

test("an exited unreaped real child passes the exit oracle without observer reaping", async () => {
  const child = await ownedChild();
  expect(hostProcessAlive(child.process)).toBe(true);
  expect(await child.command("exit")).toEqual({ stage: "exited", status: 23 });
  const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  expect(fields[0], "ACTUAL_KERNEL_ZOMBIE").toBe("Z");
  expect(fields[19], "SAME_CAPTURED_START_IDENTITY").toBe(child.process.startTime);
  expect(hostProcessAlive(child.parent), "RUNNING_WAIT_OWNER_STILL_LIVE").toBe(true);
  expect(() => process.kill(child.pid, 0), "ZOMBIE_PID_STILL_EXISTS").not.toThrow();
  expect([child.process].filter(hostProcessAlive), "EXITED_UNREAPED_IS_NOT_EXECUTING").toEqual([]);
  // Repeated observation neither reaps nor changes the wait owner's status.
  expect(hostProcessAlive(child.process)).toBe(false);
  expect(() => process.kill(child.pid, 0)).not.toThrow();
  expect(await child.command("reap")).toEqual({ stage: "reaped", pid: child.pid, status: 23 });
  expect(hostProcessAlive(child.process), "REAPED_IDENTITY_GONE").toBe(false);
  await child.close();
});

// These controls vary proc reads only; the runtime controls above use real stat,
// acknowledged barriers and wait-owned Linux processes without mocked state.
function procReads(transform: (text: string, call: number) => string) {
  const original = fs.readFileSync;
  let calls = 0;
  const observer = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = original(...args);
    return args[0] === `/proc/${process.pid}/stat` ? transform(String(value), ++calls) : value;
  }) as typeof fs.readFileSync);
  const restore = async () => { observer.mockRestore(); cleanups.delete(restore); };
  cleanups.add(restore);
  return restore;
}
function replacement(text: string) {
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  fields[19] = String(BigInt(fields[19]!) + 1n);
  return text.slice(0, end + 2) + fields.join(" ");
}
function self() {
  const text = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { pid: process.pid, startTime: fields[19]! };
}

test("a replacement PID identity means the captured original is gone", async () => {
  const identity = self();
  await procReads(replacement);
  expect(hostProcessAlive(identity)).toBe(false);
});

test("observation revalidates identity after its first stat read", async () => {
  const identity = self();
  await procReads((text, call) => call === 1 ? text : replacement(text));
  expect(hostProcessAlive(identity)).toBe(false);
});

for (const code of ["ENOENT", "EACCES", "EIO"]) test(`proc ${code} is ${code === "ENOENT" ? "missing" : "inconclusive"}`, async () => {
  const identity = self();
  const error = Object.assign(new Error("proc control"), { code });
  await procReads(() => { throw error; });
  if (code === "ENOENT") expect(hostProcessAlive(identity)).toBe(false);
  else expect(() => hostProcessAlive(identity)).toThrow(error);
});

test("malformed proc state is inconclusive rather than an exit", async () => {
  const identity = self();
  await procReads(() => "invalid stat");
  expect(() => hostProcessAlive(identity)).toThrow("Invalid /proc/");
});

test("argument capture revalidates identity across cmdline and propagates unknown errors", async () => {
  const child = await ownedChild();
  // Use this process's real argv, which is available throughout the control.
  const argument = fs.readFileSync(`/proc/${process.pid}/cmdline`, "utf8").split("\0")[1]!;
  const restore = procReads((text, call) => call === 1 ? text : replacement(text));
  expect(hostProcessesWithArg(argument).some(value => value.pid === process.pid)).toBe(false);
  await restore();
  const unknown = new Error("capture read failure");
  await procReads(() => { throw unknown; });
  expect(() => hostProcessesWithArg(child.marker)).toThrow(unknown);
  await child.close();
});
