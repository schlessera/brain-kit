/** Concurrent serial Bun processes, each owning its source/dependencies/build lease. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCommands } from "./ci-runner";
import { balanceTests } from "./test-shards";
import { validateUnitReports } from "./unit-proof-report";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Unit workspace git failed: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

export async function runUnitWorkers(root: string, files: readonly string[], chrome: string | undefined, reportDir = join(root, "tmp")) {
  if (!files.length) throw new Error("Unit workers need discovered files");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  // Keep cloned test trees outside parent discovery and the native worker's
  // private /tmp. mkdtemp keeps this owned sibling container mode 0700.
  const container = mkdtempSync(join(dirname(root), ".brain-unit-workers-"));
  const head = git(root, "rev-parse", "HEAD");
  const partitions = balanceTests([...files], Math.min(2, files.length));
  const workers: { root: string; files: string[]; checkout: string }[] = [];
  try {
    for (const [index, selected] of partitions.entries()) {
      const workspace = join(container, String(index + 1));
      git(root, "worktree", "add", "--quiet", "--detach", workspace, head);
      workers.push({ root: workspace, files: selected, checkout: git(workspace, "show", "-s", "--format=%H %T %P", "HEAD") });
    }
    // Copy the parent's frozen install without a package-manager/network phase.
    // Relative workspace links retain their layout; copy-on-write still creates
    // private inodes. No worker shares mutable node_modules or build output.
    const dependencyDirs = ["node_modules", ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/node_modules`)]
      .filter(dir => existsSync(join(root, dir)));
    if (!dependencyDirs.includes("node_modules")) throw new Error("Unit workers need the parent's frozen dependency install");
    await runCommands(workers.flatMap((worker, index) => dependencyDirs.map(dir => ({
      name: `offline unit worker ${index + 1} dependency copy ${dir}`,
      argv: ["cp", "--archive", "--reflink=auto", join(root, dir), join(worker.root, dir)],
    }))), root, 2);
    await Bun.write(join(reportDir, "unit-worker-checkouts.json"), JSON.stringify(workers.map(({ root: workspace, files, checkout }, index) => {
      const { dev, ino } = statSync(join(workspace, "node_modules/typescript/package.json"));
      return { worker: index + 1, workspace: relative(root, workspace), files, checkout, dependency: { dev, ino } };
    }), null, 2));
    await runCommands(workers.map((worker, index) => ({ name: `unit worker ${index + 1} private package build`,
      argv: [process.execPath, "run", "--cwd", worker.root, "build"] })), root, 2);
    for (const worker of workers) mkdirSync(join(worker.root, "tmp/maintenance-ledger"), { recursive: true, mode: 0o700 });
    await runCommands(workers.map((worker, index) => ({ name: `complete unit worker ${index + 1}/${workers.length}`,
      argv: ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount", "bash", join(root, "scripts/unit-worker-entry.sh"),
        join(worker.root, "tmp/maintenance-ledger"), process.execPath, "run", "--cwd", worker.root, "test", ...worker.files.map(file => join(worker.root, file)),
        "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml", "--timings=tmp/unit-timings.json", "--update-timings"],
      env: { BRAIN_REQUIRE_CHROME: "1", ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}) } })), root, 2);
    const reports = workers.map(worker => {
      if (git(worker.root, "status", "--porcelain", "--untracked-files=no")) throw new Error("Unit worker changed tracked source");
      const xml = readFileSync(join(worker.root, "tmp/unit-report.xml"), "utf8");
      const timings = JSON.parse(readFileSync(join(worker.root, "tmp/unit-timings.json"), "utf8"));
      return { xml, timings, summary: validateUnitReports(worker.files, xml, timings) };
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
    validateUnitReports(files, xml, timings);
    await Bun.write(join(reportDir, "unit-report.xml"), xml);
    await Bun.write(join(reportDir, "unit-timings.json"), JSON.stringify(timings, null, 2));
  } finally {
    // runCommands waits for stopped children. Preserve every partial report
    // before removing only this invocation's clean, inactive worktrees.
    for (const [index, worker] of workers.entries()) {
      for (const suffix of ["report.xml", "timings.json"]) {
        const path = join(worker.root, `tmp/unit-${suffix}`);
        if (await Bun.file(path).exists()) copyFileSync(path, join(reportDir, `unit-worker-${index + 1}-${suffix}`));
      }
      const workerTmp = join(worker.root, "tmp");
      if (existsSync(workerTmp)) for (const name of readdirSync(workerTmp)) {
        if (/^build-\d+-[0-9a-f-]{36}-probe\.json$/.test(name)) {
          copyFileSync(join(workerTmp, name), join(reportDir, `unit-worker-${index + 1}-${name}`));
        }
      }
      git(root, "worktree", "remove", worker.root);
    }
    rmdirSync(container);
  }
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    await runUnitWorkers(root, process.argv.slice(2).map(file => relative(root, file)), process.env.PUPPETEER_EXECUTABLE_PATH);
  } catch (error) { console.error(error); process.exit(1); }
}
