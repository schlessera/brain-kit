import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
async function probe(scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "brain-pi-worker-"));
  try {
    const home = join(root, "home");
    const defaultHome = scenario === "default-home-state" || scenario.startsWith("cached-package-");
    if (defaultHome) mkdirSync(home);
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      // Only the outer fixture can see this owned fictional default HOME.
      // The actual Pi worker still masks /root read-only, as it normally does.
      ...(defaultHome ? ["--tmpfs", "/root", "--bind", home, "/root"] : []),
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/pi-worker-probe.ts"), scenario, root], {
      cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", ...(defaultHome ? { HOME: "/root" } : {}) }, stdout: "pipe", stderr: "pipe" });
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
  function unsupportedConfiguration(r: any): void {
    expect(r.failure, "PI_EXTERNAL_EXTENSION_REFUSED_BEFORE_INFERENCE").toContain("Pi input collection is not qualified");
    expect(r.calls, "PI_EXTERNAL_EXTENSION_HAS_NO_INFERENCE").toBe(0);
    expect(r.parentStateUnchanged).toBe(true);
    expect(r.sessions).toEqual([]);
    expect(r.frames.some((f: any) => f.type === "tool_use_start")).toBe(false);
    expect(r.applicationReceipts).toEqual([]);
    expect(r.bridgeEffects).toBe(0);
    expect(r.positive).toBeNull();
    expect(r.mask).toBeNull();
    expect(r.running).toEqual([]);
    policyUnchanged(r);
  }
  for (const scenario of ["cached-package-state", "cached-package-missing", "cached-package-version", "cached-package-offline-missing"]) {
    test(`${scenario} refuses before inference without changing parent resources`, async () => {
      const r = await probe(scenario);
      // A missing, stale or loaded package is unqualified input coverage.
      // Loader failures and successfully loaded extensions fail the same fence.
      unsupportedConfiguration(r);
      expect(r.parentStateUnchanged).toBe(true);
      expect(r.parentHomeWriteExists).toBe(false);
    });
  }

  test("default read-only HOME uses copied private Pi state and resumes without exposing parent files", async () => {
    const r = await probe("default-home-state");
    expect(r.frames.at(-1), "PI_DEFAULT_HOME_INITIALIZES_PRIVATE_STATE").toMatchObject({ type: "result", outcome: "success" });
    expect(r.failure).toBeUndefined();
    const results = r.frames.filter((f: any) => f.type === "tool_result" && f.toolUseId === "toolu_fixture_0");
    expect(results).toHaveLength(2);
    for (const result of results) {
      const inside = JSON.parse(result.output).state;
      expect(inside.stateInitError, "PI_DEFAULT_HOME_SDK_STATE_INITIALIZES_WITHOUT_EROFS").toBeUndefined();
      expect(inside.agentDir, "PI_SDK_RESOLVES_BOUNDED_WORKER_STATE").toBe("/tmp/brain-worker-scratch/pi-state");
      expect(inside.copiedAuth).toBe(true);
      expect(inside.parentPrivateHidden, "PI_PARENT_STATE_REMAINS_MASKED").toBe(true);
      expect(inside.homeWriteDenied).toBe(true);
    }
    expect(r.parentStateUnchanged).toBe(true);
    expect(r.parentHomeWriteExists).toBe(false);
    expect(r.sessions).toHaveLength(1);
    expect(r.resumedHistory.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["Odysseus worker proof", "Continue sailing"]);
    expect(r.running).toEqual([]);
    policyUnchanged(r);
  });
  test("the four web tools run in the trusted host executor; the worker reads neither its key nor its state (#3686)", async () => {
    const r = await probe("host-web");
    expect(r.failure, "PI_HOST_WEB_TURN_SUCCEEDS").toBeUndefined();
    expect(r.frames.at(-1)).toMatchObject({ type: "result", outcome: "success" });
    const names = new Map(r.frames.filter((f: any) => f.type === "tool_use_start").map((f: any) => [f.toolUseId, f.toolName]));
    const results = r.frames.filter((f: any) => f.type === "tool_result").map((f: any) => ({ tool: names.get(f.toolUseId), isError: f.isError, output: f.output }));
    const web = results.filter((result: any) => result.tool !== "bash");
    expect(web.map((result: any) => `${result.tool}:${JSON.parse(result.output).ok}`).sort(), "PI_HOST_WEB_FOUR_TOOLS_EXECUTE")
      .toEqual(["fetch_content:true", "get_search_content:true", "source_check:true", "web_search:true"]);
    expect(web.find((result: any) => result.tool === "web_search").output, "PI_HOST_WEB_PROVIDER_RESULT").toContain("The raft reaches Ithaca at dawn.");
    const shell = results.find((result: any) => result.tool === "bash");
    expect(shell?.output, "PI_HOST_WEB_WORKER_PROBE_RAN").toContain("WORKER_WEB_PROBE_DONE");
    expect(shell.output, "PI_HOST_WEB_SENTINEL_UNREADABLE_FROM_WORKER").not.toContain(r.web.sentinel);
    expect(shell.output, "PI_HOST_WEB_CONFIG_UNREADABLE_FROM_WORKER").not.toContain("exaBaseUrl");
    expect(JSON.stringify(r.frames), "PI_HOST_WEB_SENTINEL_NEVER_IN_FRAMES").not.toContain(r.web.sentinel);
    expect(r.web.providerKeys.length).toBeGreaterThanOrEqual(2);
    expect(r.web.providerKeys.every((key: string) => key === r.web.sentinel), "PI_HOST_WEB_KEY_FROM_HOST").toBe(true);
    expect(r.web.hostConfigUnchanged, "PI_HOST_WEB_PARENT_CONFIG_UNCHANGED").toBe(true);
    expect(r.web.receipts.filter((receipt: any) => receipt.kind === "executor").map((receipt: any) => receipt.exit), "PI_HOST_WEB_EXECUTOR_EXIT")
      .toMatchObject([{ reason: "closed", exited: true, cleaned: true }]);
    expect(r.web.executorEntriesAfterClose, "PI_HOST_WEB_STATE_REMOVED").toEqual([]);
    expect(r.parentStateUnchanged).toBe(true);
    expect(r.running).toEqual([]);
    policyUnchanged(r);
  });
  test("an installed extension stays inactive under the default configuration and the curated turn succeeds (#3658)", async () => {
    const r = await probe("inactive-extension");
    expect(r.failure, "PI_DEFAULT_IGNORES_INSTALLED_EXTENSION").toBeUndefined();
    expect(r.frames.at(-1), "PI_DEFAULT_CURATED_TURN_SUCCEEDS").toMatchObject({ type: "result", outcome: "success" });
    expect(r.firstTools, "PI_DEFAULT_CURATED_ROSTER").toContain("bash");
    expect(r.firstTools, "PI_DEFAULT_EXTENSION_NOT_LOADED").not.toContain("inactive_voyage");
    expect(r.running).toEqual([]);
    policyUnchanged(r);
  });
  test("curated bash, routed writes and nested bash cannot change policy while a permitted edit is recorded", async () => {
    const r = await probe("attacks");
    policyUnchanged(r);
    expect(r.failure).toBeUndefined();
    expect(r.frames.at(-1).outcome).toBe("success");
    const tool = r.frames.find((f: any) => f.type === "tool_result" && f.toolUseId === "toolu_fixture_0");
    const inside = JSON.parse(tool.output);
    expect(inside.scratch).toBe("Odysseus: curated bash ran in scratch.");
    expect(inside.attempted).toEqual(Array(4).fill("denied"));
    expect(r.applicationReceipts.filter((v: any) => !v.ok)).toHaveLength(8);
    const application = r.applicationReceipts.find((v: any) => v.ok);
    expect(application.changes[0].path).toBe("notes/worker-positive.md");
    expect(application).toMatchObject({ indexed: false, indexStatus: "pending" });
    expect(r.positive).toContain("Odysseus sails to Ithaca.");
    expect(r.approvals, "curated writes need no extra confirmation").toBe(0);
    expect(r.frames.filter((f: any) => f.type === "tool_result").some((f: any) => f.output.includes("read_only_brain") && f.output.includes("brain_add"))).toBe(true);
    expect(r.running).toEqual([]);
    expect(r.bridgeEffects, "forged calls cannot execute a host bridge handler").toBe(0);
    // The first-party bootstrap discards inherited authority. Bun and the
    // model client open their own eventfds/urandom/inference descriptors later.
    expect(inside.workerPid).not.toBe(inside.pid);
    expect(inside.descriptors.filter((d: any) => d.fd <= 2).sort((a: any, b: any) => a.fd - b.fd).map((d: any) => [d.fd, d.pipe])).toEqual([[0, true], [1, true], [2, true]]);
    expect(inside.descriptors.filter((d: any) => d.fd > 2 && d.target.startsWith("/") && !d.pipe
      && d.target !== "/dev/urandom" && !/^\/proc\/\d+\/statm$/.test(d.target))).toEqual([]);
    expect(r.histories[0].some((m: any) => m.toolCalls.some((t: any) => t.output?.includes('"indexStatus":"pending"')))).toBe(true);
  });
  test.each(["external-extension", "forge-bridge", "forge-policy", "forge-answer", "forge-malformed", "forge-revoked", "forge-replay", "forge-identity", "forge-overflow", "forge-transcript", "forge-readbase-path", "forge-readbase-replay", "forge-committed"])("%s: external extension configuration refuses before inference or host effects", async scenario => {
    const r = await probe(scenario);
    unsupportedConfiguration(r);
    expect(JSON.stringify(r.frames)).not.toContain("Calypso keeps the hidden route");
  });
  test("a ranged brain_read_base pages in the worker and its whole-document receipt backs a later edit", async () => {
    const r = await probe("read-base-page");
    policyUnchanged(r);
    expect(r.failure).toBeUndefined();
    const read = r.frames.find((f: any) => f.type === "tool_result" && f.toolUseId === "toolu_fixture_0");
    // The worker's server request carries only the path of the granted ranged input.
    expect(read.output).toStartWith('{"expectedBaseHash":');
    const page = JSON.parse(read.output);
    const whole = "---\ntype: note\n---\nDay 1: Odysseus leaves Troy.\nDay 2: Athena counsels patience.\n";
    expect(page).toEqual({ expectedBaseHash: new Bun.CryptoHasher("sha256").update(whole).digest("hex"),
      bytes: Buffer.byteLength(whole), lines: 5, offset: 4, returnedLines: 1, text: "Day 1: Odysseus leaves Troy.\n", nextOffset: 5 });
    const edit = r.applicationReceipts.find((v: any) => v.ok);
    expect(edit?.changes[0].path).toBe("notes/voyage-log.md");
    expect(r.voyageLog).toBe(whole.replace("patience", "courage"));
    expect(r.running).toEqual([]);
  });
  test("a failed host probe refuses before any curated worker starts", async () => {
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
  test("an already cancelled turn starts neither a worker nor inference", async () => {
    const r = await probe("pre-aborted");
    policyUnchanged(r);
    expect(r.calls).toBe(0);
    expect(r.hostPids, "PI_PREABORT_NO_WORKER").toHaveLength(0);
    expect(r.running).toEqual([]);
    expect(r.sessions, "PI_PREABORT_NO_SESSION").toEqual([]);
    // The shared backend contract uses a bare terminal when no identity was acquired.
    expect(r.frames.at(-1)).toMatchObject({ type: "error", code: "agent_error", message: "The turn was cancelled before a session was acquired." });
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
