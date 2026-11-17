// The seam of the browser repetition gate, once (#4163): the real container
// side (scripts/browser-determinism-inside.mjs), the installed Vitest and a real
// Chromium, in the pinned image, against fixture specs no ordinary browser,
// layout or story project includes: their two projects are declared in
// tests/fixtures/browser-determinism/vitest.config.mjs. tests/browser-determinism.test.ts
// enumerates every case against a stand-in; this proves that further passes in
// one Vitest process really rerun a file, that the first failing repetition
// stops the run with its spec and project named, and that burners start and
// stop beside the browser.
//
// The container has no network and is started with --pull=never, as
// tests/workspace-lease.test.ts starts it: hosted proof pulls the pinned image
// before the partition that holds this file (scripts/ci-proof.ts).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_KIND } from "../scripts/browser-determinism-inside.mjs";
import { resolveBrowserPin } from "../scripts/captures/provenance";

const ROOT = join(import.meta.dir, ".."), FIXTURES = "tests/fixtures/browser-determinism";
const racy = `${FIXTURES}/landing-racy.repeat.js`, steady = `${FIXTURES}/landing-steady.repeat.js`;
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Runs the container side on `pairs` and returns what it wrote, said and exited with. */
async function repeatInContainer(pairs: { project: string; file: string }[], repetitions: number, configRoot = FIXTURES) {
  const scratch = mkdtempSync(join(tmpdir(), "browser-determinism-container-")); owned.push(scratch);
  // The result is read from the checkout's ignored tmp/, where the container writes it through its one mount.
  const run = `tmp/browser-determinism-container/${process.pid}-${owned.length}`;
  mkdirSync(join(ROOT, run), { recursive: true }); owned.push(join(ROOT, run));
  writeFileSync(join(ROOT, run, "plan.json"), JSON.stringify({ kind: RESULT_KIND, version: 1, root: configRoot, result: `${run}/passes.json`, pairs, repetitions, deadlineFactor: 3, burners: 1, cpuList: null }));
  // Rootless Docker maps the container's user to a subordinate one: it needs the plan readable, these two
  // directories open, and an open umask inside so this process can remove what the container wrote. Rootful
  // Docker runs as this user and needs none of it.
  chmodSync(join(ROOT, run, "plan.json"), 0o644);
  for (const dir of [scratch, join(ROOT, run)]) chmodSync(dir, 0o777);
  const child = Bun.spawn(["docker", "run", "--rm", "--pull=never", "--network=none", "--ipc=host", "--user", `${process.getuid!()}:${process.getgid!()}`,
    "-v", `${ROOT}:/repo`, "-v", `${scratch}:${scratch}`, "-e", `TMPDIR=${scratch}`, "-e", "HOME=/tmp", "-w", "/repo",
    (await resolveBrowserPin(ROOT)).image, "sh", "-c", 'umask 000 && exec node scripts/browser-determinism-inside.mjs "$1"', "sh", `${run}/plan.json`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let result: any;
  try { result = JSON.parse(readFileSync(join(ROOT, run, "passes.json"), "utf8")); } catch { throw new Error(`The container wrote no result (exit ${code}):\n${out}\n${err}`); }
  return { code, out, result };
}

test("the racy fixture fails the real runner at its third repetition in the pinned container, with spec, project and repetition named", async () => {
  const { code, out, result } = await repeatInContainer([{ project: "harbour", file: racy }], 5);
  expect(result.failure, "SPEC_PROJECT_AND_REPETITION_NAMED").toEqual({ project: "harbour", file: racy, repetition: 3, test: "the crew is aboard before the tide turns",
    reason: "a test case failed: expected 'tide' to be 'crew' // Object.is equality" });
  // Two green passes before the failing one: a single pass would have let the race through.
  expect(result.passes.map((pass: { repetition: number; ok: boolean }) => [pass.repetition, pass.ok]), "FURTHER_PASSES_RERUN_THE_FILE").toEqual([[1, true], [2, true], [3, false]]);
  expect(code).toBe(1);
  expect(out).toContain(`[browser-determinism] FAILED: ${racy} in project harbour, repetition 3 of 5: "the crew is aboard before the tide turns"`);
  // Exactly the selected pair ran: the same file in the fixture's other project did not.
  expect(out).not.toContain("strait");
  expect(result.load.burners, "BURNER_STARTED_INSIDE_THE_CONTAINER").toBe(1);
});

test("the same spec made deterministic passes every repetition in both of its projects", async () => {
  const pairs = [{ project: "harbour", file: steady }, { project: "strait", file: steady }];
  const { code, out, result } = await repeatInContainer(pairs, 5);
  expect(result.failure, out).toBeNull();
  expect(result.passes.map((pass: { repetition: number; ok: boolean }) => [pass.repetition, pass.ok])).toEqual([[1, true], [2, true], [3, true], [4, true], [5, true]]);
  expect([code, result.pairs, result.repetitions]).toEqual([0, pairs, 5]);
  expect(out).toContain("[browser-determinism] Passed: 2 project/file pair(s), 5 repetition(s) each.");
});

test("real Vitest defaults scale for hooks and still stop hangs, while explicit hook arguments stay unscaled", async () => {
  const hook = await repeatInContainer([{ project: "harbour", file: "tests/fixtures/browser-deadlines/deadline-hook.repeat.js" }], 2, "tests/fixtures/browser-deadlines");
  expect(hook.result.failure, hook.out).toBeNull();
  expect(hook.code).toBe(0);
  expect(hook.out).toContain("testTimeout=3000 ms, hookTimeout=2100 ms; BRAIN_TEST_DEADLINE_FACTOR=3");

  const hang = await repeatInContainer([{ project: "harbour", file: "tests/fixtures/browser-deadlines/deadline-hang.repeat.js" }], 2, "tests/fixtures/browser-deadlines");
  expect(hang.code).toBe(1);
  expect(hang.result.failure).toMatchObject({ repetition: 1, test: "the missing crew never arrives" });
  expect(hang.result.failure.reason, "HANG_FAILS_AT_SCALED_CAP").toContain("Test timed out in 3000ms");
  expect(hang.result.passes.map((pass: { ok: boolean }) => pass.ok)).toEqual([false]);

  const explicit = await repeatInContainer([{ project: "harbour", file: "tests/fixtures/browser-deadlines/deadline-explicit-hook.repeat.js" }], 2, "tests/fixtures/browser-deadlines");
  expect(explicit.code).toBe(1);
  expect(explicit.result.failure.reason, "EXPLICIT_HOOK_TIMEOUT_IS_UNSCALED").toContain("Hook timed out in 80ms");
}, 60_000);
