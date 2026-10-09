/** Complete affected hosted proof. Reuses the opt-in local command inventory. */
import { join, resolve } from "node:path";
import { localChecks, requireRuntimeTools } from "./check-pr";
import { runCommands, type Command } from "./ci-runner";
import type { CheckPlan } from "./ci-plan";
import { balanceTests, discoverTests } from "./test-shards";
import { resolveBrowserPin } from "./captures/provenance";

export const PROOF_JOBS = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime"] as const;
export type ProofCategory = "unit" | "browser" | "layout" | "captures" | "runtime";

/** Aggregate requires passed selected jobs; missing/false-looking output is not proof. */
export function proofProblems(needs: Record<string, { result?: string; outputs?: Record<string, string> }>): string[] {
  const problems: string[] = [];
  if (needs.changeset?.result !== "success") problems.push("metadata did not pass");
  for (const name of PROOF_JOBS) {
    const selected = needs.changeset?.outputs?.[name];
    const result = needs[name]?.result;
    if (selected !== "true" && selected !== "false") problems.push(`${name}: selection output is missing or invalid`);
    else if (selected === "true" && result !== "success") problems.push(`${name}: selected proof did not pass (${result ?? "missing"})`);
    else if (selected === "false" && result !== "skipped") problems.push(`${name}: unselected job must be intentionally skipped (${result ?? "missing"})`);
  }
  return problems;
}

/** Complete discovery expands unknown/global inputs; root tooling tests accompany package changes. */
export function unitFiles(plan: CheckPlan, root: string, shard = "1/1"): string[] {
  if (!plan.local.fullTests) throw new Error("Unit proof was not selected");
  const roots = plan.global ? ["packages", "tests"] : ["tests", ...plan.affected.map(dir => `packages/${dir}`)];
  const files = discoverTests(root, roots);
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("Expected proof --shard=M/N");
  const index = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) throw new Error("Invalid proof shard");
  return balanceTests(files, total)[index - 1]!;
}

export function categoryCommands(category: ProofCategory, plan: CheckPlan, root: string, shard?: string): Command[] {
  const inventory = localChecks(plan, true);
  if (category === "unit") return [{ name: "complete affected unit and integration suite", argv: [process.execPath, "run", "test",
    ...unitFiles(plan, root, shard).map(file => join(root, file)), "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml",
    "--timings=tmp/unit-timings.json", "--update-timings"], env: { BRAIN_REQUIRE_CHROME: "1" } }];
  const names: Record<Exclude<ProofCategory, "unit">, string[]> = {
    browser: ["workspace build for real browser checks", "complete pinned visual/accessibility/pointer suite"],
    layout: ["workspace build for real browser checks", "complete pinned layout/offline/endurance suite"],
    captures: ["editorial provenance and reproducibility"],
    runtime: ["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "shared-process Chrome then child cleanup"],
  };
  const selected = inventory.filter(command => names[category].includes(command.name));
  if (selected.length !== names[category].length) throw new Error(`${category}: incomplete command inventory`);
  if (category === "captures") selected.unshift({ name: "pinned capture fonts and original notices", argv: [process.execPath, "run", "capture:fonts"] });
  if (shard && (category === "browser" || category === "layout")) selected.at(-1)!.argv.push(`--shard=${shard}`);
  return selected;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "aggregate") {
      const problems = proofProblems(JSON.parse(process.env.PROOF_NEEDS ?? "null"));
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("All selected hosted proof passed; remaining skips are planner-intended.");
    } else {
      const root = resolve(import.meta.dir, "..");
      const category = process.argv[2] as ProofCategory;
      if (!["unit", "browser", "layout", "captures", "runtime"].includes(category)) throw new Error("Unknown proof category");
      const shard = process.argv[3]?.replace(/^--shard=/, "");
      if (process.argv.length > 4 || (process.argv[3] && !process.argv[3].startsWith("--shard="))) throw new Error("Unexpected proof argument");
      const plan = await Bun.file(process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json")).json() as CheckPlan;
      const identity = Bun.spawnSync(["git", "show", "-s", "--format=%H %T %P", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (identity.exitCode !== 0) throw new Error("Cannot record actual proof checkout");
      const [sha, tree, ...parents] = new TextDecoder().decode(identity.stdout).trim().split(" ");
      await Bun.write(join(root, "tmp/proof-checkout.json"), JSON.stringify({ category, shard,
        checkout: { sha, tree, parents }, plan, files: category === "unit" ? unitFiles(plan, root, shard) : undefined }, null, 2));
      const native = category === "unit" || category === "runtime";
      const chrome = requireRuntimeTools({ ...plan, local: { ...plan.local, fullTests: native,
        browser: !native, layout: !native, captures: !native } });
      if (chrome && category === "unit") await runCommands([{ name: "first real Chrome launch and render",
        argv: [process.execPath, "packages/ui-render-puppeteer/tests/cold-start.ts", chrome] }], root);
      const commands = categoryCommands(category, plan, root, shard).map(command => ({ ...command,
        env: { ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}), ...command.env } }));
      // The host/container lease regression deliberately uses --pull=never
      // under the offline test harness. Prepare its actual pinned image once,
      // only on the partition that discovers that test, before entering tests.
      if (category === "unit" && unitFiles(plan, root, shard).includes("tests/workspace-lease.test.ts")) {
        if (!Bun.which("docker")) throw new Error("The native workspace lease test requires Docker");
        const { image } = await resolveBrowserPin(root);
        commands.unshift({ name: "pinned offline workspace lease container prerequisite", argv: ["docker", "pull", image], env: {} });
      }
      await runCommands(commands, root, 1);
    }
  } catch (error) { console.error(error); process.exit(1); }
}
