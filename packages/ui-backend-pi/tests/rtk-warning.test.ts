import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi rewritten bash commands suppress the hook warning in a fresh worker home", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rtk-warning-"));
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
printf 'suppression=%s\n' "\${RTK_SUPPRESS_HOOK_WARNING-unset}" >&2
printf '%s\n' 'Odysseus command error' >&2
exit 7
`);
    chmodSync(binary, 0o755);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/rtk-warning-probe.ts"), root], {
      env: { ...process.env, HOME: home, PATH: `${root}:/usr/bin:/bin`, RTK_SUPPRESS_HOOK_WARNING: "0" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(out, "PI_WORKER_HOOK_WARNING_SUPPRESSED").not.toContain("No hook installed");
    expect(out).toContain("suppression=1");
    expect(out).toContain("Odysseus command error");
    expect(out).toContain("[exit 7]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
