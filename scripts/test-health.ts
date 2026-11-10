/**
 * The deterministic half of the `test-health` skill
 * (.agents/skills/test-health/SKILL.md): what to audit next, what the static
 * signals are, how a test behaves over repeated runs, whether a mutation is
 * killed, whether a worksheet and a batch may be recorded and landed, and what
 * the numbers say. The auditing agent supplies judgment; everything a script
 * can decide, this decides the same way for every agent and model.
 *
 *   bun scripts/test-health.ts <command> [options]
 *
 *   doctor                                   can this checkout audit, and may it land
 *   inventory [--rows]                       test files by tier and package
 *   signals [file...]                        static smell signals
 *   plan [--profile p] [--base ref] [--package p] [--mode hot|sweep]
 *        [--shard file] [--batch id] [--budget-files n] [--bun-only] [--dry-run]
 *                                            choose and claim this run's clusters
 *   brief --run id --cluster n [--json]      everything known about one cluster
 *   measure <file...> [--runs n] [--shuffle] [--together] [--stress] [--out file]
 *   mutate --test file --expect text (--patch file | --from-worktree path...)
 *          [--name case] [--out file]        exit 0 only when the mutant is killed
 *   validate <worksheet> [--run id]          check a worksheet and its evidence
 *   record cluster --run id --cluster n --worksheet file [--commit sha]
 *   record run --run id --outcome o [--agent label] [--note text]
 *   record batch --batch id --event e [--pr n] [--commit sha] [--merge-sha sha] [--reason text]
 *   batch status                             open batches, ripeness and the landing slot
 *   record void --run id --cluster n --reason text
 *   batch verify --base ref [--head ref] [--net-only]
 *                                            the gate a batch passes before it lands
 *   shards --count n [--tag t] [--out dir]   disjoint work lists for parallel workers
 *   costs ingest --artifacts dir             case durations from downloaded CI artifacts
 *   report [--publish] [--out dir]           metrics.json and report.md
 *
 * Common options: --profile cron|push, --ledger-dir <dir> (a local directory
 * instead of the shared ref), --state-dir <dir>, --offline (no GitHub calls),
 * --bun-only (leave out the tiers that need the browser container).
 *
 * Output is written for an agent that pays for every token it reads: one line
 * of JSON holding what the next step needs, with the detail in the file the
 * command wrote. --full prints everything, --pretty indents it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { declaredFor, reportsCases, runtimeAccounting, staticAccounting, type CaseSummary, type FileAccounting } from "./test-health/accounting";
import { branchFor, batchIdFor, landingSlots, openBatch, parkedChangedFiles, ripeness, trailerFor, verifyBatch } from "./test-health/batch";
import { LENS_IDS } from "./test-health/catalog";
import { loadConfig, type Config } from "./test-health/config";
import { doctor } from "./test-health/doctor";
import { blobsOf, cachedInventory, type Discover, type Inventory, type Row } from "./test-health/inventory";
import { fetchIssues, fetchOpenPrFiles, mapIssues, type Issue } from "./test-health/issues";
import { parseJunit, parseProofCases, type CaseResult } from "./test-health/junit";
import { DirLedgerStore, GitLedgerStore, landedOrPending, ledgerState, type AuditedFile, type BatchEvent,
  type LedgerRecord, type LedgerState, type LedgerStore, type RunRecord } from "./test-health/ledger";
import { measure } from "./test-health/measure";
import { mutate, worktreePatch } from "./test-health/mutate";
import { buildAffinity, buildImportIndex, type Affinity } from "./test-health/neighbours";
import { buildMetrics, buildSnapshot, renderReport } from "./test-health/report";
import { bunRunner, DEFAULT_BUN_COMMAND, visualRunner, type TestRunner } from "./test-health/runner";
import { makeShards, planRun, rank, remainingIn, type Cluster, type IssueRef, type Mode, type Shard } from "./test-health/select";
import { countSignals, scanFiles, scanSource, signalWeight, type FileSignals } from "./test-health/signals";
import { resolveWorksheet, validateWorksheet, type DraftWorksheet } from "./test-health/worksheet";

/** What the CLI reaches outside the checkout for. Tests replace all of it. */
export interface Io {
  root: string;
  now: () => Date;
  out: (text: string) => void;
  discover?: Discover;
  bunCommand?: readonly string[];
  issues?: () => Issue[];
  openPrFiles?: () => Set<string>;
  runId?: () => string;
}

const BOOLEAN = new Set(["rows", "dry-run", "json", "shuffle", "together", "stress", "publish", "offline", "summary", "bun-only", "help", "net-only", "full", "pretty"]);
/** Tiers that run without the pinned browser container. */
const BUN_TIERS = ["fast", "unit", "runtime", "experiment"];

export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Map<string, string | true>; lists: Map<string, string[]> } {
  const positional: string[] = [], flags = new Map<string, string | true>(), lists = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (BOOLEAN.has(name)) { flags.set(name, true); continue; }
    if (name === "from-worktree") {
      const paths: string[] = inline ? [inline] : [];
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) paths.push(argv[++index]!);
      lists.set(name, paths);
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { positional, flags, lists };
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

interface Session { io: Io; flags: Map<string, string | true>; config: Config; store: LedgerStore; stateDir: string; cacheDir: string }
const flag = (session: Session, name: string): string | undefined => { const value = session.flags.get(name); return typeof value === "string" ? value : undefined; };
const need = (session: Session, name: string): string => { const value = flag(session, name); if (!value) throw new Error(`--${name} is required`); return value; };
const offline = (session: Session): boolean => session.flags.has("offline");

function openSession(io: Io, flags: Map<string, string | true>): Session {
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
  const overrides: Record<string, unknown> = {};
  if (text("base")) overrides.base = text("base");
  if (text("budget-files")) overrides.budgetFiles = Number(text("budget-files"));
  if (flags.has("bun-only")) overrides.tiers = BUN_TIERS;
  const config = loadConfig(text("profile") ?? "cron", overrides);
  const common = git(io.root, ["rev-parse", "--git-common-dir"]);
  const stateDir = text("state-dir") ? resolve(text("state-dir")!) : join(isAbsolute(common) ? common : join(io.root, common), "test-health");
  const store = text("ledger-dir") ? new DirLedgerStore(resolve(text("ledger-dir")!)) : new GitLedgerStore(io.root, config.ledgerRemote, config.ledgerRef);
  return { io, flags, config, store, stateDir, cacheDir: join(stateDir, "cache") };
}

interface World { inventory: Inventory; signals: Map<string, FileSignals>; affinity: Affinity; issues: Map<string, IssueRef[]>; openPrFiles: Set<string>; state: LedgerState }

async function loadWorld(session: Session, withGithub: boolean): Promise<World> {
  const { io, cacheDir } = session;
  const inventory = await cachedInventory(io.root, cacheDir, io.discover);
  const signals = scanFiles(io.root, inventory.rows, cacheDir);
  const { workspaces } = await import("./ci-plan");
  const packageDirs = new Map(existsSync(join(io.root, "packages")) ? workspaces(io.root).map(workspace => [workspace.name, workspace.dir] as const) : []);
  const affinity = buildAffinity(inventory.rows, buildImportIndex(io.root, inventory.rows, packageDirs, cacheDir));
  const github = withGithub && !offline(session);
  const issues = github ? mapIssues((io.issues ?? (() => fetchIssues(io.root)))(), inventory.rows.map(row => row.file)) : new Map<string, IssueRef[]>();
  const openPrFiles = github ? (io.openPrFiles ?? (() => fetchOpenPrFiles(io.root)))() : new Set<string>();
  return { inventory, signals, affinity, issues, openPrFiles, state: ledgerState(session.store.read(), io.now()) };
}

const newRunId = (now: Date): string => `th-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
const runDir = (session: Session, runId: string): string => join(session.stateDir, "runs", runId);

interface SavedPlan {
  runId: string; startedAt: string; profile: string; base: string; mode: Mode; package: string | null;
  batch: { id: string; branch: string; base: string; isNew: boolean } | null;
  clusters: Cluster[]; rows: Record<string, Row>; issues: Record<string, IssueRef[]>;
}
function loadPlan(session: Session, runId: string): SavedPlan {
  const path = join(runDir(session, runId), "plan.json");
  if (!existsSync(path)) throw new Error(`No plan for run ${runId} in ${session.stateDir}`);
  return JSON.parse(readFileSync(path, "utf8")) as SavedPlan;
}

function planInput(session: Session, world: World, runId: string) {
  return { runId, inventory: world.inventory, profile: session.config.profile, now: session.io.now(), audits: landedOrPending(world.state),
    claims: world.state.claims, signalWeights: new Map([...world.signals].map(([file, entry]) => [file, signalWeight(entry.signals)])),
    issues: world.issues, openPrFiles: world.openPrFiles, affinity: world.affinity, runCount: world.state.runs.length };
}

async function commandPlan(session: Session): Promise<unknown> {
  const { io, config } = session;
  const world = await loadWorld(session, true);
  const now = io.now();
  const runId = (io.runId ?? (() => newRunId(now)))();
  const shardFile = flag(session, "shard");
  const shard = shardFile ? JSON.parse(readFileSync(shardFile, "utf8")) as Shard : null;
  const batchFlag = flag(session, "batch") ?? shard?.id;
  const named = batchFlag ? world.state.batches.get(batchFlag) : undefined;
  if (named && named.status !== "open") throw new Error(`Batch ${batchFlag} is already ${named.status}`);
  const wanted = flag(session, "package") ?? shard?.package;
  const continuing = named ?? (batchFlag ? undefined : openBatch(world.state, config.profile.base, wanted));
  const plan = planRun({ ...planInput(session, world, runId), mode: flag(session, "mode") as Mode | undefined, package: wanted,
    preferPackage: continuing?.package, only: shard ? new Set(shard.files) : undefined, parkedChangedFiles: parkedChangedFiles(world.state) });

  let batch: SavedPlan["batch"] = null;
  if (plan.package && plan.clusters.length) {
    const existing = continuing && continuing.package === plan.package ? continuing : undefined;
    const id = existing?.batchId ?? batchFlag ?? batchIdFor(plan.package, runId);
    batch = { id, branch: existing?.branch ?? branchFor(id), base: existing?.base ?? config.profile.base, isNew: !existing };
  }
  const files = [...new Set(plan.clusters.flatMap(cluster => [...cluster.members, ...cluster.context]))];
  const saved: SavedPlan = { runId, startedAt: now.toISOString(), profile: config.profile.name, base: config.profile.base, mode: plan.mode,
    package: plan.package, batch, clusters: plan.clusters,
    rows: Object.fromEntries(world.inventory.rows.filter(row => files.includes(row.file)).map(row => [row.file, row])),
    issues: Object.fromEntries(files.filter(file => world.issues.has(file)).map(file => [file, world.issues.get(file)!])) };
  if (!session.flags.has("dry-run")) {
    mkdirSync(runDir(session, runId), { recursive: true });
    writeFileSync(join(runDir(session, runId), "plan.json"), JSON.stringify(saved, null, 2) + "\n");
    const records: LedgerRecord[] = [];
    const members = plan.clusters.flatMap(cluster => cluster.members);
    if (members.length) {
      records.push({ v: 1, type: "claim", at: now.toISOString(), runId, files: members, profile: config.profile.name,
        expiresAt: new Date(now.getTime() + config.profile.claimHours * 3_600_000).toISOString() });
    }
    if (batch?.isNew) {
      records.push({ v: 1, type: "batch", event: "opened", at: now.toISOString(), runId, batchId: batch.id, package: plan.package!,
        branch: batch.branch, base: batch.base, profile: config.profile.name });
    }
    session.store.append(records);
  }
  return { runId, runDir: runDir(session, runId), profile: config.profile.name, mode: plan.mode, package: plan.package, batch,
    throttled: plan.throttled, stats: plan.stats,
    // Context files are listed in each cluster's brief, where they are needed.
    clusters: plan.clusters.map(cluster => ({ index: cluster.index, seed: cluster.seed, members: cluster.members,
      ...(session.flags.has("full") ? { context: cluster.context } : {}) })) };
}

function cachedCases(session: Session): Record<string, Array<{ name: string; ms: number }>> {
  const path = join(session.cacheDir, "cases.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, Array<{ name: string; ms: number }>> : {};
}

function commandBrief(session: Session): unknown {
  const runId = need(session, "run");
  const plan = loadPlan(session, runId);
  const cluster = plan.clusters[Number(need(session, "cluster"))];
  if (!cluster) throw new Error(`Run ${runId} has no cluster ${flag(session, "cluster")}`);
  const state = ledgerState(session.store.read(), session.io.now());
  const cases = cachedCases(session);
  const present = (file: string) => existsSync(join(session.io.root, file));
  const signals = scanFiles(session.io.root, [...cluster.members, ...cluster.context].filter(present).map(file => ({ file, blob: blobsOf(session.io.root, [file]).get(file)! })));
  const describe = (file: string) => {
    const row = plan.rows[file];
    const audit = state.audits.get(file);
    const found = signals.get(file)?.signals ?? [];
    return { file, tier: row?.tier ?? null, package: row?.package ?? null, runner: row?.runner ?? null, projects: row?.projects ?? [],
      costSeconds: row?.costSeconds ?? null, tests: row?.scenarios ?? null, assertions: row?.assertions ?? null,
      lastAudit: audit ? { at: audit.at, lenses: audit.lenses } : null, issues: plan.issues[file] ?? [],
      signals: found, signalCounts: countSignals(found), slowestCases: (cases[file] ?? []).slice(0, 8),
      relation: cluster.neighbours.find(neighbour => neighbour.file === file) ?? null };
  };
  const members = cluster.members.map(describe), context = cluster.context.map(describe);
  const skeleton = { schemaVersion: 1, runId, cluster: cluster.index, seed: cluster.seed, members: cluster.members, context: cluster.context,
    audits: cluster.members.map(file => ({ file, lenses: Object.fromEntries(LENS_IDS.map(lens => [lens, "TODO"])) })), findings: [] };
  const brief = { runId, cluster: cluster.index, package: plan.package, mode: plan.mode, batch: plan.batch,
    trailer: trailerFor(runId, cluster.index), worksheetPath: join(runDir(session, runId), `cluster-${cluster.index}.json`), members, context, skeleton };
  if (session.flags.has("json")) return brief;
  const line = (entry: ReturnType<typeof describe>) => [
    `### ${entry.file}`,
    `- tier ${entry.tier}, runner ${entry.runner}, cost ${entry.costSeconds ?? "unmeasured"} s, ${entry.tests} tests, ${entry.assertions} assertion lines`,
    `- last audit: ${entry.lastAudit ? entry.lastAudit.at : "never"}`,
    ...(entry.relation ? [`- related to the seed: ${entry.relation.relation}, shares ${entry.relation.shared.join(", ") || "nothing named"}`] : []),
    ...entry.issues.map(issue => `- open issue #${issue.number}: ${issue.title}${issue.needsRepro ? " (needs repro)" : ""}${issue.assigned ? " (assigned: leave the fix to its owner)" : ""}`),
    ...Object.entries(entry.signalCounts).map(([smell, count]) =>
      `- signal ${smell} x${count}: lines ${entry.signals.filter(signal => signal.smell === smell).slice(0, 12).map(signal => signal.detail ? `${signal.line} (${signal.detail})` : signal.line).join(", ")}`),
    ...entry.slowestCases.map(entry => `- slow case ${entry.ms} ms: ${entry.name}`),
  ].join("\n");
  return [
    `# Cluster ${cluster.index} of run ${runId}`,
    "",
    `Package ${plan.package}, mode ${plan.mode}, batch ${plan.batch?.id ?? "none"} on branch ${plan.batch?.branch ?? "n/a"}.`,
    `Commit trailer: \`${brief.trailer}\`. Worksheet: \`${brief.worksheetPath}\`.`,
    "",
    "## Members (audit through every lens; these may change)",
    "",
    members.map(line).join("\n\n"),
    "",
    "## Context (read only; other packages or already audited)",
    "",
    context.length ? context.map(line).join("\n\n") : "None.",
    "",
    "## Worksheet skeleton",
    "",
    "```json",
    JSON.stringify(skeleton, null, 2),
    "```",
    "",
  ].join("\n");
}

async function runnerFor(session: Session, files: readonly string[]): Promise<{ runner: TestRunner; rows: Map<string, Row> }> {
  const inventory = await cachedInventory(session.io.root, session.cacheDir, session.io.discover);
  const rows = new Map(inventory.rows.filter(row => files.includes(row.file)).map(row => [row.file, row]));
  const visual = files.filter(file => rows.get(file)?.runner === "visual");
  if (visual.length && visual.length !== files.length) throw new Error("Measure Bun and browser files in separate commands");
  const scratch = join(session.stateDir, "scratch");
  return { runner: visual.length ? visualRunner(session.io.root) : bunRunner(session.io.root, scratch, session.io.bunCommand ?? DEFAULT_BUN_COMMAND), rows };
}

const writeOut = (session: Session, value: unknown): void => {
  const path = flag(session, "out");
  if (!path) return;
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

async function commandMeasure(session: Session, files: string[]): Promise<unknown> {
  if (!files.length) throw new Error("measure needs at least one test file");
  const { runner, rows } = await runnerFor(session, files);
  const profile = session.config.profile.measure;
  const result = await measure({ files, runner, runs: Number(flag(session, "runs") ?? profile.runs),
    shuffle: session.flags.has("shuffle"), together: session.flags.has("together"), stress: session.flags.has("stress"),
    projects: new Map([...rows].filter(([, row]) => row.projects.length).map(([file, row]) => [file, row.projects])),
    costs: new Map([...rows].filter(([, row]) => row.costSeconds !== null).map(([file, row]) => [file, row.costSeconds!])),
    budgetSeconds: profile.budgetSeconds, now: session.io.now() });
  writeOut(session, result);
  if (session.flags.has("full")) return result;
  const some = (list: string[], limit: number) => list.length > limit ? [...list.slice(0, limit), `(+${list.length - limit} more)`] : list;
  return { out: flag(session, "out") ?? null, together: result.together,
    files: result.files.map(entry => ({ file: entry.file, verdict: entry.verdict, runs: entry.runs, failures: entry.failures, medianMs: entry.medianMs,
      ...(entry.failingCases.length ? { failingCases: some(entry.failingCases.map(failing => failing.name), 5) } : {}),
      ...(entry.zeroAssertionCases.length ? { zeroAssertionCases: some(entry.zeroAssertionCases, 10) } : {}),
      ...(entry.skippedCases.length ? { skippedCases: entry.skippedCases.length } : {}),
      ...(entry.setupError !== undefined ? { setupError: entry.setupError } : {}),
      slowestCases: entry.slowestCases.slice(0, 3) })) };
}

async function commandMutate(session: Session, lists: Map<string, string[]>): Promise<{ value: unknown; code: number }> {
  const test = need(session, "test");
  const fromWorktree = lists.get("from-worktree");
  const patchFile = flag(session, "patch");
  if (!fromWorktree?.length === !patchFile) throw new Error("Give exactly one of --patch <file> or --from-worktree <path...>");
  const patch = patchFile ? readFileSync(patchFile, "utf8") : worktreePatch(session.io.root, fromWorktree!);
  const { runner, rows } = await runnerFor(session, [test]);
  const receipt = await mutate({ root: session.io.root, test, name: flag(session, "name"), expect: need(session, "expect"), patch, runner,
    projects: rows.get(test)?.projects, now: session.io.now() }, Boolean(fromWorktree?.length));
  writeOut(session, receipt);
  const value = session.flags.has("full") ? receipt
    : { verdict: receipt.verdict, detail: receipt.detail, test: receipt.test, name: receipt.name, out: flag(session, "out") ?? null };
  return { value, code: receipt.verdict === "killed" ? 0 : 1 };
}

function readWorksheet(session: Session, path: string, runId: string | undefined) {
  const draft = JSON.parse(readFileSync(path, "utf8")) as DraftWorksheet;
  const base = runId ? runDir(session, runId) : resolve(path, "..");
  const sheet = resolveWorksheet(draft, reference => JSON.parse(readFileSync(isAbsolute(reference) ? reference : join(base, reference), "utf8")));
  return { sheet, problems: validateWorksheet(sheet, { stableRuns: session.config.profile.measure.stableRuns }) };
}

function commandRecordCluster(session: Session): unknown {
  const { io } = session;
  const runId = need(session, "run");
  const plan = loadPlan(session, runId);
  const index = Number(need(session, "cluster"));
  const planned = plan.clusters[index];
  if (!planned) throw new Error(`Run ${runId} has no cluster ${index}`);
  const { sheet, problems } = readWorksheet(session, need(session, "worksheet"), runId);
  if (sheet.runId !== runId || sheet.cluster !== index) problems.push(`the worksheet is for ${sheet.runId}#${sheet.cluster}`);
  if (sheet.seed !== planned.seed) problems.push(`the planned seed is ${planned.seed}`);
  for (const file of sheet.members ?? []) if (!planned.members.includes(file)) problems.push(`${file} is not a planned member of this cluster`);
  if (problems.length) throw new Error(`The worksheet cannot be recorded:\n- ${problems.join("\n- ")}`);

  const commit = flag(session, "commit") ? git(io.root, ["rev-parse", "--verify", `${flag(session, "commit")}^{commit}`]) : null;
  if (commit && !git(io.root, ["show", "-s", "--format=%B", commit]).includes(trailerFor(runId, index))) {
    throw new Error(`Commit ${commit.slice(0, 10)} lacks the trailer "${trailerFor(runId, index)}"`);
  }
  const current = commit ? null : blobsOf(io.root, sheet.members);
  const audits: AuditedFile[] = sheet.members.map(file => {
    const blobBefore = plan.rows[file]?.blob;
    if (!blobBefore) throw new Error(`${file} has no planned blob`);
    let blobAfter: string | null;
    if (commit) { try { blobAfter = git(io.root, ["rev-parse", "--verify", `${commit}:${file}`]); } catch { blobAfter = null; } }
    else blobAfter = existsSync(join(io.root, file)) ? current!.get(file) ?? null : null;
    if (!commit && blobAfter !== blobBefore) throw new Error(`${file} changed but no --commit was given: commit the cluster with its trailer first`);
    return { file, blobBefore, blobAfter, lenses: sheet.audits.find(audit => audit.file === file)!.lenses };
  });
  // Test accounting: every test a change makes disappear must be one a finding declared.
  const lost: string[] = [], accounting: FileAccounting[] = [];
  const source = (blob: string | null) => { if (!blob) return ""; try { return Bun.spawnSync(["git", "cat-file", "-p", blob], { cwd: io.root, stdout: "pipe" }).stdout.toString(); } catch { return ""; } };
  const measured = (side: "before" | "after", file: string): CaseSummary[] | null => {
    const path = sheet.measurements?.[side];
    if (!path) return null;
    const result = JSON.parse(readFileSync(isAbsolute(path) ? path : join(runDir(session, runId), path), "utf8")) as { files?: Array<{ file: string; cases?: CaseSummary[] }> };
    return result.files?.find(entry => entry.file === file)?.cases ?? null;
  };
  for (const audit of audits.filter(entry => entry.blobAfter !== entry.blobBefore)) {
    const declared = declaredFor(audit.file, sheet.findings);
    const counted = staticAccounting(scanSource(audit.file, source(audit.blobBefore)).titles, scanSource(audit.file, source(audit.blobAfter)).titles, declared);
    for (const problem of counted.problems) lost.push(`${audit.file}: ${problem}`);
    let runtime: FileAccounting["runtime"] = null;
    if (reportsCases(audit.file)) {
      const [was, is] = [measured("before", audit.file), audit.blobAfter ? measured("after", audit.file) : []];
      if (!was || !is) lost.push(`${audit.file}: changed, so the worksheet's measurements.before and measurements.after must both measure it`);
      else {
        const { problems, ...compared } = runtimeAccounting(was, is, declared.removedCases);
        for (const problem of problems) lost.push(`${audit.file}: ${problem}`);
        runtime = compared;
      }
    }
    accounting.push({ file: audit.file, testsBefore: counted.before, testsAfter: counted.after, declaredRemoved: declared.removes.length, runtime });
  }
  if (lost.length) throw new Error(`The cluster cannot be recorded; tests would be lost without a declaration:\n- ${lost.join("\n- ")}`);
  const record: LedgerRecord = { v: 1, type: "cluster", at: io.now().toISOString(), runId, cluster: index, batchId: plan.batch?.id ?? null,
    commit, package: plan.package ?? "", worksheet: sheet, audits, accounting };
  session.store.append([record]);
  const sum = (pick: (entry: FileAccounting) => number) => accounting.reduce((total, entry) => total + pick(entry), 0);
  return { recorded: `${runId}#${index}`, files: audits.length, changed: accounting.length, findings: sheet.findings.length, commit,
    tests: { before: sum(entry => entry.testsBefore), after: sum(entry => entry.testsAfter), declaredRemoved: sum(entry => entry.declaredRemoved) } };
}

async function commandRecordRun(session: Session): Promise<unknown> {
  const runId = need(session, "run");
  const outcome = need(session, "outcome") as RunRecord["outcome"];
  if (!["completed", "throttled", "blocked", "nothing-to-do", "failed"].includes(outcome)) throw new Error(`Unknown outcome ${outcome}`);
  const planPath = join(runDir(session, runId), "plan.json");
  const plan = existsSync(planPath) ? loadPlan(session, runId) : null;
  const world = await loadWorld(session, true);
  const record: RunRecord = { v: 1, type: "run", at: session.io.now().toISOString(), runId, agent: flag(session, "agent") ?? "unknown",
    profile: plan?.profile ?? session.config.profile.name, mode: plan?.mode ?? "none", package: plan?.package ?? null,
    startedAt: plan?.startedAt ?? session.io.now().toISOString(), outcome, ...(flag(session, "note") ? { note: flag(session, "note") } : {}),
    snapshot: buildSnapshot(world.inventory, world.signals, world.issues) };
  session.store.append([record]);
  return { recorded: runId, outcome, clusters: world.state.clusters.filter(cluster => cluster.runId === runId).length };
}

function commandRecordBatch(session: Session): unknown {
  const batchId = need(session, "batch");
  const event = need(session, "event") as BatchEvent;
  if (!["pr", "attempt", "dropped", "landed", "abandoned"].includes(event)) throw new Error(`Unknown batch event ${event}`);
  const now = session.io.now().toISOString();
  const state = ledgerState(session.store.read(), session.io.now());
  const batch = state.batches.get(batchId);
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  const runId = flag(session, "run") ?? `batch-${batchId}`;
  const commit = flag(session, "commit");
  const records: LedgerRecord[] = [{ v: 1, type: "batch", event, at: now, runId, batchId,
    ...(flag(session, "pr") ? { pr: Number(flag(session, "pr")) } : {}), ...(commit ? { commit } : {}),
    ...(flag(session, "merge-sha") ? { mergeSha: flag(session, "merge-sha") } : {}), ...(flag(session, "reason") ? { reason: flag(session, "reason") } : {}) }];
  // A dropped commit takes its audits with it, so the rotation offers those files again.
  const voided = event === "dropped" ? batch.clusters.filter(cluster => commit && cluster.commit?.startsWith(commit)) : event === "abandoned" ? batch.clusters : [];
  if (event === "dropped" && !voided.length) throw new Error(`No recorded cluster of ${batchId} has commit ${commit ?? "(none given)"}`);
  for (const cluster of voided) records.push({ v: 1, type: "void", at: now, runId: cluster.runId, cluster: cluster.cluster, reason: flag(session, "reason") ?? event });
  session.store.append(records);
  return { batch: batchId, event, voidedClusters: voided.map(cluster => `${cluster.runId}#${cluster.cluster}`) };
}

async function commandBatchStatus(session: Session): Promise<unknown> {
  const world = await loadWorld(session, true);
  const now = session.io.now();
  const slot = landingSlots(world.state, session.config.profile, now);
  const batches = [...world.state.batches.values()].filter(batch => batch.status === "open").map(batch => {
    const remaining = remainingIn(planInput(session, world, "status"), batch.package);
    return { batchId: batch.batchId, package: batch.package, branch: batch.branch, base: batch.base, pr: batch.pr, attempts: batch.attempts,
      clusters: batch.clusters.length, remainingInPackage: remaining, ...ripeness(batch, world.state, session.config.profile, now, remaining === 0) };
  });
  const ready = batches.filter(batch => batch.ripe && batch.pr === null).sort((a, b) => b.changedFiles - a.changedFiles);
  return { landingSlot: slot, batches, land: slot.open ? ready[0]?.batchId ?? null : null, parkedChangedFiles: parkedChangedFiles(world.state) };
}

async function commandShards(session: Session): Promise<unknown> {
  const world = await loadWorld(session, true);
  const input = planInput(session, world, "shards");
  const eligible = rank(input).filter(candidate => session.config.profile.tiers.includes(candidate.row.tier)
    && !world.openPrFiles.has(candidate.row.file) && !world.state.claims.has(candidate.row.file));
  const tag = flag(session, "tag") ?? session.io.now().toISOString().slice(0, 10).replaceAll("-", "");
  const shards = makeShards(eligible, Number(need(session, "count"))).map(shard => ({ ...shard, id: `${tag}-${shard.id}` }));
  const out = flag(session, "out");
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const shard of shards) writeFileSync(join(out, `${shard.id}.json`), JSON.stringify(shard, null, 2) + "\n");
  }
  return { shards: shards.map(shard => ({ id: shard.id, package: shard.package, files: shard.files.length, effort: shard.effort,
    ...(out ? { path: join(out, `${shard.id}.json`) } : {}) })) };
}

function commandCostsIngest(session: Session): unknown {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  const cases: CaseResult[] = [];
  let reports = 0;
  for (const path of walk(need(session, "artifacts"))) {
    if (path.endsWith("unit-report.xml")) { cases.push(...parseJunit(readFileSync(path, "utf8"))); reports++; }
    else if (path.endsWith("proof-cases.json")) { cases.push(...parseProofCases(readFileSync(path, "utf8"))); reports++; }
  }
  const byFile: Record<string, Array<{ name: string; ms: number }>> = {};
  for (const entry of cases) if (entry.ms !== null && entry.state === "passed") (byFile[entry.file.replace(/^\.\//, "")] ??= []).push({ name: entry.name, ms: entry.ms });
  for (const list of Object.values(byFile)) list.sort((a, b) => b.ms - a.ms).splice(15);
  mkdirSync(session.cacheDir, { recursive: true });
  writeFileSync(join(session.cacheDir, "cases.json"), JSON.stringify(byFile) + "\n");
  return { reports, cases: cases.length, files: Object.keys(byFile).length };
}

async function commandReport(session: Session): Promise<unknown> {
  const inventory = await cachedInventory(session.io.root, session.cacheDir, session.io.discover);
  const state = ledgerState(session.store.read(), session.io.now());
  const metrics = buildMetrics(state, inventory, session.io.now(), session.config.profile.reauditDays);
  const markdown = renderReport(metrics);
  const out = flag(session, "out") ?? join(session.stateDir, "report");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(join(out, "report.md"), markdown);
  if (session.flags.has("publish")) session.store.append([], { "metrics.json": JSON.stringify(metrics, null, 2) + "\n", "report.md": markdown });
  const where = { written: out, published: session.flags.has("publish") };
  if (session.flags.has("full")) return { ...metrics, ...where };
  return { coverage: metrics.coverage, runs: metrics.runs.total, findings: { total: metrics.findings.total, byStatus: metrics.findings.byStatus },
    proof: metrics.proof, accounting: metrics.accounting, batches: metrics.batches, refind: metrics.refind, ...where };
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const { positional, flags, lists } = parseArgs(argv);
  const [command, sub, ...rest] = positional;
  const print = (value: unknown) => io.out(typeof value === "string" ? value : JSON.stringify(value, null, flags.has("pretty") ? 2 : undefined));
  if (!command || command === "help" || flags.has("help")) { print(readFileSync(import.meta.path, "utf8").split("*/")[0]!.replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, "")); return command ? 0 : 2; }
  if (command === "doctor") {
    const result = doctor(io.root, undefined, flags.has("offline"));
    print(flags.has("full") ? result : { ok: result.ok, capabilities: result.capabilities,
      failed: result.checks.filter(check => !check.ok).map(check => ({ name: check.name, detail: check.detail, blocking: check.blocking })) });
    return result.ok ? 0 : 1;
  }
  const session = openSession(io, flags);
  if (command === "inventory") {
    const inventory = await cachedInventory(io.root, session.cacheDir, io.discover);
    const tally = (pick: (row: Row) => string) => { const counts: Record<string, number> = {}; for (const row of inventory.rows) counts[pick(row)] = (counts[pick(row)] ?? 0) + 1; return counts; };
    print({ sha: inventory.sha, files: inventory.rows.length, byTier: tally(row => row.tier), byPackage: tally(row => row.package),
      undiscovered: inventory.undiscovered, ...(flags.has("rows") ? { rows: inventory.rows } : {}) });
  } else if (command === "signals") {
    const inventory = await cachedInventory(io.root, session.cacheDir, io.discover);
    const wanted = [sub, ...rest].filter((file): file is string => Boolean(file));
    const rows = wanted.length ? wanted.map(file => ({ file, blob: blobsOf(io.root, [file]).get(file) ?? "" })) : inventory.rows;
    const scanned = scanFiles(io.root, rows, wanted.length ? undefined : session.cacheDir);
    const totals: Record<string, number> = {};
    for (const entry of scanned.values()) for (const [smell, count] of Object.entries(countSignals(entry.signals))) totals[smell] = (totals[smell] ?? 0) + count;
    print(wanted.length && !flags.has("summary") ? Object.fromEntries(scanned) : { files: scanned.size, totals });
  } else if (command === "plan") print(await commandPlan(session));
  else if (command === "brief") print(commandBrief(session));
  else if (command === "measure") print(await commandMeasure(session, [sub, ...rest].filter((file): file is string => Boolean(file))));
  else if (command === "mutate") { const { value, code } = await commandMutate(session, lists); print(value); return code; }
  else if (command === "validate") {
    if (!sub) throw new Error("validate needs a worksheet path");
    const { problems } = readWorksheet(session, sub, flag(session, "run"));
    print({ ok: problems.length === 0, problems });
    return problems.length ? 1 : 0;
  } else if (command === "record" && sub === "cluster") print(commandRecordCluster(session));
  else if (command === "record" && sub === "run") print(await commandRecordRun(session));
  else if (command === "record" && sub === "batch") print(commandRecordBatch(session));
  else if (command === "record" && sub === "void") {
    // Withdraws one cluster's audits after its batch has landed, when its change was undone later.
    const [runId, cluster] = [need(session, "run"), Number(need(session, "cluster"))];
    const state = ledgerState(session.store.read(), io.now());
    if (!state.clusters.some(record => record.runId === runId && record.cluster === cluster)) throw new Error(`No recorded cluster ${runId}#${cluster}`);
    session.store.append([{ v: 1, type: "void", at: io.now().toISOString(), runId, cluster, reason: need(session, "reason") }]);
    print({ voided: `${runId}#${cluster}` });
  }
  else if (command === "batch" && sub === "status") print(await commandBatchStatus(session));
  else if (command === "batch" && sub === "verify") {
    const state = ledgerState(session.store.read(), io.now());
    const result = await verifyBatch({ root: io.root, base: need(session, "base"), head: flag(session, "head") ?? "HEAD",
      clusters: state.clusters, voided: state.voided, netOnly: flags.has("net-only") });
    print(result);
    return result.ok ? 0 : 1;
  } else if (command === "shards") print(await commandShards(session));
  else if (command === "costs" && sub === "ingest") print(commandCostsIngest(session));
  else if (command === "report") print(await commandReport(session));
  else throw new Error(`Unknown command: ${positional.join(" ")} (run with --help)`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2), { root: resolve(import.meta.dir, ".."), now: () => new Date(), out: text => console.log(text) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
