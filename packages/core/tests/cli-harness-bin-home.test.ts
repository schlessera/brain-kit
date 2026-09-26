/**
 * The CLI harness points XDG_BIN_HOME at a throwaway directory, so a test that
 * runs `brain setup` or `brain doctor --fix` links `brain` there and never
 * replaces the developer's own `~/.local/bin/brain` (#507).
 */

import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { cleanup, makeTempBrain, runCli, testBinHome } from "./cli-harness";

const REPO_NODE_MODULES = resolve(import.meta.dir, "../../../node_modules");
const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

test("doctor --fix links brain under the harness's XDG_BIN_HOME, not ~/.local/bin", async () => {
  const root = makeTempBrain();
  temps.push(root);
  // A node_modules with its own .bin/brain, so installBinLinks has a target.
  rmSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  for (const entry of readdirSync(REPO_NODE_MODULES)) {
    if (entry !== ".bin") symlinkSync(join(REPO_NODE_MODULES, entry), join(root, "node_modules", entry));
  }
  const target = join(root, "node_modules", ".bin", "brain");
  writeFileSync(target, "#!/bin/sh\n");
  // The MCP check passes from project config, so doctor never probes (or --fix
  // never registers with) a host `claude`.
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  // A broken skill link fails the symlinks check, which is what makes --fix link the bin.
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  symlinkSync(join(root, "nowhere"), join(root, ".claude", "skills", "ghost"));

  // The child gets a throwaway HOME holding a sentinel where ~/.local/bin/brain
  // would be. If the harness default ever stops applying, --fix relinks the
  // sentinel, not the developer's own link, and the last assertion fails.
  const home = mkdtempSync(join(tmpdir(), "brain-sentinel-home-"));
  temps.push(home);
  const sentinelTarget = join(home, "sentinel-brain");
  writeFileSync(sentinelTarget, "#!/bin/sh\n");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const sentinel = join(home, ".local", "bin", "brain");
  symlinkSync(sentinelTarget, sentinel);

  const link = join(testBinHome(), "brain");
  rmSync(link, { force: true });
  // A developer's own XDG_BIN_HOME would otherwise be what the child inherits
  // once the harness default is gone, so it is deleted from the environment
  // the harness copies (not overridden), and the sentinel HOME is all that is left.
  const inherited = process.env.XDG_BIN_HOME;
  delete process.env.XDG_BIN_HOME;
  let run;
  try {
    run = await runCli(root, ["doctor", "--fix", "--json"], { HOME: home });
  } finally {
    if (inherited !== undefined) process.env.XDG_BIN_HOME = inherited;
  }
  const { stdout, code, stderr } = run;
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout).fixesApplied).toContain("symlinks");

  expect(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(readlinkSync(sentinel)).toBe(sentinelTarget);
});
