import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createPiBackend } from "../../ui-backend-pi/src/backend";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { contentHash, createBrainApplication } from "../src/brain/application";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createKeyedLock, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";
import { handleClientMessage } from "../src/ws/dispatch";
import { createMaskApplication, readMaskBase } from "../src/brain/mask-application";
import type { BrainApplicationInput } from "@schlessera/brain-ui-sdk/server";

test.each(["claude", "pi"] as const)("%s first-party curated update respects the same turn's custom protection", async kind => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-application-"));
  const brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "me"));
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nprotect: [me/identity.md]\n---\nAthena protects identity.\n");
  const original = "---\ntype: note\ntitle: Odysseus identity\n---\nOdysseus.\n";
  writeFileSync(join(brain, "me/identity.md"), original);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  const firstParty = kind === "claude" ? createClaudeBackend({ brainPath: brain }) : createPiBackend({ brainPath: brain, loadExtensions: false });
  let applied: BrainApplicationResult | undefined;
  const backend = { ...makeFakeBackend({ id: kind, startTurn: async request => {
    const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox: request.workerSandbox, env: {}, command: ["/bin/sh", "-c",
      'if printf attack > me/identity.md; then exit 41; fi; printf DIRECT_POLICY_WRITE_REFUSED'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toBe("DIRECT_POLICY_WRITE_REFUSED");
    applied = await request.bridge.applyBrain!({ operation: "update", path: "me/identity.md", expectedBaseHash: contentHash(original), append_content: "Athena changed this through the curated route." });
    request.bridge.emit({ type: "session_info", sessionId: `session-${kind}`, isNew: true });
    request.bridge.emit({ type: "result", sessionId: `session-${kind}`, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: firstParty.brainApplicationPolicy };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], kind), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); },
    applicationPlanner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
  try {
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Odysseus inspects identity.", attachments: [] });
    expect(applied?.ok, "POLICY_CURATED_PROTECT_REFUSAL").toBe(false);
    expect(applied?.code).toBe("policy_denied"); expect(applied?.changes).toEqual([]);
    expect(readFileSync(join(brain, "me/identity.md"), "utf8")).toBe(original);
  } finally { host.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("every authoritative document output checks protection before commit, with permitted writes and reads intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-outputs-"));
  for (const dir of ["me", "notes/protected", "projects/active/raft", "generated"]) mkdirSync(join(root, dir), { recursive: true });
  const original = "---\ntype: note\ntitle: Odysseus identity\n---\nOdysseus.\n";
  writeFileSync(join(root, "me/identity.md"), original); writeFileSync(join(root, "projects/active/raft/status.md"), original);
  const protection = ["me/identity.md", "notes/protected", "notes/new-protected.md", "generated/from-policy.md", "projects/archive/raft/status.md"];
  let planned = 0;
  const apply = createBrainApplication({ root, principalId: "odysseus", turnId: "outputs", signal: new AbortController().signal,
    protectedPaths: protection, policy: { available: ["write", "edit", "update", "archive", "add", "staged"], autoAllowed: ["write", "edit", "update", "add", "staged"], lock: createKeyedLock() },
    isAuthorized: () => true, approve: async () => true, record() {}, planner: {
      async planAdd(_root, _input, read) { planned++; expect(read("me/identity.md")).toBe(original); return { path: "generated/from-policy.md", content: original, baseContent: null, outcome: {} }; }, index: async () => {},
    } });
  // The route owns the admitted array; later caller mutation grants nothing.
  protection.length = 0;
  const inputs: BrainApplicationInput[] = [
    { operation: "write", path: "me/identity.md", expectedBaseHash: contentHash(original), content: "Wrong" },
    { operation: "edit", path: "me/identity.md", expectedBaseHash: contentHash(original), old_string: "Odysseus.", new_string: "Wrong" },
    { operation: "update", path: "me/identity.md", expectedBaseHash: contentHash(original), append_content: "Wrong" },
    { operation: "archive", path: "me/identity.md", expectedBaseHash: contentHash(original) },
    { operation: "write", path: "notes/protected/descendant.md", expectedBaseHash: null, content: "Wrong" },
    { operation: "staged", files: [{ path: "notes/allowed.md", expectedBaseHash: null, content: "Allowed later" }, { path: "notes/new-protected.md", expectedBaseHash: null, content: "Wrong" }] },
    { operation: "add", target: "notes/new-protected.md", content: "Wrong" },
    { operation: "add", content: "Wrong generated target" },
    { operation: "archive", path: "projects/active/raft/status.md", expectedBaseHash: contentHash(original) },
  ];
  try {
    for (const input of inputs) {
      const result = await apply({ principalId: "odysseus", turnId: "outputs", input });
      expect(result.code, `POLICY_ALL_OUTPUTS_REFUSED: ${input.operation}`).toBe("policy_denied"); expect(result.changes).toEqual([]);
    }
    expect(planned).toBe(1); expect(existsSync(join(root, "notes/allowed.md")), "POLICY_NO_PARTIAL_STAGED_APPLICATION").toBe(false);
    expect(existsSync(join(root, "projects/archive/raft/status.md"))).toBe(false);
    expect(readFileSync(join(root, "projects/active/raft/status.md"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "me/identity.md"), "utf8")).toBe(original);
    const positive = await apply({ principalId: "odysseus", turnId: "outputs", input: { operation: "write", path: "notes/allowed.md", expectedBaseHash: null, content: "Odysseus may write this.\n" } });
    expect(positive.ok, positive.message).toBe(true); expect(readFileSync(join(root, "notes/allowed.md"), "utf8")).toBe("Odysseus may write this.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a later session's policy load cannot replace the first admitted application authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-sessions-"));
  const brain = join(root, "brain"); for (const dir of ["context/policies", "me", "notes"]) mkdirSync(join(brain, dir), { recursive: true });
  const path = join(brain, "context/policies/governance.md"), original = "---\ntype: note\n---\nOdysseus.\n";
  writeFileSync(path, "---\nschema_version: 1\nprotect: [me/identity.md]\n---\n");
  writeFileSync(join(brain, "me/identity.md"), original); writeFileSync(join(brain, "notes/allowed.md"), original);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  let captured!: () => void, resume!: () => void;
  const firstCaptured = new Promise<void>(resolve => { captured = resolve; }), firstResume = new Promise<void>(resolve => { resume = resolve; });
  const results: BrainApplicationResult[] = [];
  const firstParty = createClaudeBackend({ brainPath: brain });
  const backend = { ...makeFakeBackend({ id: "claude", startTurn: async request => {
    const first = request.prompt === "First";
    request.bridge.emit({ type: "session_info", sessionId: first ? "first-policy-session" : "second-policy-session", isNew: true });
    if (first) { captured(); await firstResume; }
    const result = await request.bridge.applyBrain!({ operation: "update", path: first ? "me/identity.md" : "notes/allowed.md", expectedBaseHash: contentHash(original), append_content: "Athena reviews." });
    results.push(result); request.bridge.emit({ type: "result", sessionId: first ? "first-policy-session" : "second-policy-session", durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: firstParty.brainApplicationPolicy };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); },
    applicationPlanner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
  let first: Promise<void> | undefined;
  try {
    first = runSession(host, { authorization: testAuthorization(principal.id), text: "First", attachments: [] });
    await firstCaptured;
    writeFileSync(path, "---\nschema_version: 1\nprotect: []\n---\n");
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Second", attachments: [] });
    resume(); await first;
    expect(results.map(result => result.ok), "POLICY_ADMITTED_APPLICATION_SESSION_ISOLATION").toEqual([true, false]);
    expect(results[1]?.code).toBe("policy_denied");
    expect(readFileSync(join(brain, "me/identity.md"), "utf8")).toBe(original);
    expect(readFileSync(join(brain, "notes/allowed.md"), "utf8")).toContain("Athena reviews.");
  } finally { resume(); await first; host.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an allowed scratch mask's actual cleanup retains protected files and directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-scratch-"));
  mkdirSync(join(root, ".brain/scratch/kept"), { recursive: true });
  mkdirSync(join(root, ".brain/scratch/empty/branch"), { recursive: true });
  mkdirSync(join(root, ".brain/scratch/anchor"));
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const imagePath = ".brain/scratch/raft.png", maskPath = ".brain/scratch/raft-mask.png", protectedPath = ".brain/scratch/kept/old.png";
  writeFileSync(join(root, imagePath), png); writeFileSync(join(root, protectedPath), png);
  utimesSync(join(root, protectedPath), new Date(0), new Date(0));
  const apply = createMaskApplication({ root, principalId: "odysseus", turnId: "protected-cleanup", signal: new AbortController().signal,
    protectedPaths: [".brain/scratch/kept", ".brain/scratch/empty", ".brain/scratch/anchor/future.png"], lock: createKeyedLock(), isAuthorized: () => true, isAvailable: () => true, record() {} });
  try {
    const result = await apply({ principalId: "odysseus", turnId: "protected-cleanup", base: readMaskBase(root, imagePath), input: { imagePath, maskPath, png } });
    expect(result.ok).toBe(true); expect(readFileSync(join(root, maskPath))).toEqual(png);
    expect(existsSync(join(root, protectedPath)), "POLICY_MASK_CLEANUP_PROTECT_RETENTION").toBe(true);
    expect(readFileSync(join(root, protectedPath))).toEqual(png);
    expect(existsSync(join(root, ".brain/scratch/empty/branch")), "POLICY_MASK_CLEANUP_PROTECTED_DIRECTORY").toBe(true);
    expect(existsSync(join(root, ".brain/scratch/anchor")), "POLICY_MASK_CLEANUP_PROTECTED_ANCESTRY").toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["claude protected", "pi protected", "claude permitted", "pi permitted"] as const)("%s actual submitted PNG mask obeys admitted protection", async variant => {
  const kind = variant.startsWith("pi") ? "pi" : "claude";
  const protectedTarget = variant.endsWith("protected");
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-mask-"));
  const brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "assets"));
  const maskPath = kind === "pi" ? "assets/raft.mask.png" : "assets/raft-mask.png";
  writeFileSync(join(brain, "context/policies/governance.md"), `---\nschema_version: 1\nprotect: [${protectedTarget ? maskPath : ""}]\n---\nAthena reviews this mask.\n`);
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  writeFileSync(join(brain, "assets/raft.png"), png); writeFileSync(join(brain, maskPath), png);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const authorization = testAuthorization(principal.id);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  const firstParty = kind === "claude" ? createClaudeBackend({ brainPath: brain }) : createPiBackend({ brainPath: brain, loadExtensions: false });
  const submitted = Buffer.from([...png, 1]);
  let applied: BrainApplicationResult | undefined;
  const backend = { ...makeFakeBackend({ id: kind, startTurn: async request => {
    const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox: request.workerSandbox, env: {}, command: ["/bin/sh", "-c",
      `${protectedTarget ? `if printf attack > ${maskPath}; then exit 41; fi;` : ""} printf control > permitted.md || exit 42; printf DIRECT_MASK_CONTROL_PASSED`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0); expect(child.stdout.toString()).toBe("DIRECT_MASK_CONTROL_PASSED");
    const response = await request.bridge.requestMask!("assets/raft.png", "Mark the raft sail.");
    applied = await request.bridge.applyImageMask!({ imagePath: "assets/raft.png", maskPath, png: response });
    request.bridge.emit({ type: "session_info", sessionId: `mask-${kind}`, isNew: true });
    request.bridge.emit({ type: "result", sessionId: `mask-${kind}`, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: firstParty.brainApplicationPolicy };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], kind), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  const ws = { send(data: string) {
    const frame = JSON.parse(data);
    if (frame.type === "mask_request") void handleClientMessage(host, ws, { type: "mask_response", requestId: frame.requestId, turnId: frame.turnId, maskPng: submitted.toString("base64") }, { principal, authorization, protocolRev: 3 });
  } };
  host.clients.add(ws, principal.id);
  try {
    await runSession(host, { authorization, text: "Odysseus marks the raft sail.", attachments: [] });
    expect(applied?.ok, "POLICY_SUBMITTED_MASK_PROTECT_REFUSAL").toBe(!protectedTarget);
    if (protectedTarget) { expect(applied?.code).toBe("policy_denied"); expect(applied?.changes).toEqual([]); }
    expect(readFileSync(join(brain, maskPath))).toEqual(protectedTarget ? png : submitted);
  } finally { host.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
