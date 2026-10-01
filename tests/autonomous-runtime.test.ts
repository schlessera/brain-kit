import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
async function probe(backend: string, scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "brain-autonomous-runtime-"));
  try {
    // Native Claude transport is outside the Bun preload's scope. Run the
    // actual adapters and the fixture API together behind kernel network
    // isolation. No skip/fallback can substitute a fake session manager.
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/autonomous-runtime-probe.ts"), backend, scenario, root], {
      cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const receipt = JSON.parse(out.trim().split("\n").at(-1)!);
    receipt.toolBodyRan = existsSync(join(root, "brain/unauthorized.md"));
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const backend of ["claude", "pi"]) describe(`${backend} real autonomous runtime`, () => {
  test("does not persist a session or transcript while preserving runtime identity and usage", async () => {
    const r = await probe(backend, "success");
    expect(r.calls).toBeGreaterThan(0);
    expect(r.frames.filter((f: any) => f.type === "result")).toHaveLength(1);
    expect(r.frames.at(-1).outcome).toBe("success");
    expect(r.frames.some((f: any) => f.type === "session_info")).toBe(false);
    expect(r.transcripts, "no persisted runtime history").toEqual([]);
    expect(r.sessions).toEqual([]);
    expect(r.interactiveRows.n).toBe(0);
    expect(r.rollup.origin).toBe("autonomous");
    expect(r.rollup.session_id).toBeNull();
    expect(r.rollup.principal_id).toBeTruthy();
    expect(r.rollup.input_tokens).toBeGreaterThan(0);
    expect(r.rollup.output_tokens).toBeGreaterThan(0);
    expect(r.spans[0].attrs).toContain("brain.runtime.session_id");
    expect(JSON.parse(r.spans[0].attrs)["brain.runtime.session_id"]).toBe(r.frames.at(-1).sessionId);
    expect(JSON.parse(r.spans[0].attrs)["brain.backend_id"]).toBe(backend);
    expect(r.reservation.status).toBe("settled");
    expect(r.reservation.principal_id).toBe(r.rollup.principal_id);
    expect(r.reservation.input_tokens).toBeGreaterThan(0);
    expect(r.reservation.output_tokens).toBeGreaterThan(0);
    expect(r.reservation.charged_turns).toBe(1);
  });
  test("captures permission checkpoint before denying and aborting without a parked approval", async () => {
    const r = await probe(backend, "permission");
    expect(r.sawExpectedTool, "fixture reached the actual permission gate").toBe(true);
    expect(r.toolBodyRan, "server-selected tools refuse a write effect").toBe(false);
    expect(r.captured, "checkpoint before no-grant denial").toHaveLength(1);
    expect(r.checkpoint).toEqual(r.captured[0]);
    expect(r.checkpoint.kind).toBe("permission");
    expect(r.checkpoint.request.toolName).toBe(backend === "claude" ? "Write" : "write_file");
    expect(r.checkpoint.stateMd).toContain("authority boundary");
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.frames.some((f: any) => f.type === "tool_approval_request")).toBe(false);
    expect(r.transcripts).toEqual([]);
    expect(r.rollup.origin).toBe("autonomous");
    expect(r.rollup.input_tokens, "inference before escalation is still accounted").toBeGreaterThan(0);
    expect(r.rollup.output_tokens, "inference before escalation is still accounted").toBeGreaterThan(0);
  });
  test("bridge tools outside the exact server roster escalate before their callback runs", async () => {
    const r = await probe(backend, "bridge-permission");
    expect(r.sawExpectedTool).toBe(true);
    expect(r.captured).toHaveLength(1);
    expect(r.checkpoint.kind, "bridge capabilities do not widen server tool authority").toBe("permission");
    expect(r.checkpoint.request.toolName).toBe(backend === "claude" ? "mcp__brain-ui__ask_user" : "ask_user");
    expect(r.frames.at(-1).outcome).toBe("cancelled");
  });
  test("principal revocation visibly aborts the actual in-flight inference", async () => {
    const r = await probe(backend, "revoked");
    expect(r.calls).toBeGreaterThan(0);
    expect(r.revocationElapsedMs, "revocation check aborts before the host deadline").toBeLessThan(3000);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.events.some((event: any) => event.event_type === "principal_revoked")).toBe(true);
    expect(r.rollup.outcome).toBe("cancelled");
    expect(r.transcripts).toEqual([]);
    expect(r.captured).toEqual([]);
  });
  test("a question checkpoints and aborts without waiting for a human answer", async () => {
    const r = await probe(backend, "question");
    expect(r.sawExpectedTool).toBe(true);
    expect(r.captured).toHaveLength(1);
    expect(r.checkpoint.kind).toBe("question");
    expect(r.checkpoint.questions).toHaveLength(1);
    expect(r.checkpoint.questions[0].question).toContain("Odysseus");
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.transcripts).toEqual([]);
  });
  test("unsupported profiles visibly reject without acquiring or persisting a runtime", async () => {
    const r = await probe(backend, "unsupported");
    expect(r.failure.name).toBe("BackendRequestError");
    expect(r.frames.some((frame: any) => frame.type === "error" && frame.code === "AUTONOMOUS_TURN_FAILED")).toBe(true);
    expect(r.calls).toBe(0);
    expect(r.sessions).toEqual([]);
    expect(r.transcripts).toEqual([]);
    expect(r.interactiveRows.n).toBe(0);
    expect(r.rollup.outcome).toBe("error");
  });
  test("an already aborted host signal unwinds without inference or persistence", async () => {
    const r = await probe(backend, "preaborted");
    expect(r.calls).toBe(0);
    expect(r.frames.at(-1).type).toMatch(/result|error/);
    expect(r.sessions).toEqual([]);
    expect(r.transcripts).toEqual([]);
    expect(r.rollup.outcome).toBe("cancelled");
  });
  test("ordinary mode still advertises and persists a resumable session", async () => {
    const r = await probe(backend, "ordinary");
    expect(r.frames[0].type).toBe("session_info");
    expect(r.frames.at(-1).outcome).toBe("success");
    expect(r.transcripts.length).toBeGreaterThan(0);
    expect(r.sessions).toHaveLength(1);
    expect(r.histories[0].length).toBeGreaterThan(0);
  });
});
