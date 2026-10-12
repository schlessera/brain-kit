import { Hono } from "hono";
import type { AppEnv } from "../src/app-env";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { createSessionProfiles } from "../src/ws/session-profiles";
import { createSessionProfileRoutes } from "../src/routes/session-profiles";
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
    const row = f.db.query("SELECT policy_hash, errors FROM turn_governance_policy WHERE turn_id = ?").get(`invalid-${index}`) as { policy_hash: string | null; errors: string };
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
    request.bridge.emit({ type: "result", sessionId: `session-${origin}`, durationMs: 1, numTurns: 1, isError: false });
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


test("confirmed session preference tightens the next actual worker without changing another session or voice", async () => {
  const f = fixture(); f.write("profiles: { interactive: governed, voice: governed }");
  writeFileSync(join(f.brain, "harbor.md"), "Odysseus arrives.\n");
  const signal = new AbortController().signal;
  const active = await f.turns.begin("preference-active", signal);
  expect(active.sandbox.profile).toBe("governed");
  const strict = await f.turns.begin("preference-next", signal, "interactive", "strict");
  try {
    expect(strict.sandbox.profile, "SESSION_PROFILE_NEXT_ADMISSION").toBe("strict");
    expect(active.sandbox.profile, "SESSION_PROFILE_RUNNING_UNCHANGED").toBe("governed");
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: strict.sandbox, env: {}, command: ["/bin/sh", "-c", 'if printf attack > harbor.md; then exit 41; fi; printf STRICT_SESSION_WRITE_REFUSED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(worker.exitCode, worker.stderr.toString()).toBe(0);
    expect(worker.stdout.toString()).toBe("STRICT_SESSION_WRITE_REFUSED");
  } finally { strict.end(); active.end(); }
  const other = await f.turns.begin("preference-other", signal, "interactive", "governed");
  expect(other.sandbox.profile).toBe("governed"); other.end();
  const voice = await f.turns.begin("preference-voice", signal, "voice", "strict");
  expect(voice.sandbox.profile, "SESSION_PROFILE_VOICE_IGNORES_INTERACTIVE_PREFERENCE").toBe("governed"); voice.end();
  f.write("profiles: { interactive: strict }");
  const facts = f.turns.facts();
  expect(facts.policyProfile).toBe("strict");
  f.write("unknown: true");
  const locked = await f.turns.begin("preference-policy-lock", signal, "interactive", "governed");
  expect(locked.sandbox.profile, "SESSION_PROFILE_POLICY_LOWER_BOUND").toBe("strict");
  expect(locked.policy.hash).toBe(facts.policy.hash); locked.end();
});


test("authenticated profile routes persist named preferences, lock policy and refuse expired, unknown and mismatched drafts", async () => {
  const f = fixture(); const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const catalog = createSessionCatalog(() => f.db); catalog.persistSessionStub("ithaca-chat", "Odysseus reviews the harbor.", "claude", "claude");
  const profiles = createSessionProfiles(f.db, f.turns);
  const app = new Hono<AppEnv>().use("*", (c, next) => { c.set("principal", principal); return next(); }).route("/api", createSessionProfileRoutes(profiles));
  const save = (path: string, preference: string) => app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preference }) });
  expect((await save("/api/sessions/missing-chat/profile", "strict")).status, "SESSION_PROFILE_UNKNOWN_REFUSED").toBe(404);
  expect((await save("/api/sessions/ithaca-chat/profile", "strict")).status).toBe(200);
  expect(createSessionProfiles(f.db, f.turns).read(principal.id, "session", "ithaca-chat").preference, "SESSION_PROFILE_RELOAD_CONFIRMED").toBe("strict");
  f.write("profiles: { interactive: strict }");
  expect((await save("/api/sessions/ithaca-chat/profile", "governed")).status, "SESSION_PROFILE_LOCKED_ROUTE_REFUSAL").toBe(409);
  expect((await save("/api/drafts/harbor-draft/profile", "strict")).status).toBe(200);
  const foreign = createPrincipal(f.db, { authMethod: "password", label: "Penelope device", ttlSeconds: 3600 });
  expect(() => profiles.preference(foreign.id, undefined, "harbor-draft"), "SESSION_PROFILE_DRAFT_PRINCIPAL_ISOLATION").toThrow("unavailable");
  expect(profiles.read(foreign.id, "draft", "harbor-draft").draftPreferenceStored).toBe(false);
  revokePrincipal(f.db, principal.id, Date.now());
  expect((await save("/api/sessions/ithaca-chat/profile", "strict")).status, "SESSION_PROFILE_EXPIRED_ROUTE_REFUSAL").toBe(401);
});

test("real first sends bind only their authenticated draft preference and emit actual admitted attribution", async () => {
  const f = fixture(); f.write("profiles: { interactive: governed, voice: governed }");
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const profiles = createSessionProfiles(f.db, f.turns);
  profiles.save(principal.id, "draft", "ithaca-draft", "strict");
  profiles.save(principal.id, "draft", "harbor-draft", "governed");
  const observations: string[] = []; let nextSession = "ithaca-chat";
  let paused: (() => void) | undefined; let resumeWorker: (() => void) | undefined;
  let pauseWorker = false;
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    observations.push(request.workerSandbox!.profile!);
    if (pauseWorker) { paused!(); await new Promise<void>(resolve => { resumeWorker = resolve; }); }
    const sessionId = request.sessionId ?? nextSession;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    // A repeated backend announcement must not bind or consume a preference twice.
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    request.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
  } });
  const frames: any[] = [];
  const host = new WsHost({ brainPath: f.brain, governedTurns: f.turns, sessionProfiles: profiles,
    registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => f.db) });
  host.clients.add({ send: raw => frames.push(JSON.parse(String(raw))) }, principal.id);
  try {
    const common = { authorization: testAuthorization(principal.id), text: "Odysseus inspects the harbor.", attachments: [] };
    await runSession(host, { ...common, draftId: "correlation-ithaca", requestId: "request-ithaca", profileDraftId: "ithaca-draft" });
    expect(observations, "SESSION_PROFILE_FIRST_SEND_STRICT").toEqual(["strict"]);
    expect(profiles.read(principal.id, "session", "ithaca-chat")).toMatchObject({ preference: "strict", actualProfile: "strict", origin: "interactive" });
    expect(profiles.read(principal.id, "draft", "harbor-draft")).toMatchObject({ preference: "governed", draftPreferenceStored: true });
    nextSession = "harbor-chat";
    await runSession(host, { ...common, draftId: "correlation-harbor", requestId: "request-harbor", profileDraftId: "harbor-draft" });
    expect(observations, "SESSION_PROFILE_SEPARATE_DRAFT_ISOLATION").toEqual(["strict", "governed"]);
    const named = frames.filter(frame => frame.type === "session_info");
    expect(named[0]).toMatchObject({ sessionId: "ithaca-chat", draftId: "correlation-ithaca", requestId: "request-ithaca", workerProfile: { preference: "strict", actualProfile: "strict" } });
    profiles.save(principal.id, "session", "ithaca-chat", "strict");
    const workerStarted = new Promise<void>(resolve => { paused = resolve; }); pauseWorker = true;
    const inFlight = runSession(host, { ...common, sessionId: "ithaca-chat" });
    await workerStarted;
    profiles.save(principal.id, "session", "ithaca-chat", "governed");
    expect(observations.at(-1), "SESSION_PROFILE_SUCCESSFUL_SAVE_RUNNING_AUTHORITY_UNCHANGED").toBe("strict");
    resumeWorker!(); await inFlight; pauseWorker = false;
    expect(profiles.read(principal.id, "session", "ithaca-chat")).toMatchObject({ preference: "governed", actualProfile: "strict" });
    await runSession(host, { ...common, sessionId: "ithaca-chat", source: "voice-dictate" });
    expect(observations.at(-1), "SESSION_PROFILE_DICTATION_INTERACTIVE").toBe("governed");
    await runSession(host, { ...common, sessionId: "ithaca-chat", work: { posture: "voice", started() {}, settle() {} } as never });
    expect(profiles.read(principal.id, "session", "ithaca-chat").origin).toBe("voice");
    expect(() => profiles.save(principal.id, "session", "ithaca-chat", "strict"), "SESSION_PROFILE_VOICE_SAVE_REFUSAL").toThrow("Voice uses");
    const before = observations.length;
    await runSession(host, { ...common, profileDraftId: "harbor-draft" });
    expect(observations.length, "SESSION_PROFILE_UNCORRELATED_FIRST_SEND_REFUSAL").toBe(before);
  } finally { host.close(); }
});
