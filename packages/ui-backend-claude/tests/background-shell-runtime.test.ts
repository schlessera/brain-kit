import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

test("installed Claude refuses background Bash and replays native orphan notifications with provenance", async () => {
  const root = resolve(import.meta.dir, "../../.."), scratch = mkdtempSync("/tmp/odysseus-background-proof-");
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/background-shell-probe.ts"), scratch],
      { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    expect(out).toContain("NATIVE_BACKGROUND_AND_NOTIFICATION_PROOF_PASSED");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 90_000);
