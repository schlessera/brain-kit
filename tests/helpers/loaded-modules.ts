/**
 * Which modules did a process evaluate? Runs a command in a child Bun process
 * under `loaded-modules-recorder.ts` and resolves to the child's exit code,
 * output and the modules it loaded. The list is an observation of one
 * invocation: it proves the load set for the `argv` that ran, nothing more.
 *
 * What the list holds (pinned by `tests/loaded-modules.test.ts`): every module
 * whose evaluation completed, through a static import or `import()`, including
 * files under `node_modules`. A module imported with `import type`, or whose
 * imported names are used only as types, is never evaluated. A module whose
 * evaluation did not complete is absent, with every importer still evaluating
 * at that moment: an entry that calls `process.exit` at top level is missing
 * while the dependencies it finished loading are present. So an absence is
 * evidence only beside a run that proves the module would have been listed.
 *
 * Files inside the repository are reported as repo-relative paths, everything
 * else as resolved. The recorder and its generated preload are left out.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { watchdogMs } from "../../scripts/test-deadlines";

const REPO_ROOT = realpathSync(resolve(import.meta.dir, "../.."));
const RECORDER = realpathSync(join(import.meta.dir, "loaded-modules-recorder.ts"));

export interface LoadedModulesOptions {
  /** The child's working directory. */
  cwd: string;
  /**
   * The child's complete environment: nothing from the parent's is added. A
   * caller running the `brain` CLI passes `keylessEnv(root)` so the child has a
   * test-owned home, XDG roots and `PATH`.
   */
  env: Record<string, string>;
  /** Written to the child's stdin, which is then closed. Default: empty. */
  stdin?: string;
  /** Milliseconds before a child that has not exited is killed, scaled by `watchdogMs`. Default 20 s. */
  watchdog?: number;
}

export interface LoadedModulesRun {
  code: number;
  stdout: string;
  stderr: string;
  /** The modules the child loaded, sorted. */
  modules: string[];
}

/** Run `bun <argv>` with the recorder preloaded and report what it loaded. */
export async function runLoadedModules(argv: readonly string[], options: LoadedModulesOptions): Promise<LoadedModulesRun> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brain-loaded-modules-")));
  try {
    const output = join(dir, "modules.json");
    const preload = join(dir, "preload.ts");
    writeFileSync(preload, `import { recordLoadedModules } from ${JSON.stringify(RECORDER)};\nrecordLoadedModules(${JSON.stringify(output)});\n`);
    const child = Bun.spawn([process.execPath, "--preload", preload, ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(options.stdin ?? "");
    await child.stdin.end();
    const ms = watchdogMs(options.watchdog ?? 20_000);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ms);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(watchdog));
    if (timedOut) throw new Error(`bun ${argv.join(" ")} (pid ${child.pid}) did not exit within ${ms} ms and was killed`);
    let recorded: string[];
    try {
      recorded = JSON.parse(readFileSync(output, "utf8")) as string[];
    } catch (cause) {
      throw new Error(`bun ${argv.join(" ")} exited ${code} without recording its modules: ${stderr}`, { cause });
    }
    const modules = recorded
      .filter((path) => path !== RECORDER && path !== preload)
      .map((path) => (path.startsWith(REPO_ROOT + sep) ? relative(REPO_ROOT, path) : path))
      .sort();
    return { code, stdout, stderr, modules };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
