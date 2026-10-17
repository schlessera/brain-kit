/** Internal Vitest receipt. Keep project identity and skipped cases, unlike list --json. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = (path) => relative(root, path).replaceAll("\\", "/");
const spec = (value) => ({ project: value.project.name.replace(/ \((?:chromium|webkit)\)$/, ""), file: file(value.moduleId) });
const checkout = () => {
  // The outer visual wrapper captures/rechecks host identity for mounted
  // worktrees. Direct Node runs can read their own repository instead.
  if (process.env.BRAIN_PROOF_CASE_CHECKOUT) {
    const value = JSON.parse(process.env.BRAIN_PROOF_CASE_CHECKOUT);
    if (![value.sha, value.tree, ...value.parents].every(item => typeof item === "string" && /^[a-f0-9]{40}$/.test(item))) throw new Error("Invalid transported case checkout");
    return value;
  }
  const [sha, tree, ...parents] = execFileSync("git", ["show", "-s", "--format=%H %T %P", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(" ");
  return { sha, tree, parents };
};

/** A complete report is evidence to reconcile, never a replacement for runner exit status. */
export function caseReportProblems(report, selection, expectedCheckout) {
  const problems = [];
  // Vitest emits onTestRunStart before the sequencer applies --shard. Keep
  // that requested domain separate from independently expected execution.
  const input = Array.isArray(selection) ? { version: 1, requested: selection, executed: selection } : selection;
  if (input?.version !== 1) return ["unknown independent case-report selection version"];
  const key = (value) => `${value.project}::${value.file}`;
  for (const name of ["requested", "executed"]) {
    const specs = input[name];
    if (!Array.isArray(specs) || !specs.length || specs.some(spec => !spec ||
        typeof spec.project !== "string" || !spec.project.trim() || typeof spec.file !== "string" || !spec.file.trim())) {
      problems.push(`missing or invalid independent ${name} case-report selection`);
    } else if (new Set(specs.map(key)).size !== specs.length) problems.push(`duplicate independent ${name} case-report selection`);
  }
  if (problems.length) return problems;
  const requested = input.requested.map(key).sort(), executed = input.executed.map(key).sort();
  if (executed.some(key => !requested.includes(key))) problems.push("executed case-report selection is outside requested domain");
  if (report.version !== 1 || JSON.stringify(report.checkout) !== JSON.stringify(expectedCheckout)) problems.push("stale or unknown case-report identity");
  if (report.reason !== "passed" || report.unhandledErrors.length) problems.push("case run did not finish successfully");
  for (const [name, rows, expected] of [["selected", report.selected, requested], ["collected", report.collected, executed], ["reported", report.modules, executed]]) {
    const actual = rows.map(key).sort();
    if (new Set(actual).size !== actual.length) problems.push(`duplicate ${name} case-report ownership`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`omitted or unexpected ${name} case-report ownership`);
  }
  const ids = new Set();
  for (const module of report.modules) {
    if (module.state !== "passed" || module.errors.length || !module.cases.length) problems.push(`incomplete module: ${key(module)}`);
    const collected = report.collected.find(value => key(value) === key(module));
    const identities = cases => cases.map(test => `${test.id}::${test.name}`).sort();
    if (!collected || JSON.stringify(identities(collected.cases)) !== JSON.stringify(identities(module.cases))) problems.push(`omitted or unexpected reported case: ${key(module)}`);
    for (const test of module.cases) {
      const id = `${key(module)}::${test.id}`;
      if (ids.has(id)) problems.push(`duplicate collected case: ${id}`);
      ids.add(id);
      if (test.state !== "passed") problems.push(`unproven case (${test.state}): ${key(module)}::${test.name}`);
    }
  }
  return problems;
}

export default class ProofCaseReporter {
  constructor(options = {}) { this.output = options.output ?? resolve(root, "tmp/proof-cases.json"); }
  onTestRunStart(specifications) {
    this.identity = checkout();
    this.selected = specifications.map(spec);
    this.collected = [];
  }
  onTestModuleCollected(module) {
    this.collected.push({ ...spec(module), cases: [...module.children.allTests()].map(test => ({ id: test.id, name: test.fullName })) });
  }
  onTestRunEnd(modules, errors, reason) {
    const report = {
      version: 1, checkout: this.identity,
      run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, job: process.env.GITHUB_JOB ?? null },
      selected: this.selected, collected: this.collected, reason,
      unhandledErrors: errors.map(error => ({ name: error.name, message: error.message })),
      modules: modules.map(module => ({ ...spec(module), state: module.state(),
        errors: module.errors().map(error => ({ name: error.name, message: error.message })),
        cases: [...module.children.allTests()].map(test => ({ id: test.id, name: test.fullName,
          state: test.result().state, location: test.location ?? null,
          durationMs: test.diagnostic()?.duration ?? null })),
      })),
    };
    mkdirSync(dirname(this.output), { recursive: true });
    writeFileSync(this.output, JSON.stringify(report, null, 2) + "\n");
    if (JSON.stringify(checkout()) !== JSON.stringify(this.identity)) throw new Error("Checkout changed during case reporting");
  }
}

// Explicit evidence reconciliation; never invoked by the candidate aggregate.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== "--check") throw new Error("usage: node scripts/proof-case-report.mjs --check <report.json> <selected-specs.json> <checkout.json>");
    const read = path => JSON.parse(readFileSync(path, "utf8"));
    const problems = caseReportProblems(read(process.argv[3]), read(process.argv[4]), read(process.argv[5]).checkout);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log("Selected browser case receipt reconciled; runner and aggregate outcomes remain separately required.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
