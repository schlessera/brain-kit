/**
 * #689 (moved from #676 AC3): end to end through the production dispatcher,
 * a follow-up minted from a resolved Action widens only the operation, tool,
 * input and path that the stored resolution authorized, inside the restricted
 * envelope of each installed first-party runtime. An attempt to exceed them
 * escalates or is refused, and nothing is written. Everything runs inside an
 * offline network namespace against keyless fixture upstreams.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TIMEOUT = 180_000;
const NOTE = "notes/ithaca-loom.md";
const CONTENT = "Penelope keeps the loom until Odysseus returns.\n";

async function probe(adapter: "claude" | "pi", scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "autonomous-dispatch-"));
  try {
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(join(root, "claude"), { recursive: true });
    mkdirSync(join(root, "pi"), { recursive: true });
    writeFileSync(join(root, "pi/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/autonomous-dispatch-probe.ts"),
      adapter, scenario, root], { cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude"),
        PI_CODING_AGENT_DIR: join(root, "pi"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...(adapter === "pi" ? { ANTHROPIC_API_KEY: "sk-odysseus-fixture-relay-key" } : {}) } });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(await Bun.file(join(root, "receipt.json")).text());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const EXCEED: Record<string, { path: string; tool: string }> = {
  input: { path: NOTE, tool: "write_file" },
  path: { path: "notes/suitors.md", tool: "write_file" },
  tool: { path: "notes/quick-note-water.md", tool: "edit_file" },
};
const name = (adapter: string, tool: string) => adapter === "claude" ? `mcp__brain-ui__${tool}` : tool;

/** The agent tier's proposal: one durable decision, nothing written, one follow-up after two devices resolve. */
function proposed(r: any, adapter: string): void {
  expect(r.passes[0], "the arrival was triaged and dispatched once").toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(r.passes[0].failed).toBeUndefined();
  expect(r.proposed).toHaveLength(1);
  expect(r.proposed[0]).toMatchObject({ type: "approve", status: "pending" });
  expect(r.proposed[0].options.map((o: any) => o.id)).toEqual(["apply", "dismiss"]);
  expect(r.proposed[0].options[0].effect.payload.operation, "STORED_EXACT_OPERATION").toEqual({ toolName: name(adapter, "write_file"),
    input: { operation: "write", path: NOTE, expectedBaseHash: null, content: CONTENT }, targetPath: NOTE });
  expect(r.checkpoints[0]).toEqual([r.proposed[0].options[0].effect.payload.operation]);
  expect(r.arrival, "the arrival is superseded by its resolution").toMatchObject({ status: "superseded" });
  expect(r.executes, "ONE_FOLLOW_UP: two devices and a replay mint exactly one follow-up").toBe(1);
  expect(r.requests.filter((q: any) => q.kind === "agent-tier").length).toBeGreaterThan(0);
  expect(r.requests.filter((q: any) => q.kind === "follow-up").length, "the follow-up ran through the dispatcher").toBeGreaterThan(0);
}

for (const adapter of ["claude", "pi"] as const) describe(`${adapter} follow-up scope through the production dispatcher`, () => {
  test("the approved follow-up applies exactly the authorized operation once", async () => {
    const r = await probe(adapter, "exact");
    proposed(r, adapter);
    expect(r.files, "APPLIED_EXACTLY").toEqual({ note: CONTENT, suitors: null, existing: "unchanged" });
    expect(r.followUp).toMatchObject({ status: "done" });
    expect(r.decisions.filter((d: any) => d.status === "pending"), "no further decision").toEqual([]);
    expect(r.passes[2], "nothing left to run").toMatchObject({ claimed: 0 });
    expect(r.reservations.map((x: any) => [x.purpose, x.status])).toEqual([["triage", "settled"], ["execute", "settled"], ["execute", "settled"]]);
  }, TIMEOUT);

  for (const [scenario, { path, tool }] of Object.entries(EXCEED)) test(`a follow-up exceeding its approval by ${scenario} escalates and writes nothing`, async () => {
    const r = await probe(adapter, scenario);
    proposed(r, adapter);
    expect(r.files, "NOTHING_WRITTEN").toEqual({ note: null, suitors: null, existing: "unchanged" });
    expect(r.followUp, "the follow-up waits on a fresh decision").toMatchObject({ status: "blocked" });
    const pending = r.decisions.filter((d: any) => d.status === "pending");
    expect(pending, "ESCALATED: the excess is a new durable decision").toHaveLength(1);
    expect(r.checkpoints).toHaveLength(2);
    expect(r.checkpoints[1].map((o: any) => [o.toolName, o.targetPath])).toEqual([[name(adapter, tool), path]]);
    expect(r.passes[2]).toMatchObject({ claimed: 0 });
  }, TIMEOUT);
});
