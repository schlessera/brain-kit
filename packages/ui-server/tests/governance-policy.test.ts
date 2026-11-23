import * as operationalState from "../src/brain/operational-state";
import { hostExecution } from "../src/brain/host-boundary";
import * as startupViews from "../../ui-sdk/src/server/worker-startup-view.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { Hono } from "hono";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { createSessionProfiles } from "../src/ws/session-profiles";
import { createSessionProfileRoutes } from "../src/routes/session-profiles";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createGovernancePolicyReader } from "../src/brain/governance-policy";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { openSqliteWriter, procedureCaller } from "../src/db/write-worker";
import * as governedTurnWrites from "../src/brain/governed-turn-writes";
import { createProviderExposures } from "../src/brain/provider-exposure";
import * as probe from "./fixtures/write-worker-probe";
import { watchWriteSites } from "./helpers/write-sites";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const cleanup: Array<() => void> = [];
/** A worker commit held for `ms`, queued at once, as a slow fsync would. */
function slowCommit(writer: import("../src/db/write-worker").SqliteWriter, ms: number) {
  const channel = writer.channel(probe, { table: "odysseus_log" });
  return channel.call("slow", "Calypso", ms);
}
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture(options: { writer?: boolean; slowPolicyRecord?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  const path = join(brain, "context/policies/governance.md");
  const write = (yaml: string) => writeFileSync(path, `---\nschema_version: 1\n${yaml}\n---\nAthena reviews policy.\n`);
  const dbPath = join(root, "state/ui.db");
  mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  // With a writer, admission records commit on it, as in the app (#2850).
  const writer = options.writer ? openSqliteWriter(db) : undefined;
  if (writer) cleanup.push(() => { void writer.close(); });
  // The production recorder (#2758): on the writer when there is one, inline on this connection otherwise.
  const records = procedureCaller(db, governedTurnWrites, undefined, writer);
  const exposures = writer ? createProviderExposures(db, writer) : undefined;
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db, writer);
  const notices: string[] = [];
  // Peers here stay active until the test releases them; refuse at a short bound.
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report: message => notices.push(message),
    peerFolderPlanWaitMs: 300,
    ...(exposures ? { exposures } : {}),
    recordPolicy: (turnId, origin, profile, policy) =>
      (options.slowPolicyRecord ? void slowCommit(writer!, 300) : undefined, records("recordPolicy", turnId, origin, profile, policy.hash, policy.source, JSON.stringify(policy.policy), JSON.stringify(policy.errors), 1)) });
  return { brain, path, write, db, execution, notices, turns, writer, exposures };
}

test.each(["interactive", "voice"] as const)("%s policy selection enters an actual strict worker and records its immutable policy identity", async origin => {
  const f = fixture();
  f.write(`profiles: { interactive: ${origin === "interactive" ? "strict" : "governed"}, voice: ${origin === "voice" ? "strict" : "governed"} }`);
  writeFileSync(join(f.brain, "harbor.md"), "Odysseus arrives.\n");
  const hold = await f.turns.begin(`turn-${origin}`, new AbortController().signal, origin);
  try {
    expect(hold.sandbox.profile, "POLICY_ACTUAL_STRICT_ADMISSION").toBe("strict");
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, startupView: hold.startupView, sandbox: hold.sandbox, env: {}, command: ["/bin/sh", "-c",
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
  } finally { await hold.end(); }
});

test("invalid edits retain the last actual policy/hash and record the validation notice; invalid-first uses defaults", async () => {
  const f = fixture(); f.write("unknown: true");
  const initial = await f.turns.begin("invalid-first", new AbortController().signal);
  expect(initial.policy.hash).toBeNull(); expect(initial.policy.source).toBe("default"); expect(initial.policy.errors.join(" ")).toContain("unknown"); await initial.end();
  f.write("profiles: { interactive: strict }");
  const valid = await f.turns.begin("valid", new AbortController().signal); const hash = valid.policy.hash; await valid.end();
  for (const [index, yaml] of ["unknown: true", "release: [.git/config]", "profiles: { voice: restricted }"].entries()) {
    f.write(yaml);
    const invalid = await f.turns.begin(`invalid-${index}`, new AbortController().signal);
    expect(invalid.sandbox.profile, "POLICY_LAST_VALID_PROFILE_RETAINED").toBe("strict");
    expect(invalid.policy.hash).toBe(hash); expect(invalid.policy.source).toBe("last_valid");
    expect(invalid.policy.errors.length).toBeGreaterThan(0);
    const row = f.db.query("SELECT policy_hash, errors FROM turn_governance_policy WHERE turn_id = ?").get(`invalid-${index}`) as { policy_hash: string | null; errors: string };
    expect(row.policy_hash).toEqual(hash); expect(JSON.parse(row.errors).length).toBeGreaterThan(0); await invalid.end();
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
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, startupView: hold.startupView, sandbox: hold.sandbox, env: {}, command: ["/bin/sh", "-c",
      'if printf attack > me/identity.md; then exit 41; fi; printf released > .claude/settings.json || exit 42; if printf attack > context/policies/governance.md; then exit 43; fi; printf POLICY_PROTECTION_APPLIED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(worker.exitCode, worker.stderr.toString()).toBe(0); expect(worker.stdout.toString()).toBe("POLICY_PROTECTION_APPLIED");
    expect(readFileSync(join(f.brain, "me/identity.md"), "utf8")).toBe("Odysseus.\n");
    expect(readFileSync(join(f.brain, ".claude/settings.json"), "utf8")).toBe("released");
    const row = f.db.query("SELECT manifest FROM governed_turn_manifests WHERE turn_id = ?").get("governed-protection") as { manifest: string };
    expect(JSON.parse(row.manifest).protected).toContain("me/identity.md"); expect(JSON.parse(row.manifest).protected).not.toContain(".claude/settings.json");
  } finally { await hold.end(); }
});

test("a known missing file selects defaults; the reader never invents autonomous authority", () => {
  const f = fixture(); const reader = createGovernancePolicyReader(f.brain);
  expect(reader.load()).toMatchObject({ hash: null, source: "default", errors: [], policy: { profiles: { interactive: "governed", voice: "governed" } } });
  expect(reader.load().policy.profiles).not.toHaveProperty("autonomous");
});

test.each(["interactive", "voice", "dictation", "live"] as const)("real session routing carries %s origin to policy admission", async origin => {
  const f = fixture(); f.write("profiles: { interactive: governed, voice: strict }");
  let actualProfile: string | undefined;
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    actualProfile = request.workerSandbox?.profile;
    const child = Bun.spawnSync(workerCommand({ brainPath: f.brain, startupView: request.workerStartupView, sandbox: request.workerSandbox, env: {}, command: ["/bin/sh", "-c",
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
        : origin === "live" ? { source: "voice-conversation" as const, work: { posture: "interactive", started() {}, settle() {} } as never }
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
    const worker = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: strict.sandbox, startupView: strict.startupView, env: {}, command: ["/bin/sh", "-c", 'if printf attack > harbor.md; then exit 41; fi; printf STRICT_SESSION_WRITE_REFUSED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(worker.exitCode, worker.stderr.toString()).toBe(0);
    expect(worker.stdout.toString()).toBe("STRICT_SESSION_WRITE_REFUSED");
  } finally { await strict.end(); await active.end(); }
  const other = await f.turns.begin("preference-other", signal, "interactive", "governed");
  expect(other.sandbox.profile).toBe("governed"); await other.end();
  const voice = await f.turns.begin("preference-voice", signal, "voice", "strict");
  expect(voice.sandbox.profile, "SESSION_PROFILE_VOICE_IGNORES_INTERACTIVE_PREFERENCE").toBe("governed"); await voice.end();
  f.write("profiles: { interactive: strict }");
  const facts = f.turns.facts();
  expect(facts.policyProfile).toBe("strict");
  f.write("unknown: true");
  const locked = await f.turns.begin("preference-policy-lock", signal, "interactive", "governed");
  expect(locked.sandbox.profile, "SESSION_PROFILE_POLICY_LOWER_BOUND").toBe("strict");
  expect(locked.policy.hash).toBe(facts.policy.hash); await locked.end();
});


test("session profile renders the byte cap in binary units without changing the policy's exact value", () => {
  const f = fixture();
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const profiles = createSessionProfiles(f.db, f.turns);
  const readScope = () => profiles.read(principal.id, "draft", "ithaca-draft").limits.find(limit => limit.name === "Per-turn scope")!.value;
  expect(readScope(), "PROFILE_DEFAULT_READABLE_BYTE_CAP").toContain("4 GiB observed bytes");
  expect(f.turns.facts("interactive").policy.policy.scope.max_bytes_written).toBe(4 * 1024 ** 3);
  for (const [bytes, display] of [[512, "512 B"], [1024, "1 KiB"], [1536 * 1024, "1.5 MiB"]] as const) {
    f.write(`scope: { max_bytes_written: ${bytes} }`);
    expect(readScope(), "PROFILE_CUSTOM_READABLE_BYTE_CAP").toContain(`${display} observed bytes`);
    expect(f.turns.facts("interactive").policy.policy.scope.max_bytes_written).toBe(bytes);
  }
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
    for (const preference of ["strict", "governed"] as const) {
      profiles.save(principal.id, "session", "ithaca-chat", preference);
      await runSession(host, { ...common, sessionId: "ithaca-chat", source: "voice-conversation",
        work: { posture: "interactive", started() {}, observe() {}, settle() {} } });
      expect(observations.at(-1), "SESSION_PROFILE_LIVE_USES_ORDINARY_PREFERENCE").toBe(preference);
      expect(profiles.read(principal.id, "session", "ithaca-chat")).toMatchObject({ preference, actualProfile: preference, origin: "interactive" });
    }
    await runSession(host, { ...common, sessionId: "ithaca-chat", work: { posture: "voice", started() {}, settle() {} } as never });
    expect(profiles.read(principal.id, "session", "ithaca-chat").origin).toBe("voice");
    expect(() => profiles.save(principal.id, "session", "ithaca-chat", "strict"), "SESSION_PROFILE_VOICE_SAVE_REFUSAL").toThrow("Voice uses");
    const before = observations.length;
    await runSession(host, { ...common, profileDraftId: "harbor-draft" });
    expect(observations.length, "SESSION_PROFILE_UNCORRELATED_FIRST_SEND_REFUSAL").toBe(before);
  } finally { host.close(); }
});


test("unsupported policy edits never dispatch engines in the reader or actual admission", async () => {
  const sentinel = frontmatterEngineSentinel();
  try {
    const f = fixture(), reader = createGovernancePolicyReader(f.brain);
    f.write("profiles: { interactive: strict }");
    const valid = reader.load();
    const admitted = await f.turns.begin("supported-yaml", new AbortController().signal); const hash = admitted.policy.hash; await admitted.end();
    for (const [index, language] of ["js", "javascript", "JS", "JavaScript", "json", "unknown"].entries()) {
      writeFileSync(f.path, `\uFEFF--- ${language} \r\nschema_version: 1\r\n---\r\nOdysseus\r\n`);
      const current = reader.load();
      expect(sentinel.dispatched, "READER_NO_ENGINE_DISPATCH").toEqual([]);
      expect(current.source).toBe("last_valid"); expect(current.hash).toBe(valid.hash);
      expect(current.policy.profiles.interactive).toBe("strict"); expect(current.errors.join(" ")).toContain("use YAML data only");
      const turn = await f.turns.begin(`unsupported-${index}`, new AbortController().signal);
      try {
        expect(sentinel.dispatched, "ADMISSION_NO_ENGINE_DISPATCH").toEqual([]);
        expect(turn.policy.source).toBe("last_valid"); expect(turn.policy.hash).toBe(hash);
        expect(turn.sandbox.profile).toBe("strict");
        expect(turn.policy.errors.join(" ")).toContain("use YAML data only");
      } finally { await turn.end(); }
    }
    const fresh = createGovernancePolicyReader(f.brain).load();
    expect(fresh.source).toBe("default"); expect(fresh.hash).toBeNull(); expect(fresh.errors.length).toBeGreaterThan(0);
  } finally { sentinel.restore(); }
});


test("admitted literal provider folders reach real governed mounts and stay masked without a proven recipient", async () => {
  const f = fixture(); f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
  mkdirSync(join(f.brain, "group/private"), { recursive: true });
  writeFileSync(join(f.brain, "group/private/identity.md"), "Odysseus private identity.\n");
  const hold = await f.turns.begin("provider-folder-topology", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    expect(hold.sandbox.retainedFolders).toEqual([".brain-cache", ".brain-index", "group/private"]);
    const child = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `
      if mv group/private group/moved 2>/dev/null; then echo ROOT_RENAMED; exit 41; fi
      if mv group group-moved 2>/dev/null; then echo ANCESTOR_RENAMED; exit 42; fi
      if printf Athena > group/private/new.md 2>/dev/null; then echo MASKED_FOLDER_WRITTEN; exit 43; fi
      printf Odysseus > group/public.md || exit 44
      cat group/private/identity.md 2>/dev/null || printf MASKED
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, `ADMITTED_PROVIDER_FOLDER_PLAN_REACHES_NATIVE_MOUNTS: ${child.stdout.toString()} ${child.stderr.toString()}`).toBe(0);
    // Retention alone authorizes nothing; with no proven recipient (#1665) the folder is masked (#1668).
    expect(child.stdout.toString(), "UNPROVEN_RECIPIENT_SEES_PROVIDER_FOLDER_MASKED").toBe("MASKED");
    expect(readFileSync(join(f.brain, "group/public.md"), "utf8"), "PERMITTED_SIBLING_WRITABLE").toBe("Odysseus");
  } finally { await hold.end(); }
});


test("an invalid admission retains provider folders from the turn reader's last-valid policy", async () => {
  const f = fixture(); f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
  mkdirSync(join(f.brain, "group/private"), { recursive: true });
  expect(f.turns.facts().policy.source).toBe("policy");
  f.write("unknown: true");
  const hold = await f.turns.begin("last-valid-provider-folder", new AbortController().signal);
  try {
    expect(hold.policy.source).toBe("last_valid");
    const child = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      'if mv group/private group/moved 2>/dev/null; then echo ROOT_RENAMED; exit 41; fi'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, `LAST_VALID_ADMITTED_POLICY_REACHES_NATIVE_FOLDER_PINS: ${child.stdout.toString()} ${child.stderr.toString()}`).toBe(0);
    const peer = await f.execution.gate()!.acquire("shared", "turn:athena-inherits-last-valid-plan");
    try {
      const sandbox = prepareWorkerSandbox(f.brain, { profile: "governed", areas: [], folderPaths: peer.folderPaths });
      const child = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
        'if mv group/private group/moved 2>/dev/null; then echo ROOT_RENAMED; exit 41; fi'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, `LAST_VALID_FOLDER_PLAN_REACHES_NEW_PEER_NATIVE_PINS: ${child.stdout.toString()} ${child.stderr.toString()}`).toBe(0);
    }
    finally { peer.release(); }
  } finally { await hold.end(); }
});


test.each(["missing", "legacy", "ancestor"] as const)("a pre-existing unpinned peer cannot invalidate newly admitted provider folder mounts (%s)", async plan => {
  const f = fixture(); f.write(plan === "ancestor" ? "providers: [{ paths: [group/**], allow: [anthropic] }]" : ""); mkdirSync(join(f.brain, "group/private"), { recursive: true });
  writeFileSync(join(f.brain, "group/private/initial.md"), "Athena");
  const prior = await f.execution.gate()!.acquire("shared", "turn:before-provider-folders");
  const oldSandbox = prepareWorkerSandbox(f.brain, { profile: "governed", areas: [], folderPaths: prior.folderPaths });
  const old = launchAgentWorker({ brainPath: f.brain, sandbox: oldSandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
    "printf ready > old-ready.md; IFS= read -r go || exit 43; mv group/private group/retired-private || exit 44; mkdir group/private || exit 45; printf Athena > group/private/born.md"] });
  async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }
  async function ready(path: string) { const deadline = Date.now() + 5000; while (!existsSync(join(f.brain, path))) { if (Date.now() >= deadline) throw Error(`Native peer readiness timed out: ${path}`); await Bun.sleep(5); } }
  const oldOutput = Promise.all([collect(old.stdout), collect(old.stderr)]);
  let admitted: Awaited<ReturnType<typeof f.turns.begin>> | undefined;
  let next: ReturnType<typeof launchAgentWorker> | undefined, refusal: unknown;
  let nextOutput: Promise<string[]> | undefined;
  try {
    await ready("old-ready.md");
    if (plan === "legacy") f.db.query("UPDATE writer_gate SET folder_topology = NULL WHERE id = ?").run(prior.id);
    f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
    try { admitted = await f.turns.begin("provider-folder-with-old-peer", new AbortController().signal); }
    catch (error) { refusal = error; }
    if (!admitted) {
      const nested = await f.execution.gate()!.acquire("shared", "nested credential-free maintenance");
      try { expect(nested.folderPaths, "KNOWN_UNSAFE_PEER_DOES_NOT_BLOCK_NESTED_SHARED_MAINTENANCE").toContain("group/private"); }
      finally { nested.release(); }
      f.write("profiles: { interactive: strict }\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]");
      const strict = await f.turns.begin("strict-during-old-peer", new AbortController().signal);
      try {
        expect(strict.sandbox.profile).toBe("strict");
        const child = launchAgentWorker({ brainPath: f.brain, sandbox: strict.sandbox, startupView: strict.startupView,
          env: {}, command: ["/bin/sh", "-c", "cat group/private/initial.md 2>/dev/null || printf MASKED"] });
        child.stdin.end();
        const [exit, out, err] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
        expect(exit, err).toBe(0); expect(out, "STRICT_TURN_MASKS_PROVIDER_FOLDER_WITHOUT_A_PROVEN_RECIPIENT").toBe("MASKED");
      } finally { await strict.end(); }
    }
    if (admitted) {
      next = launchAgentWorker({ brainPath: f.brain, sandbox: admitted.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
        "printf ready > next-ready.md; IFS= read -r go || exit 46; if mv group/private group/moved-after-peer 2>/dev/null; then printf ROOT_RENAMED; exit 41; fi; printf ROOT_RETAINED"] });
      nextOutput = Promise.all([collect(next.stdout), collect(next.stderr)]);
      await ready("next-ready.md");
    }
    old.stdin.write("go\n"); old.stdin.end();
    expect(await old.exited, (await oldOutput).join("")).toBe(0);
    expect(readFileSync(join(f.brain, "group/private/born.md"), "utf8")).toBe("Athena");
    if (next) {
      next.stdin.write("go\n"); next.stdin.end();
      const exit = await next.exited, output = (await nextOutput!).join("");
      expect(exit, output).toBe(41);
      expect(output, "OLD_PEER_INVALIDATES_A_REAL_POSTMOUNT_QUALIFIED_WRITER").toContain("ROOT_RENAMED");
    }
    expect(String(refusal), "PREEXISTING_UNPINNED_PEER_REFUSES_GOVERNED_FOLDER_ADMISSION").toContain("active peer");
  } finally {
    old.kill(); await old.exited; await oldOutput;
    if (next) { next.kill(); await next.exited; await nextOutput; }
    try { await admitted?.end(); } finally { prior.release(); }
  }
});


test("a live peer retaining a descendant permits shared admission of its pinned ancestor", async () => {
  const f = fixture(); mkdirSync(join(f.brain, "group/private/deeper"), { recursive: true });
  f.write("providers: [{ paths: [group/private/deeper/**], allow: [anthropic] }]");
  const prior = await f.execution.gate()!.acquire("shared", "turn:retained-descendant");
  const sandbox = prepareWorkerSandbox(f.brain, { profile: "governed", areas: [], folderPaths: prior.folderPaths });
  const old = launchAgentWorker({ brainPath: f.brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
    "printf ready > older-ready.md; IFS= read -r go || exit 43; if mv group/private group/moved 2>/dev/null; then exit 41; fi; printf Athena > group/private/deeper/older.md"] });
  async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }
  const oldOutput = Promise.all([collect(old.stdout), collect(old.stderr)]);
  let hold: Awaited<ReturnType<typeof f.turns.begin>> | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.brain, "older-ready.md"))) { if (Date.now() >= deadline) throw Error("Pinned peer readiness timed out"); await Bun.sleep(5); }
    f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
    hold = await f.turns.begin("shared-pinned-ancestor", new AbortController().signal);
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    const next = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      "if mv group/private group/moved 2>/dev/null; then exit 42; fi; printf Odysseus > group/public.md; if printf Athena > group/private/deeper/newer.md 2>/dev/null; then exit 43; fi"] });
    next.stdin.end();
    const [exit, out, err] = await Promise.all([next.exited, collect(next.stdout), collect(next.stderr)]);
    expect(exit, out + err).toBe(0);
    old.stdin.write("go\n"); old.stdin.end();
    expect(await old.exited, (await oldOutput).join("")).toBe(0);
    expect(readFileSync(join(f.brain, "group/private/deeper/older.md"), "utf8")).toBe("Athena");
    expect(existsSync(join(f.brain, "group/private/deeper/newer.md")), "MASKED_FOLDER_NOT_WRITTEN_BY_UNPROVEN_RECIPIENT").toBe(false);
    expect(readFileSync(join(f.brain, "group/public.md"), "utf8")).toBe("Odysseus");
  } finally { old.kill(); await old.exited; await oldOutput; try { await hold?.end(); } finally { prior.release(); } }
});


test("a gate without peer-plan checking cannot admit a governed folder request", async () => {
  const f = fixture(); mkdirSync(join(f.brain, "group/private"), { recursive: true });
  f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
  const gate = f.execution.gate()!, acquire = gate.acquire.bind(gate);
  const hook = spyOn(gate, "acquire").mockImplementation(async (...args) => {
    const hold = await acquire(...args);
    return { ...hold, assertPeerFolderPlans: undefined };
  });
  let admitted: Awaited<ReturnType<typeof f.turns.begin>> | undefined, refusal: unknown;
  try {
    try { admitted = await f.turns.begin("unknown-peer-checker", new AbortController().signal); }
    catch (error) { refusal = error; }
    expect(String(refusal), "UNKNOWN_PEER_CHECKER_CANNOT_ADMIT_GOVERNED_FOLDER").toContain("cannot check active peer plans");
  } finally { hook.mockRestore(); await admitted?.end(); }
  expect(gate.holders()).toEqual([]);
});


test("a missing folder preserves strict fallback beside an unaccounted peer", async () => {
  const f = fixture(); f.write("");
  const gate = f.execution.gate()!, prior = await gate.acquire("shared", "old unaccounted writer");
  f.db.query("UPDATE writer_gate SET folder_topology = NULL WHERE id = ?").run(prior.id);
  f.write("providers: [{ paths: [group/private/**], allow: [anthropic] }]");
  let hold: Awaited<ReturnType<typeof f.turns.begin>> | undefined;
  try {
    hold = await f.turns.begin("missing-folder-strict-fallback", new AbortController().signal);
    expect(hold.sandbox.profile).toBe("strict");
    expect(hold.sandbox.fallbackReason).toContain("protected paths could not be verified");
    expect(existsSync(join(f.brain, "group/private"))).toBe(false);
    const child = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, startupView: hold.startupView,
      env: {}, command: ["/bin/sh", "-c", "test ! -e group/private"] });
    child.stdin.end();
    async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }
    const [exit, out, err] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
    expect(exit, out + err).toBe(0);
  } finally { try { await hold?.end(); } finally { prior.release(); } }
});

test("a governed turn's admission records have committed when admission settles, and its manifest close when it ends (#2850)", async () => {
  const f = fixture({ writer: true });
  f.write("profiles: { interactive: governed }");
  const hold = await f.turns.begin("ithaca-records", new AbortController().signal);
  const policy = f.db.query("SELECT profile FROM turn_governance_policy WHERE turn_id = 'ithaca-records'").get();
  expect(policy, "ADMISSION_POLICY_RECORD_COMMITTED_BEFORE_ADMISSION_SETTLES").toEqual({ profile: "governed" });
  const manifest = () => f.db.query("SELECT ended_at FROM governed_turn_manifests WHERE turn_id = 'ithaca-records'").get();
  expect(manifest(), "ADMISSION_MANIFEST_COMMITTED_BEFORE_ADMISSION_SETTLES").toEqual({ ended_at: null });
  await hold.end();
  expect(manifest(), "ADMISSION_MANIFEST_CLOSE_COMMITTED_BEFORE_END_SETTLES").toEqual({ ended_at: expect.any(Number) });
});

test("an exposure read waits for every exposure write submitted before it (#2850)", async () => {
  const f = fixture({ writer: true });
  const shown = { recipient: "anthropic", visible: ["me"], hidden: [] };
  await f.exposures!.record("ithaca-bind", null, shown);
  const held = f.writer!.channel(probe, { table: "odysseus_log" }); await held.ready;
  const slow = held.call("slow", "Calypso", 300);
  const bound = f.turns.bindSession("ithaca-bind", "ithaca-session");
  expect(f.exposures!.forSessions(["ithaca-session"]), "EXPOSURE_BIND_NOT_COMMITTED_ON_LOOP").toEqual([]);
  expect(await f.turns.exposures(["ithaca-session"]), "EXPOSURE_READ_WAITS_FOR_PENDING_BIND").toEqual([shown]);
  await bound; await slow;
});

test("a governed turn's admission records commit on the write worker at FULL, never on the app connection (#2850)", async () => {
  const f = fixture({ writer: true });
  f.write("profiles: { interactive: governed }");
  const sites = await watchWriteSites(f.db, f.writer!, ["turn_governance_policy", "governed_turn_manifests", "session_provider_exposure", "session_masked_lineage"]);
  const hold = await f.turns.begin("ithaca-sites", new AbortController().signal);
  await hold.end();
  await f.exposures!.record("ithaca-sites", null, { recipient: "anthropic", visible: ["me"], hidden: [] });
  await f.exposures!.startMasked("ithaca-sites", ["me"]);
  await f.turns.bindSession("ithaca-sites", "ithaca-sites-session");
  await f.exposures!.narrowMasked("ithaca-sites-2", "ithaca-sites-session", ["me"]);
  expect(new Set(await sites.log()), "ADMISSION_RECORDS_WRITTEN_ON_WORKER").toEqual(new Set(["turn_governance_policy", "governed_turn_manifests", "session_provider_exposure", "session_masked_lineage"]));
});

test("a strict turn's policy record has committed when admission settles, and a manifest close when it settles (#2850)", async () => {
  // A slow commit is queued just ahead of the policy record.
  const f = fixture({ writer: true, slowPolicyRecord: true });
  f.write("profiles: { interactive: strict }");
  const hold = await f.turns.begin("ithaca-strict", new AbortController().signal);
  expect(f.db.query("SELECT profile FROM turn_governance_policy WHERE turn_id = 'ithaca-strict'").get(), "ADMISSION_STRICT_POLICY_RECORD_COMMITTED").toEqual({ profile: "strict" });
  await hold.end();
  // A manifest's close settles once its record commits, behind a slow commit.
  const manifests = f.execution.manifests()!;
  await manifests.begin("ithaca-close");
  const held = f.writer!.channel(probe, { table: "odysseus_log" }); await held.ready;
  const slow = held.call("slow", "Calypso", 300);
  await manifests.end("ithaca-close");
  expect((f.db.query("SELECT ended_at FROM governed_turn_manifests WHERE turn_id = 'ithaca-close'").get() as { ended_at: number | null }).ended_at, "MANIFEST_CLOSE_SETTLES_AFTER_ITS_RECORD").not.toBeNull();
  await slow;
});

test("code changes API persists a session preference without changing an admitted worker", async () => {
  const f = fixture();
  mkdirSync(join(f.brain, "workspaces/ithaca"), { recursive: true });
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const catalog = createSessionCatalog(() => f.db);
  catalog.persistSessionStub("ithaca-code", "Odysseus inspects source.", "claude", "claude", principal.id);
  const profiles = createSessionProfiles(f.db, f.turns);
  const app = new Hono<AppEnv>().use("*", (c, next) => { c.set("principal", principal); return next(); }).route("/api", createSessionProfileRoutes(profiles));
  const path = "/api/sessions/ithaca-code/code-changes";
  expect(await (await app.request(path)).json(), "CODE_CHANGES_DEFAULT_OFF").toEqual({ enabled: false });
  const observations: boolean[] = [];
  const inboxProtections: { protectedPaths?: readonly string[]; workspaceReadOnly?: boolean }[] = [];
  let refusedWrite: import("@schlessera/brain-ui-sdk/server").BrainApplicationResult | undefined;
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    observations.push(request.workerSandbox!.areas.find(area => area.name === "workspaces")!.mount.writable);
    if (observations.length === 1 || observations.length === 3) {
      refusedWrite = await request.bridge.applyBrain!({ operation: "write", path: "workspaces/ithaca/readme.md", content: "Athena changes source.", expectedBaseHash: null });
      const saved = await app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      expect(saved.status).toBe(200);
      expect(request.workerSandbox!.areas.find(area => area.name === "workspaces")!.mount.writable, "RUNNING_MOUNT_STAYS_FROZEN").toBe(false);
    }
    request.bridge.emit({ type: "session_info", sessionId: "ithaca-code", isNew: false });
    request.bridge.emit({ type: "result", sessionId: "ithaca-code", durationMs: 1, numTurns: 1, isError: false });
  } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: f.brain, governedTurns: f.turns, sessionProfiles: profiles, catalog, isPrincipalAuthorized: id => id === principal.id,
    inboxTools: { forTurn(context: { protectedPaths?: readonly string[]; workspaceReadOnly?: boolean }) { inboxProtections.push({ protectedPaths: context.protectedPaths, workspaceReadOnly: context.workspaceReadOnly }); return {}; } } as never,
    registry: createStaticBackendRegistry([backend], backend.id) });
  host.clients.add({ send() {} }, principal.id);
  try {
    const input = { authorization: testAuthorization(principal.id), sessionId: "ithaca-code", text: "Odysseus inspects the source.", attachments: [] };
    await runSession(host, input); await runSession(host, input);
    expect(refusedWrite?.code, "INSPECT_SESSION_BRIDGE_REFUSES_CHECKOUT_WRITE").toBe("policy_denied");
    expect(refusedWrite?.message).toContain("switch on code changes for this session");
    expect(observations, "NEXT_ADMISSION_USES_SAVED_CODE_MODE").toEqual([false, true]);
    expect(inboxProtections[0]?.workspaceReadOnly, "INSPECT_INBOX_INTAKE_GETS_WORKSPACE_PROTECTION").toBe(true);
    expect(inboxProtections[0]?.protectedPaths, "IMPLICIT_INSPECTION_IS_NOT_AN_EXPLICIT_OWNER_PROTECTION").not.toContain("workspaces");
    expect(inboxProtections[1]?.workspaceReadOnly, "WRITER_INBOX_INTAKE_KEEPS_EXISTING_POLICY").toBe(false);
    expect(inboxProtections[1]?.protectedPaths).toEqual(inboxProtections[0]?.protectedPaths);
    const begin = f.turns.begin.bind(f.turns);
    f.turns.begin = async (...args) => {
      const hold = await begin(...args);
      return { ...hold, sandbox: { ...hold.sandbox, areas: hold.sandbox.areas.map(area => area.name === "workspaces"
        ? { ...area, mount: { writable: false as const, reason: "over-limit scan", readOnlyPath: join(f.brain, "workspaces") } } : area) } };
    };
    await runSession(host, input);
    expect(refusedWrite?.code, "REFUSED_WRITABLE_MOUNT_KEEPS_HOST_WRITE_GUARD").toBe("policy_denied");
    expect(inboxProtections[2]?.workspaceReadOnly, "REFUSED_WRITABLE_MOUNT_KEEPS_ALL_HOST_GUARDS").toBe(true);
    const reloaded = createSessionProfiles(f.db, f.turns);
    expect(reloaded.codeChanges(principal.id, "ithaca-code"), "CODE_MODE_SURVIVES_RESUME").toBe(true);
    catalog.persistSessionStub("troy-code", "Athena inspects source.", "claude", "claude", principal.id);
    expect(reloaded.codeChanges(principal.id, "troy-code"), "CODE_MODE_IS_SESSION_LOCAL").toBe(false);
    revokePrincipal(f.db, principal.id, Date.now());
    expect((await app.request(path)).status, "CODE_MODE_RECHECKS_AUTH").toBe(401);
  } finally { host.close(); }
});

test("draft code changes are principal scoped, bind to a new session, and preserve independent profile saves", async () => {
  const f = fixture();
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const other = createPrincipal(f.db, { authMethod: "password", label: "Penelope device", ttlSeconds: 3600 });
  const profiles = createSessionProfiles(f.db, f.turns);
  const app = new Hono<AppEnv>().use("*", (c, next) => { c.set("principal", principal); return next(); }).route("/api", createSessionProfileRoutes(profiles));
  const save = (body: unknown) => app.request("/api/drafts/ithaca-draft/code-changes", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [null, [], {}, { enabled: "true" }, { enabled: true, profile: "governed" }])
    expect((await save(body)).status, "CODE_MODE_REJECTS_MALFORMED_INPUT").toBe(400);
  expect(await (await save({ enabled: true })).json()).toEqual({ enabled: true });
  await profiles.save(principal.id, "draft", "ithaca-draft", "strict");
  expect(profiles.codeChanges(principal.id, undefined, "ithaca-draft"), "PROFILE_SAVE_PRESERVES_CODE_MODE").toBe(true);
  expect(profiles.readCodeChanges(other.id, "draft", "ithaca-draft"), "FOREIGN_DRAFT_HAS_NO_CODE_GRANT").toEqual({ enabled: false });
  const catalog = createSessionCatalog(() => f.db);
  catalog.persistSessionStub("ithaca-bound", "Odysseus changes source.", "claude", "claude", principal.id);
  await profiles.bind(principal.id, "ithaca-draft", "ithaca-bound");
  expect(profiles.codeChanges(principal.id, "ithaca-bound"), "DRAFT_CODE_MODE_BINDS_TO_SESSION").toBe(true);
  expect(profiles.read(principal.id, "session", "ithaca-bound").preference).toBe("strict");
  await profiles.saveCodeChanges(principal.id, "session", "ithaca-bound", false);
  expect(profiles.read(principal.id, "session", "ithaca-bound").preference, "CODE_SAVE_PRESERVES_PROFILE").toBe("strict");
  expect(profiles.readCodeChanges(principal.id, "draft", "ithaca-draft")).toEqual({ enabled: false });
});

test("code changes require proven chat ownership for saves, reads, draft binds and admission", async () => {
  const f = fixture();
  const owner = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const otherLogin = createPrincipal(f.db, { authMethod: "password", label: "Athena tablet", ttlSeconds: 3600 });
  f.db.query("INSERT INTO principals(id,kind,auth_method,label,created_at,expires_at) VALUES ('telemachus','agent','delegated','Telemachus',0,?)").run(Date.now() + 3600_000);
  const profiles = createSessionProfiles(f.db, f.turns), catalog = createSessionCatalog(() => f.db);
  catalog.persistSessionStub("owned-source", "Odysseus inspects source.", "claude", "claude", owner.id);
  catalog.persistSessionStub("legacy-source", "Ithaca source.", "claude", "claude");
  await expect(profiles.saveCodeChanges("telemachus", "session", "owned-source", true)).rejects.toThrow("not available");
  await expect(profiles.saveCodeChanges(owner.id, "session", "legacy-source", true)).rejects.toThrow("not available");
  expect(() => profiles.readCodeChanges("telemachus", "session", "owned-source")).toThrow("not available");
  await profiles.saveCodeChanges(owner.id, "session", "owned-source", true);
  expect(profiles.codeChanges("telemachus", "owned-source"), "FOREIGN_ADMISSION_CANNOT_INHERIT_WRITE_GRANT").toBe(false);
  expect(profiles.codeChanges(otherLogin.id, "owned-source"), "SAME_ACCOUNT_RESUME_KEEPS_WRITE_GRANT").toBe(true);
  await profiles.saveCodeChanges("telemachus", "draft", "foreign-draft", true);
  await expect(profiles.bind("telemachus", "foreign-draft", "owned-source")).rejects.toThrow("not available");
});


test("resume code-change checks never resolve task deletion inventories", async () => {
  const f = fixture();
  const owner = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const catalog = createSessionCatalog(() => f.db), profiles = createSessionProfiles(f.db, f.turns);
  catalog.persistSessionStub("resume-source", "Ithaca source.", "claude", "claude", owner.id);
  f.db.query("INSERT INTO conversation_epochs(id,principal_id,principal_account,epoch,session_id,updated_at) VALUES(?,?,NULL,1,?,0)").run("resume-epoch", owner.id, "resume-source");
  const query = f.db.query.bind(f.db);
  const reads: string[] = [];
  let refuseTasks = false;
  const spy = spyOn(f.db, "query").mockImplementation((sql: string) => {
    reads.push(sql);
    if (refuseTasks && sql.includes("conversation_tasks")) throw new Error("Deletion inventory must not run on admission");
    return query(sql);
  });
  try {
    expect(profiles.codeChanges(owner.id, "resume-source")).toBe(false);
    expect(reads.some(sql => sql.includes("dialogue_owners")), "DEFAULT_RESUME_READS_ONLY_ITS_SAVED_SWITCH").toBe(false);
    await profiles.saveCodeChanges(owner.id, "session", "resume-source", true);
    reads.length = 0; refuseTasks = true;
    expect(profiles.codeChanges(owner.id, "resume-source"), "ENABLED_RESUME_PROVES_OWNERSHIP_WITHOUT_TASK_INVENTORY").toBe(true);
    expect(reads.some(sql => sql.includes("conversation_tasks"))).toBe(false);
  } finally { spy.mockRestore(); }
});


test("an absent-area admission permits ordinary host writes before the next turn seals the workspace", async () => {
  const f = fixture();
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const catalog = createSessionCatalog(() => f.db);
  catalog.persistSessionStub("absent-source", "Ithaca source.", "claude", "claude", principal.id);
  const profiles = createSessionProfiles(f.db, f.turns);
  const results: import("@schlessera/brain-ui-sdk/server").BrainApplicationResult[] = [];
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    if (!results.length) mkdirSync(join(f.brain, "workspaces/ithaca"), { recursive: true });
    results.push(await request.bridge.applyBrain!({ operation: "write", path: `workspaces/ithaca/${results.length ? "second" : "first"}.md`, content: "Athena inspects source.", expectedBaseHash: null }));
    request.bridge.emit({ type: "session_info", sessionId: "absent-source", isNew: false });
    request.bridge.emit({ type: "result", sessionId: "absent-source", durationMs: 1, numTurns: 1, isError: false });
  } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: f.brain, governedTurns: f.turns, sessionProfiles: profiles, catalog, isPrincipalAuthorized: id => id === principal.id,
    registry: createStaticBackendRegistry([backend], backend.id) });
  host.clients.add({ send() {} }, principal.id);
  try {
    const input = { authorization: testAuthorization(principal.id), sessionId: "absent-source", text: "Odysseus inspects source.", attachments: [] };
    await runSession(host, input); await runSession(host, input);
    expect(results[0], "ABSENT_AREA_HOST_WRITE_IS_ORDINARY_CONTENT").toMatchObject({ ok: true });
    expect(results[1], "NEXT_ADMISSION_HOST_WRITE_MEETS_READ_ONLY_MOUNT").toMatchObject({ ok: false, code: "policy_denied" });
  } finally { host.close(); }
});


test("a workspace symlink cannot protect unrelated ordinary Markdown applications", async () => {
  const f = fixture();
  mkdirSync(join(f.brain, "notes")); symlinkSync(f.brain, join(f.brain, "workspaces"));
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
  const catalog = createSessionCatalog(() => f.db);
  catalog.persistSessionStub("symlink-source", "Ithaca source.", "claude", "claude", principal.id);
  const profiles = createSessionProfiles(f.db, f.turns);
  const results: import("@schlessera/brain-ui-sdk/server").BrainApplicationResult[] = [];
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    results.push(await request.bridge.applyBrain!({ operation: "write", path: results.length ? "workspaces/notes/raft.md" : "notes/raft.md", content: "Athena inspects source.", expectedBaseHash: null }));
    request.bridge.emit({ type: "session_info", sessionId: "symlink-source", isNew: false });
    request.bridge.emit({ type: "result", sessionId: "symlink-source", durationMs: 1, numTurns: 1, isError: false });
  } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: f.brain, governedTurns: f.turns, sessionProfiles: profiles, catalog, isPrincipalAuthorized: id => id === principal.id,
    registry: createStaticBackendRegistry([backend], backend.id) });
  host.clients.add({ send() {} }, principal.id);
  try {
    const input = { authorization: testAuthorization(principal.id), sessionId: "symlink-source", text: "Odysseus inspects source.", attachments: [] };
    await runSession(host, input); await runSession(host, input);
    expect(results[0], "WORKSPACE_LINK_DOES_NOT_PROTECT_THE_WHOLE_BRAIN").toMatchObject({ ok: true });
    expect(results[1], "WORKSPACE_NAMESPACE_STILL_REFUSES_WRITES").toMatchObject({ ok: false, code: "policy_denied" });
  } finally { host.close(); }
});


test("an owner explicitly protecting the workspace symlink also protects its destination",async()=>{
 const f=fixture();mkdirSync(join(f.brain,"notes"));symlinkSync(f.brain,join(f.brain,"workspaces"));f.write("protect: [workspaces]");
 const principal=createPrincipal(f.db,{authMethod:"password",label:"Athena device",ttlSeconds:3600});const catalog=createSessionCatalog(()=>f.db);catalog.persistSessionStub("owner-source","Ithaca source.","claude","claude",principal.id);
 let result:unknown;const backend=makeFakeBackend({id:"claude",startTurn:async request=>{result=await request.bridge.applyBrain!({operation:"write",path:"notes/raft.md",content:"Athena protects this destination.",expectedBaseHash:null});request.bridge.emit({type:"result",sessionId:"owner-source",durationMs:1,numTurns:1,isError:false});}});
 backend.brainApplicationPolicy=()=>({autoAllowed:["write"],available:["write"],lock:createKeyedLock()});
 const host=new WsHost({brainPath:f.brain,governedTurns:f.turns,catalog,isPrincipalAuthorized:id=>id===principal.id,registry:createStaticBackendRegistry([backend],backend.id)});host.clients.add({send(){}},principal.id);
 try{await runSession(host,{authorization:testAuthorization(principal.id),sessionId:"owner-source",text:"Inspect the raft.",attachments:[]});expect(result,"EXPLICIT_OWNER_PROTECTION_RETAINS_SYMLINK_DESTINATION").toMatchObject({ok:false,code:"policy_denied"});expect(existsSync(join(f.brain,"notes/raft.md"))).toBe(false);}finally{host.close();}
});

test("a host without governedTurns still seals privileged checkout applications",async()=>{
 const f=fixture();mkdirSync(join(f.brain,"notes"));mkdirSync(join(f.brain,"workspaces/ithaca"),{recursive:true});
 const principal=createPrincipal(f.db,{authMethod:"password",label:"Athena device",ttlSeconds:3600});const catalog=createSessionCatalog(()=>f.db);catalog.persistSessionStub("hostless-source","Ithaca source.","claude","claude",principal.id);
 const results:unknown[]=[];const backend=makeFakeBackend({id:"claude",startTurn:async request=>{for(const path of ["notes/raft.md","workspaces/ithaca/source.md"])results.push(await request.bridge.applyBrain!({operation:"write",path,content:"Athena inspects.",expectedBaseHash:null}));request.bridge.emit({type:"result",sessionId:"hostless-source",durationMs:1,numTurns:1,isError:false});}});
 backend.brainApplicationPolicy=()=>({autoAllowed:["write"],available:["write"],lock:createKeyedLock()});
 const host=new WsHost({brainPath:f.brain,catalog,isPrincipalAuthorized:id=>id===principal.id,registry:createStaticBackendRegistry([backend],backend.id)});host.clients.add({send(){}},principal.id);
 try{await runSession(host,{authorization:testAuthorization(principal.id),sessionId:"hostless-source",text:"Inspect the raft.",attachments:[]});expect(results[0],"HOSTLESS_NOTES_STAY_USABLE").toMatchObject({ok:true});expect(results[1],"HOSTLESS_APPLICATION_CANNOT_BYPASS_INSPECTION").toMatchObject({ok:false,code:"policy_denied",message:expect.stringContaining("switch on code changes for this session")});expect(existsSync(join(f.brain,"workspaces/ithaca/source.md"))).toBe(false);}finally{host.close();}
});


test.each(["absent","symlink"])("admission refreshes an inspected %s checkpoint source",async state=>{
 const f=fixture();f.write("profiles: {interactive: strict}");mkdirSync(join(f.brain,"workspaces/ithaca"),{recursive:true});mkdirSync(join(f.brain,"notes"));mkdirSync(join(f.brain,".brain/scratch"),{recursive:true});let checkpoints=0;
 const acquisition=spyOn(startupViews,"prepareNativeWorkerStartupView").mockImplementation(async brain=>{const view=createFixtureWorkerStartupView(brain);if(++checkpoints===1){rmSync(join(view.root,"workspaces"),{recursive:true});if(state==="symlink")symlinkSync(join(view.root,"notes"),join(view.root,"workspaces"));}return view;});
 try{const hold=await f.turns.begin("stale-inspection",new AbortController().signal);try{expect(checkpoints,"INSPECTION_REFRESHES_THE_SOURCE_IT_ACTUALLY_MOUNTS").toBe(2);expect(hold.startupView).toBeDefined();expect(hold.sandbox.areas.find(area=>area.name==="workspaces")!.mount.writable).toBe(false);}finally{await hold.end();}}finally{acquisition.mockRestore();}
});


for (const profile of ["governed", "strict"] as const) test(`${profile} turns refuse unverified private state and recover without a cached verdict`, async () => {
  const f = fixture(); f.write(`profiles: { interactive: ${profile} }`);
  const unavailable = { available: false as const, reason: "private_state_unverified" as const, detail: "OperationalStateAliasVerificationUnavailable: journal-cause-canary" };
  const changed = spyOn(f.execution.boundary, "prepare").mockResolvedValue(unavailable);
  const acquisition = spyOn(startupViews, "prepareNativeWorkerStartupView");
  try {
    const error = await f.turns.begin("alias-refusal", new AbortController().signal).then(async hold => { await hold.end(); return undefined; }, error => error);
    expect(changed, "ADMISSION_REACHES_THE_PREPARE_VERDICT").toHaveBeenCalledTimes(1);
    expect(error?.reason, "BOTH_PROFILES_REFUSE_THE_POST_PREPARE_UNVERIFIED_VERDICT").toBe("private_state_unverified");
    expect(acquisition, "UNVERIFIED_PREPARE_FOLLOWS_STARTUP_CHECKPOINT").toHaveBeenCalledTimes(1);
    changed.mockRestore();
    const recovered = await f.turns.begin("alias-recovery", new AbortController().signal);
    await recovered.end();
  } finally { changed.mockRestore(); acquisition.mockRestore(); }
});


test("one warm admitted turn walks private state exactly once", async () => {
  const f = fixture(); f.write("profiles: { interactive: strict }");
  const first = await f.turns.begin("alias-warmup", new AbortController().signal);
  await first.end();
  const walk = spyOn(operationalState, "operationalStateRefusal");
  try {
    const admitted = await f.turns.begin("alias-warm", new AbortController().signal);
    try {
      expect(admitted.sandbox.profile).toBe("strict");
      expect(walk, "WARM_ADMISSION_WALKS_PRIVATE_STATE_EXACTLY_ONCE").toHaveBeenCalledTimes(1);
    } finally { await admitted.end(); }
  } finally { walk.mockRestore(); await f.turns.close(); }
});

test("preparation keeps the private-state refusal ahead of the in-brain cwd shortcut", async () => {
  const f = fixture();
  const unavailable = { available: false as const, reason: "private_state_unverified" as const, detail: "OperationalStateAliasVerificationUnavailable: journal-cause-canary" };
  const walk = spyOn(operationalState, "operationalStateRefusal").mockReturnValue(unavailable);
  const cwd = spyOn(hostExecution, "cwd").mockReturnValue(f.brain);
  const probe = spyOn(hostExecution, "probe").mockReturnValue({ ok: false, requirement: "offline worker fixture" });
  try {
    expect(await f.execution.boundary.prepare(), "PREPARE_PRIVATE_STATE_REFUSAL_WINS_OVER_CWD").toMatchObject(unavailable);
    expect(walk).toHaveBeenCalledTimes(1);
  } finally { probe.mockRestore(); cwd.mockRestore(); walk.mockRestore(); await f.turns.close(); }
});
