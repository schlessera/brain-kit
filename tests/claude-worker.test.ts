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
      { cwd: ROOT, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
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
  expect(r.indexed, JSON.stringify(r.requests).match(/indexError.{0,800}/)?.[0] ?? JSON.stringify(r.appEvents)).toEqual([{ path: "notes/worker-raft.md" }]);
  expect(r.mask).toEqual([137,80,78,71,13,10,26,10,0,0,0,0]);
  const outputs = r.requests.flatMap((req: any) => req.results ?? []).map((result: any) => JSON.stringify(result.content));
  expect(outputs.some((out: string) => out.includes("Odysseus scratch succeeds"))).toBe(true);
  expect(outputs.some((out: string) => out.includes("read-only"))).toBe(true);
  expect(outputs.some((out: string) => out.includes("Odysseus") && out.includes("results"))).toBe(true);
  const namespaceOutput = outputs.find((out: string) => /pid:\[\d+\]/.test(out));
  expect(namespaceOutput).toBeDefined();
  const namespaceIds = namespaceOutput!.match(/pid:\[\d+\]/g);
  expect(namespaceIds, namespaceOutput).toHaveLength(2); expect(namespaceIds![0]).toBe(namespaceIds![1]);
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
  expect(r.diagnostics.atAbort.native.some((file: { bash: number }) => file.bash > 0),
    "CLAUDE_ABORT_HAS_PERSISTED_BASH").toBe(true);
  expect(r.histories.length, JSON.stringify(r.diagnostics)).toBe(1);
  expect(r.sessions[0].id).toBe(r.diagnostics.sessionId);
  expect(r.calls).toBeGreaterThan(0);
  expect(r.sawDetachedChild, "actual detached sleep process started before cancellation").toBe(true);
  expect(r.frames.some((f: any) => f.type === "tool_use_start" && f.toolName === "Bash")).toBe(true);
  expect(r.frames.filter((f: any) => f.type === "result").at(-1).outcome).toBe("cancelled");
  expect(r.ordinary).toBeNull(); expect(r.appEvents).toEqual([]);
  expect(r.policy).toBe("Athena: agent writers never change these policy bytes.\n");
  expect(r.histories[0].flatMap((h: any) => h.toolCalls).some((t: any) => t.name === "Bash")).toBe(true);
  expect(r.survivors, "cancelled PID namespace leaves no detached child").toEqual([]);
});
test("an actual Claude runtime gets a large document's base hash inline from brain_read_base, never a spill file (#1624)", async () => {
  const r = await probe("read-base");
  const read = r.requests.flatMap((req: any) => req.results ?? []).find((result: any) => result.tool_use_id === "toolu_1");
  expect(read, "the model received the brain_read_base result").toBeDefined();
  const text = typeof read.content === "string" ? read.content : read.content.map((c: any) => c.text ?? "").join("");
  expect(text).toStartWith('{"expectedBaseHash":"');
  // The runtime may append its own reminder after the compact single-line JSON.
  const page = JSON.parse(text.split("\n")[0]);
  expect(page.expectedBaseHash).toMatch(/^[a-f0-9]{64}$/);
  expect(page.content).toBeUndefined();
  expect(page.nextOffset).toBeGreaterThan(1);
  expect(page.bytes).toBeGreaterThan(67_000);
  expect(r.survivors).toEqual([]);
});
test("an actual Claude whose runtime state fills its allowance ends the turn as worker_state_exceeded, not as a saved success (#1625)", async () => {
  const r = await probe("exceeded");
  // The tool's own write stops at the private tmpfs's 64 MiB limit.
  const fill = r.frames.find((f: any) => f.type === "tool_result" && f.toolUseId === "toolu_1");
  expect(fill.output).toContain("No space left on device");
  expect(fill.output).toContain(`tmpfs           ${64 * 1024 * 1024}`);
  // The runtime itself reports success, yet could not save its answer.
  expect(r.frames.some((f: any) => f.type === "text_delta" && f.text === "Odysseus completes the worker turn.")).toBe(true);
  const results = r.frames.filter((f: any) => f.type === "result");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ outcome: "error", isError: true, failure: { errorClass: "worker_state_exceeded" } });
  expect(results[0].failure.message).toContain("64 MiB allowance");
  expect(results[0].costUsd, "the turn's usage is kept").toBeGreaterThan(0);
  expect(JSON.stringify(r.histories), "the unsaved answer is not in saved history").not.toContain("Odysseus completes the worker turn.");
  expect(r.survivors).toEqual([]);
});
