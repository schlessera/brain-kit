import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("pi tool subprocess environments", () => {
  test("grep and bash strip server-only secrets while preserving agent and git credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subprocess-env-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const grep = join(bin, "grep");
      writeFileSync(
        grep,
        "#!/bin/sh\n" +
          'printf "%s|%s|%s|%s" "${COOKIE_SECRET-unset}" "$CLAUDE_CODE_OAUTH_TOKEN" "$GITHUB_TOKEN" "$BRAIN_UI_SYNC_GITHUB_TOKEN"\n',
        "utf-8"
      );
      chmodSync(grep, 0o755);

      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures/subprocess-env-probe.ts"), root],
        {
          env: {
            ...process.env,
            PATH: bin + ":" + (process.env.PATH ?? ""),
            COOKIE_SECRET: "server-only-test-secret",
            CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
            GITHUB_TOKEN: "github-test-token",
            BRAIN_UI_SYNC_GITHUB_TOKEN: "sync-test-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);

      const output = JSON.parse(stdout.trim()) as { grep: string; bash: string };
      const expected = "unset|oauth-test-token|github-test-token|sync-test-token";
      expect(output.grep).toBe(expected);
      expect(output.bash).toContain(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
