/** Actual shipped CLI, with a fixed fixture date and no provider/account environment. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lab } from "./prototype";

export interface CliReceipt { args: string[]; code: number; stdout: string; stderr: string; durationMs: number }
export async function cli(lab: Lab, args: string[]): Promise<CliReceipt> {
  const home = mkdtempSync(join(tmpdir(), "brain-lifecycle-cli-home-"));
  const start = performance.now();
  try {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixture-clock.ts"),
      join(import.meta.dir, "../../../packages/core/src/cli/brain.ts"), ...args], {
      cwd: lab.root,
      env: { HOME: home, BRAIN_ROOT: lab.root, TZ: "UTC", PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: home, XDG_CONFIG_HOME: home, PI_CODING_AGENT_DIR: home },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { args: [...args], code, stdout, stderr, durationMs: performance.now() - start };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

export function successful(receipt: CliReceipt) {
  if (receipt.code !== 0) throw new Error(`actual CLI ${receipt.args.join(" ")} exited ${receipt.code}: ${receipt.stderr}`);
  return receipt;
}
