/**
 * `brain maintain`'s git step: git's non-destructive maintenance tasks pack
 * loose objects in a brain that is a git work tree, and nothing under refs/
 * is removed.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
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

test("runs the git step between the tag report and the scratch prune", async () => {
  const root = tempBrain();
  const { steps } = await maintain(root);
  expect(steps.map((s) => s.step)).toEqual(["index", "vectors", "audit", "tags", "git", "scratch"]);
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

// A read-only pack directory makes git's own pack-objects fail. Root writes
// through the mode, so this cannot be staged there.
test.skipIf(process.getuid?.() === 0)("a git failure is a FAILED step with git's message, and exit 2", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 2);
  const pack = join(root, ".git", "objects", "pack");
  chmodSync(pack, 0o555);
  try {
    const { code, git: step } = await maintain(root);
    expect(step?.result).toStartWith("FAILED — fatal: Unable to create temporary file");
    expect(code).toBe(2);
  } finally {
    chmodSync(pack, 0o755);
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
  expect(steps.map((s) => s.step)).toEqual(["index", "vectors", "audit", "tags", "git", "scratch"]);
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
  expect(steps.map((s) => s.step)).toEqual(["index", "vectors", "audit", "tags", "git", "scratch"]);
  expect(code).toBe(0);
});

/**
 * An empty brain whose one local module has a hygiene check that either
 * returns one warning or throws. The core audit of an empty brain finds
 * nothing, so every counted issue comes from the module.
 */
function brainWithHygiene(mode: "warn" | "throw"): string {
  const root = makeTempBrain({ empty: true });
  temps.push(root);
  mkdirSync(join(root, "modules", "hygiene"), { recursive: true });
  writeFileSync(
    join(root, "modules", "hygiene", "module.ts"),
    `import { defineModule } from "@schlessera/brain";
import { z } from "zod";
export default defineModule({
  name: "hygiene",
  configSchema: z.object({ mode: z.enum(["warn", "throw"]) }).strict(),
  setup: (config) => ({
    hygieneChecks: [
      async () => {
        if (config.mode === "throw") throw new Error("ledger unreadable");
        return [{ path: "ledger.md", severity: "warning", category: "stale-block", message: "generated block is stale" }];
      },
    ],
  }),
});
`
  );
  writeFileSync(join(root, "modules", "hygiene", "package.json"), JSON.stringify({ name: "hygiene" }));
  writeFileSync(
    join(root, "brain.config.ts"),
    `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { "./modules/hygiene": { mode: "${mode}" } } });
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
  expect(steps.find((s) => s.step === "audit")?.result).toBe("0 error(s), 1 warning(s), 0 info(s)");
});

test("a throwing module check is one module-hygiene warning in both commands, and neither crashes", async () => {
  const root = brainWithHygiene("throw");
  const { code, steps } = await maintain(root);
  expect(code).toBe(0);
  expect(steps.find((s) => s.step === "audit")?.result).toBe("0 error(s), 1 warning(s), 0 info(s)");

  const audited = await auditCounts(root);
  expect(audited.warnings).toBe(1);
  expect(audited.issues.map((i) => i.category)).toEqual(["module-hygiene"]);
  expect(audited.issues[0].message).toBe('hygiene check from module "hygiene" failed: ledger unreadable');
});
