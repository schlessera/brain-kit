/**
 * #1039: the policy-write boundary, proved end to end through both installed
 * adapters' ordinary-turn entry paths. Each probe runs the actual server
 * (runSession, voice HostWork or runAutonomousTurn), the actual adapter and
 * the actual bubblewrap worker behind a kernel network namespace with
 * loopback fixture inference. Policy bytes, policy directory membership and
 * the whole brain tree are observed by the probe's outer stage, outside both
 * the worker and the server process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Mirrors the fixture's constants; the fixture is a program, not a module.
const POLICY = "---\ntype: policy\n---\nAthena alone reviews the crew policy.\n";
const TARGET = "---\ntitle: Harbor log\ntype: note\nstatus: active\n---\nOdysseus logs the harbor at Ithaca.\n";
const MEMBERS = ["crew.ipynb", "crew.md"];
const TIMEOUT = 180_000;
const passed: string[] = [];

async function probe(adapter: string, scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "policy-boundary-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/policy-boundary-probe.ts"),
      "outer", adapter, scenario, root], { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.exit as number, String(r.stderr)).toBe(0);
    expect(r.receipt, String(r.stderr)).not.toBeNull();
    return r;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Read from outside the boundary; nonempty before the turn by construction. */
function policyHeld(r: any, changed: string[]): void {
  expect(r.before.policy, "policy exists with content before the turn").toBe(POLICY);
  expect(r.before.members).toEqual(MEMBERS);
  expect(r.before.target, "permitted target exists with content before the turn").toBe(TARGET);
  expect(r.after.policy, "POLICY_BYTES_UNCHANGED").toBe(POLICY);
  expect(r.after.members, "POLICY_MEMBERSHIP_UNCHANGED").toEqual(MEMBERS);
  expect(r.escapes, "no file outside the fixture scripts carries an escape marker").toEqual([]);
  expect(r.changed, "exactly these brain paths changed").toEqual(changed);
}
const results = (r: any) => new Map<string, { isError: boolean; output: string }>(r.receipt.toolResults.map((t: any) => [t.toolUseId, t]));
function calls(r: any, name: string, match: (input: any) => boolean = () => true) {
  const out = results(r);
  const found = r.receipt.issued.filter((c: any) => c.name === name && match(c.input)).map((c: any) => ({ ...c, result: out.get(c.id) }));
  expect(found.length, `fixture issued ${name}`).toBeGreaterThan(0);
  for (const call of found) expect(call.result, `${name} ${JSON.stringify(call.input)} returned a result`).toBeDefined();
  return found as Array<{ id: string; input: any; subagent: boolean; result: { isError: boolean; output: string } }>;
}
const code = (output: string) => { try { return JSON.parse(output).code; } catch { return output; } };
const writerLaunches = (r: any) => r.receipt.spawned.filter((s: any) => s.worker && !s.hostProbe);
function attacks(r: any) {
  const texts = r.receipt.toolResults.flatMap((t: any) => {
    // pi's custom extension tool nests the attack's stdout in its JSON result.
    try { const nested = JSON.parse(t.output).attack; if (typeof nested === "string") return [t.output, nested]; } catch { /* plain text */ }
    return [t.output];
  });
  const found = texts.flatMap((text: string) => text.split("\n").filter(l => l.startsWith("ATTACK-RESULT ")).map(l => JSON.parse(l.slice(14))));
  expect(found.length, "the in-worker descriptor, mapping and /proc probe ran").toBe(adapter(r) === "pi" ? 2 : 1);
  return found;
}
const adapter = (r: any) => r.receipt.issued.some((c: any) => c.name === "probe_worker") ? "pi" : "claude";

/** Case 1: project MCP/hooks (Claude) and extension factories (pi) run before any tool event. */
function executorsHeld(r: any, adapter: "claude" | "pi"): void {
  const sources = adapter === "claude" ? ["hook", "mcp"] : ["extension-factory"];
  const witnesses = r.receipt.witnesses.filter((w: any) => sources.includes(w.source));
  expect(witnesses.map((w: any) => w.source).sort(), "each pre-tool executor actually ran in the worker").toEqual(sources);
  for (const w of witnesses) {
    expect(w.results.length).toBeGreaterThan(30);
    expect(w.results.filter((x: any) => x.ok), `${w.source} could not change a policy alias`).toEqual([]);
    expect(w.scratch, "worker scratch exists").toBe(true);
    expect(w.scratchAliases, "fresh scratch holds no policy alias").toEqual([]);
  }
}

for (const adapter of ["claude", "pi"] as const) describe(`${adapter} policy-write boundary`, () => {
  const route = adapter === "claude" ? (name: string) => `mcp__brain-ui__${name}` : (name: string) => name;
  const shell = adapter === "claude" ? "Bash" : "bash";

  test("interactive: escapes, descriptors, mappings, /proc, aliases, writers and bridge effects leave policy intact beside a permitted edit", async () => {
    const r = await probe(adapter, "attacks");
    policyHeld(r, ["notes/harbor-log.md"]);
    expect(writerLaunches(r).length, "the turn ran in an actual worker").toBeGreaterThan(0);
    // The permitted edit reached Markdown in the same turn, through the route.
    expect(r.after.target).toContain("Odysseus logs the harbor at Ithaca, through the validated route.");
    const permitted = calls(r, route("edit_file"), i => i.path === "notes/harbor-log.md")[0]!;
    expect(permitted.result.isError).toBe(false);
    expect(JSON.parse(permitted.result.output).changes).toEqual([{ path: "notes/harbor-log.md", contentHash: expect.any(String) }]);

    // Case 1: the server holds policy-backed stdout, an inherited writable
    // descriptor and a pre-confinement writable descriptor and mapping; a
    // donor process holds another. Each attack surface exists before the turn.
    const held = r.receipt.held;
    expect(held.find((d: any) => d.fd === 1), "policy-backed stdout").toMatchObject({ writable: true });
    expect(held.find((d: any) => d.fd === 3), "inherited writable descriptor").toMatchObject({ writable: true, cloexec: false });
    expect(held.filter((d: any) => d.fd > 3 && d.writable).length, "descriptor opened before confinement").toBeGreaterThan(0);
    expect(r.receipt.mapped, "server holds a writable shared policy mapping").toBe(true);
    expect(r.donor).toMatchObject({ writable: true, mapped: true });

    // Cases 1–4 from inside the worker: inherited/pre-confinement descriptors,
    // policy-backed stdio, socket and /proc descriptor transfer, mappings,
    // /proc root/cwd views and the server/donor by host pid.
    for (const a of attacks(r)) {
      expect(a.wrote, "no descriptor, mapping or /proc route wrote policy").toEqual([]);
      expect(a.attempts.length).toBeGreaterThan(15);
      expect(a.serverVisible, "neither the server nor the donor is visible in the worker").toBe(false);
      expect(a.transferReceived, "a descriptor really crossed the Unix socket").toBe(1);
      expect(a.fdCandidates, "the transferred policy descriptor was found and tried").toBeGreaterThan(0);
      const errors = Object.fromEntries(a.attempts.map((t: any) => [t.target, t.error]));
      expect(errors["mmap-shared-write"]).toBe("EACCES");
      expect(errors["socket-fd"]).toBe("EBADF");
      expect(errors["self-mem-mapping"]).toBeDefined();
      for (const name of ["server", "donor"]) expect(errors[`mem:${name}`], `${name} memory is unreachable`).toBe("ENOENT");
      for (const t of a.attempts.filter((t: any) => /^\/proc\/\d{4,}\//.test(t.target))) expect(t.error).toBe("ENOENT");
    }

    // Case 1: executors that start before any tool event.
    executorsHeld(r, adapter);

    // Case 7: shell, indirect and nested scripts, relative/symlink/alias paths
    // and the brain CLI inside the worker.
    const shells = calls(r, shell);
    const writes = shells.filter(c => c.input.command.includes("writes-attempted") || c.input.command.includes("-write.sh"));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const c of writes) expect(c.result.output).toContain("Read-only file system");
    const cli = shells.find(c => c.input.command.includes("brain.ts add"))!;
    expect(cli.result.output, "brain CLI write refuses visibly; nothing is staged").toContain("read_only_brain");
    expect(r.added, "no capture was staged or written").toEqual([]);
    if (adapter === "claude") {
      // Hosted turns withhold the raw file tools; the subagent's shell is confined too.
      expect(r.receipt.unavailable.sort()).toEqual(["Edit", "NotebookEdit", "Write"]);
      for (const name of ["Write", "Edit", "NotebookEdit"]) for (const c of calls(r, name)) expect(c.result.isError).toBe(true);
      const sub = shells.filter(c => c.subagent);
      expect(sub.length, "the subagent issued its own shell write").toBe(1);
      expect(sub[0]!.result.output).toContain("Read-only file system");
    } else {
      expect(r.receipt.unavailable).toEqual([]);
      const custom = JSON.parse(calls(r, "probe_worker")[0]!.result.output);
      expect(custom.custom.results.length).toBeGreaterThan(30);
      expect(custom.custom.results.filter((x: any) => x.ok), "extension custom tool cannot change policy").toEqual([]);
      expect(custom.factory.source).toBe("extension-factory");
    }

    // Cases 5 and 7: routed writes through the server application, including
    // traversal, hardlink, symlink, directory-symlink, case and NFKC aliases.
    const expected: Record<string, string> = {
      "context/policies/crew.md": "policy_denied", "notes/../context/policies/crew.md": "invalid_target",
      "notes/policy-hardlink.md": "alias_denied", "notes/policy-symlink.md": "alias_denied", "notes/policies-link/crew.md": "alias_denied",
      "Context/Policies/crew.md": "policy_denied", "context/ｐolicies/crew.md": "policy_denied", "context/policies/new.md": "policy_denied",
    };
    const routed = [...calls(r, route("write_file")), ...calls(r, route("edit_file"), i => i.path !== "notes/harbor-log.md")];
    expect(routed).toHaveLength(13);
    for (const c of routed) expect([c.input.path, code(c.result.output)]).toEqual([c.input.path, expected[c.input.path]]);
    expect(code(calls(r, route("brain_add"))[0]!.result.output)).toBe("policy_denied");
    expect(code(calls(r, route("brain_update"))[0]!.result.output)).toBe("policy_denied");
    expect(code(calls(r, route("brain_archive"))[0]!.result.output)).toBe("alias_denied");
    expect(code(calls(r, route("apply_staged_changes"))[0]!.result.output), "a staged batch naming policy applies nothing").toBe("policy_denied");

    // Case 6: privileged bridge effects with policy paths and aliases.
    const masks = calls(r, route("request_image_mask"));
    expect(masks).toHaveLength(4);
    for (const c of masks) expect(c.result.isError).toBe(true);
    expect(r.receipt.maskRequests, "no mask editor opened for a policy path or alias").toBe(0);
    expect(calls(r, route("ask_user"))[0]!.result.isError).toBe(false);
    expect(r.receipt.askRequests, "the ask-user answer naming policy is a value, not an effect").toBe(1);
    passed.push(`${adapter}:interactive`);
  }, TIMEOUT);

  test("race: topology and alias swaps between route validation and commit refuse; a permitted edit still lands", async () => {
    const r = await probe(adapter, "race");
    // Route receipts first, so a broken recheck fails on its own assertion.
    const receipts = Object.fromEntries(r.receipt.raceReceipts.map((x: any) => [x.path, x]));
    expect(receipts["race-dir/log.md"], "directory swapped for a policy symlink").toMatchObject({ ok: false, code: "topology_changed", changes: [] });
    expect(receipts["race-hard.md"], "file swapped for a policy hardlink").toMatchObject({ ok: false, code: "alias_denied", changes: [] });
    expect(receipts["race-sym.md"], "file swapped for a policy symlink").toMatchObject({ ok: false, code: "alias_denied", changes: [] });
    expect(receipts["race-ancestor/new.md"], "policy directory renamed into the target ancestor").toMatchObject({ ok: false, code: "topology_changed", changes: [] });
    expect(receipts["harbor-log.md"]).toMatchObject({ ok: true, changes: [{ path: "notes/harbor-log.md" }] });
    expect(r.racePayload, "RACE_PAYLOAD_NOWHERE").toEqual([]);
    // The race actor itself relinks and replaces these entries; nothing the
    // agent proposed (RACE-PAYLOAD) reaches any file.
    policyHeld(r, ["context/policies/crew.md", "notes/harbor-log.md", "notes/policy-hardlink.md", "notes/race-dir", "notes/race-dir-moved",
      "notes/race-dir-moved/log.md", "notes/race-dir/log.md", "notes/race-hard.md", "notes/race-sym.md"].sort());
    expect(r.after.target).toContain("through the validated route");
    passed.push(`${adapter}:race`);
  }, TIMEOUT);

  test("voice: the narrower membership cannot grant or write policy; an authorized capture still lands", async () => {
    const r = await probe(adapter, "voice");
    if (adapter === "pi") {
      // pi declares no voice posture: refused before any writer initializes.
      policyHeld(r, []);
      expect(r.receipt.calls).toBe(0);
      expect(r.receipt.spawned.some((s: any) => s.hostProbe), "the actual host probe passed first").toBe(true);
      expect(writerLaunches(r), "no worker, SDK or extension started").toEqual([]);
      expect(r.receipt.frames.some((f: any) => f.type === "error" && f.message.includes("no voice tool posture"))).toBe(true);
      passed.push(`${adapter}:voice`);
      return;
    }
    expect(r.added).toHaveLength(1);
    policyHeld(r, r.added);
    executorsHeld(r, adapter);
    expect(r.added[0]).toMatch(/^notes\/.+\.md$/);
    expect(r.receipt.frames.filter((f: any) => f.type === "tool_approval_request"), "voice never surfaces a grant").toEqual([]);
    expect(calls(r, "Bash")[0]!.result.output).toContain("cannot be approved here and did not run");
    expect(r.receipt.unavailable.sort(), "raw writes and the mask editor are outside voice").toEqual(["Write", "mcp__brain-ui__request_image_mask"]);
    expect(code(calls(r, route("write_file"))[0]!.result.output), "raw write is outside the voice membership").toBe("membership_denied");
    expect(code(calls(r, route("brain_update"))[0]!.result.output)).toBe("policy_denied");
    const adds = calls(r, route("brain_add"));
    expect(code(adds.find(c => c.input.target)!.result.output)).toBe("policy_denied");
    const capture = adds.find(c => !c.input.target)!;
    expect(capture.result.isError).toBe(false);
    expect(JSON.parse(capture.result.output).changes).toEqual([{ path: r.added[0], contentHash: expect.any(String) }]);
    passed.push(`${adapter}:voice`);
  }, TIMEOUT);

  test("autonomous: explicitly allowed raw writers stay in scratch; no authoritative effect without a bounded application", async () => {
    const r = await probe(adapter, "autonomous");
    policyHeld(r, []);
    expect(r.after.target, "the unattended turn could not change even the ordinary note").toBe(TARGET);
    expect(r.receipt.failure).toBeUndefined();
    executorsHeld(r, adapter);
    const command = calls(r, shell)[0]!;
    expect(command.result.output).toContain("Read-only file system");
    expect(command.result.output, "scratch remains writable for triage").toContain("Odysseus scratch succeeds");
    const writer = adapter === "claude" ? "Write" : "write_file";
    const raw = calls(r, writer);
    expect(raw).toHaveLength(2);
    for (const c of raw) expect(c.result.isError, `${writer} ${JSON.stringify(c.input)}`).toBe(true);
    expect(r.receipt.settled, "allowed tools needed no escalation").toEqual([]);
    passed.push(`${adapter}:autonomous`);
  }, TIMEOUT);

  for (const posture of ["interactive", "voice", "autonomous"]) test(`refusal (${posture}): a failed host probe refuses the turn before any writer initializes`, async () => {
    const r = await probe(adapter, `refused-${posture}`);
    policyHeld(r, []);
    expect(r.receipt.calls, "no inference request").toBe(0);
    expect(r.receipt.spawned, "no worker, SDK, extension or tool process started").toEqual([]);
    expect(r.receipt.witnesses, "no pre-tool executor or extension side effect").toEqual([]);
    if (posture === "autonomous") expect(r.receipt.failure.name).toBe("WorkerHostError");
    expect(r.receipt.frames.some((f: any) => f.type === "error" && f.failure?.errorClass === "worker_host_unsupported"
      && f.message.includes("fixture: user namespaces unavailable")), "the visible refusal names the missing host requirement").toBe(true);
    passed.push(`${adapter}:refused-${posture}`);
  }, TIMEOUT);
});

afterAll(() => {
  // The exact tuple this proof ran on, retained as a CI artifact (tmp/*-probe.json).
  const versions = Object.fromEntries(["@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent",
    "@schlessera/brain-backend-claude", "@schlessera/brain-backend-pi"].map(name =>
    [name, JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version]));
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  writeFileSync(join(ROOT, "tmp/policy-boundary-probe.json"), JSON.stringify({ architecture: process.arch, kernel: release(), bun: Bun.version,
    bubblewrap: Bun.spawnSync(["bwrap", "--version"]).stdout.toString().trim(), brainFilesystem: statfsSync(tmpdir()).type.toString(16),
    versions, passed }, null, 2) + "\n");
});
