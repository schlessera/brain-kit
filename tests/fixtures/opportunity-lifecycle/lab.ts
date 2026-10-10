/**
 * Disk-backed brain and CLI runner for `tests/opportunity-cli-agreement.test.ts`.
 * The documents were authored for the #845 opportunity-lifecycle spike; they
 * are kept in the state an interview booked for 2026-07-20 leaves them in.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DAY = "2026-07-12";
const ROOT = join(import.meta.dir, "../../..");
export const doc = (type: string, title: string, extra = "", body = "") =>
  `---\ntype: ${type}\ntitle: ${title}\ncreated: ${DAY}\nupdated: ${DAY}\nstatus: active\nrelevance: primary\ntags: [job-search]\n${extra}---\n\n${body}`;

/** A fresh brain with the repo's node_modules linked, so configured modules resolve. */
export function createLab(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "brain-lifecycle-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

export interface CliReceipt { args: string[]; code: number; stdout: string; stderr: string }
/** The shipped CLI in a child pinned to the fixture date, with no provider or account environment. */
export async function cli(root: string, args: string[]): Promise<CliReceipt> {
  const home = mkdtempSync(join(tmpdir(), "brain-lifecycle-cli-home-"));
  try {
    const child = Bun.spawn([process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      "--preload", join(import.meta.dir, "fixture-clock.ts"), join(ROOT, "packages/core/src/cli/brain.ts"), ...args], {
      cwd: root,
      env: { HOME: home, BRAIN_ROOT: root, TZ: "UTC", PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: home, XDG_CONFIG_HOME: home, PI_CODING_AGENT_DIR: home },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { args: [...args], code, stdout, stderr };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

export function successful(receipt: CliReceipt) {
  if (receipt.code !== 0) throw new Error(`actual CLI ${receipt.args.join(" ")} exited ${receipt.code}: ${receipt.stderr}`);
  return receipt;
}
