/** Validate historical selection with the real discovery/balancing code; never qualify it. */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unitFiles } from "./ci-proof";
import { balanceTests } from "./test-shards";
import selection from "./hosted-observer-selection.json";

const root = resolve(import.meta.dir, "..");
function git(...args: string[]) {
  const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw Error("Diagnostic Git identity unavailable");
  return child.stdout.toString().trim();
}
const expected = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(expected ?? "") || git("rev-parse", "HEAD") !== expected ||
    process.env.GITHUB_SHA && process.env.GITHUB_SHA !== expected) throw Error("Diagnostic ref changed");
if (git("status", "--porcelain", "--untracked-files=no")) throw Error("Dirty diagnostic source");
if (git("merge-base", selection.base, "HEAD") !== selection.base) throw Error("Wrong diagnostic base");
const allowed = new Set(["scripts/browser-input-closure.ts", "scripts/build-receipt.ts", "scripts/ci-plan.ts", "scripts/ci-proof.ts", "scripts/unit-test-consumers.ts", "scripts/unit-workers.ts", "docs/decisions/ci-utility.md", ".github/workflows/ci.yml"]);
for (const path of git("diff", "--name-only", selection.base, "HEAD").split("\n").filter(Boolean)) {
  if (!allowed.has(path) && !/^scripts\/hosted-observer(?:[-.][a-z]+)*\.(?:ts|mts|mjs|json)$/.test(path)) throw Error(`Unexpected diagnostic change: ${path}`);
}
const plan = { ...selection.plan, cadence: "confirmation" as const };
const files = unitFiles(plan, root, selection.shard);
if (JSON.stringify(balanceTests(files, 2)) !== JSON.stringify(selection.partitions)) throw Error("Historical ordered partitions changed");
for (const [file, hash] of Object.entries(selection.testSha256)) {
  if (createHash("sha256").update(readFileSync(join(root, file))).digest("hex") !== hash) throw Error(`Historical testcase changed: ${file}`);
}
mkdirSync(join(root, "tmp"), { recursive: true });
writeFileSync(join(root, "tmp/hosted-observer-plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(join(root, "tmp/ci-plan.json"), JSON.stringify(plan, null, 2));
if (process.env.BRAIN_HOSTED_OBSERVER_METADATA === "1") {
  if (!process.env.GITHUB_OUTPUT) throw Error("Missing diagnostic metadata output");
  appendFileSync(process.env.GITHUB_OUTPUT, "cadence=diagnostic-observation\nunit_shards=[4]\n" +
    ["unit", "verify", "pack", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"]
      .map(name => `${name}=${name === "unit"}\n`).join(""));
}
writeFileSync(join(root, "tmp/hosted-observer-selection.json"), JSON.stringify({ kind: selection.kind,
  actual: git("show", "-s", "--format=%H %T %P", "HEAD"), source: selection.checkout, files, partitions: selection.partitions,
  sourceRun: selection.sourceRun, shard: selection.shard,
  warning: "Historical workload selection, not affected candidate proof. Aggregate remains nonpassing." }, null, 2));
console.log("Historical discovery and ordered partitions match; diagnostic only.");
