/**
 * `brain maintain`'s git step: git's non-destructive maintenance tasks pack
 * loose objects in a brain that is a git work tree, and nothing under refs/
 * is removed.
 */

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanup, makeTempBrain, keylessEnv, runCli } from "./cli-harness";
import { failedStepsLine, maintainCommand } from "../src/cli/commands/maintain";
import { initContext } from "../src/lib/context";
import { expectBlobsIntact, git, initRepo, looseCount, reflogs, refs, writeLooseBlobs } from "./git-fixture";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

function tempBrain(): string {
  const root = makeTempBrain();
  temps.push(root);
  return root;
}

async function maintain(root: string, flags: string[] = [], env: Record<string, string> = {}) {
  const { stdout, stderr, code } = await runCli(root, ["maintain", "--json", ...flags], env);
  // A crash prints no report at all; say so rather than fail inside JSON.parse.
  expect(stdout, `maintain printed no report: ${stderr}`).not.toBe("");
  const steps = JSON.parse(stdout) as { step: string; result: string }[];
  return { code, stderr, steps, git: steps.find((s) => s.step === "git") };
}

// Packing, not pruning: every blob is still readable with its content, and
// no ref or reflog entry went. The blobs are unreachable, so a prune would
// empty the loose count just as well; only the content check tells them apart.
test("packs 20 loose blobs, leaves none loose, and loses no object, ref or reflog entry", async () => {
  const root = tempBrain();
  initRepo(root);
  const blobs = writeLooseBlobs(root, 20);
  expect(looseCount(root)).toBe(20);
  const before = refs(root);
  const logsBefore = reflogs(root);
  expect(logsBefore.length).toBeGreaterThan(0);
  expect(before.map((r) => r.split(" ")[0])).toEqual([
    "refs/heads/main",
    "refs/original/refs/heads/main",
    "refs/tags/v1",
  ]);

  const { code, git: step } = await maintain(root);
  expect(code).toBe(0);
  expect(step?.result).toBe("ok — packed 20 loose object(s)");
  expect(looseCount(root)).toBe(0);
  expectBlobsIntact(root, blobs);
  expect(refs(root)).toEqual(before);
  expect(reflogs(root)).toEqual(logsBefore);
});

// A brain with no pack yet (#3375): freshly committed, every object still
// loose. Git's incremental-repack task refuses a repository without a pack,
// and git 2.43 and 2.47 refuse even after the same run's loose-objects task
// has written the first one.
const packCount = (root: string) => Number(git(root, "count-objects", "-v").match(/^packs: (\d+)$/m)![1]);

test("a repository with no pack yet gets its first pack and an ok step", async () => {
  const root = tempBrain();
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Ithaca");
  const blobs = writeLooseBlobs(root, 3);
  const loose = looseCount(root);
  expect(packCount(root), "FIXTURE_HAS_NO_PACK").toBe(0);
  const before = refs(root);

  const { code, git: step } = await maintain(root);
  expect(step?.result, "MAINTAIN_PACKLESS_REPOSITORY_PACKS").toBe(`ok — packed ${loose} loose object(s)`);
  expect(code).toBe(0);
  expect(packCount(root)).toBeGreaterThan(0);
  expect(looseCount(root)).toBe(0);
  expectBlobsIntact(root, blobs);
  expect(refs(root)).toEqual(before);
});

test("a repository with no objects at all is an ok step with nothing packed", async () => {
  const root = tempBrain();
  git(root, "init", "-q", "-b", "main");
  expect(looseCount(root)).toBe(0);
  expect(packCount(root), "FIXTURE_HAS_NO_PACK").toBe(0);

  const { code, git: step } = await maintain(root);
  expect(step?.result, "MAINTAIN_OBJECTLESS_REPOSITORY_OK").toBe("ok — packed 0 loose object(s)");
  expect(code).toBe(0);
});

test("runs the git step between the tag report and the scratch prune", async () => {
  const root = tempBrain();
  const { steps } = await maintain(root);
  expect(steps.map((s) => s.step)).toEqual(["registry", "index", "vectors", "audit", "stats", "tags", "git", "scratch"]);
});

test("a brain that is not a git repository skips the step and exits 0", async () => {
  const root = tempBrain();
  const { code, git: step } = await maintain(root);
  expect(code).toBe(0);
  expect(step?.result).toBe("skipped — not a git repository");
});

test("--no-git skips the step and leaves the objects loose", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 3);
  const { code, git: step } = await maintain(root, ["--no-git"]);
  expect(code).toBe(0);
  expect(step?.result).toBe("skipped — --no-git");
  expect(looseCount(root)).toBe(3);
});

// A read-only pack directory makes native Git maintenance fail. Root writes
// through the mode, so this cannot be staged there.
test.skipIf(process.getuid?.() === 0)("a git failure is a FAILED step with git's message, and exit 2", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 2);
  const pack = join(root, ".git", "objects", "pack");
  chmodSync(pack, 0o555);
  try {
    // Git versions may attempt incremental-repack before loose-objects. Observe
    // the native refusal rather than pinning which task reports it first.
    const env = { LC_ALL: "C" };
    const native = Bun.spawnSync(["git", "-C", root, "maintenance", "run",
      "--task=loose-objects", "--task=incremental-repack", "--task=pack-refs"],
      { env: { ...keylessEnv(root), ...env }, stdout: "pipe", stderr: "pipe" });
    const error = native.stderr.toString().trim();
    expect(native.exitCode, "NATIVE_GIT_PERMISSION_REFUSAL").not.toBe(0);
    expect(error, "NATIVE_GIT_PACK_DIRECTORY_REFUSAL").toContain(pack);
    expect(error, "NATIVE_GIT_PERMISSION_DIAGNOSTIC").toContain("Permission denied");
    const firstLine = error.split("\n").find(line => line.trim() !== "")!.trim();
    const { code, git: step } = await maintain(root, [], env);
    expect(step?.result, "MAINTAIN_PRESERVES_NATIVE_GIT_ERROR").toBe(`FAILED — ${firstLine}`);
    expect(code).toBe(2);
  } finally {
    chmodSync(pack, 0o755);
  }
});

// A git whose maintenance write runs out of space (#3357). The wrapper runs
// every other git command for real; only `maintenance run` fails, with git's own
// out-of-space wording, after a warning line so the first line is not the one.
function gitOutOfSpace(root: string): string {
  const bin = mkdtempSync(join(tmpdir(), "brain-git-enospc-"));
  temps.push(bin);
  const real = Bun.which("git")!;
  writeFileSync(join(bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = maintenance ]; then
    echo "warning: packing 2 loose objects" >&2
    echo "fatal: sha1 file '.git/objects/pack/tmp_pack_Ithaca' write error. Out of diskspace" >&2
    exit 128
  fi
done
exec '${real}' "$@"
`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, "bun"));
  return `${bin}:${keylessEnv(root).PATH}`;
}

test("an unhosted git step that runs out of space reports the shortfall without a hosted setting", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 2);
  const { code, git: step } = await maintain(root, [], { PATH: gitOutOfSpace(root) });
  expect(step?.result, "MAINTAIN_GIT_NO_SPACE_UNHOSTED").toMatch(
    /^FAILED — no space: git packing ran out of space on the filesystem holding \.git \(\d+ bytes available when the step started\)\. git: fatal: sha1 file '\.git\/objects\/pack\/tmp_pack_Ithaca' write error\. Out of diskspace$/);
  expect(step?.result, "MAINTAIN_GIT_NO_SPACE_NO_HOSTED_SETTING").not.toMatch(/BRAIN_UI_|output stage|allowance/);
  expect(code).toBe(2);
  expect(looseCount(root)).toBe(2);
});

test("a launcher-declared output allowance names its size and setting in the out-of-space step", async () => {
  const root = tempBrain();
  initRepo(root);
  const allowance = JSON.stringify({ bytes: 4194304, setting: "ODYSSEUS_STAGE_BYTES" });
  const { git: step } = await maintain(root, [], { PATH: gitOutOfSpace(root), BRAIN_WORKER_OUTPUT_ALLOWANCE: allowance });
  expect(step?.result, "MAINTAIN_GIT_NO_SPACE_DECLARED_ALLOWANCE").toMatch(
    /^FAILED — no space: git packing ran out of space in the maintenance worker's output stage \(allowance 4194304 bytes, set by ODYSSEUS_STAGE_BYTES; \d+ bytes available when the step started\)\. /);
});

test("a malformed output allowance is ignored, never echoed", async () => {
  const root = tempBrain();
  initRepo(root);
  for (const malformed of ["not json", JSON.stringify({ bytes: -1, setting: "ODYSSEUS_STAGE_BYTES" }), JSON.stringify({ bytes: 4096, setting: "rm -rf /" })]) {
    const { git: step } = await maintain(root, [], { PATH: gitOutOfSpace(root), BRAIN_WORKER_OUTPUT_ALLOWANCE: malformed });
    expect(step?.result).toStartWith("FAILED — no space: git packing ran out of space on the filesystem holding .git (");
  }
});

// Git that runs but refuses the repository (here a broken core.bare; dubious
// ownership fails the same way) must not read as "not a git repository".
test("a repository git cannot read is a FAILED step with git's message, not a skip", async () => {
  const root = tempBrain();
  initRepo(root);
  git(root, "config", "core.bare", "maybe");
  const { code, steps, git: step } = await maintain(root);
  expect(step?.result).toBe("FAILED — fatal: bad boolean config value 'maybe' for 'core.bare'");
  expect(code).toBe(2);
  expect(steps.map((s) => s.step)).toEqual(["registry", "index", "vectors", "audit", "stats", "tags", "git", "scratch"]);
});

// The cron wrapper keeps only the end of stderr, which the steps' own
// diagnostics fill. A failed run therefore ends stderr with one line naming
// the failed steps; stdout, in either mode, is the report and nothing else.
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1);
const GIT_REFUSAL = "fatal: bad boolean config value 'maybe' for 'core.bare'";

test("a failed run's last stderr line names the failed step, and stdout is only the report", async () => {
  const root = tempBrain();
  initRepo(root);
  git(root, "config", "core.bare", "maybe");
  const json = await runCli(root, ["maintain", "--json"]);
  expect(json.code).toBe(2);
  expect(lastLine(json.stderr), "MAINTAIN_NAMES_FAILED_STEP_LAST").toBe(`brain maintain: FAILED step(s): git (${GIT_REFUSAL})`);
  const steps = JSON.parse(json.stdout) as { step: string; result: string }[];
  expect(json.stdout, "MAINTAIN_JSON_STDOUT_IS_THE_REPORT").toBe(`${JSON.stringify(steps, null, 2)}\n`);

  const text = await runCli(root, ["maintain", "--human"]);
  expect(text.code).toBe(2);
  expect(lastLine(text.stderr), "MAINTAIN_TEXT_NAMES_FAILED_STEP_LAST").toBe(`brain maintain: FAILED step(s): git (${GIT_REFUSAL})`);
  expect(text.stdout.startsWith("Maintenance run:\n\n")).toBe(true);
  expect(text.stdout).toContain(`  git        FAILED — ${GIT_REFUSAL}\n`);
  expect(text.stdout).not.toContain("brain maintain:");
});

test("a successful run writes no failed-steps line", async () => {
  const root = tempBrain();
  for (const flags of [["--json"], ["--human"]]) {
    const { code, stderr } = await runCli(root, ["maintain", ...flags]);
    expect(code).toBe(0);
    expect(stderr, "MAINTAIN_SUCCESS_IS_SILENT").not.toContain("FAILED step(s)");
  }
});

test("the failed-steps line keeps every name and stays well inside the cron tail", () => {
  const steps = ["registry", "index", "vectors", "audit", "stats", "tags", "git", "scratch"];
  const report = steps.map((step) => ({ step, result: `FAILED — ${step}-cause ${"x".repeat(3_000)}\nsecond line` }));
  const line = failedStepsLine(report)!;
  expect(line.length).toBeLessThanOrEqual(1_000);
  expect(line).not.toContain("\n");
  expect(line).not.toContain("second line");
  for (const step of steps) expect(line).toContain(`${step} (${step}-cause x`);
  expect(failedStepsLine([{ step: "git", result: "ok — packed 2 loose object(s)" }, { step: "tags", result: "skipped — none" }])).toBeNull();
  expect(failedStepsLine([{ step: "git", result: `FAILED — ${"y".repeat(500)}` }])).toBe(`brain maintain: FAILED step(s): git (${"y".repeat(199)}\u2026)`);
});

// No git on PATH: nothing to pack, so the step skips and says why, and the
// rest of the run still happens.
test("a machine without git skips the step with the reason and still runs the rest", async () => {
  const root = tempBrain();
  const bin = mkdtempSync(join(tmpdir(), "brain-nogit-"));
  temps.push(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  const { code, steps, git: step } = await maintain(root, [], { PATH: bin });
  expect(step?.result).toStartWith("skipped — git could not be run");
  expect(steps.map((s) => s.step)).toEqual(["registry", "index", "vectors", "audit", "stats", "tags", "git", "scratch"]);
  expect(code).toBe(0);
});

/**
 * An empty brain with local modules whose hygiene checks each return one
 * warning, throw an Error, or throw a non-Error value. The core audit of an
 * empty brain finds nothing, so every counted issue comes from the modules.
 */
type Mode = "warn" | "throw" | "throw-null" | "throw-undefined";
function brainWithHygiene(...modes: Mode[]): string {
  const root = makeTempBrain({ empty: true });
  temps.push(root);
  const entries: string[] = [];
  modes.forEach((mode, i) => {
    const name = `hygiene-${i}`;
    mkdirSync(join(root, "modules", name), { recursive: true });
    writeFileSync(
      join(root, "modules", name, "module.ts"),
      `import { defineModule } from "@schlessera/brain";
import { z } from "zod";
export default defineModule({
  name: "${name}",
  configSchema: z.object({ mode: z.enum(["warn", "throw", "throw-null", "throw-undefined"]) }).strict(),
  setup: (config) => ({
    hygieneChecks: [
      async () => {
        if (config.mode === "throw") throw new Error("ledger unreadable");
        if (config.mode === "throw-null") throw null;
        if (config.mode === "throw-undefined") throw undefined;
        return [{ path: "ledger.md", severity: "warning", category: "stale-block", message: "generated block is stale" }];
      },
    ],
  }),
});
`
    );
    writeFileSync(join(root, "modules", name, "package.json"), JSON.stringify({ name }));
    entries.push(`"./modules/${name}": { mode: "${mode}" }`);
  });
  writeFileSync(
    join(root, "brain.config.ts"),
    `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { ${entries.join(", ")} } });
`
  );
  return root;
}

async function auditCounts(root: string) {
  const { stdout, stderr, code } = await runCli(root, ["audit", "--json"]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout) as { issues: { category: string; message: string }[]; errors: number; warnings: number; infos: number };
}

test("the audit step counts a module hygiene warning, the same number brain audit reports", async () => {
  const root = brainWithHygiene("warn");
  const { code, steps } = await maintain(root);
  expect(code).toBe(0);
  const audited = await auditCounts(root);
  expect(audited.warnings).toBe(1);
  expect(steps.find((s) => s.step === "audit")?.result).toBe("0 error(s), 1 warning(s), 0 info(s); 1 must-fix, 0 informational");
});

test("a throwing module check is one module-hygiene warning in both commands, and neither crashes", async () => {
  const root = brainWithHygiene("throw");
  const { code, steps } = await maintain(root);
  expect(code).toBe(0);
  expect(steps.find((s) => s.step === "audit")?.result).toBe("0 error(s), 1 warning(s), 0 info(s); 1 must-fix, 0 informational");

  const audited = await auditCounts(root);
  expect(audited.warnings).toBe(1);
  expect(audited.issues.map((i) => i.category)).toEqual(["module-hygiene"]);
  expect(audited.issues[0].message).toBe('hygiene check from module "hygiene-0" failed: ledger unreadable');
});

test("a module check throwing null or undefined does not stop the next module's check", async () => {
  const root = brainWithHygiene("throw-null", "throw-undefined", "warn");
  const { code, steps } = await maintain(root);
  expect(code).toBe(0);
  expect(steps.find((s) => s.step === "audit")?.result).toBe("0 error(s), 3 warning(s), 0 info(s); 3 must-fix, 0 informational");

  const audited = await auditCounts(root);
  expect(audited.issues.map((i) => i.message)).toEqual([
    'hygiene check from module "hygiene-0" failed: null',
    'hygiene check from module "hygiene-1" failed: undefined',
    "generated block is stale",
  ]);
});

test("a failed index step closes its database handle", async () => {
  const root = tempBrain();
  const brain = await initContext({ root });
  // Every handle openDatabase returns runs a statement first, and bun's
  // close() may defer releasing the file, so the handles are tracked through
  // the prototype: run() marks a handle opened, close() marks it closed.
  const opened = new Set<Database>();
  const closed = new Set<Database>();
  const { run, close } = Database.prototype;
  Database.prototype.run = function (this: Database, ...args: Parameters<typeof run>) {
    opened.add(this);
    return run.apply(this, args);
  } as typeof run;
  Database.prototype.close = function (this: Database, ...args: Parameters<typeof close>) {
    closed.add(this);
    return close.apply(this, args);
  } as typeof close;
  // A taxonomy that throws on first use makes indexAll reject after the
  // database is open.
  const taxonomy = new Proxy({}, { get: () => { throw new Error("taxonomy unavailable"); } });
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await maintainCommand.run(["--no-git"], { brain: { ...brain, taxonomy }, json: true } as never);
  } finally {
    console.log = log;
    console.error = error;
    Database.prototype.run = run;
    Database.prototype.close = close;
  }
  expect(opened.size).toBeGreaterThan(0);
  expect([...opened].filter((db) => !closed.has(db))).toHaveLength(0);
});
