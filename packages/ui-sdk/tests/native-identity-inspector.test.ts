import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
