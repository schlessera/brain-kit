/**
 * Host writers a turn drives outside its worker refuse every target in the
 * turn's admitted protection set (#2876, option 1): conversation inbox
 * staging (`inbox_add`) with its compensation, and an autonomous turn's
 * exactly approved application. Links count both ways, as do ancestors and
 * descendants, and the refusal is the hosted application's. A target outside
 * the set still writes.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, BrainApplicationInput, BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { createInboxBridgeTools } from "../src/inbox/bridge-tools.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { boundaryPlanner, contentHash, createBrainApplication } from "../src/brain/application.js";
import { createFixtureHostBoundary } from "./helpers/native-host-fixture.js";
import { createHostExecution } from "../src/brain/host-execution.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";
import { WsHost } from "../src/ws/host.js";
import { runSession } from "../src/ws/run-session.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization } from "./helpers/principal.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createMaskApplication, readMaskBase } from "../src/brain/mask-application.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const LORE = "---\ntype: note\ntitle: Ithacan lore\n---\nThe suitors gather in the hall.\n";
const NOTE = "---\ntype: note\ntitle: Harbor\n---\nOdysseus reaches Ithaca.\n";
/** The hosted application's refusal of a protected target, word for word. */
const PROTECTED_TARGET_REFUSAL = "This target is protected by the policy admitted for this turn; no change was applied.";

/** Every file under a folder with its exact bytes, links not followed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1)] = readFileSync(path).toString("base64");
  }
  return out;
}

/** A brain whose admitted policy protects `protect`, with `lore/` holding owner data. */
function brainWith(protect: readonly string[], arrange?: (brain: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-protected-writers-")), brain = join(root, "brain");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["context/policies", "lore", "notes"]) mkdirSync(join(brain, dir), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), `---\nschema_version: 1\nprotect: [${protect.join(", ")}]\n---\nOdysseus protects the lore.\n`);
  writeFileSync(join(brain, "lore/taxonomy.md"), LORE);
  arrange?.(brain);
  return { root, brain };
}

// ---------------------------------------------------------------------------
// The autonomous turn's exactly approved application.

/** An admitted autonomous run whose one approved operation is `proposal`. */
async function autonomousApply(protect: readonly string[], proposal: BrainApplicationInput & { operation: "write" | "edit" | "update" }, arrange?: (brain: string) => void) {
  const { root, brain } = brainWith(protect, arrange);
  const native = createNativeJournalFixture(brain, root);
  cleanup.push(() => native.close());
  const db = createUiDb(":memory:");
  cleanup.push(() => db.close());
  const store = createActivityStore(db, { writer: "protected-writers-test" });
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  createInboxStore(db).ingest({ threadId: "ithaca", itemId: "ithaca", dedupKey: "ithaca", stagingId: "ithaca", source: "share", stakes: 2, expiresAt: Date.now() + 86_400_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 },
    pricing: { resolve: () => ({ input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } });
  budget.claim("ithaca", { runId: "run", principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, Date.now() + 600_000);
  let applied: BrainApplicationResult | undefined, escalations = 0;
  const backend: AgentBackend = { id: "pi", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    startTurn: async req => {
      applied = await req.bridge.applyBrain!(proposal);
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
    },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    brainApplicationPolicy: () => ({ autoAllowed: [], available: ["write", "edit", "update"], lock: createKeyedLock() }) };
  const toolName = { write: "write_file", edit: "edit_file", update: "brain_update" }[proposal.operation];
  const before = snapshot(join(brain, "lore"));
  await runAutonomousTurn({ db, store, backend, brainPath: brain, nativeManager: native.client,
    applicationPlanner: boundaryPlanner(createFixtureHostBoundary({ brainPath: brain })), checkpoint() { escalations++; } },
  { turnId: "run", principalId: principal.id, prompt: "Odysseus files his harbor note.", systemPromptAppend: "Server selected instructions",
    allowedTools: [toolName], signal: new AbortController().signal,
    application: { approved: { toolName, input: proposal, targetPath: proposal.path } } });
  expect(escalations, "THE_APPROVED_OPERATION_NEEDS_NO_FURTHER_DECISION").toBe(0);
  return { brain, applied: applied!, before, after: snapshot(join(brain, "lore")) };
}

test("an autonomous turn's approved write outside the protection set still applies", async () => {
  const proposal = { operation: "write" as const, path: "notes/harbor.md", expectedBaseHash: null, content: NOTE };
  const { brain, applied } = await autonomousApply(["lore"], proposal);
  expect(applied.ok, applied.message).toBe(true);
  expect(readFileSync(join(brain, "notes/harbor.md"), "utf8")).toBe(NOTE);
});

/**
 * `absent` names what the refused application must not have created. A link
 * on the target's own way keeps the route's alias refusal, as for a hosted turn.
 */
const ALIAS_REFUSAL = { code: "alias_denied", message: "A target directory is a symlink or is not a directory." };
const AUTONOMOUS_CASES: { name: string; protect: string[]; proposal: BrainApplicationInput & { operation: "write" | "edit" | "update" }; arrange?: (brain: string) => void;
  absent?: string; refusal?: { code: string; message: string } }[] = [
  { name: "the protected document itself", protect: ["lore/taxonomy.md"],
    proposal: { operation: "update", path: "lore/taxonomy.md", expectedBaseHash: contentHash(LORE), append_content: "The suitors are gone." } },
  { name: "a new document below a protected folder", protect: ["lore"], absent: "lore/suitors.md",
    proposal: { operation: "write", path: "lore/suitors.md", expectedBaseHash: null, content: NOTE } },
  { name: "a document whose missing folders a protected path names", protect: ["lore/heroes"], absent: "lore/heroes",
    proposal: { operation: "write", path: "lore/heroes/odysseus.md", expectedBaseHash: null, content: NOTE } },
  { name: "a link that leads into a protected folder", protect: ["lore"], absent: "lore/suitors.md", refusal: ALIAS_REFUSAL,
    arrange: brain => symlinkSync("../lore", join(brain, "notes/legends")),
    proposal: { operation: "write", path: "notes/legends/suitors.md", expectedBaseHash: null, content: NOTE } },
  { name: "the real folder a protected link names", protect: ["taxonomy"],
    arrange: brain => symlinkSync("lore", join(brain, "taxonomy")),
    proposal: { operation: "edit", path: "lore/taxonomy.md", expectedBaseHash: contentHash(LORE), old_string: "gather", new_string: "scatter" } },
  { name: "the document a `.env*` link names", protect: [],
    arrange: brain => { writeFileSync(join(brain, "lore/harbor-secrets.md"), NOTE); symlinkSync("lore/harbor-secrets.md", join(brain, ".env")); },
    proposal: { operation: "write", path: "lore/harbor-secrets.md", expectedBaseHash: contentHash(NOTE), content: LORE } },
];

for (const { name, protect, proposal, arrange, absent, refusal } of AUTONOMOUS_CASES) test(`an autonomous turn's approved application refuses ${name}`, async () => {
  const { brain, applied, before, after } = await autonomousApply(protect, proposal, arrange);
  expect({ ok: applied.ok, code: applied.code, message: applied.message, changes: applied.changes }, `AUTONOMOUS_PROTECTED_TARGET_REFUSED ${name}`)
    .toEqual({ ok: false, ...(refusal ?? { code: "policy_denied", message: PROTECTED_TARGET_REFUSAL }), changes: [] });
  expect(after, "PROTECTED_BYTES_UNCHANGED").toEqual(before);
  if (absent) expect(existsSync(join(brain, absent)), "NOTHING_CREATED_UNDER_PROTECTION").toBe(false);
});

// The hosted application's rule now follows a protected link too.
test("a hosted application refuses the real document a protected link names, and still writes beside it", async () => {
  const { brain } = brainWith(["taxonomy"], brain => symlinkSync("lore", join(brain, "taxonomy")));
  const apply = createBrainApplication({ root: brain, principalId: "odysseus", turnId: "hosted", signal: new AbortController().signal,
    protectedPaths: protectedPaths({ protect: ["taxonomy"] }), policy: { available: ["write"], autoAllowed: ["write"], lock: createKeyedLock() },
    isAuthorized: () => true, approve: async () => true, record() {}, planner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
  const refused = await apply({ principalId: "odysseus", turnId: "hosted", input: { operation: "write", path: "lore/taxonomy.md", expectedBaseHash: contentHash(LORE), content: NOTE } });
  expect({ ok: refused.ok, code: refused.code }, "HOSTED_PROTECTED_LINK_TARGET_REFUSED").toEqual({ ok: false, code: "policy_denied" });
  expect(readFileSync(join(brain, "lore/taxonomy.md"), "utf8")).toBe(LORE);
  const written = await apply({ principalId: "odysseus", turnId: "hosted", input: { operation: "write", path: "notes/harbor.md", expectedBaseHash: null, content: NOTE } });
  expect(written.ok, written.message).toBe(true);
});

// A link that resolves nowhere protects its own name and nothing else.
test("a protected link that no writer could follow refuses nothing beside it", async () => {
  const { brain } = brainWith(["taxonomy", "legacy"], brain => {
    writeFileSync(join(brain, "notes/harbor.md"), NOTE);
    symlinkSync("notes/harbor.md/..", join(brain, "taxonomy"));
    symlinkSync("missing/../notes", join(brain, "legacy"));
  });
  const apply = createBrainApplication({ root: brain, principalId: "odysseus", turnId: "hosted", signal: new AbortController().signal,
    protectedPaths: protectedPaths({ protect: ["taxonomy", "legacy"] }), policy: { available: ["write"], autoAllowed: ["write"], lock: createKeyedLock() },
    isAuthorized: () => true, approve: async () => true, record() {}, planner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
  const written = await apply({ principalId: "odysseus", turnId: "hosted", input: { operation: "write", path: "notes/ithaca.md", expectedBaseHash: null, content: NOTE } });
  expect(written.ok, `UNRESOLVABLE_PROTECTED_LINK_PROTECTS_NOTHING_ELSE ${written.message}`).toBe(true);
});

// An image mask is a hosted writer too: it follows a protected link the same way.
test("an image mask refuses a target a protected link names, and still writes beside it", async () => {
  const { brain } = brainWith(["artwork"], brain => { mkdirSync(join(brain, "assets")); symlinkSync("assets", join(brain, "artwork")); });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  writeFileSync(join(brain, "assets/raft.png"), png);
  const view = createFixtureWorkerStartupView(brain);
  cleanup.push(() => view.cleanup());
  const apply = createMaskApplication({ maintenance: { startupView: view, tempDomain: { statePath: join(view.storage.root, "maintenance-state.db") } }, root: brain,
    principalId: "odysseus", turnId: "mask", signal: new AbortController().signal, protectedPaths: protectedPaths({ protect: ["artwork"] }),
    lock: createKeyedLock(), isAuthorized: () => true, isAvailable: () => true, record() {} });
  const refused = await apply({ principalId: "odysseus", turnId: "mask", base: readMaskBase(brain, "assets/raft.png"), input: { imagePath: "assets/raft.png", maskPath: "assets/raft-mask.png", png } });
  expect({ ok: refused.ok, code: refused.code }, "MASK_PROTECTED_LINK_TARGET_REFUSED").toEqual({ ok: false, code: "policy_denied" });
  expect(existsSync(join(brain, "assets/raft-mask.png"))).toBe(false);
  writeFileSync(join(brain, "notes/raft.png"), png);
  const written = await apply({ principalId: "odysseus", turnId: "mask", base: readMaskBase(brain, "notes/raft.png"), input: { imagePath: "notes/raft.png", maskPath: "notes/raft-mask.png", png } });
  expect(written.ok, written.message).toBe(true);
});

test("an image mask's scratch prune keeps the expired file a protected link names", async () => {
  const { brain } = brainWith(["kept"], brain => {
    mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
    writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
    symlinkSync(".brain/scratch/old.png", join(brain, "kept"));
  });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  writeFileSync(join(brain, ".brain/scratch/raft.png"), png);
  writeFileSync(join(brain, ".brain/scratch/old.png"), png);
  utimesSync(join(brain, ".brain/scratch/old.png"), new Date(0), new Date(0));
  const view = createFixtureWorkerStartupView(brain);
  cleanup.push(() => view.cleanup());
  const apply = createMaskApplication({ maintenance: { startupView: view, tempDomain: { statePath: join(view.storage.root, "maintenance-state.db") } }, root: brain,
    principalId: "odysseus", turnId: "prune", signal: new AbortController().signal, protectedPaths: protectedPaths({ protect: ["kept"] }),
    lock: createKeyedLock(), isAuthorized: () => true, isAvailable: () => true, record() {} });
  const result = await apply({ principalId: "odysseus", turnId: "prune", base: readMaskBase(brain, ".brain/scratch/raft.png"),
    input: { imagePath: ".brain/scratch/raft.png", maskPath: ".brain/scratch/raft-mask.png", png } });
  expect(result.ok, result.message).toBe(true);
  expect(existsSync(join(brain, ".brain/scratch/old.png")), "PRUNE_KEEPS_A_PROTECTED_LINK_TARGET").toBe(true);
});

// ---------------------------------------------------------------------------
// Conversation inbox staging.

/** A hosted conversation turn's `inbox_add`, under the turn's admitted protection set. */
function conversationInbox(protect: readonly string[], arrange?: (brain: string) => void, isCurrent: (brain: string) => boolean = () => true) {
  const { brain } = brainWith(protect, arrange);
  const db = createUiDb(":memory:");
  cleanup.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, brain);
  cleanup.push(() => intake.close());
  const tools = createInboxBridgeTools(db, intake, createInboxResolver(db, { allowedOperations: () => [] }), brain).forTurn({
    principalId: principal.id, turnId: "conversation", origin: "interactive", membership: "interactive", sessionId: () => "ithaca-session",
    isCurrent: () => isCurrent(brain), protectedPaths: protectedPaths({ protect: [...protect] }) });
  const add = async () => {
    try { return { result: await tools.inboxAdd!({ text: "Remind Odysseus to string the bow.", idempotencyKey: "bow" }) }; }
    catch (error) { return { error: error as Error & { code?: string } }; }
  };
  return { brain, db, principal, add, items: () => (db.query("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n };
}

/** The staged arrivals under a folder, published or partial: one directory per arrival. */
const arrivals = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => /^\.?[a-f0-9-]{36}(\.partial)?$/.test(name)) : [];

test("inbox_add outside the protection set still stages the arrival", async () => {
  const f = conversationInbox(["lore"]);
  const { result, error } = await f.add();
  expect(error, String(error)).toBeUndefined();
  expect(result?.created).toBe(true);
  expect(arrivals(join(f.brain, SHARE_STAGING_DIR)), "STAGED_OUTSIDE_PROTECTION").toHaveLength(1);
  expect(f.items()).toBe(1);
});

const INBOX_CASES: { name: string; protect: string[]; arrange?: (brain: string) => void; protectedDir: string }[] = [
  { name: "the protected staging directory", protect: [SHARE_STAGING_DIR], protectedDir: SHARE_STAGING_DIR },
  { name: "a protected ancestor of the staging directory", protect: [".brain-ui"], protectedDir: ".brain-ui" },
  { name: "a staging directory that links into a protected folder", protect: ["lore"], protectedDir: "lore",
    arrange: brain => { mkdirSync(join(brain, ".brain-ui")); symlinkSync("../lore", join(brain, SHARE_STAGING_DIR)); } },
  { name: "a staging ancestor that links into a protected folder", protect: ["lore"], protectedDir: "lore",
    arrange: brain => symlinkSync("lore", join(brain, ".brain-ui")) },
  { name: "a staging directory that links into a `.env*` name", protect: [], protectedDir: ".env.archive",
    arrange: brain => { mkdirSync(join(brain, ".env.archive")); mkdirSync(join(brain, ".brain-ui")); symlinkSync("../.env.archive", join(brain, SHARE_STAGING_DIR)); } },
  { name: "a protected link that names the staging directory", protect: ["feeds"], protectedDir: SHARE_STAGING_DIR,
    arrange: brain => { mkdirSync(join(brain, SHARE_STAGING_DIR), { recursive: true }); symlinkSync(SHARE_STAGING_DIR, join(brain, "feeds")); } },
];

for (const { name, protect, arrange, protectedDir } of INBOX_CASES) test(`inbox_add refuses ${name}`, async () => {
  const f = conversationInbox(protect, arrange);
  const before = snapshot(join(f.brain, protectedDir));
  const { result, error } = await f.add();
  expect(result, "NO_ARRIVAL_RETURNED").toBeUndefined();
  expect({ code: error?.code, message: error?.message }, `INBOX_PROTECTED_TARGET_REFUSED ${name}`).toEqual({ code: "policy_denied", message: PROTECTED_TARGET_REFUSAL });
  expect(snapshot(join(f.brain, protectedDir)), "PROTECTED_BYTES_UNCHANGED").toEqual(before);
  expect(arrivals(join(f.brain, SHARE_STAGING_DIR)), "NOTHING_STAGED").toEqual([]);
  expect(f.items(), "NO_INBOX_ITEM").toBe(0);
  expect((f.db.query("SELECT COUNT(*) AS n FROM inbox_intake_receipts").get() as { n: number }).n, "NO_RECEIPT_TO_COMPENSATE").toBe(0);
});

test("inbox_add's compensation of an earlier arrival refuses a protected staging directory", async () => {
  const earlier = crypto.randomUUID();
  const f = conversationInbox([`${SHARE_STAGING_DIR}/${earlier}`], brain => {
    mkdirSync(join(brain, SHARE_STAGING_DIR, earlier), { recursive: true });
    writeFileSync(join(brain, SHARE_STAGING_DIR, earlier, "meta.json"), "{\"id\":\"earlier\"}\n");
  });
  // A receipt an earlier writer left for compensation: the next intake reconciles it.
  f.db.query("INSERT INTO inbox_intake_receipts (staging_id, source, principal_id, dedup_key, content_hash, created_at, reconcile_after, state) VALUES (?, 'cli', ?, 'cli:earlier', 'hash', ?, ?, 'cleanup')")
    .run(earlier, f.principal.id, Date.now(), Date.now());
  const before = snapshot(join(f.brain, SHARE_STAGING_DIR, earlier));
  const { error } = await f.add();
  expect({ code: error?.code, message: error?.message }, "INBOX_COMPENSATION_REFUSED").toEqual({ code: "policy_denied", message: PROTECTED_TARGET_REFUSAL });
  expect(snapshot(join(f.brain, SHARE_STAGING_DIR, earlier)), "PROTECTED_ARRIVAL_KEPT").toEqual(before);
  expect(Object.keys(before)).toEqual(["meta.json"]);
});

test("inbox_add's compensation of its own arrival refuses once a link leads it into a protected folder", async () => {
  let moved: string | undefined;
  // Authority ends after the arrival is published, as the staging directory
  // becomes a link into the protected folder: compensation would follow it.
  const f = conversationInbox(["lore"], undefined, brain => {
    const staged = arrivals(join(brain, SHARE_STAGING_DIR));
    if (moved || !staged.length) return true;
    renameSync(join(brain, SHARE_STAGING_DIR), join(brain, "lore/inbox"));
    symlinkSync("../lore/inbox", join(brain, SHARE_STAGING_DIR));
    moved = staged[0];
    return false;
  });
  const { result, error } = await f.add();
  expect(result).toBeUndefined();
  expect(error?.message, "AUTHORITY_ENDED_AFTER_STAGING").toBe("Inbox principal or turn is no longer authorized");
  expect(moved, "ARRIVAL_STAGED_BEFORE_THE_LINK").toBeDefined();
  expect(Object.keys(snapshot(join(f.brain, "lore/inbox", moved!))), "OWN_COMPENSATION_REFUSED_INSIDE_PROTECTION").toEqual(["meta.json"]);
  expect(f.items()).toBe(0);
  // The refused removal keeps its receipt, so the arrival stays accounted for.
  expect(f.db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(moved!), "RECEIPT_KEPT_FOR_RECOVERY").toEqual({ state: "cleanup" });
});

// ---------------------------------------------------------------------------
// The hosted bridge hands the admitted protection set to inbox staging.

test.each([["protected", [".brain-ui"]], ["unprotected", ["lore"]]] as const)("a governed hosted turn's inbox_add uses the admitted protection set (%s staging)", async (variant, protect) => {
  const { root, brain } = brainWith(protect);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const native = createNativeJournalFixture(brain, root);
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  const intake = createInboxIntake(db, brain);
  let added: unknown, failure: (Error & { code?: string }) | undefined;
  const backend = { ...makeFakeBackend({ id: "pi", startTurn: async request => {
    try { added = await request.bridge.inboxAdd!({ text: "Remind Odysseus to string the bow.", idempotencyKey: "bow" }); }
    catch (error) { failure = error as Error & { code?: string }; }
    request.bridge.emit({ type: "session_info", sessionId: "session-bow", isNew: true });
    request.bridge.emit({ type: "result", sessionId: "session-bow", durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: createPiBackend({ brainPath: brain, loadExtensions: false }).brainApplicationPolicy };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); },
    inboxTools: createInboxBridgeTools(db, intake, createInboxResolver(db, { allowedOperations: () => [] }), brain),
    applicationPlanner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
  try {
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Odysseus notes a reminder.", attachments: [] });
    if (variant === "protected") {
      expect({ code: failure?.code, message: failure?.message }, "HOSTED_INBOX_PROTECTED_STAGING_REFUSED").toEqual({ code: "policy_denied", message: PROTECTED_TARGET_REFUSAL });
      expect(arrivals(join(brain, SHARE_STAGING_DIR))).toEqual([]);
    } else {
      expect(failure, String(failure)).toBeUndefined();
      expect(added).toMatchObject({ created: true });
      expect(arrivals(join(brain, SHARE_STAGING_DIR))).toHaveLength(1);
    }
  } finally { host.close(); await intake.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
