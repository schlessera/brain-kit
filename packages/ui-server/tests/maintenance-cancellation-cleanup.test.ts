import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../../..");
const SOURCE = join(import.meta.dir, "maintenance-startup-view.test.ts");

// Cross the induced deadline during preparation as a regression control; the
// selected callback must still reach its checkpoint before that deadline starts.
for (const setupDelay of [0, 450]) for (const timing of ["during", "after"] as const) test(`a timed-out ${timing} Git cancellation restores globals before fixture deletion and survives a late finally (setup delay ${setupDelay}ms)`, async () => {
  const caseName = `cancellation ${timing} Git preparation starts no maintenance command and releases admission`;
  const root = mkdtempSync(join(tmpdir(), "odysseus-cancellation-control-"));
  try {
    let source = readFileSync(SOURCE, "utf8");
    const checkpoint = '    const dbPath = join(state, "ui.db"); db = createUiDb(dbPath);';
    const unwind = "  } finally { restore(); }";
    const restored = "    restored = true;";
    const init = "  const init = Bun.spawnSync([realGit,";
    const fixtureRemoval = "  cleanup.push(() => rmSync(brain, { recursive: true, force: true }));";
    expect(source.split(checkpoint)).toHaveLength(2);
    expect(source.split(unwind)).toHaveLength(2);
    expect(source.split(restored)).toHaveLength(2);
    expect(source.split(init)).toHaveLength(2);
    expect(source.split(fixtureRemoval)).toHaveLength(2);
    const registration = 'for (const timing of ["during", "after"] as const) test(`cancellation';
    expect(source.split(registration)).toHaveLength(2);
    if (setupDelay) source = source.replace(init, `  if (timing === ${JSON.stringify(timing)}) await Bun.sleep(${setupDelay});\n${init}`);
    source = source.replace('import { afterEach,', 'import { beforeAll, describe, afterEach,')
      .replace(registration, registration.replace(' test(', ' cancellationControlTest('))
      .replace(restored, "    isolationProbe.restorations = (isolationProbe.restorations ?? 0) + 1;\n" + restored)
      .replace(fixtureRemoval, `  cleanup.push(() => {
    isolationProbe.restoredBeforeDeletion = Bun.which === originalWhich &&
      process.env.PATH === originalPath && workerSdk.runMaintenanceWorker === originalWorker;
    rmSync(brain, { recursive: true, force: true });
  });`);
    // Keep the real cancellation setup and cleanup. Suspend before starting
    // native work so the timeout ordering is deterministic and inexpensive.
    source = source.replace(checkpoint, `
    if (timing === ${JSON.stringify(timing)}) {
      isolationProbe.timing = timing;
      isolationProbe.fakeGit = fakeGit;
      await new Promise<void>(resolve => {
        isolationProbe.resume = resolve;
        isolationProbe.ready();
      });
      return;
    }
${checkpoint}`).replace(unwind, "  } finally { restore(); isolationProbe.unwound = true; }")
      .replace(/^(import[^\n]* from )"([^"\n]+)"/gm, (match, prefix: string, specifier: string) =>
        specifier.startsWith("node:") || specifier === "bun:test" ? match :
          `${prefix}${JSON.stringify(Bun.resolveSync(specifier, dirname(SOURCE)))}`);
    source += `
const isolationProbe = {} as {
  timing: string; fakeGit: string; resume(): void; ready(): void;
  pending: Promise<void>; settled: boolean; unwound: boolean; restorations: number;
  restoredBeforeDeletion: boolean;
};
function cancellationControlTest(name: string, callback: () => Promise<void>) {
  if (name !== ${JSON.stringify(caseName)}) { test(name, callback); return; }
  // Only this case stages the original callback. A file-wide beforeEach
  // would reinstall its spies before the two subsequent ownership checks.
  describe("staged cancellation", () => {
    beforeAll(async () => {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          // This setup watchdog diagnoses a missing acknowledgement and owns
          // cleanup; it is distinct from the genuine Bun test timeout below.
          watchdog = setTimeout(() => reject(new Error("CANCELLATION_SETUP_CHECKPOINT_MISSING")), 5_000);
          isolationProbe.ready = resolve;
          isolationProbe.settled = false;
          isolationProbe.pending = callback();
          // Observe rejection immediately, including failure before checkpoint.
          isolationProbe.pending.then(() => {
            isolationProbe.settled = true;
            reject(new Error("CANCELLATION_SETUP_CALLBACK_SETTLED"));
          }, error => {
            isolationProbe.settled = true;
            reject(new Error("CANCELLATION_SETUP_CALLBACK_FAILED", { cause: error }));
          });
        });
        expect(isolationProbe.timing, "SETUP_ACK_TIMING").toBe(${JSON.stringify(timing)});
        expect(isolationProbe.fakeGit, "SETUP_ACK_SHIM").toBeTruthy();
        if (${JSON.stringify(timing)} === "during") {
          expect(Bun.which("git"), "SETUP_ACK_SHIM_IDENTITY").toBe(isolationProbe.fakeGit);
        } else {
          expect(workerSdk.runMaintenanceWorker, "SETUP_ACK_WORKER_SHIM").not.toBe(originalWorker);
        }
        expect(isolationProbe.resume, "SETUP_ACK_RESUME").toBeFunction();
        expect(isolationProbe.settled, "SETUP_CALLBACK_STILL_PENDING").toBe(false);
      } catch (error) {
        // Bun does not run afterEach for a failed beforeAll. Restore globals
        // before fixture deletion here too, and release any suspended callback.
        try { for (const remove of cleanup.splice(0).reverse()) remove(); }
        finally { isolationProbe.resume?.(); }
        throw error;
      } finally { clearTimeout(watchdog); }
    }, 30_000);
    test(name, async () => {
      expect(isolationProbe.settled, "TIMEOUT_CALLBACK_STILL_PENDING").toBe(false);
      await isolationProbe.pending;
    }, 250);
  });
}
const originalWhich = Bun.which, originalPath = process.env.PATH;
const originalWorker = workerSdk.runMaintenanceWorker;
const realGit = Bun.which("git");
test("following cancellation resolves real Git after shim deletion", () => {
  expect(isolationProbe.timing, "CANCELLATION_SETUP_REACHED").toBe(${JSON.stringify(timing)});
  expect(existsSync(isolationProbe.fakeGit), "SHIM_ALREADY_DELETED").toBe(false);
  expect(Bun.which("git"), "FOLLOWING_CASE_REAL_GIT").toBe(realGit);
  expect(Bun.which, "FOLLOWING_CASE_ORIGINAL_LOOKUP").toBe(originalWhich);
  expect(process.env.PATH, "FOLLOWING_CASE_ORIGINAL_PATH").toBe(originalPath);
  expect(workerSdk.runMaintenanceWorker, "FOLLOWING_CASE_ORIGINAL_MAINTENANCE_WORKER").toBe(originalWorker);
  expect(isolationProbe.restoredBeforeDeletion, "GLOBALS_RESTORED_BEFORE_FIXTURE_DELETION").toBe(true);
  const git = Bun.spawnSync([realGit!, "--version"]);
  expect(git.exitCode, git.stderr.toString()).toBe(0);
});
test("late cancellation finally preserves the following case's lookup", async () => {
  const next = spyOn(Bun, "which").mockImplementation((name, options) =>
    name === "git" ? "/fixture/next-git" : originalWhich(name, options));
  const nextWorker = spyOn(workerSdk, "runMaintenanceWorker").mockImplementation(originalWorker);
  cleanup.push(() => { next.mockRestore(); nextWorker.mockRestore(); });
  try {
    expect(isolationProbe.unwound, "FINALLY_STILL_SUSPENDED_AFTER_CLEANUP").not.toBe(true);
    isolationProbe.resume();
    await isolationProbe.pending;
    expect(isolationProbe.unwound, "LATE_FINALLY_COMPLETED").toBe(true);
    // Bun mocks can themselves ignore a second mockRestore. Observe entry to
    // the original restoration body too, so that cannot mask a missing guard.
    expect(isolationProbe.restorations, "LATE_FINALLY_RESTORES_ONLY_ONCE").toBe(1);
    expect(Bun.which("git"), "LATE_FINALLY_PRESERVES_NEXT_LOOKUP").toBe("/fixture/next-git");
    expect(process.env.PATH, "LATE_FINALLY_PRESERVES_PATH").toBe(originalPath);
    expect(workerSdk.runMaintenanceWorker, "LATE_FINALLY_PRESERVES_NEXT_WORKER").toBe(nextWorker);
  } finally { next.mockRestore(); nextWorker.mockRestore(); }
});
`;
    const file = join(root, "cancellation.test.ts");
    writeFileSync(file, source);
    const child = Bun.spawn([process.execPath, "run", "test", file,
      "--test-name-pattern", `${caseName}|following cancellation|late cancellation`], {
      cwd: ROOT, env: { ...process.env, AGENT: "0" }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const output = stdout + stderr;
    expect(code, output).toBe(1);
    expect(output, "CONTROL_FAILS_ONLY_ON_INDUCED_TIMEOUT").toContain(`(fail) staged cancellation > ${caseName}`);
    expect(output).toContain("this test timed out after 250ms");
    expect(output).not.toContain("CANCELLATION_SETUP_CHECKPOINT_MISSING");
    expect(output).not.toContain("CANCELLATION_SETUP_CALLBACK_FAILED");
    expect(output).not.toContain("CANCELLATION_SETUP_CALLBACK_SETTLED");
    expect(output).toContain("(pass) following cancellation resolves real Git after shim deletion");
    expect(output).toContain("(pass) late cancellation finally preserves the following case's lookup");
    expect(output).toContain("2 pass");
    expect(output).toContain("1 fail");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
