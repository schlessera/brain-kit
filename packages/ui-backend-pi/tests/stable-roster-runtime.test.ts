import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("Pi native workers retain full schemas across no-grant, typed and missing-handler turns without authority widening", async () => {
  const root = resolve(import.meta.dir, "../../.."), scratch = mkdtempSync(join(tmpdir(), "odysseus-pi-roster-"));
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
    "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/stable-roster-probe.ts"), scratch],
    { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir(), HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "pi-agent") }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 170_000);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(exit, err || out).toBe(0);
    const { captures, voiceRefused, unchanged } = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    const names = ["request_image_mask", "ask_user_list", "ask_user_rank", "ask_user_form", "propose_policy_change", "inbox_add", "resolve_action", "complete_share"];
    for (const capture of captures) {
      expect(JSON.stringify(capture.tools), `PI_BYTE_IDENTICAL_PROVIDER_TOOLS_${capture.mode}`).toBe(JSON.stringify(captures[0].tools));
      expect(capture.cards).toBe(0);
      const results = capture.frames.filter((frame: any) => frame.type === "tool_result");
      if (capture.mode === "typed") { expect(capture.calls).toEqual(["askUserList"]); expect(results[0].isError).not.toBe(true); continue; }
      expect(capture.calls).toEqual([]); expect(results.length).toBe(names.length + (capture.mode === "missing" ? 4 : 0));
      for (const result of results) expect(result.isError, `PI_MODEL_READABLE_REFUSAL_${capture.mode}_${result.toolUseId}`).toBe(true);
    }
    expect(voiceRefused).toBe(true); expect(unchanged).toBe(true);
  } finally { clearTimeout(timer); child.kill(); rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
