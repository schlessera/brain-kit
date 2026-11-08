import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localChecks, newReceipt, runPreflight, settledOutcome, type PreflightStep } from "../scripts/check-pr";
import { checkCategories, coveredCategories, parseReceipt, receiptBlock, receiptFromBody, receiptRefusal, RECEIPT_END, RECEIPT_START,
  uncoveredChecks, type CheckReceipt } from "../scripts/check-receipt";
import { planChecks, workspaces } from "../scripts/ci-plan";
import type { Command } from "../scripts/ci-runner";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const head = "a".repeat(40);
const command = (name: string, script: string): Command => ({ name, argv: [process.execPath, "-e", script] });

test("a check forced past its budget is recorded timed-out and the run continues (#2940)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-receipt-")); dirs.push(dir);
  const steps: PreflightStep[] = [[command("all lint and leakage gates", "await Bun.sleep(30000)")], [command("affected fast invariants", "process.exit(0)")]];
  const saved: string[] = [];
  const receipt = await runPreflight(steps, newReceipt(steps, head, "origin/main", "focused"), { root: dir, timeoutMs: 300, save: r => saved.push(JSON.stringify(r)) });
  expect(receipt.checks.map(c => [c.name, c.outcome])).toEqual([["all lint and leakage gates", "timed-out"], ["affected fast invariants", "passed"]]);
  expect(receipt.checks[0]!.reason).toContain("300 ms check budget");
  expect(receipt.finishedAt).not.toBeNull();
  // Saved while running: a killed check:pr leaves the started check reading as timed out.
  expect(saved.some(text => text.includes("started; check:pr ended before it finished"))).toBe(true);
});

test("outcomes: preempted is neither passed nor failed, a failure skips the rest, --skip is recorded", async () => {
  expect(settledOutcome({ exitCode: 75, signal: null, elapsedMs: 1, timedOut: false, stopped: false }, undefined).outcome).toBe("preempted");
  expect(settledOutcome({ exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, stopped: false }, undefined).outcome).toBe("passed");
  expect(settledOutcome({ exitCode: null, signal: "SIGTERM", elapsedMs: 1, timedOut: false, stopped: true }, undefined).outcome).toBe("skipped");
  expect(settledOutcome({ exitCode: 1, signal: null, elapsedMs: 1, timedOut: false, stopped: false }, undefined).outcome).toBe("failed");
  const dir = mkdtempSync(join(tmpdir(), "odysseus-receipt-")); dirs.push(dir);
  const steps: PreflightStep[] = [[command("environment documentation", "process.exit(75)")], [command("strict typecheck", "process.exit(0)")],
    [command("contribution changeset", "process.exit(3)")], [command("affected fast invariants", "process.exit(0)")]];
  const receipt = newReceipt(steps, head, "origin/main", "focused");
  await expect(runPreflight(steps, receipt, { root: dir, skip: new Set(["strict typecheck"]), save: () => {} })).rejects.toThrow("contribution changeset failed");
  expect(receipt.checks.map(c => c.outcome)).toEqual(["preempted", "skipped", "failed", "skipped"]);
  expect(receipt.checks[1]!.reason).toBe("skipped with --skip");
  expect(receipt.checks[3]!.reason).toBe("not run after contribution changeset failed");
  expect(parseReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
});

test("every selected local check maps to a hosted category", () => {
  const root = resolve(import.meta.dir, "..");
  const plan = planChecks(["package.json"], workspaces(root), root);
  const names = [...localChecks(plan, true), ...localChecks(plan, false, "b".repeat(40), true)].map(c => c.name)
    .concat(["contribution changeset", "first real Chrome launch and render", "pinned capture fonts and original notices", "packed consumer checks",
      "complete pinned visual/accessibility/pointer suite", "complete pinned layout/offline suite", "complete pinned endurance suite", "editorial provenance and reproducibility"]);
  for (const name of names) expect(checkCategories(name).length, name).toBeGreaterThan(0);
  expect(checkCategories("an unknown future check")).toEqual([]);
});

function receipt(checks: CheckReceipt["checks"]): CheckReceipt {
  return { version: 1, kind: "brain-check-pr-receipt", head, base: "origin/main", mode: "focused", startedAt: "2026-07-12T00:00:00.000Z", finishedAt: "2026-07-12T00:05:00.000Z", checks };
}

test("the PR body carries one receipt; missing, empty markers and duplicates are explicit", () => {
  const r = receipt([{ name: "strict typecheck", categories: ["verify"], outcome: "passed" }]);
  const body = `## Proof\n\n${receiptBlock(r)}\n`;
  expect(receiptFromBody(body)).toEqual(r);
  expect(receiptFromBody(body.replace(/\n/g, "\r\n"))).toEqual(r);
  expect(receiptFromBody(null)).toBeNull();
  expect(receiptFromBody(`${RECEIPT_START}\n${RECEIPT_END}`)).toBeNull();
  expect(() => receiptFromBody(body + body)).toThrow("more than one");
  expect(() => receiptFromBody(`${RECEIPT_START}\n\`\`\`json\n{"version":2}\n\`\`\`\n${RECEIPT_END}`)).toThrow("Invalid check:pr receipt");
  expect(receiptRefusal("no receipt here", new Set())).toContain("No check:pr receipt");
});

test("merge refusal names skipped, timed-out and preempted checks whose hosted category did not run", () => {
  const selected = { selections: { verify: "true", browser: "true", layout: "true", unit: "false" }, results: { verify: "success", browser: "skipped", layout: "skipped" }, retained: ["layout"] };
  const covered = coveredCategories(selected);
  expect([...covered].sort()).toEqual(["changeset", "layout", "verify"]);
  const r = receipt([
    { name: "strict typecheck", categories: ["verify"], outcome: "timed-out" },
    { name: "complete pinned visual/accessibility/pointer suite", categories: ["browser"], outcome: "skipped" },
    { name: "complete unit and integration suite", categories: ["unit"], outcome: "preempted" },
    { name: "complete pinned layout/offline suite", categories: ["layout"], outcome: "skipped" },
    { name: "environment documentation", categories: ["changeset"], outcome: "failed" },
  ]);
  expect(uncoveredChecks(r, covered).map(c => c.name)).toEqual(["complete pinned visual/accessibility/pointer suite", "complete unit and integration suite"]);
  const refusal = receiptRefusal(receiptBlock(r), covered)!;
  expect(refusal).toContain("complete pinned visual/accessibility/pointer suite (skipped; needs browser)");
  expect(refusal).toContain("complete unit and integration suite (preempted; needs unit)");
  expect(receiptRefusal(receiptBlock(receipt([{ name: "strict typecheck", categories: ["verify"], outcome: "skipped" }])), covered)).toBeNull();
});

test("check:pr CLI writes a receipt recording a forced timeout and prints the PR block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-check-pr-cli-")); dirs.push(dir);
  const owner = resolve(import.meta.dir, ".."), entry = join(dir, "scripts/check-pr.ts");
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "packages/ithaca"), { recursive: true });
  cpSync(join(owner, "scripts/check-pr.ts"), entry);
  for (const helper of ["ci-plan", "ci-runner", "check-packages", "check-receipt", "test-shards", "test", "unit-workers"]) writeFileSync(join(dir, `scripts/${helper}.ts`), `export * from ${JSON.stringify(join(owner, `scripts/${helper}.ts`))};\n`);
  writeFileSync(join(dir, "scripts/host-admission.mjs"), `export * from ${JSON.stringify(join(owner, "scripts/host-admission.mjs"))};\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
  writeFileSync(join(dir, "packages/ithaca/package.json"), JSON.stringify({ name: "@odysseus/ithaca" }));
  writeFileSync(join(dir, ".gitignore"), "tmp/\n");
  // Only the checks' own commands are replaced: the lint gate hangs, everything else passes.
  const preload = join(dir, "odysseus-slow-lint.ts");
  writeFileSync(preload, `const sync=Bun.spawnSync, spawn=Bun.spawn;
    Bun.spawnSync=((argv,options)=>{const c=Array.isArray(argv)?argv:argv.cmd;if(c[0]==="bwrap")return {exitCode:0,exitedDueToTimeout:false,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};return sync(argv,options);});
    Bun.spawn=((argv,options)=>spawn(argv.includes("lint")?[process.execPath,"-e","await Bun.sleep(30000)"]:[process.execPath,"-e","process.exit(0)"],options));`);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", ...args], { cwd: dir, stdout: "pipe" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
  const base = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
  writeFileSync(join(dir, "packages/ithaca/README.md"), "The return to Ithaca.\n");
  const child = Bun.spawn([process.execPath, "--preload", preload, entry, "--base", base, "--check-timeout=1"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const path = join(dir, "tmp/check-pr-receipt.json");
  expect(existsSync(path), `CHECK_PR_WRITES_RECEIPT: ${err}`).toBe(true);
  const written = parseReceipt(JSON.parse(readFileSync(path, "utf8")));
  expect(written.head).toBe(base);
  expect(written.checks.find(c => c.name === "all lint and leakage gates")?.outcome, "FORCED_TIMEOUT_RECORDED").toBe("timed-out");
  expect(written.checks.filter(c => c.name !== "all lint and leakage gates").every(c => c.outcome === "passed")).toBe(true);
  expect(code, err).toBe(0);
  expect(err).toContain("Local preflight incomplete");
  expect(receiptFromBody(out)).toEqual(written);
});
