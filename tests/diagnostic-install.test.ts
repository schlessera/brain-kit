import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { join } from "node:path";

test("diagnostic installs avoid modified cache bytes and isolate diagnostic edits", async () => {
  // The installer is native code, outside the JS network preload. Give the
  // entire local registry/install fixture a real network namespace instead.
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    process.execPath, join(import.meta.dir, "fixtures/diagnostic-install-probe.ts")], {
    env: { ...process.env, DIAGNOSTIC_PARENT_NET: readlinkSync("/proc/self/ns/net") }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, out + err).toBe(0);
  expect(out).toContain("diagnostic isolation and provenance passed");
});
