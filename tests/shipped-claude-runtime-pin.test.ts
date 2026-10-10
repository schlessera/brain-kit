// The public backend's exact Agent SDK and bundled Claude CLI pair. This half
// of the hygiene research-runtime test protects what ships, so it stays in
// product proof (#1386). The research 0.3.292 / 2.1.292 pair and its
// independence from this one were checked by the mechanical-hygiene spike
// harness, removed with the #838 evaluation machinery.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledClaudeBinary } from "../packages/core/src/providers/agents/claude-binary";

test("the public backend resolves SDK 0.3.293 and its bundled CLI reports 2.1.293", () => {
  const root = join(import.meta.dir, "..");
  const current = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(root, "packages/ui-backend-claude/src"));
  expect(JSON.parse(readFileSync(join(dirname(current), "package.json"), "utf8")).version).toBe("0.3.293");
  const native = bundledClaudeBinary(current); expect(native).not.toBeNull();
  const child = Bun.spawnSync([native!, "--version"], { env: { PATH: "/usr/bin:/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0); expect(child.stdout.toString().trim()).toBe("2.1.293 (Claude Code)");
});
