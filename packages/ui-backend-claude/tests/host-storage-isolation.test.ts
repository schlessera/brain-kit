/** Exercise the actual test preload and turns against a disposable invoking home. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeHomeSnapshot } from "../../../scripts/test-home";

const workspace = resolve(import.meta.dir, "../../..");
test("the shared preload keeps default and explicit-profile turns out of the invoking Claude home", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-isolation-"));
  const home = join(root, "invoking-home"), config = join(home, ".claude");
  mkdirSync(config, { recursive: true });
  const sentinel = join(config, "sentinel");
  writeFileSync(sentinel, "Ithaca\n");
  const baseline = claudeHomeSnapshot(home);
  try {
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", "--preload",
      join(workspace, "scripts/test-network-preload.ts"), join(import.meta.dir, "fixtures/host-storage-isolation.test.ts")], {
      cwd: workspace, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, ODYSSEUS_ISOLATION_REPORT: join(root, "report.json") },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    expect(claudeHomeSnapshot(home), "INVOKING_CLAUDE_HOME_UNCHANGED").toBe(baseline);
    expect(readFileSync(sentinel, "utf8")).toBe("Ithaca\n");
    const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
    expect(report.records).toEqual([1, 1, 1]);
    expect(report.storageWasOwned).toBe(true);
    expect(existsSync(report.home)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
