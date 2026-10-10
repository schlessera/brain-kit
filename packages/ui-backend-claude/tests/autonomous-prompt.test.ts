/** Inspect the installed SDK/CLI's request bytes in an offline namespace. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
test("restricted turns keep the marked trusted prefix identical across item and ambient changes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "autonomous-prompt-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/autonomous-prompt-probe.ts"), scratch],
      { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const requests = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    const prefixes: string[] = [];
    for (const [index, q] of requests.entries()) {
      const blocks = q.system as Array<{ text: string; cache_control?: { type: string; scope?: string; ttl?: string } }>;
      const fixed = blocks.findIndex(b => b.text.includes("brain-kit autonomous instructions v1"));
      expect(fixed, "TRUSTED_PREFIX_PRESENT in actual provider bytes").toBeGreaterThanOrEqual(0);
      expect(blocks[fixed].cache_control, "STATIC_CACHE_MARKING").toMatchObject({ type: "ephemeral" });
      const prefix = JSON.stringify({ tools: q.tools, system: blocks });
      prefixes.push(prefix);
      const dynamic = `ITEM-CONTEXT-${index}: budget=${index + 1}; attempt=${index}; timestamp=2026-07-12T0${index}:00:00Z`;
      expect(prefix, "DYNAMIC_AFTER_BOUNDARY").not.toContain(dynamic);
      expect(JSON.stringify(q.messages), "SERVER_CONTEXT_IN_SUFFIX").toContain(dynamic);
      expect(JSON.stringify(q), "NO_AMBIENT_INSTRUCTIONS").not.toContain("AMBIENT-ODYSSEUS");
      expect(prefix, "NO_CWD_IN_PREFIX").not.toContain(scratch);
      expect(JSON.stringify(q.messages)).toContain(`Odysseus item ${index}`);
      expect(JSON.stringify(q)).not.toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    }
    expect(prefixes).toHaveLength(4);
    expect(prefixes[1], "BYTE_IDENTICAL_FIXED_PREFIX").toBe(prefixes[0]);
    expect(prefixes[2], "BYTE_IDENTICAL_FIXED_PREFIX").toBe(prefixes[0]);
    expect(prefixes[3], "APPROVED_MEMBERSHIP_INVALIDATES_PREFIX").not.toBe(prefixes[0]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
