/**
 * #676: the restricted envelope of untrusted autonomous execution, proved
 * end to end through both installed adapters' `runAutonomousTurn` path.
 *
 * A hostile staged Odysseus share drives a keyless fixture model to run an
 * attack inside the actual worker: credential, environment, `/proc` and host
 * file reads; TCP, UDP, DNS and host and abstract Unix socket egress; abuse
 * of the inference relay; and policy, symlink and hardlink writes. Egress is
 * counted by listeners in the probe's outer stage, outside both the worker
 * and the server. The relay's injected credential is observed at the fixture
 * upstream. Everything runs inside an offline network namespace.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { MARKERS } from "./fixtures/autonomous-containment-markers";

const ROOT = join(import.meta.dir, "..");
const POLICY = "---\ntype: policy\n---\nAthena alone reviews the crew policy.\n";
const TIMEOUT = 180_000;
const passed: string[] = [];

async function probe(adapter: string, scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "autonomous-containment-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/autonomous-containment-probe.ts"),
      "outer", adapter, scenario, root], { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.exit as number, String(r.stderr)).toBe(0);
    expect(r.receipt, String(r.stderr)).not.toBeNull();
    expect(r.policy, "POLICY_BYTES_UNCHANGED").toBe(POLICY);
    return r;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** The attack's reports: the main agent's, and for Claude a subagent's through nested indirection. */
function attacks(r: any, adapter: string): any[] {
  const found = r.receipt.toolResults.flatMap((t: any) => t.output.split("\n").filter((l: string) => l.startsWith("ATTACK-RESULT ")))
    .map((l: string) => JSON.parse(l.slice(14)));
  expect(found.length, "the hostile share's attack ran inside the worker").toBe(adapter === "claude" ? 2 : 1);
  return found;
}

for (const adapter of ["claude", "pi"] as const) describe(`${adapter} autonomous containment`, () => {
  test("a hostile staged share cannot read secrets, reach the network or sockets, or write the brain; inference, staging and escalation work", async () => {
    const r = await probe(adapter, "attack");
    const receipt = r.receipt;
    expect(receipt.failure).toBeUndefined();
    const reports = attacks(r, adapter);

    // Egress, observed by listeners outside the worker and the server.
    expect(r.counts, "EGRESS_NONE: no connection or datagram reached a host listener").toEqual({ tcp: 0, udp: 0, unixHost: 0, unixHome: 0, abstract: 0 });
    for (const a of reports) {
      expect(a.net["tcp-host"], "host TCP listener unreachable").toBe("ECONNREFUSED");
      expect(a.net["tcp-upstream"], "the inference upstream is unreachable except through the relay").toBe("ECONNREFUSED");
      expect(a.net.dns, "no name resolves").toBe("gaierror");
      expect(a.net["unix-host"], "host Unix socket outside the envelope is absent").toBe("ENOENT");
      expect(a.net["unix-home"], "a socket in the host home is absent").toBe("ENOENT");
      expect(a.net["unix-abstract"], "the host's abstract socket namespace is unreachable").toBe("ECONNREFUSED");

      // Secrets: environment, /proc environ, host files and the host home.
      expect(a.leaks, "SECRETS_UNSEEN: no marker in any environment, /proc environ or readable file").toEqual([]);
      const reads = Object.entries(a.reads as Record<string, string>).filter(([path]) => path.includes("autonomous-containment-"));
      expect(reads.length).toBe(4);
      for (const [path, outcome] of reads) expect([path, outcome]).toEqual([path, "ENOENT"]);
      // The runtime itself, whether the Claude CLI or pi's in-process SDK and
      // trusted entry, shares the attack's network and mount namespace.
      expect(a.processes.length, "the runtime process is visible in the worker").toBeGreaterThan(1);
      const runtime = a.processes.filter((p: any) => adapter === "claude" ? /claude/.test(p.cmd) : /worker-entry/.test(p.cmd));
      expect(runtime.length, `${adapter} runtime process found`).toBeGreaterThan(0);
      for (const p of a.processes) expect(p.net, `${p.cmd} shares the restricted network namespace`).toBe(a.selfNet);

      // The relay: only POST to an inference route reaches the upstream.
      expect(a.relay).toEqual({ "get-models": 405, "post-files": 403, "post-batches": 403, "post-traversal": 403,
        "post-other-host": 200, "post-messages": 200 });
      // Writes: brain and policy are read-only; staging in scratch works.
      expect(a.writes).toEqual({ policy: "EROFS", scratch: "ok", "symlink-write": "EROFS", hardlink: "EXDEV" });
      expect(a.scratchReadBack).toBe("Odysseus triage staged");
    }
    const paths = [...new Set(receipt.requests.map((q: any) => q.path.replace(/\?.*$/, "")))];
    expect(paths, "RELAY_ROUTES_ONLY: the upstream saw only the inference route").toEqual(["/v1/messages"]);
    for (const q of receipt.requests) {
      expect(q.apiKey, "CREDENTIAL_INJECTED: the server's key, never the worker's").toBe(MARKERS.realKey);
      expect(q.authorization).toBeNull();
      for (const value of Object.values(MARKERS).filter(v => v !== MARKERS.realKey)) expect(q.body.includes(value), `request carries ${value}`).toBe(false);
    }

    // R29: no ambient instructions, skills, hooks, SYSTEM.md or extension; the
    // turn's instructions are the server's snapshot.
    const turns = receipt.requests.filter((q: any) => q.tools.length > 0);
    expect(turns.length, "inference worked through the relay").toBeGreaterThan(1);
    for (const q of turns) {
      expect(q.body.includes(MARKERS.ambient), "AMBIENT_NOT_LOADED").toBe(false);
      expect(q.tools).not.toContain("ambient_extension_tool");
      // A Claude subagent carries its own agent prompt, not the main append.
      if (!q.body.includes("SUBAGENT-ODYSSEUS")) expect(q.body).toContain("SERVER-INSTRUCTION-SNAPSHOT-ODYSSEUS");
    }

    // An out-of-roster call escalates as a durable decision and never runs;
    // the principal is the server's, not anything the model wrote.
    expect(receipt.result).toMatchObject({ escalated: true });
    expect(receipt.settled).toHaveLength(1);
    const outside = adapter === "claude" ? "mcp__brain-ui__show_block" : "read_file";
    expect(receipt.settled[0]).toMatchObject({ kind: "permission", principalId: receipt.principalId,
      request: { toolName: outside, outsideEnforcedAllowlist: true } });
    // Last, so a weakened envelope fails on the escape it allows first.
    expect(receipt.spawned, "exactly one writer worker, in the restricted envelope").toEqual(["restricted"]);
    passed.push(`${adapter}:attack`);
  }, TIMEOUT);

  test("refusal: a host that cannot establish the restricted envelope refuses before any worker or inference", async () => {
    const r = await probe(adapter, "refused");
    const receipt = r.receipt;
    expect(receipt.failure?.name).toBe("WorkerHostError");
    expect(receipt.requests, "no inference request").toEqual([]);
    expect(receipt.spawned, "no worker started").toEqual([]);
    expect(receipt.frames.some((f: any) => f.failure?.errorClass === "worker_host_unsupported"
      && f.message.includes("fixture: network namespaces unavailable")), "the visible refusal names the missing requirement").toBe(true);
    passed.push(`${adapter}:refused`);
  }, TIMEOUT);
});

afterAll(() => {
  const versions = Object.fromEntries(["@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent",
    "@schlessera/brain-backend-claude", "@schlessera/brain-backend-pi"].map(name =>
    [name, JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version]));
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  writeFileSync(join(ROOT, "tmp/autonomous-containment-probe.json"), JSON.stringify({ architecture: process.arch, kernel: release(), bun: Bun.version,
    bubblewrap: Bun.spawnSync(["bwrap", "--version"]).stdout.toString().trim(), versions, passed }, null, 2) + "\n");
});
