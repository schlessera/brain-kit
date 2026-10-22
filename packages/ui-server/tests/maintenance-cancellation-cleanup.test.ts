import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../../..");
const SOURCE = join(import.meta.dir, "maintenance-startup-view.test.ts");

for (const timing of ["during", "after"] as const) test(`a timed-out ${timing} Git cancellation restores globals before fixture deletion and survives a late finally`, async () => {
  const caseName = `cancellation ${timing} Git preparation starts no maintenance command and releases admission`;
  const root = mkdtempSync(join(tmpdir(), "odysseus-cancellation-control-"));
  try {
    let source = readFileSync(SOURCE, "utf8");
    const checkpoint = '    const dbPath = join(state, "ui.db"); db = createUiDb(dbPath);';
    const unwind = "  } finally { restore(); }";
    expect(source.split(checkpoint)).toHaveLength(2);
    expect(source.split(unwind)).toHaveLength(2);
    // Keep the real cancellation setup and cleanup. Suspend before starting
    // native work so the timeout ordering is deterministic and inexpensive.
    source = source.replace(checkpoint, `
    if (timing === ${JSON.stringify(timing)}) {
      isolationProbe.timing = timing;
      isolationProbe.fakeGit = fakeGit;
      await new Promise<void>(resolve => { isolationProbe.resume = resolve; });
      return;
    }
${checkpoint}`).replace(unwind, "  } finally { restore(); isolationProbe.unwound?.(); }")
      .replace(/^(import[^\n]* from )"([^"\n]+)"/gm, (match, prefix: string, specifier: string) =>
        specifier.startsWith("node:") || specifier === "bun:test" ? match :
          `${prefix}${JSON.stringify(Bun.resolveSync(specifier, dirname(SOURCE)))}`);
    source += `
const isolationProbe = {} as { timing: string; fakeGit: string; resume(): void; unwound?(): void };
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
  const git = Bun.spawnSync([realGit!, "--version"]);
  expect(git.exitCode, git.stderr.toString()).toBe(0);
});
test("late cancellation finally preserves the following case's lookup", async () => {
  const next = spyOn(Bun, "which").mockImplementation((name, options) =>
    name === "git" ? "/fixture/next-git" : originalWhich(name, options));
  const nextWorker = spyOn(workerSdk, "runMaintenanceWorker").mockImplementation(originalWorker);
  cleanup.push(() => { next.mockRestore(); nextWorker.mockRestore(); });
  try {
    const unwound = new Promise<void>(resolve => { isolationProbe.unwound = resolve; });
    isolationProbe.resume();
    await unwound;
    expect(Bun.which("git"), "LATE_FINALLY_PRESERVES_NEXT_LOOKUP").toBe("/fixture/next-git");
    expect(process.env.PATH, "LATE_FINALLY_PRESERVES_PATH").toBe(originalPath);
    expect(workerSdk.runMaintenanceWorker, "LATE_FINALLY_PRESERVES_NEXT_WORKER").toBe(nextWorker);
  } finally { next.mockRestore(); nextWorker.mockRestore(); }
});
`;
    const file = join(root, "cancellation.test.ts");
    writeFileSync(file, source);
    const child = Bun.spawn([process.execPath, "run", "test", file, "--timeout", "250",
      "--test-name-pattern", `${caseName}|following cancellation|late cancellation`], {
      cwd: ROOT, env: { ...process.env, AGENT: "0" }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const output = stdout + stderr;
    expect(code, output).toBe(1);
    expect(output, "CONTROL_FAILS_ONLY_ON_INDUCED_TIMEOUT").toContain(`(fail) ${caseName}`);
    expect(output).toContain("this test timed out after 250ms");
    expect(output).toContain("(pass) following cancellation resolves real Git after shim deletion");
    expect(output).toContain("(pass) late cancellation finally preserves the following case's lookup");
    expect(output).toContain("2 pass");
    expect(output).toContain("1 fail");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
