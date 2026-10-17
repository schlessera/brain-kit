import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnEnv } from "../src/sdk-options.js";
import { resetRtkProbe, rtkRewriteCommand } from "../../ui-sdk/src/server/rtk.js";

test("Claude rewritten commands suppress the hook warning in a fresh worker home", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-rtk-warning-"));
  const previousPath = process.env.PATH;
  try {
    const home = join(root, "home"); mkdirSync(home);
    const binary = join(root, "rtk");
    writeFileSync(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "hook" ]; then
  cat >/dev/null
  printf '%s\n' '{"hookSpecificOutput":{"updatedInput":{"command":"${binary} git status"}}}'
  exit 0
fi
if [ "\${RTK_SUPPRESS_HOOK_WARNING-unset}" != "1" ]; then
  printf '%s\n' '[rtk] No hook installed — run rtk init -g' >&2
fi
printf '%s\n' 'Odysseus command error' >&2
exit 7
`);
    chmodSync(binary, 0o755);
    process.env.PATH = `${root}:/usr/bin:/bin`;
    resetRtkProbe();
    const env = turnEnv({ id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({ HOME: home, RTK_SUPPRESS_HOOK_WARNING: "0" }) });
    const command = await rtkRewriteCommand("git status", env);
    expect(command).toBe(`${binary} git status`);
    const child = Bun.spawn(["/bin/bash", "-c", command], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(7);
    expect(out + err, "CLAUDE_WORKER_HOOK_WARNING_SUPPRESSED").not.toContain("No hook installed");
    expect(err).toContain("Odysseus command error");
    expect(env.RTK_SUPPRESS_HOOK_WARNING).toBe("1");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    resetRtkProbe(); rmSync(root, { recursive: true, force: true });
  }
});
