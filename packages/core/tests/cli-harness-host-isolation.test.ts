/** Exercise the real CLI boundary with hostile, entirely fictional host state (#660). */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliResult } from "./cli-harness";

const HARNESS = join(import.meta.dir, "cli-harness.ts");

for (const entry of ["runCli", "keylessEnv"] as const) {
  test(`${entry}: doctor never starts the outer Claude sentinel`, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "brain-host-sentinel-"));
    try {
      const home = join(fixture, "home");
      const bin = join(fixture, "bin");
      mkdirSync(home);
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "bun"));
      symlinkSync(Bun.which("git")!, join(bin, "git"));
      const calls = join(fixture, "calls");
      const sentinel = join(bin, "claude");
      writeFileSync(sentinel, '#!/bin/sh\nprintf "outer-claude\\n" >> "$FIXTURE_CALLS"\n', { mode: 0o755 });
      // A populated host config with no brain registration makes doctor reach
      // command discovery if either entry forgets the controlled PATH.
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { unrelated: {} } }));
      const env = { PATH: bin, HOME: home, FIXTURE_CALLS: calls };
      const control = Bun.spawnSync([sentinel, "mcp", "list"], { env });
      expect(control.exitCode).toBe(0);
      expect(readFileSync(calls, "utf8")).toBe("outer-claude\n");
      rmSync(calls);

      const program = `
        import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from ${JSON.stringify(HARNESS)};
        const root = makeTempBrain();
        try {
          const results = [];
          for (const args of [["doctor", "--json"], ["doctor", "--fix", "--json"]]) {
            if (${JSON.stringify(entry)} === "runCli") results.push(await runCli(root, args));
            else {
              const child = Bun.spawn(["bun", BRAIN_BIN, ...args], {
                env: keylessEnv(root), stdout: "pipe", stderr: "pipe", stdin: "ignore",
              });
              const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
              ]);
              results.push({ stdout, stderr, code });
            }
          }
          console.log(JSON.stringify(results));
        } finally { cleanup(root); }
      `;
      const proc = Bun.spawn([process.execPath, "-e", program], { env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      // This observation fails with the old harness, even though doctor exits 0.
      expect(existsSync(calls), "the outer Claude sentinel must never execute").toBe(false);
      const results: CliResult[] = JSON.parse(stdout);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).checks.find((check: { id: string }) => check.id === "mcp"))
          .toMatchObject({ status: "warn", detail: expect.stringContaining("could not determine MCP registration") });
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("doctor ignores a populated outer HOME and child configuration directories are test-owned", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "brain-host-config-"));
  try {
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    symlinkSync(Bun.which("git")!, join(bin, "git"));
    // This is a real registration branch, with a deliberately nonexistent
    // source file. Leaking HOME changes the doctor's actual mcp verdict.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { brain: { command: "bun", args: [join(home, "missing-server.ts")] } },
    }));
    const configKeys = ["HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
    const env = Object.fromEntries(configKeys.map(key => [key, home]));
    env.PATH = bin;
    const program = `
      import { cleanup, keylessEnv, makeTempBrain, runCli } from ${JSON.stringify(HARNESS)};
      const root = makeTempBrain();
      try {
        const result = await runCli(root, ["doctor", "--json"]);
        const child = Bun.spawn(["bun", "-e", ${JSON.stringify(`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(configKeys)}.map(key => [key, process.env[key]]))))`)}], {
          env: keylessEnv(root), stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        console.log(JSON.stringify({ result, config: { stdout, stderr, code } }));
      } finally { cleanup(root); }
    `;
    const proc = Bun.spawn([process.execPath, "-e", program], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    const { result, config }: { result: CliResult; config: CliResult } = JSON.parse(stdout);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).checks.find((check: { id: string }) => check.id === "mcp"))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("could not determine MCP registration") });
    expect(config.code, config.stderr).toBe(0);
    const dirs = JSON.parse(config.stdout);
    expect(Object.keys(dirs).sort()).toEqual([...configKeys].sort());
    for (const key of configKeys) {
      expect(dirs[key], key).not.toBe(home);
      expect(dirs[key], key).toContain("brain-test-home-");
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
