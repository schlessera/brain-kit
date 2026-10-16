import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("installed Claude keeps request tools fixed and refuses every unavailable tool before settings, cards and handlers", async () => {
  const root = resolve(import.meta.dir, "../../.."), scratch = mkdtempSync(join(tmpdir(), "odysseus-roster-runtime-"));
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
    "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/stable-roster-probe.ts"), scratch],
    { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 170_000);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const { captures, raft, loom } = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    const bridgeNames = ["request_image_mask", "ask_user_list", "ask_user_rank", "ask_user_form", "propose_policy_change", "inbox_add", "resolve_action", "complete_share"].map(name => `mcp__brain-ui__${name}`);
    const natives = ["Write", "Edit", "NotebookEdit"];
    const missing = ["ask_user", "get_current_location", "query_activity", "brain_read_base", "brain_add", "brain_update", "brain_archive", "write_file", "edit_file", "apply_staged_changes"].map(name => `mcp__brain-ui__${name}`);
    expect(captures).toHaveLength(10);
    expect(new Set(captures.slice(0, 3).map((c: any) => c.sessionId)).size).toBe(1);
    expect(new Set(captures.slice(3, 8).map((c: any) => c.sessionId)).size).toBe(1);
    expect(captures[0].sessionId).not.toBe(captures[3].sessionId);
    for (const capture of captures) {
      if (capture.mode === "unhosted") {
        expect(JSON.stringify(capture.tools), "BYTE_IDENTICAL_UNHOSTED_TOOLS").toBe(JSON.stringify(captures[8].tools));
        for (const name of ["brain_add", "brain_update", "brain_archive"])
          expect(capture.tools.some((tool: any) => tool.name === `mcp__brain__${name}`), `UNHOSTED_LEGACY_ROSTER_${name}`).toBe(true);
        expect(capture.cards).toBe(0); expect(capture.results[0].is_error).not.toBe(true);
        expect(JSON.stringify(capture.results[0]), "LEGACY_UNHOSTED_AUTHORITY_RETAINED").toContain("LEGACY_HANDLER_EXECUTED");
        continue;
      }
      expect(JSON.stringify(capture.tools), `BYTE_IDENTICAL_PROVIDER_TOOLS_${capture.mode}`).toBe(JSON.stringify(captures[0].tools));
      expect(capture.cards, `NO_PERMISSION_CARDS_${capture.mode}`).toBe(0);
      if (["typed", "partial"].includes(capture.mode)) { expect(capture.calls, `TYPED_AVAILABLE_HANDLER_${capture.mode}`).toEqual([capture.mode === "partial" ? "inboxAdd" : "askUserList"]); expect(capture.results[0].is_error).not.toBe(true); continue; }
      const expected = capture.mode === "strict" ? natives : capture.mode === "voice" ? [...bridgeNames, ...natives] : capture.mode === "missing" ? [...bridgeNames, ...missing] : bridgeNames;
      for (const name of expected) expect(capture.denials, `RUNTIME_HOOK_REFUSAL_${capture.mode}_${name}: ${JSON.stringify(capture.results)}`).toContain(name);
      expect(capture.calls, `NO_PRIVILEGED_HANDLER_${capture.mode}`).toEqual([]);
      expect(capture.results.length).toBe(capture.mode === "strict" ? 3 : capture.mode === "voice" ? 11 : capture.mode === "missing" ? 18 : 8);
      expect(capture.results.every((r: any) => r.is_error === true), `MODEL_READABLE_REFUSALS_${capture.mode}`).toBe(true);
    }
    expect(raft).toBe("Odysseus repairs the raft.\n"); expect(loom).not.toContain("MUTATION");
  } finally { clearTimeout(timer); child.kill(); rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
