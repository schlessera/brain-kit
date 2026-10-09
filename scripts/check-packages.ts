/** Run the authoritative pack job locally without copying its consumer probes. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runCommands } from "./ci-runner";

export function packCommands(root: string): Array<{ name: string; run: string }> {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: { pack: { steps: Array<{ name?: string; run?: string }> } };
  };
  const commands = workflow.jobs.pack.steps.flatMap(step => step.run ? [{ name: step.name ?? step.run, run: step.run }] : []);
  if (!commands.length) throw new Error("The pack job has no executable checks");
  if (commands.some(command => command.run.includes("${{"))) throw new Error("Local pack commands cannot interpolate CI expressions");
  return commands;
}

export async function checkPackages(root: string): Promise<void> {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: { pack: { steps: Array<{ uses?: string; with?: { "node-version"?: string } }> } };
  };
  const required = workflow.jobs.pack.steps.find(step => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"];
  if (required) {
    const node = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
    const actual = new TextDecoder().decode(node.stdout).trim().replace(/^v/, "");
    if (node.exitCode !== 0 || !Bun.semver.satisfies(actual, `>=${required}.0.0`)) {
      throw new Error(`Packed local proof requires Node >=${required} (installed: ${actual || "unavailable"})`);
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), "brainkit-pack-"));
  try {
    for (const command of packCommands(root)) await runCommands([
      { name: command.name, argv: ["bash", "-e", "-o", "pipefail", "-c", command.run], env: { RUNNER_TEMP: temporary } },
    ], root);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try { await checkPackages(resolve(import.meta.dir, "..")); }
  catch (error) { console.error(error); process.exit(1); }
}
