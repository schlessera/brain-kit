/**
 * Runs test files the way the repository runs them, and reports each case.
 *
 * Bun tiers go through the root wrapper (`scripts/test.ts`), which supplies
 * the preload, the 30 s timeout and host admission for heavy files. Browser
 * tiers go through the pinned container (`scripts/visual.mjs`); that path
 * needs Docker, and reports an exit code and output but no case durations.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseJunit, type CaseResult } from "./junit";

export interface RunRequest {
  files: string[];
  /** Run only cases whose name contains this text. */
  name?: string;
  /** Randomize case order with this seed (Bun tiers only). */
  seed?: number;
  /** Vitest projects, for the browser runner. */
  projects?: string[];
}
export interface RunOutput { exitCode: number; wallMs: number; cases: CaseResult[]; output: string }
export type TestRunner = (request: RunRequest) => Promise<RunOutput>;

export const DEFAULT_BUN_COMMAND: readonly string[] = ["bun", "scripts/test.ts", "--timeout", "30000"];
const OUTPUT_LIMIT = 200_000;

async function spawn(command: string[], cwd: string): Promise<{ exitCode: number; wallMs: number; output: string }> {
  const started = performance.now();
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const output = `${stdout}\n${stderr}`;
  return { exitCode, wallMs: Math.round(performance.now() - started), output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function bunRunner(root: string, scratch: string, command: readonly string[] = DEFAULT_BUN_COMMAND): TestRunner {
  let sequence = 0;
  return async request => {
    mkdirSync(scratch, { recursive: true });
    const report = join(scratch, `junit-${process.pid}-${sequence++}.xml`);
    const args = [...command, ...request.files.map(file => `./${file}`), "--reporter=junit", `--reporter-outfile=${report}`,
      ...(request.name ? ["-t", escapeRegex(request.name)] : []),
      ...(request.seed === undefined ? [] : ["--randomize", `--seed=${request.seed}`])];
    const run = await spawn(args, root);
    const cases = existsSync(report) ? parseJunit(readFileSync(report, "utf8")) : [];
    rmSync(report, { force: true });
    return { ...run, cases: cases.map(entry => ({ ...entry, file: entry.file.replace(/^\.\//, "") })) };
  };
}

export function visualRunner(root: string): TestRunner {
  return async request => {
    if (!request.projects?.length) throw new Error("The browser runner needs the Vitest project of each file");
    const filters = request.files.map(file => `--filter=${file.split("/").pop()!.replace(/\.tsx?$/, "")}`);
    const run = await spawn(["node", "scripts/visual.mjs", ...request.projects.map(project => `--project=${project}`), ...filters], root);
    return { ...run, cases: [] };
  };
}
