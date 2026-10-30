import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeIdentityInspector, NATIVE_LOOP_INSPECTION, NATIVE_ROOT_INSPECTION, type NativeInspection } from "../src/server/native-identity-inspector";

const PYTHON = "/usr/bin/python3", ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function inspector(options: { timeoutMs?: number; maximumBytes?: number } = {}) {
  const value = createNativeIdentityInspector({ python: PYTHON, env: ENV, timeoutMs: options.timeoutMs ?? 10_000, maximumBytes: options.maximumBytes ?? 64 * 1024 });
  cleanups.push(() => value.close());
  return value;
}
function directory() {
  const root = mkdtempSync(join(tmpdir(), "native-inspector-odysseus-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
/** The launch every inspection used before #2872: a fresh interpreter, one path argument. */
function fresh(program: NativeInspection, path: string) {
  const result = Bun.spawnSync([PYTHON, "-I", "-S", "-c", program === "root" ? NATIVE_ROOT_INSPECTION : NATIVE_LOOP_INSPECTION, path], { env: ENV, cwd: "/", stdin: "ignore" });
  return { code: result.exitCode, text: result.stdout.toString(), errors: result.stderr.toString() };
}
const lastLine = (text: string) => text.trim().split("\n").at(-1);
/** This test process's own inspector children; never another process's. */
const children = () => Bun.spawnSync(["/usr/bin/pgrep", "-P", String(process.pid), "-f", "import sys,json,io,traceback"]).stdout.toString().trim().split("\n").filter(Boolean);
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("the inspection programs are byte-identical to the ones each fresh launch ran before #2872", () => {
  // Hashes of `INSPECT` and `LOOP_IDENTITY` in native-brain-manager.ts at the commit before #2872.
  expect(sha256(NATIVE_ROOT_INSPECTION), "NATIVE_ROOT_INSPECTION_UNCHANGED").toBe("d85064c887fdad3d21f7b252ca7d76e19dc90ce05659e8cf0550743fcbe55964");
  expect(sha256(NATIVE_LOOP_INSPECTION), "NATIVE_LOOP_INSPECTION_UNCHANGED").toBe("c362c7fbac33253a4e1e69f429064fb9392261ff5ae2b211c8e07df7e4c4e050");
});

test("each inspection answers as a fresh launch would, for the same path", async () => {
  const root = directory(), inspect = inspector();
  mkdirSync(join(root, "ithaca")); writeFileSync(join(root, "scheria.md"), "Nausicaa");
  symlinkSync(join(root, "ithaca"), join(root, "harbour"));
  const cases: [NativeInspection, string][] = [
    ["root", join(root, "ithaca")], ["root", join(root, "missing")], ["root", join(root, "harbour")], ["root", join(root, "scheria.md")],
    ["loop", join(root, "scheria.md")], ["loop", join(root, "missing")], ["loop", join(root, "harbour")],
  ];
  for (const [program, path] of cases) {
    const expected = fresh(program, path), actual = await inspect.run(program, path);
    expect(expected.code, `fresh launch refuses ${program} ${path}`).toBe(1);
    expect(actual, `NATIVE_INSPECTOR_MATCHES_FRESH_LAUNCH ${program} ${path}`).toEqual(expected);
  }
  expect(inspect.launches, "NATIVE_INSPECTOR_ONE_INTERPRETER").toBe(1);
});

test("alternating inspection failures retain the active source and exact fresh diagnostic", async () => {
  const root = directory(), path = join(root, "scheria.md"), inspect = inspector();
  writeFileSync(path, "Nausicaa");
  const cases: [NativeInspection, string][] = [["root", root], ["loop", path], ["root", root], ["loop", path]];
  for (const [program, rejectedPath] of cases) {
    const expected = fresh(program, rejectedPath), actual = await inspect.run(program, rejectedPath);
    expect(expected.code).toBe(1);
    expect(expected.text).toBe("");
    expect(actual, `NATIVE_INSPECTOR_ACTIVE_SOURCE ${program}`).toEqual(expected);
    expect(actual.errors).toContain('File "<string>"');
    expect(actual.errors).not.toContain("request=json.loads(line)");
    expect(actual.errors).not.toContain("for line in sys.stdin");
  }
  expect(inspect.launches).toBe(1);
});

test("every request inspects the path again; no answer is reused", async () => {
  const root = directory(), path = join(root, "penelope"), inspect = inspector();
  expect(lastLine((await inspect.run("root", path)).errors), "NATIVE_INSPECTOR_SEES_ABSENT_PATH").toContain("FileNotFoundError");
  mkdirSync(path);
  expect(lastLine((await inspect.run("root", path)).errors), "NATIVE_INSPECTOR_SEES_CREATED_PATH").toBe("RuntimeError: not a subvolume root");
  rmSync(path, { recursive: true });
  expect(lastLine((await inspect.run("root", path)).errors), "NATIVE_INSPECTOR_SEES_REMOVED_PATH").toContain("FileNotFoundError");
  expect(inspect.launches).toBe(1);
});

test("an interrupted or timed-out inspection is unknown and the next one starts a new interpreter", async () => {
  const root = directory(), fifo = join(root, "sirens");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
  const inspect = inspector({ timeoutMs: 300 });
  // Opening a FIFO for reading blocks until a writer appears: the loop program waits.
  await expect(inspect.run("loop", fifo), "NATIVE_INSPECTOR_TIMEOUT_UNKNOWN").rejects.toMatchObject({ code: "unknown", message: expect.stringContaining("operation timeout exceeded") });
  const controller = new AbortController(), pending = inspect.run("loop", fifo, controller.signal);
  setTimeout(() => controller.abort(new Error("Odysseus stopped the inspection")), 100);
  await expect(pending, "NATIVE_INSPECTOR_ABORT_UNKNOWN").rejects.toMatchObject({ code: "unknown", message: expect.stringContaining("Odysseus stopped the inspection") });
  expect(lastLine((await inspect.run("root", root)).errors)).toBe("RuntimeError: not a subvolume root");
  expect(inspect.launches, "NATIVE_INSPECTOR_RESTARTS_AFTER_INTERRUPTION").toBe(3);
});

test("an oversized reply refuses and closing refuses later inspections", async () => {
  const root = directory(), small = inspector({ maximumBytes: 16 });
  await expect(small.run("root", root), "NATIVE_INSPECTOR_REPLY_BOUND").rejects.toMatchObject({ code: "unavailable", message: "Native manager command output exceeded its bound." });
  const inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  expect(children()).toHaveLength(1);
  await inspect.close();
  expect(children(), "NATIVE_INSPECTOR_CLOSE_JOINS_EXIT").toEqual([]);
  await expect(inspect.run("root", root), "NATIVE_INSPECTOR_CLOSED").rejects.toMatchObject({ code: "unavailable", message: "Native manager is closing." });
});

test("a request cancelled before it starts throws its own reason and starts no interpreter", async () => {
  const inspect = inspector(), reason = new Error("Odysseus never asked");
  await expect(inspect.run("root", directory(), AbortSignal.abort(reason)), "NATIVE_INSPECTOR_PRESTART_ABORT_REASON").rejects.toBe(reason);
  expect(inspect.launches).toBe(0);
});

test("an interpreter that died is replaced, failing only the request that met it", async () => {
  const root = directory(), inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  const pids = children();
  expect(pids, "one inspector child").toHaveLength(1);
  process.kill(Number(pids[0]), "SIGKILL");
  await expect(inspect.run("root", root), "NATIVE_INSPECTOR_DEATH_FAILS_REQUEST").rejects.toMatchObject({ code: "unavailable" });
  expect(lastLine((await inspect.run("root", root)).errors), "NATIVE_INSPECTOR_REPLACED_AFTER_DEATH").toBe("RuntimeError: not a subvolume root");
  expect(inspect.launches).toBe(2);
});

test("concurrent requests are answered in order on the one interpreter", async () => {
  const root = directory(), inspect = inspector();
  mkdirSync(join(root, "ithaca"));
  const answers = await Promise.all([join(root, "ithaca"), join(root, "missing"), join(root, "ithaca")].map(path => inspect.run("root", path)));
  expect(answers.map(answer => lastLine(answer.errors)?.split(":")[0]), "NATIVE_INSPECTOR_REPLIES_PAIRED").toEqual(["RuntimeError", "FileNotFoundError", "RuntimeError"]);
  expect(inspect.launches).toBe(1);
});


/** Observe only actual inspector children launched by this test process. */
function observedInspectors() {
  const spawned: Array<Bun.Subprocess<"pipe", "pipe", "pipe">> = [];
  const nativeSpawn = Bun.spawn;
  const observer = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const child = Reflect.apply(nativeSpawn, Bun, [command, options]) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    if (command[0] === PYTHON && command[4]?.startsWith("import sys,json,io,traceback"))
      spawned.push(child as Bun.Subprocess<"pipe", "pipe", "pipe">);
    return child;
  }) as typeof Bun.spawn);
  cleanups.push(() => observer.mockRestore());
  return spawned;
}

/** Do not yield to Bun's child-exit callback before the native write premise. */
function killBeforeExitCallback(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  expect(Number(fields[1]), "THE_INSPECTOR_IS_OUR_DIRECT_CHILD").toBe(process.pid);
  child.kill("SIGKILL");
  const start = performance.now(), deadline = start + 1_000;
  let state = "", polls = 0;
  while (performance.now() < deadline) {
    polls++;
    try {
      const current = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const currentFields = current.slice(current.lastIndexOf(")") + 2).split(" ");
      expect(currentFields[19], "THE_KERNEL_OBSERVATION_IS_THE_SAME_OWNED_PROCESS").toBe(fields[19]);
      state = currentFields[0]!;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = "gone";
    }
    if (state === "Z" || state === "gone") break;
    Bun.sleepSync(1);
  }
  console.error(JSON.stringify({ kind: "inspector-kernel-exit", pid: child.pid, state, polls, elapsedMs: performance.now() - start }));
  expect(["Z", "gone"], "KERNEL_CONFIRMS_EXIT_BEFORE_THE_PARENT_CALLBACK").toContain(state);
}

/** Retain native sink behavior; observe either synchronous or asynchronous failure. */
function observeSinkErrors(stdin: Bun.FileSink, failed: (error: unknown) => void) {
  const counts = { writes: 0 };
  for (const operation of ["write", "flush"] as const) {
    const native = stdin[operation];
    const observer = spyOn(stdin, operation).mockImplementation(((...args: unknown[]) => {
      if (operation === "write") counts.writes++;
      try {
        const result = Reflect.apply(native, stdin, args);
        if (result instanceof Promise) return result.catch(error => { failed(error); throw error; });
        return result;
      } catch (error) { failed(error); throw error; }
    }) as typeof stdin[typeof operation]);
    cleanups.push(() => observer.mockRestore());
  }
  return counts;
}

for (const attempt of [1, 2, 3]) test(`native write EPIPE is unavailable, joins retirement and replaces once (${attempt})`, async () => {
  const root = directory(), spawned = observedInspectors(), inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  expect(spawned).toHaveLength(1);
  const child = spawned[0]!, stdin = child.stdin;
  let nativeError: unknown, exitJoined = false;
  void child.exited.then(() => { exitJoined = true; });
  const counts = observeSinkErrors(stdin, error => { nativeError = error; });
  killBeforeExitCallback(child);
  const failed = inspect.run("root", root).then(() => undefined, error => error);
  // Queue a successor while the failed exchange is still being retired.
  const successor = inspect.run("root", root);
  void successor.catch(() => {});
  const error = await failed;
  expect(nativeError, "THE_REAL_SINK_WRITE_SUPPLIES_EPIPE").toMatchObject({ code: "EPIPE", syscall: "write" });
  expect(error, "NATIVE_INSPECTOR_DEATH_FAILS_REQUEST").toMatchObject({ code: "unavailable" });
  expect(exitJoined, "FAILED_REQUEST_JOINS_THE_DEAD_INTERPRETER").toBe(true);
  expect(await child.exited).toBe(137);
  expect(counts.writes, "RETIRED_INTERPRETER_RECEIVES_NO_SUCCESSOR_OR_RETRY").toBe(1);
  expect(await successor.then(reply => lastLine(reply.errors), error => error), "QUEUED_SUCCESSOR_USES_A_REPLACEMENT").toBe("RuntimeError: not a subvolume root");
  expect(inspect.launches, "ONLY_ONE_REPLACEMENT_IS_STARTED").toBe(2);
  expect(spawned).toHaveLength(2);
});

// Abort while the native EPIPE catch is joining retirement, before classification.
test("cancellation retains unknown precedence over a real native EPIPE", async () => {
  const root = directory(), spawned = observedInspectors(), inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  const child = spawned[0]!, stdin = child.stdin;
  const controller = new AbortController(), reason = new Error("Odysseus stopped the inspection");
  let nativeError: unknown;
  observeSinkErrors(stdin, error => { nativeError = error; });
  void child.exited.then(() => controller.abort(reason));
  killBeforeExitCallback(child);
  let error: unknown;
  try { await inspect.run("root", root, controller.signal); } catch (failure) { error = failure; }
  expect(nativeError, "CANCELLATION_CONTROL_REACHES_NATIVE_EPIPE").toMatchObject({ code: "EPIPE", syscall: "write" });
  expect(error, "CANCELLATION_WINS_OVER_TRANSPORT_EPIPE").toMatchObject({ code: "unknown", message: expect.stringContaining(reason.message) });
  expect(await child.exited).toBe(137);
  expect((await inspect.run("root", root)).code).toBe(1);
  expect(inspect.launches).toBe(2);
});


test("an already joined interpreter exit takes the EOF refusal path and replaces once", async () => {
  const root = directory(), spawned = observedInspectors(), inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  const child = spawned[0]!;
  child.kill("SIGKILL");
  expect(await child.exited).toBe(137);
  await expect(inspect.run("root", root), "JOINED_EXIT_REMAINS_UNAVAILABLE").rejects.toMatchObject({
    code: "unavailable", message: "Native command refused: identity inspector exited",
  });
  expect((await inspect.run("root", root)).code).toBe(1);
  expect(inspect.launches).toBe(2);
});

test("unrelated sink failures preserve the original error instead of guessing unavailable", async () => {
  const root = directory(), spawned = observedInspectors(), inspect = inspector();
  expect((await inspect.run("root", root)).code).toBe(1);
  const marker = Object.assign(new Error("Odysseus sink control"), { code: "EIO" });
  const writer = spyOn(spawned[0]!.stdin, "write").mockImplementation(() => { throw marker; });
  cleanups.push(() => writer.mockRestore());
  await expect(inspect.run("root", root), "UNRELATED_ERRORS_ARE_NOT_NORMALIZED").rejects.toBe(marker);
  expect(await spawned[0]!.exited).toBe(137);
  expect((await inspect.run("root", root)).code).toBe(1);
  expect(inspect.launches).toBe(2);
});
