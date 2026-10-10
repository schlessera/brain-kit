import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dir, "..");
async function probe(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "claude-worker-runtime-"));
  const before = processes();
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(ROOT, "tests/fixtures/claude-worker-probe.ts"), scenario, root],
      { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, err || out).toBe(0);
    const receipt = JSON.parse(out.trim().split("\n").at(-1)!);
    receipt.survivors = [...processes()].filter(([pid, cmd]) => !before.has(pid) && (cmd.includes(root) || cmd.startsWith(receipt.childMarker + " ")));
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function processes(): Map<string, string> {
  const result = new Map<string, string>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try { result.set(pid, readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")); } catch { /* Process exited. */ }
  }
  return result;
}
test("ordinary Claude worker protects policy bytes, applies and indexes permitted Markdown, masks, scratch and resumes", async () => {
  const r = await probe("ordinary");
  expect(r.calls).toBe(11);
  expect(r.policy, "POLICY_BYTES_UNCHANGED").toBe("Athena: agent writers never change these policy bytes.\n");
  expect(r.entries).toEqual(["crew.ipynb", "crew.md"]);
  expect(JSON.parse(r.notebook).cells[0].source).toEqual(["Athena: agent writers never change these policy bytes.\n"]);
  expect(r.ordinary).toContain("Odysseus sails through the validated worker route.");
  expect(r.indexed).toEqual([{ path: "notes/worker-raft.md" }]);
  expect(r.mask).toEqual([137,80,78,71,13,10,26,10,0,0,0,0]);
  const outputs = r.requests.flatMap((req: any) => req.results ?? []).map((result: any) => JSON.stringify(result.content));
  expect(outputs.some((out: string) => out.includes("Odysseus scratch succeeds"))).toBe(true);
  expect(outputs.some((out: string) => out.includes("read-only"))).toBe(true);
  expect(outputs.some((out: string) => out.includes("Odysseus") && out.includes("results"))).toBe(true);
  const namespaceOutput = outputs.find((out: string) => /pid:\[\d+\]/.test(out));
  expect(namespaceOutput).toBeDefined();
  const namespaceIds = namespaceOutput!.match(/pid:\[\d+\]/g);
  expect(namespaceIds).toHaveLength(2); expect(namespaceIds![0]).toBe(namespaceIds![1]);
  expect(r.requests[0].tools).not.toContain("mcp__brain__brain_add");
  expect(r.frames.filter((frame: any) => frame.type === "tool_approval_request"), "ordinary permitted writes add no confirmation").toEqual([]);
  expect(r.sessions).toHaveLength(1);
  expect(r.frames.filter((frame: any) => frame.type === "session_info")).toHaveLength(2);
  expect(r.frames.filter((frame: any) => frame.type === "result").map((f: any) => f.outcome)).toEqual(["success", "success"]);
  expect(r.histories[0].filter((h: any) => h.role === "user").length).toBeGreaterThanOrEqual(2);
  const effects = r.appEvents.filter((e: any) => e.event_type === "brain_application_change").map((e: any) => JSON.parse(e.payload).v.path);
  expect(effects).toEqual(["notes/worker-raft.md", "assets/raft-mask.png"]);
  expect(r.survivors, "no worker or descendant survives a completed turn").toEqual([]);
});
test("aborting an actual Claude mid-tool removes its detached descendant and history has no phantom Markdown effect", async () => {
  const r = await probe("abort");
  expect(r.calls).toBeGreaterThan(0);
  expect(r.sawDetachedChild, "actual detached sleep process started before cancellation").toBe(true);
  expect(r.frames.some((f: any) => f.type === "tool_use_start" && f.toolName === "Bash")).toBe(true);
  expect(r.frames.filter((f: any) => f.type === "result").at(-1).outcome).toBe("cancelled");
  expect(r.ordinary).toBeNull(); expect(r.appEvents).toEqual([]);
  expect(r.policy).toBe("Athena: agent writers never change these policy bytes.\n");
  expect(r.histories[0].flatMap((h: any) => h.toolCalls).some((t: any) => t.name === "Bash")).toBe(true);
  expect(r.survivors, "cancelled PID namespace leaves no detached child").toEqual([]);
});
