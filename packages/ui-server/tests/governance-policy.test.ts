import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createGovernancePolicyReader } from "../src/brain/governance-policy";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  const path = join(brain, "context/policies/governance.md");
  const write = (yaml: string) => writeFileSync(path, `---\nschema_version: 1\n${yaml}\n---\nAthena reviews policy.\n`);
  const dbPath = join(root, "state/ui.db");
  mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const notices: string[] = [];
  const turns = createGovernedTurns({ brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report: message => notices.push(message),
    recordPolicy: (turnId, origin, profile, policy) => db.query("INSERT INTO turn_governance_policy (turn_id, origin, profile, policy_hash, source, policy, errors, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(turnId, origin, profile, policy.hash, policy.source, JSON.stringify(policy.policy), JSON.stringify(policy.errors), 1) });
  return { brain, path, write, db, execution, notices, turns };
}

test.each(["interactive", "voice"] as const)("%s policy selection enters an actual strict worker and records its immutable policy identity", async origin => {
  const f = fixture();
  f.write(`profiles: { interactive: ${origin === "interactive" ? "strict" : "governed"}, voice: ${origin === "voice" ? "strict" : "governed"} }`);
  writeFileSync(join(f.brain, "harbor.md"), "Odysseus arrives.\n");
  const hold = await f.turns.begin(`turn-${origin}`, new AbortController().signal, origin);
  try {
    expect(hold.sandbox.profile, "POLICY_ACTUAL_STRICT_ADMISSION").toBe("strict");
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: {}, command: ["/bin/sh", "-c",
      'if printf attack > harbor.md; then exit 41; fi; printf STRICT_POLICY_WRITE_REFUSED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(worker.exitCode, worker.stderr.toString()).toBe(0);
    expect(worker.stdout.toString()).toBe("STRICT_POLICY_WRITE_REFUSED");
    expect(readFileSync(join(f.brain, "harbor.md"), "utf8")).toBe("Odysseus arrives.\n");
    const originalHash = hold.policy.hash;
    f.write("profiles: { interactive: governed, voice: governed }");
    expect(hold.policy.hash, "POLICY_ACTIVE_TURN_IDENTITY_UNCHANGED").toBe(originalHash);
    expect(hold.policy.policy.profiles[origin]).toBe("strict");
    expect(Object.isFrozen(hold.policy.policy.profiles)).toBe(true);
    const row = f.db.query("SELECT policy_hash, origin, profile FROM turn_governance_policy WHERE turn_id = ?").get(`turn-${origin}`);
    expect(row).toEqual({ policy_hash: originalHash, origin, profile: "strict" });
  } finally { hold.end(); }
});

test("invalid edits retain the last actual policy/hash and record the validation notice; invalid-first uses defaults", async () => {
  const f = fixture(); f.write("unknown: true");
  const initial = await f.turns.begin("invalid-first", new AbortController().signal);
  expect(initial.policy.hash).toBeNull(); expect(initial.policy.source).toBe("default"); expect(initial.policy.errors.join(" ")).toContain("unknown"); initial.end();
  f.write("profiles: { interactive: strict }");
  const valid = await f.turns.begin("valid", new AbortController().signal); const hash = valid.policy.hash; valid.end();
  for (const [index, yaml] of ["unknown: true", "release: [.git/config]", "profiles: { voice: restricted }"].entries()) {
    f.write(yaml);
    const invalid = await f.turns.begin(`invalid-${index}`, new AbortController().signal);
    expect(invalid.sandbox.profile, "POLICY_LAST_VALID_PROFILE_RETAINED").toBe("strict");
    expect(invalid.policy.hash).toBe(hash); expect(invalid.policy.source).toBe("last_valid");
    expect(invalid.policy.errors.length).toBeGreaterThan(0);
    const row = f.db.query("SELECT policy_hash, errors FROM turn_governance_policy WHERE turn_id = ?").get(`invalid-${index}`) as { policy_hash: string; errors: string };
    expect(row.policy_hash).toEqual(hash); expect(JSON.parse(row.errors).length).toBeGreaterThan(0); invalid.end();
  }
  expect(f.notices.filter(value => value.includes("Governance policy invalid")).length).toBe(4);
});

test("policy additions and exact tier B release reach real governed mounts and manifest", async () => {
  const f = fixture(); f.write("protect: [me/identity.md]\nrelease: [.claude/settings.json]");
  mkdirSync(join(f.brain, "me")); mkdirSync(join(f.brain, ".claude"));
  writeFileSync(join(f.brain, "me/identity.md"), "Odysseus.\n"); writeFileSync(join(f.brain, ".claude/settings.json"), "{}\n");
  const hold = await f.turns.begin("governed-protection", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: {}, command: ["/bin/sh", "-c",
      'if printf attack > me/identity.md; then exit 41; fi; printf released > .claude/settings.json || exit 42; if printf attack > context/policies/governance.md; then exit 43; fi; printf POLICY_PROTECTION_APPLIED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(worker.exitCode, worker.stderr.toString()).toBe(0); expect(worker.stdout.toString()).toBe("POLICY_PROTECTION_APPLIED");
    expect(readFileSync(join(f.brain, "me/identity.md"), "utf8")).toBe("Odysseus.\n");
    expect(readFileSync(join(f.brain, ".claude/settings.json"), "utf8")).toBe("released");
    const row = f.db.query("SELECT manifest FROM governed_turn_manifests WHERE turn_id = ?").get("governed-protection") as { manifest: string };
    expect(JSON.parse(row.manifest).protected).toContain("me/identity.md"); expect(JSON.parse(row.manifest).protected).not.toContain(".claude/settings.json");
  } finally { hold.end(); }
});

test("a known missing file selects defaults; the reader never invents autonomous authority", () => {
  const f = fixture(); const reader = createGovernancePolicyReader(f.brain);
  expect(reader.load()).toMatchObject({ hash: null, source: "default", errors: [], policy: { profiles: { interactive: "governed", voice: "governed" } } });
  expect(reader.load().policy.profiles).not.toHaveProperty("autonomous");
});

test.each(["interactive", "voice", "dictation"] as const)("real session routing carries %s origin to policy admission", async origin => {
  const f = fixture(); f.write("profiles: { interactive: governed, voice: strict }");
  let actualProfile: string | undefined;
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    actualProfile = request.workerSandbox?.profile;
    const child = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: request.workerSandbox, env: {}, command: ["/bin/sh", "-c",
      'if printf fixture > harbor.md; then printf writable; else printf readonly; fi'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString(), "POLICY_ROUTED_ORIGIN_RUNTIME").toBe(origin === "voice" ? "readonly" : "writable");
    request.bridge.emit({ type: "session_info", sessionId: `session-${origin}`, isNew: true });
    request.bridge.emit({ type: "result", sessionId: `session-${origin}`, durationMs: 1 });
  } });
  const host = new WsHost({ brainPath: f.brain, governedTurns: f.turns, registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => f.db) });
  try {
    await runSession(host, { authorization: testAuthorization(), text: "Odysseus inspects the harbor.", attachments: [],
      ...(origin === "voice" ? { source: "voice-conversation" as const, work: { posture: "voice", started() {}, settle() {} } as never }
        : origin === "dictation" ? { source: "voice-dictate" as const } : {}) });
    expect(actualProfile, "POLICY_ROUTED_ORIGIN_PROFILE").toBe(origin === "voice" ? "strict" : "governed");
    expect(f.db.query("SELECT origin, profile FROM turn_governance_policy").get()).toEqual({ origin: origin === "voice" ? "voice" : "interactive", profile: actualProfile });
  } finally { host.close(); }
});
