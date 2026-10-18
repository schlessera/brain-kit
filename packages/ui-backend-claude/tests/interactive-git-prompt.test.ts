/** Real interactive preset requests, with only loopback available. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
test("interactive git context stays absent across changed repository and resumed turns for both billing modes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "interactive-git-prompt-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/interactive-git-prompt-probe.ts"), scratch],
      { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(out);
    expect(exit, err || out).toBe(0);
    const requests = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    expect(requests).toHaveLength(4);
    for (const q of requests) {
      expect(JSON.stringify(q).includes("odysseus-cache-branch"), "GIT_STATUS_ABSENT").toBe(false);
      expect(JSON.stringify(q).includes("Odysseus cache first commit"), "GIT_COMMITS_ABSENT").toBe(false);
      expect(JSON.stringify(q).includes("Odysseus cache changed commit"), "GIT_COMMITS_ABSENT").toBe(false);
    }
    for (const start of [0, 2]) {
      expect(JSON.stringify(requests[start + 1].tools), "TOOLS_BYTE_IDENTICAL").toBe(JSON.stringify(requests[start].tools));
      expect(JSON.stringify(requests[start + 1].system), "SYSTEM_BYTE_IDENTICAL").toBe(JSON.stringify(requests[start].system));
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
