/** Concurrent serial Bun processes, each owning its source/dependencies/build lease. */
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, readSync, rmSync, rmdirSync, statSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runCommands } from "./ci-runner";
import { balanceTests, FILE_COST_SECONDS } from "./test-shards";
import { validateChangedUnitReports, validateUnitReports } from "./unit-proof-report";
import { captureUnitInputs } from "./unit-worker-inputs";
import { timingSeed } from "./changed-unit-worker";
import { invocationBuild, preparedWorkerEnvironment } from "./test-invocation";
import { selectBuildPackages } from "./publishable-packages";

/** Reserve 30% of memory; each local worker budgets two GiB and two CPUs. */
export function localUnitWorkerCount(cores = availableParallelism(), memory = totalmem()): number {
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memory * 0.7 / (2 * 1024 ** 3))));
}

export interface UnitWorkerOptions { changed?: string; workers?: number; preparedTree?: boolean; }

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Unit workspace git failed: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function command(argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Unit tree setup failed: ${new TextDecoder().decode(result.stderr)}`);
}

function dependencyDirectories(root: string): string[] {
  const directories = ["node_modules", ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/node_modules`)]
    .filter(dir => existsSync(join(root, dir)));
  if (!directories.includes("node_modules")) throw new Error("Unit workers need the parent's frozen dependency install");
  return directories;
}

function removeOverlayScratch(path: string) {
  // Overlayfs creates its owned internal work directory with mode 000.
  const internal = join(path, "work");
  if (existsSync(internal)) chmodSync(internal, 0o700);
  rmSync(path, { recursive: true });
}

// Only these workspace-owned outputs survive a unit worker's removal. External
// tmpdir captures and optional caller-directed output paths are separate work.
const diagnosticRoots = [
  ".vitest-attachments", "packages/ui-kit/.vitest-attachments", "packages/ui-react/.vitest-attachments",
  "tmp/diagram-renderer-proof", "tmp/mermaid-renderer-proof", "tmp/diagram-export-proof",
  "tmp/cold-capture", "tmp/share-review", "tmp/svg-proof", "tmp/unit-consumer-planning",
];
const screenshotTrees = ["packages/ui-kit/src", "packages/ui-kit/tests", "packages/ui-react/src", "packages/ui-react/tests"];
const automaticScreenshot = (path: string) => path.includes("/__screenshots__/") && /-\d+\.png$/.test(path);

function diagnosticReferences(root: string, head: string, objectFormat: string, inputs?: { untracked: string[] }, snapshotDirectory?: string) {
  if (!["sha1", "sha256"].includes(objectFormat)) throw new Error("Unsupported unit workspace object format");
  const references = new Map<string, string>();
  for (const entry of git(root, "ls-tree", "-r", "-z", head, "--", ...diagnosticRoots, ...screenshotTrees).split("\0")) {
    const match = /^[0-7]+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (match) references.set(match[2]!, match[1]!);
  }
  for (const file of inputs?.untracked ?? []) if (automaticScreenshot(file) && screenshotTrees.some(tree => file.startsWith(`${tree}/`))) {
    const path = join(snapshotDirectory!, file);
    if (lstatSync(path).isFile()) {
      const bytes = readFileSync(path);
      references.set(file, createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex"));
    }
  }
  return references;
}

function preserveDiagnostics(worker: { root: string; device: number; inode: number }, destination: () => string, references: ReadonlyMap<string, string>, objectFormat: string) {
  const errors: unknown[] = [];
  const attempt = (operation: () => void) => { try { operation(); } catch (error) { errors.push(error); } };
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const root = openSync(worker.root, directoryFlags);
  try {
    const identity = fstatSync(root);
    if (identity.dev !== worker.device || identity.ino !== worker.inode) throw new Error("Replaced unit diagnostic workspace");
    // Unit execution already requires Linux namespaces. Descriptor-relative opens
    // pin each owned directory and refuse links, including replaced ancestors.
    const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
    function directory(path: string): number | undefined {
      let current = openSync(`/proc/self/fd/${root}`, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        for (const part of path.split("/")) {
          let next: number;
          try { next = openSync(at(current, part), directoryFlags); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
          closeSync(current); current = next;
        }
        const result = current; current = -1; return result;
      } finally { if (current !== -1) closeSync(current); }
    }
    function copy(path: string, parent: number, name: string, generatedScreenshot: boolean) {
      if (isAbsolute(path) || path.split("/").includes("..") || path.includes("\\")) throw new Error("Escaped unit diagnostic path");
      const source = at(parent, name);
      const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(input);
        if (!before.isFile()) throw new Error(`Non-file unit diagnostic: ${path}`);
        const bytes = readFileSync(input);
        const blob = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (references.get(path) === blob) return;
        const target = join(destination(), path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const output = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeFileSync(output, bytes);
          const verified = Buffer.alloc(bytes.length);
          let offset = 0;
          while (offset < verified.length) {
            const count = readSync(output, verified, offset, verified.length - offset, offset);
            if (!count) throw new Error(`Incomplete unit diagnostic copy: ${path}`);
            offset += count;
          }
          if (fstatSync(output).size !== bytes.length ||
              createHash("sha256").update(verified).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) {
            throw new Error(`Changed unit diagnostic copy: ${path}`);
          }
        } finally { closeSync(output); }
        // New automatic images are not ignored by Git. Only after verifying the
        // exclusive copy, remove the same untracked inode through its pinned parent.
        // Tracked images are never removed/restored; the dirty-source guard remains.
        if (generatedScreenshot && !references.has(path)) {
          const now = lstatSync(source);
          const current = fstatSync(input);
          if (!now.isFile() || now.dev !== before.dev || now.ino !== before.ino ||
              now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs ||
              current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
            throw new Error(`Replaced unit diagnostic output: ${path}`);
          }
          unlinkSync(source);
        }
      } finally { closeSync(input); }
    }
    function visit(path: string, fd: number, screenshots: boolean) {
      for (const entry of readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) attempt(() => {
        const child = `${path}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Linked unit diagnostic: ${child}`);
        if (entry.isDirectory()) {
          if (!screenshots || !["node_modules", "dist"].includes(entry.name)) {
            const nested = openSync(at(fd, entry.name), directoryFlags);
            try { visit(child, nested, screenshots); } finally { closeSync(nested); }
          }
        } else if (entry.isFile()) {
          if (!screenshots || automaticScreenshot(child)) copy(child, fd, entry.name, screenshots);
        } else throw new Error(`Non-file unit diagnostic: ${child}`);
      });
    }
    for (const [paths, screenshots] of [[diagnosticRoots, false], [screenshotTrees, true]] as const) {
      for (const path of paths) attempt(() => {
        const fd = directory(path);
        if (fd !== undefined) try { visit(path, fd, screenshots); } finally { closeSync(fd); }
      });
    }
  } finally { closeSync(root); }
  if (errors.length) throw new AggregateError(errors, "Unit worker diagnostic preservation failed");
}

export async function runUnitWorkers(root: string, files: readonly string[], chrome: string | undefined, outputDirectory?: string, options: UnitWorkerOptions = {}) {
  if (options.preparedTree) return await bootstrapPreparedTree(root, files, chrome, outputDirectory, options);
  return await runWorkers(root, files, chrome, outputDirectory, options);
}

/** Only the freshly built template's live owner can enter this internal path. */
export async function runPreparedUnitWorkers(root: string, files: readonly string[], chrome: string | undefined, outputDirectory: string,
  options: UnitWorkerOptions, callerRoot: string, invocation: string) {
  const record = invocationBuild(root, selectBuildPackages(root).map(pkg => pkg.dir));
  if (!record || record.ownerPid !== process.pid || record.preparedSource) throw new Error("Missing live prepared unit tree owner");
  return await runWorkers(root, files, chrome, outputDirectory, options, callerRoot, invocation);
}

async function runWorkers(root: string, files: readonly string[], chrome: string | undefined, outputDirectory: string | undefined,
  options: UnitWorkerOptions, preparedCaller?: string, preparedInvocation?: string) {
  if (!options.changed && !files.length) throw new Error("Unit workers need discovered files");
  if (options.changed && files.length) throw new Error("Changed unit workers let Bun select files");
  const count = options.workers ?? (options.changed ? localUnitWorkerCount() : 2);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Unit worker count must be a positive integer");
  const reportDir = outputDirectory ?? (options.changed ? mkdtempSync(join(tmpdir(), "brain-import-graph-")) : join(root, "tmp"));
  if (options.changed && outputDirectory === undefined) console.log(`Unit queue reports: ${reportDir}`);
  const started = performance.now();
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  // Keep cloned test trees outside parent discovery and the native worker's
  // private /tmp. mkdtemp keeps this owned sibling container mode 0700.
  const container = mkdtempSync(join(dirname(root), ".brain-unit-workers-"));
  const head = git(root, "rev-parse", "HEAD");
  const partitions = options.changed ? Array.from({ length: count }, () => [] as string[]) : balanceTests([...files], Math.min(count, files.length));
  const workers: { root: string; files: string[]; checkout: string; device: number; inode: number; copiedInputs?: boolean;
    checkoutMs: number; dependencyCopyMs: number; overlay?: { upper: string; work: string; mounted: boolean } }[] = [];
  let inputs: ReturnType<typeof captureUnitInputs> | undefined;
  let checkoutMs = 0, dependencyCopyMs = 0;
  let selectedFiles: number | undefined = options.changed ? undefined : files.length;
  let references = new Map<string, string>();
  let objectFormat = "sha1";
  let diagnosticDirectory: string | undefined;
  function diagnosticDestination(index: number) {
    if (!diagnosticDirectory) {
      const base = join(realpathSync(reportDir), "unit-worker-diagnostics");
      const info = lstatSync(base, { throwIfNoEntry: false });
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("Unsafe unit diagnostic destination");
      if (!info) mkdirSync(base, { mode: 0o700 });
      // The source container's fresh name also identifies this invocation in the
      // upload. Exclusive creation refuses an existing or linked destination.
      const owned = join(base, basename(container));
      mkdirSync(owned, { mode: 0o700 });
      diagnosticDirectory = owned;
    }
    return join(diagnosticDirectory, `worker-${index + 1}`);
  }
  let primaryFailure: unknown;
  async function preserveReportsAndRemoveWorkers() {
    // runCommands waits for stopped children. Preserve every partial report
    // before removing only this invocation's clean, inactive worktrees.
    const cleanupFailures: unknown[] = [];
    const selectionReports: Array<{ selected?: number; preparationMs?: number | null; testMs?: number | null; elapsedMs?: number; exitCode?: number } | null> = [];
    for (const [index, worker] of workers.entries()) {
      try {
        for (const suffix of ["report.xml", "timings.json", "selection.json", "output.log"]) {
          const siblingLog = options.changed && suffix === "output.log";
          const path = siblingLog ? join(container, `${index + 1}-output.log`) : join(worker.root, `tmp/unit-${suffix}`);
          if (await Bun.file(path).exists()) {
            copyFileSync(path, join(reportDir, `unit-worker-${index + 1}-${suffix}`));
            if (siblingLog) unlinkSync(path);
          }
        }
        const workerTmp = join(worker.root, "tmp");
        if (existsSync(workerTmp)) for (const name of readdirSync(workerTmp)) {
          if (/^build-\d+-[0-9a-f-]{36}-probe\.json$/.test(name)) {
            copyFileSync(join(workerTmp, name), join(reportDir, `unit-worker-${index + 1}-${name}`));
          }
        }
      } catch (error) { cleanupFailures.push(error); }
      if (options.changed) try {
        const path = join(worker.root, "tmp/unit-selection.json");
        selectionReports[index] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
      } catch (error) { cleanupFailures.push(error); }
      try { preserveDiagnostics(worker, () => diagnosticDestination(index), references, objectFormat); }
      catch (error) { cleanupFailures.push(error); }
      try {
        if (worker.copiedInputs) inputs!.remove(worker.root);
        if (worker.overlay?.mounted) { command(["umount", "--", worker.root]); worker.overlay.mounted = false; }
        git(root, "worktree", "remove", worker.root);
        if (worker.overlay) { removeOverlayScratch(worker.overlay.upper); removeOverlayScratch(worker.overlay.work); }
      } catch (error) { cleanupFailures.push(error); }
    }
    if (options.changed) try { rmSync(join(container, "inputs"), { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    try { rmdirSync(container); } catch (error) { cleanupFailures.push(error); }
    try {
      const selections = workers.map((_, index) => selectionReports[index] ?? null);
      const observed = selections.map(value => value?.selected)
        .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
      const agreed = observed.length === workers.length && new Set(observed).size === 1 ? observed[0] : undefined;
      const preparation = selections.map(value => value?.preparationMs)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
      await Bun.write(join(reportDir, "unit-worker-summary.json"), JSON.stringify({ workers: workers.length, head,
        preparedInvocation,
        selectedFiles: selectedFiles ?? agreed, proofPassed: primaryFailure === undefined && cleanupFailures.length === 0,
        cleanupPassed: cleanupFailures.length === 0,
        elapsedMs: performance.now() - started, checkoutMs, dependencyCopyMs,
        preparationMs: preparation.length ? Math.max(...preparation) : null, selections: options.changed ? selections : undefined,
        workerPhases: workers.map((worker, index) => ({ worker: index + 1, checkoutMs: worker.checkoutMs,
          dependencyCopyMs: worker.dependencyCopyMs, preparationMs: selections[index]?.preparationMs ?? null,
          testMs: selections[index]?.testMs ?? null, invocationMs: selections[index]?.elapsedMs ?? null })) }, null, 2));
    } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) throw new AggregateError(primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      "Unit worker report/diagnostic preservation or cleanup failed");
  }

  try {
    const base = options.changed ? git(root, "rev-parse", "--verify", "--end-of-options", `${options.changed}^{commit}`) : undefined;
    if (base) inputs = captureUnitInputs(root, join(container, "inputs"));
    objectFormat = git(root, "rev-parse", "--show-object-format");
    // One immutable, bounded tree lookup per invocation; no Git process or
    // whole-repository walk per image. Unchanged tracked bytes are not evidence.
    // Pending source screenshots belong to the captured input just like tracked
    // references. Only newly produced automatic images may be removed after copy.
    references = diagnosticReferences(root, head, objectFormat, inputs, join(container, "inputs"));
    for (const [index, selected] of partitions.entries()) {
      const beforeCheckout = performance.now();
      const workspace = join(container, String(index + 1));
      git(root, "worktree", "add", "--quiet", "--detach", workspace, head);
      const identity = lstatSync(workspace);
      workers.push({ root: workspace, files: selected, checkout: git(workspace, "show", "-s", "--format=%H %T %P", "HEAD"), device: identity.dev, inode: identity.ino,
        checkoutMs: 0, dependencyCopyMs: 0 });
      const worker = workers[index]!;
      if (preparedCaller) {
        if (!inputs || /[,:\\\n]/.test(root + workspace)) throw new Error("Unsupported prepared overlay path");
        const gitfile = readFileSync(join(workspace, ".git"));
        const upper = join(container, `${index + 1}-upper`), work = join(container, `${index + 1}-work`);
        mkdirSync(upper, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
        worker.overlay = { upper, work, mounted: false };
        command(["mount", "-t", "overlay", "overlay", "-o", `userxattr,lowerdir=${root},upperdir=${upper},workdir=${work}`, workspace]);
        worker.overlay.mounted = true; worker.copiedInputs = true;
        const overlayIdentity = lstatSync(workspace); worker.device = overlayIdentity.dev; worker.inode = overlayIdentity.ino;
        writeFileSync(join(workspace, ".git"), gitfile);
        inputs.restoreIndex(workspace);
      } else if (inputs) { inputs.restore(workspace); worker.copiedInputs = true; }
      workers[index]!.checkoutMs = performance.now() - beforeCheckout;
    }
    checkoutMs = performance.now() - started;
    // Copy the parent's frozen install without a package-manager/network phase.
    // Relative workspace links retain their layout; copy-on-write still creates
    // private inodes. No worker shares mutable node_modules or build output.
    const dependencyDirs = preparedCaller ? [] : dependencyDirectories(root);
    const copying = performance.now();
    await runCommands(workers.flatMap((worker, index) => dependencyDirs.map(dir => ({
      name: `offline unit worker ${index + 1} dependency copy ${dir}`,
      argv: ["cp", "--archive", "--reflink=auto", join(root, dir), join(worker.root, dir)],
      completed: (elapsedMs: number) => { worker.dependencyCopyMs += elapsedMs; },
    }))), root, 2);
    dependencyCopyMs = performance.now() - copying;
    await Bun.write(join(reportDir, "unit-worker-checkouts.json"), JSON.stringify(workers.map(({ root: workspace, files, checkout }, index) => {
      const { dev, ino } = statSync(join(workspace, "node_modules/typescript/package.json"));
      return { worker: index + 1, workspace: relative(preparedCaller ?? root, workspace), files, checkout, dependency: { dev, ino },
        ...(base ? { changed: base, inputKey: inputs!.key, shard: `${index + 1}/${workers.length}` } : {}) };
    }), null, 2));
    for (const worker of workers) {
      mkdirSync(join(worker.root, "tmp/maintenance-ledger"), { recursive: true, mode: 0o700 });
      if (base) await Bun.write(join(worker.root, "tmp/unit-timings.json"), JSON.stringify(timingSeed(FILE_COST_SECONDS)));
    }
    await runCommands(workers.map((worker, index) => ({ name: `complete unit worker ${index + 1}/${workers.length}`,
      argv: ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount", "bash", join(root, "scripts/unit-worker-entry.sh"),
        join(worker.root, "tmp/maintenance-ledger"), process.execPath,
        ...(base ? [join(worker.root, "scripts/changed-unit-worker.ts"), base, `${index + 1}/${workers.length}`] :
          ["run", "--cwd", worker.root, "test", "--internal-full-preparation", ...worker.files.map(file => join(worker.root, file)),
            "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml", "--timings=tmp/unit-timings.json", "--update-timings"])],
      env: { BRAIN_REQUIRE_CHROME: "1", ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}),
        ...(preparedCaller ? preparedWorkerEnvironment(root, worker.root) : {}) } })), root, count);
    const reports = workers.map(worker => {
      // Dirty-input workers verify the complete snapshot during cleanup, after
      // the unchanged collector has handed off and removed automatic images.
      if (!inputs && git(worker.root, "status", "--porcelain", "--untracked-files=no")) throw new Error("Unit worker changed tracked source");
      const xml = readFileSync(join(worker.root, "tmp/unit-report.xml"), "utf8");
      const timings = JSON.parse(readFileSync(join(worker.root, "tmp/unit-timings.json"), "utf8"));
      let selection: { selected: number; assigned: number; preparationMs: number } | undefined;
      if (base) {
        selection = JSON.parse(readFileSync(join(worker.root, "tmp/unit-selection.json"), "utf8"));
        worker.files = Object.keys(timings.files ?? {});
      }
      return { xml, timings, selection, summary: validateUnitReports(worker.files, xml, timings, Boolean(base)) };
    });
    const totals = { tests: 0, failures: 0, skipped: 0, assertions: 0, time: 0 };
    for (const report of reports) {
      const tag = /<testsuites\b[^>]*>/.exec(report.xml)![0];
      for (const name of Object.keys(totals) as (keyof typeof totals)[]) {
        const raw = new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1];
        const value = Number(raw);
        if (raw === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Invalid worker ${name} total`);
        totals[name] += value;
      }
    }
    const xml = `<testsuites ${Object.entries(totals).map(([key, value]) => `${key}="${value}"`).join(" ")}>\n` +
      reports.map(report => report.xml.replace(/^[\s\S]*?<testsuites\b[^>]*>/, "").replace(/<\/testsuites>\s*$/, "")).join("\n") + "\n</testsuites>\n";
    const timings = { version: 1, files: Object.assign({}, ...reports.map(report => report.timings.files)) };
    const expected = base ? validateChangedUnitReports(reports) : files;
    validateUnitReports(expected, xml, timings, Boolean(base));
    await Bun.write(join(reportDir, "unit-report.xml"), xml);
    await Bun.write(join(reportDir, "unit-timings.json"), JSON.stringify(timings, null, 2));
    selectedFiles = expected.length;
    console.log(`Unit queue reconciled ${expected.length} files exactly once across ${workers.length} workers`);
  } catch (error) { primaryFailure = error; throw error; } finally {
    await preserveReportsAndRemoveWorkers();
  }
}

async function bootstrapPreparedTree(root: string, files: readonly string[], chrome: string | undefined,
  outputDirectory: string | undefined, options: UnitWorkerOptions) {
  if (!options.changed || files.length) throw new Error("Prepared unit trees require Bun changed selection");
  const count = options.workers ?? localUnitWorkerCount();
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Unit worker count must be a positive integer");
  const started = performance.now(), head = git(root, "rev-parse", "HEAD"), invocation = randomUUID();
  git(root, "rev-parse", "--verify", "--end-of-options", `${options.changed}^{commit}`);
  const objectFormat = git(root, "rev-parse", "--show-object-format");
  const reportDir = outputDirectory ?? mkdtempSync(join(tmpdir(), "brain-import-graph-"));
  mkdirSync(reportDir, { recursive: true });
  const container = mkdtempSync(join(dirname(root), ".brain-unit-prepared-")), template = join(container, "tree");
  let inputs: ReturnType<typeof captureUnitInputs> | undefined;
  let references = new Map<string, string>();
  let created = false, identity: { device: number; inode: number } | undefined;
  let helperStarted = false;
  let checkoutMs = 0, dependencyCopyMs = 0, primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  async function finishPreparedTree() {
    let setup: { preparationMs?: number; cleanupPassed?: boolean } = {};
    let summary: Record<string, unknown> = {};
    try {
      const path = join(reportDir, "unit-prepared-setup.json");
      if (existsSync(path)) { const candidate = JSON.parse(readFileSync(path, "utf8")); if (candidate.invocation === invocation) setup = candidate; }
      const result = join(reportDir, "unit-worker-summary.json");
      if (existsSync(result)) { const candidate = JSON.parse(readFileSync(result, "utf8")); if (candidate.preparedInvocation === invocation) summary = candidate; }
      if (created && identity) {
        for (const name of existsSync(join(template, "tmp")) ? readdirSync(join(template, "tmp")) : []) if (/^build-\d+-[0-9a-f-]{36}-probe\.json$/.test(name)) {
          copyFileSync(join(template, "tmp", name), join(reportDir, `unit-prepared-${name}`));
        }
        let destination: string | undefined;
        preserveDiagnostics({ root: template, ...identity }, () => destination ??= mkdtempSync(join(realpathSync(reportDir), "unit-prepared-diagnostics-")), references, objectFormat);
        if (helperStarted && setup.cleanupPassed !== true) throw new Error(`Prepared unit tree retained after incomplete cleanup: ${template}`);
        inputs!.remove(template); git(root, "worktree", "remove", template); created = false;
      }
      rmSync(join(container, "inputs"), { recursive: true, force: true }); rmdirSync(container);
    } catch (error) { cleanupFailures.push(error); }
    try {
      await Bun.write(join(reportDir, "unit-worker-summary.json"), JSON.stringify({ ...summary, workers: count, head, preparedInvocation: invocation,
        proofPassed: primaryFailure === undefined && cleanupFailures.length === 0,
        cleanupPassed: !created && cleanupFailures.length === 0, elapsedMs: performance.now() - started,
        preparedTree: { checkoutMs, dependencyCopyMs, preparationMs: setup.preparationMs ?? null } }, null, 2));
    } catch (error) { cleanupFailures.push(error); }
  }
  try {
    inputs = captureUnitInputs(root, join(container, "inputs"));
    references = diagnosticReferences(root, head, objectFormat, inputs, join(container, "inputs"));
    git(root, "worktree", "add", "--quiet", "--detach", template, head); created = true;
    const info = lstatSync(template); identity = { device: info.dev, inode: info.ino };
    inputs.restore(template); checkoutMs = performance.now() - started;
    const copying = performance.now();
    await runCommands(dependencyDirectories(root).map(dir => ({ name: `prepared unit tree dependency copy ${dir}`,
      argv: ["cp", "--archive", "--reflink=auto", join(root, dir), join(template, dir)] })), root, 2);
    dependencyCopyMs = performance.now() - copying;
    helperStarted = true;
    await runCommands([{ name: "prepared unit tree and private views", argv: ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount",
      process.execPath, join(import.meta.dir, "unit-prepared-tree.ts"), template, root, reportDir, JSON.stringify(options), JSON.stringify(files), chrome ?? "", invocation] }], root, 1, 30_000);
  } catch (error) { primaryFailure = error; }
  finally { await finishPreparedTree(); }
  if (cleanupFailures.length) throw new AggregateError(primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures], "Prepared unit tree cleanup failed");
  if (primaryFailure !== undefined) throw primaryFailure;
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const options: UnitWorkerOptions = {}, files: string[] = [];
    let reportDir: string | undefined;
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith("--changed=")) options.changed = arg.slice("--changed=".length);
      else if (/^--workers=[1-9]\d*$/.test(arg)) options.workers = Number(arg.slice("--workers=".length));
      else if (arg.startsWith("--reports=")) reportDir = resolve(root, arg.slice("--reports=".length));
      else if (arg === "--prepared-tree") options.preparedTree = true;
      else if (arg.startsWith("-")) throw new Error("Expected unit-workers [files] [--changed=<base>] [--workers=N] [--reports=<directory>] [--prepared-tree]");
      else files.push(relative(root, arg));
    }
    // Local failure logs contain machine paths. Keep those private artifacts
    // outside the public tree; hosted callers retain their existing destination.
    if (options.changed && reportDir === undefined) reportDir = mkdtempSync(join(tmpdir(), "brain-import-graph-"));
    if (reportDir) console.log(`Unit queue reports: ${reportDir}`);
    await runUnitWorkers(root, files, process.env.PUPPETEER_EXECUTABLE_PATH, reportDir, options);
  } catch (error) { console.error(error); process.exit(1); }
}
