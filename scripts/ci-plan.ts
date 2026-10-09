/** Repository-only check selection. Product CLI/MCP contracts are unaffected. */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Workspace {
  dir: string;
  name: string;
  dependencies: string[];
  files: string[];
}

// Focused local feedback and cheap CI use this inventory. Complete affected
// suites discover every test in hosted proof; this list is not a proof allowlist.
// These suites exercise contracts, data integrity and permission boundaries
// without real browsers, installed model runtimes or real-time deadline waits.
export const FAST_TESTS: Readonly<Record<string, readonly string[]>> = {
  tooling: [
    "tests/ci-plan.test.ts", "tests/ci-runner.test.ts",
    "tests/local-checks.test.ts", "tests/hosted-proof.test.ts", "tests/browser-shards.test.ts",
    "tests/measurement-fixture-lifetime.test.ts", // 0.13s owner/exit regression (#1330).
    "tests/ci-workflows.test.ts", "tests/release-manifest.test.ts",
    "tests/lockfile.test.ts",
    "tests/changeset-gate.test.ts", "tests/contract-gate.test.ts",
    "tests/decision-citations.test.ts", "tests/dependency-edges.test.ts",
    "tests/frontmatter-parse-sync.test.ts",
  ],
  contract: ["tests/api-surface.test.ts", "tests/dependency-edges.test.ts", "tests/decision-citations.test.ts"],
  core: [
    "packages/core/tests/frontmatter-parse.test.ts",
    "packages/core/tests/frontmatter.test.ts",
    "packages/core/tests/indexer-reliability.test.ts",
    "packages/core/tests/eval-corpus.test.ts",
    "packages/core/tests/cli-contract.test.ts",
  ],
  "ui-sdk": [
    "packages/ui-sdk/tests/schemas.test.ts",
    "packages/ui-sdk/tests/tool-contracts.test.ts",
    "packages/ui-sdk/tests/permission-gate.test.ts",
    "packages/ui-sdk/tests/inbox-schemas.test.ts",
  ],
  "ui-server": [
    "packages/ui-server/tests/auth.test.ts",
    "packages/ui-server/tests/http-principal-boundaries.test.ts",
    "packages/ui-server/tests/session-cookie.test.ts",
  ],
  "ui-backend-claude": [
    "packages/ui-backend-claude/tests/characterization-permissions.test.ts",
    "packages/ui-backend-claude/tests/measured-runtime.test.ts",
  ],
  "ui-backend-pi": ["packages/ui-backend-pi/tests/tools-permission.test.ts"],
  "ui-react": [
    "packages/ui-react/tests/session-demux.test.ts",
    "packages/ui-react/tests/root-isolation.test.ts",
    "packages/ui-react/tests/follow-up-queue.test.ts",
    "packages/ui-react/tests/frontmatter.test.ts",
  ],
  "render-template": ["packages/render-template/tests/link-policy.test.ts"],
  "module-images": ["packages/module-images/tests/routing.test.ts"],
  "module-video": ["packages/module-video/tests/module.test.ts"],
  "module-speaking": ["packages/module-speaking/tests/module.test.ts"],
  "module-jobs": ["packages/module-jobs/tests/jobs-dedup.test.ts"],
  "module-travel": ["packages/module-travel/tests/foundation.test.ts"],
};

export interface CheckPlan {
  changed: string[];
  affected: string[];
  global: boolean;
  typecheck: boolean;
  tests: string[];
  pack: boolean;
  // Complete proof categories, shared by hosted CI and opt-in full local checks.
  local: { fullTests: boolean; browser: boolean; layout: boolean; captures: boolean; runtime: boolean };
}

export function workspaces(root: string): Workspace[] {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
    .map(entry => {
      const manifest = JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8"));
      return { dir: entry.name, name: manifest.name,
        dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies,
          ...manifest.peerDependencies, ...manifest.optionalDependencies }),
        files: manifest.files ?? [] };
    });
}

/** Reverse dependency closure includes peers, optional deps and test/dev deps. */
export function affectedWorkspaces(changed: readonly string[], packages: readonly Workspace[]): string[] {
  const selected = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    const names = new Set(packages.filter(p => selected.has(p.dir)).map(p => p.name));
    for (const pkg of packages) {
      if (!selected.has(pkg.dir) && pkg.dependencies.some(name => names.has(name))) {
        selected.add(pkg.dir);
        expanded = true;
      }
    }
  }
  return [...selected].sort();
}

export function planChecks(changed: readonly string[], packages: readonly Workspace[]): CheckPlan {
  const dirs = new Set(packages.map(p => p.dir));
  const packagePaths = changed.filter(path => path.startsWith("packages/"));
  const direct = packagePaths.map(path => path.split("/")[1]!);
  // Unknown roots fail open to checking, not to skipping. Ordinary prose,
  // examples and changeset entries need metadata/lint checks only.
  const prose = (path: string) => /\.(md|mdx|txt)$/.test(path) ||
    path.startsWith(".changeset/") || path.startsWith("docs/") ||
    path.startsWith(".github/ISSUE_TEMPLATE/") || path === "LICENSE";
  const global = changed.some(path =>
    path === "bun.lock" || path === "package.json" || path === ".changeset/config.json" ||
    (!path.startsWith("packages/") && !path.startsWith("template/") &&
      !path.startsWith("api-report/") && !prose(path))) || direct.some(dir => !dirs.has(dir));
  const affected = global ? [...dirs].sort() : affectedWorkspaces(direct, packages);
  // Fixture Markdown and shipped skills are behavioral inputs too; only
  // package prose outside those domains can avoid the affected checks.
  const packageCode = packagePaths.some(path => !/\.(md|mdx|txt)$/.test(path) ||
    /^packages\/[^/]+\/(src|fixtures|tests|skills|migrations|assets)\//.test(path));
  const typedInputs = packagePaths.some(path => /\.(?:[cm]?[jt]sx?|json|toml)$/.test(path));
  const tooling = global || changed.some(path => path.startsWith("api-report/") || path.startsWith("template/") || path.startsWith("docs/decisions/"));
  const contract = global || packagePaths.some(path => /^packages\/[^/]+\/(src\/|package\.json$)/.test(path)) ||
    changed.some(path => path.startsWith("api-report/"));
  const groups = [...(tooling ? ["tooling"] : []), ...(contract ? ["contract"] : []), ...(packageCode || global ? affected : [])];
  const tests = [...new Set(groups.flatMap(group => FAST_TESTS[group] ?? []))].sort();
  const ships = packagePaths.some(path => {
    const [, dir, ...rest] = path.split("/");
    const relative = rest.join("/");
    const pkg = packages.find(p => p.dir === dir);
    return !pkg || relative === "package.json" || relative === "LICENSE" ||
      pkg.files.some(file => relative === file.replace(/\/$/, "") || relative.startsWith(file.replace(/\/$/, "") + "/"));
  });
  const ui = affected.some(dir => ["ui-sdk", "ui-kit", "ui-react", "ui-server", "render-template", "geo"].includes(dir));
  const captureInputs = changed.some(path => path === "docs/process/feature-captures.md" || path.startsWith("scripts/capture") || path.startsWith("scripts/captures/"));
  return { changed: [...changed].sort(), affected, global,
    typecheck: global || typedInputs || changed.some(path => path.startsWith("template/") && /\.[cm]?[jt]sx?$/.test(path)),
    tests, pack: global || ships,
    local: { fullTests: global || packageCode || changed.some(path => path.startsWith("template/") && !prose(path)), browser: (global || packageCode) && ui,
      layout: (global || packageCode) && ui, captures: captureInputs || ((global || packageCode) && ui),
      runtime: global || (packageCode && affected.some(dir => ["ui-backend-claude", "ui-backend-pi", "ui-server", "ui-render-puppeteer", "scrape", "core", "ui-react"].includes(dir))) } };
}

/** Explicit false outputs distinguish intentional exclusions from missing proof. */
export function proofSelections(plan: CheckPlan, draft = false): Record<string, boolean> {
  return Object.fromEntries(Object.entries({
    verify: plan.typecheck || (!plan.local.fullTests && plan.tests.length > 0), pack: plan.pack,
    unit: plan.local.fullTests, browser: plan.local.browser, layout: plan.local.layout,
    captures: plan.local.captures, runtime: plan.local.runtime,
  }).map(([name, selected]) => [name, !draft && selected]));
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Cannot determine changed files: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout);
}

/** --no-renames includes BOTH sides of a rename; NUL delimiters retain spaces. */
export function changedFiles(root: string, base: string, head = "HEAD", mergeBase = true, working = false): string[] {
  if (!base || /^0+$/.test(base)) throw new Error("A reachable, nonzero diff base is required");
  const from = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const to = git(root, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const start = mergeBase ? git(root, ["merge-base", from, to]).trim() : from;
  const paths = git(root, ["diff", "--name-only", "--no-renames", "-z", start, to, "--"]).split("\0").filter(Boolean);
  if (working) {
    paths.push(...git(root, ["diff", "--name-only", "--no-renames", "-z", to, "--"]).split("\0").filter(Boolean));
    paths.push(...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  }
  return [...new Set(paths)].sort();
}

export function planFromEnvironment(root: string, env: NodeJS.ProcessEnv): CheckPlan {
  if (["api", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return planChecks(["package.json"], workspaces(root));
  const pr = env.GITHUB_EVENT_NAME === "pull_request";
  const base = pr ? env.BASE_SHA : env.BEFORE_SHA;
  if (!base || !env.HEAD_SHA) throw new Error("CI requires BASE_SHA/BEFORE_SHA and HEAD_SHA");
  return planChecks(changedFiles(root, base, env.HEAD_SHA, pr), workspaces(root));
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const plan = planFromEnvironment(root, process.env);
    const path = process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json");
    await Bun.write(path, JSON.stringify(plan, null, 2) + "\n");
    const draft = process.env.PR_DRAFT === "true";
    const selections = proofSelections(plan, draft);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(selections).map(([name, selected]) => `${name}=${selected}\n`).join(""));
    console.log(JSON.stringify({ ...plan, draft }, null, 2));
  } catch (error) { console.error(error); process.exit(1); }
}
