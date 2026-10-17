/** Repository-only check selection. Product CLI/MCP contracts are unaffected. */
import { appendFileSync, existsSync, readFileSync, readdirSync, readlinkSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { closureSelects, discoverBrowserClosures, type BrowserClosures } from "./browser-input-closure";

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
    "tests/ci-plan.test.ts", "tests/ci-runner.test.ts", "tests/browser-input-closure.test.ts",
    "tests/diagram-export-source.test.ts", // 0.3s tracked native-producer source controls.
    "tests/diagram-export-installation.test.ts", // 0.03s finite installed input controls.
    "tests/local-checks.test.ts", "tests/hosted-proof.test.ts", "tests/browser-shards.test.ts",
    "tests/candidate-proof.test.ts", "tests/proof-inventory.test.ts",
    "tests/proof-reuse.test.ts", // 4.47s immutable source/input ownership controls (#1333).
    "tests/measurement-fixture-lifetime.test.ts", // 0.13s owner/exit regression (#1330).
    "tests/ci-workflows.test.ts", "tests/release-manifest.test.ts", "tests/ci-pack.test.ts",
    "tests/lockfile.test.ts",
    "tests/changeset-gate.test.ts", "tests/contract-gate.test.ts",
    "tests/decision-citations.test.ts", "tests/dependency-edges.test.ts",
    "tests/frontmatter-parse-gate.test.ts",
  ],
  contract: ["tests/api-surface.test.ts", "tests/dependency-edges.test.ts", "tests/decision-citations.test.ts"],
  common: ["packages/common/tests/frontmatter-parse.test.ts"],
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
  cadence?: ProofCadence;
  typecheck: boolean;
  tests: string[];
  pack: boolean;
  /** Root consumer and independent-test plans execute this exact discovered inventory. */
  unitTests?: string[];
  // Complete proof categories, shared by hosted CI and opt-in full local checks.
  local: { fullTests: boolean; browser: boolean; layout: boolean; captures: boolean; runtime: boolean; endurance: boolean };
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

/** Reviewed non-package consumers. Overlapping rules must agree, otherwise global. */
export const ROOT_CONSUMERS = [
  { prefix: "scripts/captures/", categories: ["captures"] },
  { prefix: "scripts/capture", categories: ["captures"] },
  { prefix: "scripts/native-proof/", categories: ["runtime"] },
  { prefix: "scripts/prove-native-host.ts", categories: ["runtime"] },
  { prefix: "scripts/prove-worker-identity.ts", categories: ["runtime"] },
  { prefix: "scripts/visual.mjs", categories: ["browser", "layout", "endurance"] },
  { prefix: "scripts/browser-shards.ts", categories: ["browser", "layout", "endurance"] },
  { prefix: "scripts/browser-shard-costs.json", categories: ["browser", "layout", "endurance"] },
  { prefix: "scripts/ci-", categories: [] },
  { prefix: "scripts/proof-", categories: [] },
  { prefix: "scripts/candidate-proof.ts", categories: [] },
  { prefix: "website/", categories: [] },
] as const;
type RootCategory = "browser" | "layout" | "endurance" | "captures" | "runtime";
interface ConsumerSelection { tests: string[]; categories: Set<RootCategory>; global: boolean; reason?: string; }
/** Conservative reverse string/import closure, including helpers and symlink targets.
 * Any unreadable tracked input or escaping link invalidates the entire scan.
 */
export function rootConsumers(root: string, changed: readonly string[],
  rules: readonly { prefix: string; categories: readonly RootCategory[] }[] = ROOT_CONSUMERS): ConsumerSelection {
  const categories = new Set<RootCategory>(), selected = new Set<string>();
  try {
    const paths = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
    // Include local, not-yet-added inputs in local preflight as well.
    paths.push(...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
    const texts = new Map<string, string>();
    for (const path of new Set(paths)) {
      const full = join(root, path), stat = lstatSync(full);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Unknown consumer input");
      const target = realpathSync(full);
      if (relative(root, target).startsWith("..") || !relative(root, target)) throw new Error("Escaping consumer input");
      // Permission bits are checked too: root can otherwise read chmod(000) files.
      if (!(lstatSync(target).mode & 0o444)) throw new Error("Unreadable consumer input");
      const text = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full, "utf8");
      texts.set(path, text.includes("\0") ? "" : text);
    }
    // Index path/name tokens once; extensionless imports and basename/string
    // references deliberately overinclude colliding names rather than omit them.
    const references = new Map<string, Set<string>>();
    const imports = new Map<string, Set<string>>();
    for (const [path, text] of texts) {
      for (const literal of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
        const name = basename(literal[1]!);
        const owners = imports.get(name) ?? new Set<string>(); owners.add(path); imports.set(name, owners);
      }
      for (const token of text.matchAll(/[A-Za-z0-9_@.-]+/g)) {
        const key = token[0].replace(/^[.]+|[.]+$/g, "");
        if (!key) continue;
        const owners = references.get(key) ?? new Set<string>(); owners.add(path); references.set(key, owners);
      }
    }
    for (const input of changed) {
      if (!texts.has(input)) throw new Error(`Missing changed consumer input: ${input}`);
      const matches = rules.filter(rule => input.startsWith(rule.prefix));
      if (new Set(matches.map(rule => JSON.stringify([...rule.categories].sort()))).size > 1) throw new Error("Conflicting consumers");
      for (const rule of matches) for (const category of rule.categories) categories.add(category);
      const closure = new Set([input]);
      const pending = [input];
      for (let index = 0; index < pending.length; index++) {
        const dependency = pending[index]!;
        // Test consumers are execution leaves. Referencing a test inventory
        // from a runner/config does not make that runner a consumer of its code.
        if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(dependency) && !/(?:\bmodule\.exports\b|\bexports\.|\bexport\s+(?:\{|\*|(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)|default))/m.test(texts.get(dependency) ?? "")) continue;
        const name = basename(dependency);
        if (!/^[A-Za-z0-9_@.-]+$/.test(name)) throw new Error(`Unknown reference spelling: ${dependency}`);
        const owners = new Set([...(references.get(name) ?? []), ...(imports.get(name.replace(/\.[^. /]+$/, "")) ?? [])]);
        for (const path of owners) {
          if (closure.has(path)) continue;
          closure.add(path); pending.push(path);
        }
      }
      // A root input used by shipped package code has no reviewed narrow
      // category ownership here; keep complete proof instead of guessing it.
      const shipped = [...closure].find(path => /^packages\/[^/]+\/(?:src|assets|skills|migrations)\//.test(path));
      if (shipped) throw new Error(`Unmapped shipped consumer: ${input} → ${shipped}`);
      for (const path of closure) {
        const owners = rules.filter(rule => path.startsWith(rule.prefix));
        if (new Set(owners.map(rule => JSON.stringify([...rule.categories].sort()))).size > 1) throw new Error("Conflicting consumers");
        for (const rule of owners) for (const category of rule.categories) categories.add(category);
      }
      const consumers = [...closure].filter(path => /^(?:tests\/|packages\/).*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));
      // A known category or a real test consumer is required, never an empty skip.
      if (!matches.length && !consumers.length) throw new Error(`Unmapped consumer input: ${input}`);
      for (const test of consumers) selected.add(test);
    }
    return { tests: [...selected].sort(), categories, global: false };
  } catch (error) { return { tests: [], categories, global: true, reason: String(error) }; }
}

/** Fail closed to ordinary affected discovery unless every changed input is an
 * independent Bun test. Text references deliberately include prose and strings;
 * basename matching catches relative imports and extensionless command names.
 */
export function independentTests(root: string, changed: readonly string[]): string[] | undefined {
  const prose = (path: string) => /\.(md|mdx|txt)$/.test(path) || path === "LICENSE";
  const candidates = changed.filter(path => !prose(path) || path.startsWith("tests/") || /^packages\/[^/]+\/(src|fixtures|tests|skills|migrations|assets)\//.test(path));
  if (!candidates.length || candidates.some(path => !(/^(?:packages\/[^/]+\/|tests\/)/.test(path)) || path.split("/").slice(0, -1).some(part => part.startsWith(".") || part.toLowerCase() === "node_modules") ||
    !/(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path))) return undefined;
  try {
    const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
    // Expanded build inventories catch glob includes/extends without literal
    // basename references. Tests emitted as package code are not independent.
    for (const configPath of tracked.filter(path => /^packages\/[^/]+\/tsconfig\.build\.json$/.test(path))) {
      const path = join(root, configPath);
      const config = ts.readConfigFile(path, ts.sys.readFile);
      if (config.error) return undefined;
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path));
      if (parsed.errors.length || parsed.fileNames.some(path => candidates.includes(relative(root, path).replaceAll("\\", "/")))) return undefined;
    }
    for (const file of candidates) {
      if (!tracked.includes(file) || !lstatSync(join(root, file)).isFile() || /\bexport\b/.test(readFileSync(join(root, file), "utf8"))) return undefined;
      const stem = basename(file).replace(/\.[^.]+$/, "");
      // Any other tracked file can consume this input, including another changed
      // test. Unreadable/deleted paths and unknown modes refuse the optimization.
      for (const other of tracked) if (other !== file && (lstatSync(join(root, other)).isSymbolicLink() ? readlinkSync(join(root, other)) : readFileSync(join(root, other), "utf8")).includes(stem)) return undefined;
    }
    return candidates.sort();
  } catch { return undefined; }
}

export function planChecks(changed: readonly string[], packages: readonly Workspace[], root = resolve(import.meta.dir, ".."), enableConsumerSelection = true): CheckPlan {
  const leaves = root && enableConsumerSelection ? independentTests(root, changed) : undefined;
  if (leaves) {
    const affected = [...new Set(leaves.filter(file => file.startsWith("packages/")).map(file => file.split("/")[1]!))].sort();
    if (affected.every(dir => packages.some(pkg => pkg.dir === dir))) {
      const groups = [...affected, ...(leaves.some(file => file.startsWith("tests/")) ? ["tooling"] : [])];
      const tests = [...new Set(groups.flatMap(dir => FAST_TESTS[dir] ?? []))].sort();
      return { changed: [...changed].sort(), affected, global: false, typecheck: true,
        tests, unitTests: [...new Set([...leaves, ...tests])].sort(), pack: false,
        local: {fullTests: true, browser: false, layout: false, captures: false, runtime: false, endurance: false} };
    }
  }
  const dirs = new Set(packages.map(p => p.dir));
  const packagePaths = changed.filter(path => path.startsWith("packages/"));
  const direct = packagePaths.map(path => path.split("/")[1]!);
  // Unknown roots fail open to checking, not to skipping. Ordinary prose,
  // examples and changeset entries need metadata/lint checks only.
  const prose = (path: string) => /\.(md|mdx|txt)$/.test(path) ||
    path.startsWith(".changeset/") || path.startsWith("docs/") ||
    path.startsWith(".github/ISSUE_TEMPLATE/") || path === "LICENSE";
  const rootPaths = enableConsumerSelection ? changed.filter(path => /^(?:scripts|tests|experiments|website)\//.test(path)) : [];
  const consumers = rootPaths.length ? rootConsumers(root, rootPaths) : { tests: [], categories: new Set<RootCategory>(), global: false };
  const global = consumers.global || changed.some(path =>
    path.startsWith(".github/workflows/") || path === "bun.lock" || path === "package.json" || path === ".changeset/config.json" ||
    (!path.startsWith("packages/") && !path.startsWith("template/") &&
      !path.startsWith("api-report/") && !rootPaths.includes(path) && !prose(path))) || direct.some(dir => !dirs.has(dir));
  const affected = global ? [...dirs].sort() : affectedWorkspaces(direct, packages);
  // Fixture Markdown and shipped skills are behavioral inputs too; only
  // package prose outside those domains can avoid the affected checks.
  const packageCode = packagePaths.some(path => !/\.(md|mdx|txt)$/.test(path) ||
    /^packages\/[^/]+\/(src|fixtures|tests|skills|migrations|assets)\//.test(path));
  const typedInputs = packagePaths.some(path => /\.(?:[cm]?[jt]sx?|json|toml)$/.test(path));
  const tooling = global || rootPaths.length > 0 || changed.some(path => path.startsWith("api-report/") || path.startsWith("template/") || path.startsWith("docs/decisions/"));
  const contract = global || packagePaths.some(path => /^packages\/[^/]+\/(src\/|package\.json$)/.test(path)) ||
    changed.some(path => path.startsWith("api-report/"));
  const groups = [...(tooling ? ["tooling"] : []), ...(contract ? ["contract"] : []), ...(packageCode || global ? affected : [])];
  const tests = [...new Set([...groups.flatMap(group => FAST_TESTS[group] ?? []), ...consumers.tests])].sort();
  const ships = packagePaths.some(path => {
    const [, dir, ...rest] = path.split("/");
    const relative = rest.join("/");
    const pkg = packages.find(p => p.dir === dir);
    return !pkg || relative === "package.json" || relative === "LICENSE" ||
      pkg.files.some(file => relative === file.replace(/\/$/, "") || relative.startsWith(file.replace(/\/$/, "") + "/"));
  });
  const ui = affected.some(dir => ["ui-sdk", "ui-kit", "ui-react", "ui-server", "render-template", "geo"].includes(dir));
  const captureInputs = changed.some(path => path === "docs/process/feature-captures.md" || path.startsWith("scripts/capture") || path.startsWith("scripts/captures/"));
  const plan: CheckPlan = { changed: [...changed].sort(), affected, global,
    ...(rootPaths.length && !global && !packageCode ? { unitTests: [...new Set([...tests, ...consumers.tests])].sort() } : {}),
    typecheck: global || rootPaths.some(path => /\.[cm]?[jt]sx?$/.test(path)) || typedInputs || changed.some(path => path.startsWith("template/") && /\.[cm]?[jt]sx?$/.test(path)),
    tests, pack: global || ships,
    local: { fullTests: global || packageCode || consumers.tests.length > 0 || changed.some(path => path.startsWith("template/") && !prose(path)), browser: consumers.categories.has("browser") || ((global || packageCode) && ui),
      layout: consumers.categories.has("layout") || ((global || packageCode) && ui), captures: consumers.categories.has("captures") || captureInputs || ((global || packageCode) && ui),
      endurance: consumers.categories.has("endurance") || ((global || packageCode) && ui),
      runtime: consumers.categories.has("runtime") || global || (packageCode && affected.some(dir => ["ui-backend-claude", "ui-backend-pi", "ui-server", "ui-render-puppeteer", "scrape", "core", "ui-react"].includes(dir))) } };
  // Explicit roots identify a real harness; two-argument synthetic workspace diagnostics stay conservative.
  return arguments.length >= 3 && !global ? selectBrowserClosures(plan, discoverBrowserClosures(root)) : plan;
}

/** Global dependency/tooling changes remain exhaustive; selected categories remain complete. */
export function selectBrowserClosures(plan: CheckPlan, closures: BrowserClosures): CheckPlan {
  if (plan.global) return plan;
  const local = { ...plan.local };
  for (const category of ["browser", "layout", "endurance", "captures"] as const) local[category] = closureSelects(plan.changed, closures[category], local[category]);
  return { ...plan, local };
}

/** Narrow inventories use fewer nonempty partitions; ordinary proof keeps four. */
export function unitShards(plan: CheckPlan): number[] {
  const count = plan.unitTests?.length ?? 4;
  if (!count) throw new Error("Empty selected unit inventory");
  return Array.from({length: Math.min(4, count)}, (_, i) => i + 1);
}

export type ProofCadence = "draft" | "feedback" | "confirmation" | "integrated" | "exhaustive";

/** A request is an event, never a sticky label that can approve a later head. */
export function proofCadence(env: NodeJS.ProcessEnv, event: any): ProofCadence {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    if (event.pull_request?.draft === true) return "draft";
    if (["opened", "reopened", "ready_for_review"].includes(event.action)) return "confirmation";
    return "feedback";
  }
  if (env.GITHUB_EVENT_NAME === "push") return "integrated";
  if (["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return "exhaustive";
  throw new Error("Unknown proof event: confirmation cannot be inferred");
}

/** Explicit false outputs distinguish intentional exclusions from missing proof. */
export function proofSelections(plan: CheckPlan, draft = false): Record<string, boolean> {
  const feedback = plan.cadence === "feedback";
  draft ||= plan.cadence === "draft";
  return Object.fromEntries(Object.entries({
    verify: plan.typecheck || ((feedback || !plan.local.fullTests) && plan.tests.length > 0), pack: !feedback && plan.pack,
    unit: !feedback && plan.local.fullTests, browser: !feedback && plan.local.browser, layout: !feedback && plan.local.layout,
    captures: !feedback && plan.local.captures, runtime: !feedback && plan.local.runtime, runtime_host: !feedback && plan.local.runtime, endurance: !feedback && plan.local.endurance,
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
  if (["api", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return planChecks(["package.json"], workspaces(root), root);
  const pr = env.GITHUB_EVENT_NAME === "pull_request";
  const base = pr ? env.BASE_SHA : env.BEFORE_SHA;
  if (!base || !env.HEAD_SHA) throw new Error("CI requires BASE_SHA/BEFORE_SHA and HEAD_SHA");
  return planChecks(changedFiles(root, base, env.HEAD_SHA, pr), workspaces(root), root, pr);
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const plan = planFromEnvironment(root, process.env);
    if (process.env.GITHUB_ACTIONS === "true" && !process.env.GITHUB_EVENT_PATH) throw new Error("Hosted proof requires GITHUB_EVENT_PATH");
    // Standalone planner diagnostics preserve complete selection; only an actual
    // event requests hosted confirmation, enforced again by the final gate.
    const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : undefined;
    if (event) plan.cadence = proofCadence(process.env, event);
    const path = process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json");
    await Bun.write(path, JSON.stringify(plan, null, 2) + "\n");
    const draft = process.env.PR_DRAFT === "true";
    const selections = proofSelections(plan, draft);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `unit_shards=${JSON.stringify(unitShards(plan))}\n` +
      `cadence=${plan.cadence ?? "diagnostic"}\n` + Object.entries(selections).map(([name, selected]) => `${name}=${selected}\n`).join(""));
    console.log(JSON.stringify({ ...plan, draft, event: event && {
      name: process.env.GITHUB_EVENT_NAME, action: event.action,
      head: event.pull_request?.head?.sha ?? process.env.GITHUB_SHA,
      base: event.pull_request?.base?.sha ?? event.before,
    } }, null, 2));
  } catch (error) { console.error(error); process.exit(1); }
}
