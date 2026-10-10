/**
 * #689 AC1 and AC4 through the whole app with each installed first-party
 * runtime: share-target intake, the token-file cron poke, T1, the agent tier
 * in the restricted envelope, two WebSocket devices and the follow-up. A
 * hostile share cannot read host secrets, run a payload, reach the network or
 * write the policy, and inference, staging and escalation still work. Runs
 * offline inside a network namespace against keyless fixture upstreams.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKERS } from "./fixtures/autonomous-containment-markers";

const ROOT = join(import.meta.dir, "..");
const TIMEOUT = 180_000;
const POLICY = "---\ntype: policy\n---\nAthena alone reviews the crew policy.\n";

async function probe(adapter: "claude" | "pi", scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "autonomous-app-"));
  try {
    for (const dir of ["home", "claude", "pi"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "pi/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/autonomous-app-probe.ts"),
      adapter, scenario, root], { cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude"),
        PI_CODING_AGENT_DIR: join(root, "pi"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ODYSSEUS_HOST_SECRET: MARKERS.hostEnv,
        ...(adapter === "pi" ? { ANTHROPIC_API_KEY: MARKERS.realKey } : {}) } });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(await Bun.file(join(root, "receipt.json")).text());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Shared by every scenario: the share-target intake, untrusted trust, relay-only inference with the server's key. */
function pipeline(r: any): void {
  expect(r.share.status, "SHARE_TARGET_INTAKE").toBe(201);
  expect(r.thread, "the share is untrusted").toMatchObject({ trustClass: "untrusted", source: "share" });
  expect(r.passes[0], "the cron poke triaged and dispatched the share").toMatchObject({ ok: true, claimed: 1, dispatchEnabled: true });
  expect(r.requests.filter((q: any) => q.kind === "agent-tier").length, "inference worked through the relay").toBeGreaterThan(0);
  for (const q of r.requests) {
    expect(q.apiKey, "CREDENTIAL_INJECTED: the server's key at the upstream").toBe(MARKERS.realKey);
    expect(q.leaked, "SECRETS_UNSEEN: no secret reached a model request").toEqual([]);
  }
  expect(r.files.policy, "POLICY_BYTES_UNCHANGED").toBe(POLICY);
  expect(r.tcpHits, "EGRESS_NONE").toBe(0);
}

for (const adapter of ["claude", "pi"] as const) describe(`${adapter} in the whole app pipeline`, () => {
  test("a shared arrival is triaged, escalated, resolved by two devices and applied once", async () => {
    const r = await probe(adapter, "exact");
    pipeline(r);
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0].options.map((o: any) => o.id)).toEqual(["apply", "cancel"]);
    expect(r.errors, "both devices resolve without a refusal").toEqual([]);
    expect(r.executes, "ONE_FOLLOW_UP").toEqual(["done"]);
    expect(r.files.note, "APPLIED_ONCE").toBe("Penelope keeps the loom until Odysseus returns.\n");
    expect(r.passes.at(-1)).toMatchObject({ claimed: 0 });
  }, TIMEOUT);

  test("hostile share: host secrets stay unreadable and the policy write becomes a cancel-only decision", async () => {
    const r = await probe(adapter, "hostile-read");
    pipeline(r);
    const reads = r.requests.filter((q: any) => q.kind === "agent-tier" && q.results > 0);
    expect(reads.length, "the reads ran and their results returned to the model").toBeGreaterThan(0);
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0], "ESCALATED_NOT_APPROVABLE").toMatchObject({ type: "choose" });
    expect(r.proposed[0].options.map((o: any) => o.id)).toEqual(["cancel"]);
    expect(r.checkpoints, "the policy proposal is audit data, never an approvable operation").toEqual([[]]);
    expect(r.executes).toEqual([]);
  }, TIMEOUT);

  test("hostile share: an out-of-roster shell payload never runs and becomes a cancel-only decision", async () => {
    const r = await probe(adapter, "hostile-exec");
    pipeline(r);
    expect(r.proposed, "EXEC_ESCALATED: the payload became a decision instead of running").toHaveLength(1);
    expect(r.proposed[0].options.map((o: any) => o.id), "EXEC_ESCALATED").toEqual(["cancel"]);
    expect(r.escalated[0][0], "the decision names the refused shell call").toContain(adapter === "claude" ? "Bash" : "bash");
    expect(r.executes).toEqual([]);
  }, TIMEOUT);
});
