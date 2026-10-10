import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
async function probe(scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "brain-pi-worker-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/pi-worker-probe.ts"), scenario, root], {
      cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err || out).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const golden = "---\ntype: policy\n---\nAthena alone reviews the crew policy.\n";
function policyUnchanged(r: any): void {
  expect(r.policyBytes, "policy bytes observed outside the ordinary pi worker").toBe(golden);
  expect(r.policyMembers, "policy directory entries observed outside the worker").toEqual(["rule.md"]);
}

describe("ordinary pi isolated worker", () => {
  test("extension factories, custom tools, routed writes and nested bash cannot change policy while a permitted edit is indexed", async () => {
    const r = await probe("attacks");
    policyUnchanged(r);
    expect(r.failure).toBeUndefined();
    expect(r.frames.at(-1).outcome).toBe("success");
    const tool = r.frames.find((f: any) => f.type === "tool_result" && f.toolUseId === "toolu_fixture_0");
    const inside = JSON.parse(tool.output);
    expect(inside.scratch).toBe("Odysseus: factory ran in scratch.");
    expect(inside.attempted).toEqual(Array(4).fill("denied"));
    expect(inside.custom).toEqual(Array(4).fill("denied"));
    expect(r.applicationReceipts.filter((v: any) => !v.ok)).toHaveLength(8);
    const application = r.applicationReceipts.find((v: any) => v.ok);
    expect(application.changes[0].path).toBe("notes/worker-positive.md");
    expect(application.indexed).toBe(true);
    expect(r.positive).toContain("Odysseus sails to Ithaca.");
    expect(r.approvals, "only the custom tool asks; the ordinary permitted write has no extra confirmation").toBe(1);
    expect(r.frames.filter((f: any) => f.type === "tool_result").some((f: any) => f.output.includes("read_only_brain") && f.output.includes("brain_add"))).toBe(true);
    expect(r.running).toEqual([]);
    expect(r.bridgeEffects, "forged calls cannot execute a host bridge handler").toBe(0);
    // The first-party bootstrap discards inherited authority. Bun and the
    // model client open their own eventfds/urandom/inference descriptors later.
    expect(inside.descriptors.filter((d: any) => d.fd <= 2).every((d: any) => d.pipe)).toBe(true);
    expect(inside.descriptors.filter((d: any) => d.fd > 2 && d.target.startsWith("/") && !d.pipe
      && d.target !== "/dev/urandom" && !/^\/proc\/\d+\/statm$/.test(d.target))).toEqual([]);
    expect(r.histories[0].some((m: any) => m.toolCalls.some((t: any) => t.output?.includes('"indexed":true')))).toBe(true);
  });
  test.each(["forge-bridge", "forge-policy", "forge-answer", "forge-malformed", "forge-revoked", "forge-replay", "forge-identity", "forge-overflow", "forge-transcript"])("refuses %s from a real extension inside the worker", async scenario => {
    const r = await probe(scenario);
    policyUnchanged(r);
    expect(r.running).toEqual([]);
    expect(r.bridgeEffects, "forged calls cannot execute a host bridge handler").toBe(0);
    expect(r.frames.at(-1).outcome).toMatch(/error|cancelled/);
    if (scenario === "forge-policy") expect(r.applicationReceipts[0].code).toBe("policy_denied");
    else if (scenario === "forge-revoked") expect(r.frames.some((f: any) => f.code === "PI_WORKER_RPC_REFUSED" && f.message.includes("cancelled or revoked"))).toBe(true);
    else if (scenario === "forge-replay") expect(r.frames.some((f: any) => f.code === "PI_WORKER_RPC_REFUSED" && f.message.includes("Replayed"))).toBe(true);
    else if (scenario === "forge-identity") expect(r.frames.some((f: any) => f.type === "error" && f.message.includes("transcript identity"))).toBe(true);
    else if (scenario === "forge-overflow") expect(r.frames.some((f: any) => f.type === "error" && f.message.includes("exceeds its bound"))).toBe(true);
    else expect(r.frames.some((f: any) => f.type === "error")).toBe(true);
  });
  test("a failed host probe refuses before any installed extension factory runs", async () => {
    const r = await probe("failed-host");
    policyUnchanged(r);
    expect(r.calls).toBe(0);
    expect(r.hostPids).toEqual([]);
    expect(r.sessions).toEqual([]);
    expect(r.failure).toContain("fixture missing namespaces");
  });
  test("ordinary sessions persist and resume with the same list/history shapes", async () => {
    const r = await probe("resume");
    policyUnchanged(r);
    expect(r.sessions).toHaveLength(1);
    expect(Object.keys(r.sessions[0]).sort()).toEqual(["createdAt", "id", "lastActiveAt", "numTurns", "title", "totalCostUsd"]);
    expect(r.frames.filter((f: any) => f.type === "session_info").map((f: any) => f.sessionId)).toEqual([r.sessions[0].id, r.sessions[0].id]);
    expect(r.resumedHistory.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["Odysseus worker proof", "Continue sailing"]);
    expect(r.running).toEqual([]);
  });
  test("an already cancelled turn awaits worker exit without starting inference", async () => {
    const r = await probe("pre-aborted");
    policyUnchanged(r);
    expect(r.calls).toBe(0);
    expect(r.hostPids).toHaveLength(1);
    expect(r.running).toEqual([]);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
  });
  test("aborting a tool kills the worker and its nested process tree and retains honest history", async () => {
    const r = await probe("cancel");
    policyUnchanged(r);
    expect(r.hostPids.length).toBeGreaterThan(2);
    expect(r.running).toEqual([]);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.applicationReceipts).toEqual([]);
    expect(r.positive).toBeNull();
    expect(r.histories[0].some((m: any) => m.toolCalls.some((t: any) => t.output === "late"))).toBe(false);
  });
  test("cancellation after a server commit retains the authoritative receipt in history", async () => {
    const r = await probe("cancel-application");
    policyUnchanged(r);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.positive).toContain("Odysseus committed the raft note.");
    expect(r.applicationReceipts).toHaveLength(1);
    expect(r.applicationReceipts[0].ok).toBe(true);
    const recorded = r.histories[0].flatMap((m: any) => m.toolCalls).find((t: any) => t.name === "write_file");
    expect(recorded.output, "a committed effect retains its server receipt even before a worker tool result").toBeDefined();
    expect(JSON.parse(recorded.output)).toEqual(r.applicationReceipts[0]);
    expect(r.running).toEqual([]);
  });
  test("an authorized RPC commit missing from worker history still retains its exact server receipt on cancellation", async () => {
    const r = await probe("forge-committed");
    policyUnchanged(r);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.positive).toContain("Odysseus committed the raft note.");
    expect(r.applicationReceipts[0].ok).toBe(true);
    const recorded = r.histories[0].flatMap((m: any) => m.toolCalls).find((t: any) => t.id === "forged");
    expect(recorded?.output, "a committed RPC effect cannot disappear with missing worker history").toBeDefined();
    expect(JSON.parse(recorded.output)).toEqual(r.applicationReceipts[0]);
    expect(recorded.name).toBe("write_file");
    expect(r.running).toEqual([]);
  });
  test("server mask effects refuse policy paths and aliases before opening a user editor", async () => {
    const r = await probe("mask-policy");
    policyUnchanged(r);
    expect(r.bridgeEffects).toBe(0);
    expect(r.frames.filter((f: any) => f.type === "tool_result" && f.isError)).toHaveLength(4);
  });
  test("revocation while a mask editor is open refuses its filesystem effect", async () => {
    const r = await probe("mask-revoked");
    policyUnchanged(r);
    expect(r.bridgeEffects).toBe(1);
    expect(r.mask).toBeNull();
    expect(r.frames.at(-1).outcome).toBe("cancelled");
  });
  test("a permitted mask uses the shared server PNG operation and existing filename/result", async () => {
    const r = await probe("mask-positive");
    policyUnchanged(r);
    expect(r.bridgeEffects).toBe(1);
    expect(r.applicationReceipts, "the shared server operation records the actual PNG effect").toHaveLength(1);
    expect(r.applicationReceipts[0].changes[0].path).toBe("notes/raft.mask.png");
    expect(r.mask).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const output = JSON.parse(r.frames.find((f: any) => f.type === "tool_result").output);
    expect(output.maskPath).toBe("notes/raft.mask.png");
    expect(output.imagePath).toBe("notes/raft.png");
    expect(output.bytes).toBe(8);
    expect(r.histories[0].flatMap((m: any) => m.toolCalls).some((t: any) => t.output === JSON.stringify(output))).toBe(true);
    expect(r.frames.at(-1).outcome).toBe("success");
  });
  test("hosted mask refuses before the editor when the server PNG route is absent", async () => {
    const r = await probe("mask-no-route");
    policyUnchanged(r);
    expect(r.bridgeEffects, "no editor opens without an authoritative PNG route").toBe(0);
    expect(r.mask).toBeNull();
    expect(r.frames.some((f: any) => f.code === "PI_WORKER_RPC_REFUSED" && f.message.includes("server-owned PNG"))).toBe(true);
  });
  test("a concurrent image change in the pi mask editor refuses the shared application", async () => {
    const r = await probe("mask-stale");
    policyUnchanged(r);
    expect(r.applicationReceipts[0].code).toBe("stale_base");
    expect(r.mask).toBeNull();
  });
  test("cancellation after a pi PNG commit retains the exact server receipt in session history", async () => {
    const r = await probe("mask-cancel-commit");
    policyUnchanged(r);
    expect(r.frames.at(-1).outcome).toBe("cancelled");
    expect(r.mask).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const recorded = r.histories[0].flatMap((m: any) => m.toolCalls).find((t: any) => t.name === "request_image_mask");
    expect(recorded?.output, "the committed PNG cannot disappear on cancellation").toBeDefined();
    expect(JSON.parse(recorded.output)).toEqual(r.applicationReceipts[0]);
    expect(r.running).toEqual([]);
  });

});
