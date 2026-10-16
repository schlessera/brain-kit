import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { parseGovernancePolicy } from "@schlessera/brain/internal";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createUiDb } from "../src/db/client.js";
import { createPolicyProposals, type PolicyProposalTurn } from "../src/brain/policy-proposal.js";
import { createGovernancePolicyReader } from "../src/brain/governance-policy.js";
const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n";
const proposed = original.replace("interactive: governed", "interactive: strict").replace("reviews", "approves");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(patch: Partial<Parameters<typeof createPolicyProposals>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "policy-proposal-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context/policies"), { recursive: true }); const path = join(root, "context/policies/governance.md"); writeFileSync(path, original);
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  const lock = createKeyedLock(), events: PolicyChangeReview[] = [], edits: string[] = [], emitted: PolicyChangeReview[] = [];
  let answer!: (allow: boolean) => void, approveCalls = 0, authorized = true, available = true;
  const service = createPolicyProposals({ root, db, lock, observeUserPolicy: (_id, write) => { edits.push(readFileSync(path, "utf8")); write(); edits.push(readFileSync(path, "utf8")); }, recordEvent: review => events.push(structuredClone(review)), ...patch });
  const turn: PolicyProposalTurn = { principalId: "odysseus", turnId: "policy-turn", sessionId: () => null, signal: new AbortController().signal,
    isAuthorized: () => authorized, isAvailable: () => available, approve: () => { approveCalls++; return new Promise(resolve => { answer = resolve; }); }, emit: review => emitted.push(structuredClone(review)) };
  return { root, path, db, lock, service, turn, events, edits, emitted, answer: (allow: boolean) => answer(allow), count: () => approveCalls,
    revoke: () => { authorized = false; }, voice: () => { available = false; } };
}
const input = { content: proposed, rationale: "Use strict for the next turn." };
test("approval publishes exact bytes under the shared brain lock and the next admission sees the new hash", async () => {
  const f = fixture(), reader = createGovernancePolicyReader(f.root), admitted = reader.load();
  const pending = f.service.propose(f.turn, "policy-1", input); expect(f.count()).toBe(1);
  const release = await f.lock.acquire(BRAIN_LOCK_KEY); f.answer(true);
  await Promise.resolve(); expect(readFileSync(f.path, "utf8")).toBe(original); release();
  const result = await pending;
  expect(result.state).toBe("updated"); expect(readFileSync(f.path, "utf8")).toBe(proposed);
  expect(f.edits).toEqual([original, proposed]); expect(f.events).toHaveLength(1);
  expect(reader.load().hash).toBe(result.proposedHash); expect(reader.load().policy.profiles.interactive).toBe("strict");
  expect(admitted.policy.profiles.interactive).toBe("governed");
  expect(result.sections).toEqual(["profiles.interactive"]); expect(result.bodyChanged).toBe(true);
});
test("decline preserves bytes and retains the same request receipt", async () => {
  const f = fixture(), pending = f.service.propose(f.turn, "policy-1", input); f.answer(false);
  expect((await pending).state).toBe("declined"); expect(readFileSync(f.path, "utf8")).toBe(original); expect(f.edits).toHaveLength(0);
  expect(f.service.read("odysseus", "policy-turn", "policy-1")?.state).toBe("declined");
});
test("stale write refuses changed bytes at final publication and consumes the approval", async () => {
  const changed = original + "Later outside-turn edit.\n";
  const f = fixture({ beforeCommit: () => writeFileSync(f.path, changed) });
  const pending = f.service.propose(f.turn, "policy-1", input); f.answer(true);
  const result = await pending; expect(result.state).toBe("stale"); expect(result.message).toContain("Nothing was written");
  expect(readFileSync(f.path, "utf8")).toBe(changed); expect(f.edits).toHaveLength(0); expect(f.events).toHaveLength(0);
  expect((await f.service.propose(f.turn, "policy-1", input)).state).toBe("stale"); expect(f.count()).toBe(1);
});
test("an edit while waiting for lock is stale; approving never overwrites it", async () => {
  const f = fixture(), pending = f.service.propose(f.turn, "policy-1", input), release = await f.lock.acquire(BRAIN_LOCK_KEY);
  f.answer(true); writeFileSync(f.path, original + "New revision.\n"); release();
  expect((await pending).state).toBe("stale"); expect(readFileSync(f.path, "utf8")).toBe(original + "New revision.\n");
});
test("invalid proposals raise no card; revalidation consumes approval and leaves bytes intact", async () => {
  let valid = true;
  const f = fixture({ validate: bytes => valid ? parseGovernancePolicy(bytes) : parseGovernancePolicy(Buffer.from("---\nschema_version: 9\n---\n")) });
  await expect(f.service.propose(f.turn, "bad", { ...input, content: "---\nschema_version: 9\n---\n" })).rejects.toThrow("Invalid policy"); expect(f.count()).toBe(0);
  const pending = f.service.propose(f.turn, "policy-1", input); valid = false; f.answer(true);
  expect((await pending).state).toBe("invalid"); expect(readFileSync(f.path, "utf8")).toBe(original); expect(f.edits).toHaveLength(0);
});
test("duplicates and uncertain reconciliation never resubmit writes; account and input cannot borrow a receipt", async () => {
  const f = fixture(), first = f.service.propose(f.turn, "policy-1", input), duplicate = f.service.propose(f.turn, "policy-1", input);
  expect(f.count()).toBe(1); f.answer(true); expect((await first).state).toBe("updated"); expect(await duplicate).toEqual(await first);
  expect((await f.service.propose(f.turn, "policy-1", input)).state).toBe("updated"); expect(f.edits).toHaveLength(2);
  expect(f.service.read("telemachus", "policy-turn", "policy-1")).toBeNull();
  expect(f.service.read("odysseus", "other-turn", "policy-1")).toBeNull();
  await expect(f.service.propose(f.turn, "policy-1", { ...input, rationale: "Different request" })).rejects.toThrow("another request");
});
test("live authority, voice membership and journal recording window refuse the callback", async () => {
  const f = fixture(), pending = f.service.propose(f.turn, "policy-1", input); f.revoke(); f.answer(true);
  expect((await pending).state).toBe("refused"); expect(readFileSync(f.path, "utf8")).toBe(original);
  const voice = fixture(); voice.voice(); await expect(voice.service.propose(voice.turn, "voice", input)).rejects.toThrow("interactive authority"); expect(voice.count()).toBe(0);
  const ended = fixture({ observeUserPolicy: () => { throw new Error("Recording window ended"); } });
  const later = ended.service.propose(ended.turn, "later", input); ended.answer(true); expect((await later).state).toBe("refused"); expect(readFileSync(ended.path, "utf8")).toBe(original);
});
for (const alias of ["symlink", "hardlink", "ancestor"] as const) test(`policy publication refuses ${alias} aliases`, async () => {
  const f = fixture();
  const pending = f.service.propose(f.turn, "policy-1", input);
  if (alias === "ancestor") { renameSync(join(f.root, "context"), join(f.root, "old-context")); symlinkSync(join(f.root, "old-context"), join(f.root, "context")); }
  else { renameSync(f.path, join(f.root, "original.md")); (alias === "symlink" ? symlinkSync : linkSync)(join(f.root, "original.md"), f.path); }
  f.answer(true); expect((await pending).state).toBe("refused"); expect(readFileSync(f.path, "utf8")).toBe(original); expect(f.edits).toHaveLength(0);
});

test("the concrete journal records user/policy bytes and the next journal admission captures the new policy hash", async () => {
  let journal!: ReturnType<typeof createTurnJournal>;
  const f = fixture({ observeUserPolicy: (id, write) => journal.observeUserPolicy(id, write) });
  const objects = mkdtempSync(join(tmpdir(), "policy-journal-state-")); cleanup.push(() => rmSync(objects, { recursive: true, force: true }));
  const native = createNativeJournalFixture(f.root, objects); cleanup.push(() => native.close());
  journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: f.root, dbPath: ":memory:", objectsRoot: objects }); cleanup.push(() => journal.close());
  f.db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
  f.turn.sessionId = () => "ithaca";
  const reader = createGovernancePolicyReader(f.root), initial = reader.load();
  await journal.begin("policy-turn", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: initial.hash }, error => { throw error; });
  const pending = f.service.propose(f.turn, "policy-1", input); f.answer(true); const result = await pending; expect(result.state).toBe("updated");
  await journal.finish("policy-turn");
  const details = journal.details("ithaca", "policy-turn")!, change = details.changes.find(change => change.path === "context/policies/governance.md")!;
  expect(change).toMatchObject({ actor: "user", class: "policy" });
  expect(journal.version("ithaca", "policy-turn", change.sequence, "before")!.bytes(1024).toString()).toBe(original);
  expect(journal.version("ithaca", "policy-turn", change.sequence, "after")!.bytes(1024).toString()).toBe(proposed);
  const next = reader.load();
  expect(next.hash).toBe(result.proposedHash); expect(next.policy.profiles.interactive).toBe("strict");
    await journal.begin("next-policy-turn", { sessionId: "ithaca", actor: "interactive", model: null, profile: "strict", policyHash: next.hash }, error => { throw error; });
    expect(journal.summary("next-policy-turn").policyHash).toBe(result.proposedHash); await journal.finish("next-policy-turn");
});

test("a host restart/lost recorder cannot reactivate pending or uncertain policy execution", async () => {
  const f = fixture(); const waiting = f.service.propose(f.turn, "policy-1", input);
  const restarted = createPolicyProposals({ root: f.root, db: f.db, lock: f.lock, observeUserPolicy: () => { throw new Error("No live journal window"); }, recordEvent() {} });
  expect(restarted.read("odysseus", "policy-turn", "policy-1")?.state).toBe("unknown");
  expect((await restarted.propose(f.turn, "policy-1", input)).state).toBe("unknown"); expect(readFileSync(f.path, "utf8")).toBe(original); expect(f.count()).toBe(1);
  f.answer(false); await waiting;
  const uncertain = fixture({ recordEvent() { throw new Error("Receipt recording unavailable"); } });
  const applied = uncertain.service.propose(uncertain.turn, "policy-1", input); uncertain.answer(true);
  expect((await applied).state).toBe("unknown"); expect(readFileSync(uncertain.path, "utf8")).toBe(proposed);
  expect((await uncertain.service.propose(uncertain.turn, "policy-1", input)).state).toBe("unknown"); expect(uncertain.edits).toHaveLength(2);
});

test("missing brain permits service startup but never creates a root or requests approval", async () => {
  const parent = mkdtempSync(join(tmpdir(), "policy-missing-root-")); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "brain"), path = join(root, "context/policies/governance.md");
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  let approvals = 0, observations = 0, events = 0;
  let service!: ReturnType<typeof createPolicyProposals>;
  expect(() => { service = createPolicyProposals({ root, db, lock: createKeyedLock(),
    observeUserPolicy: (_id, write) => { observations++; write(); }, recordEvent: () => { events++; } }); }, "POLICY_MISSING_ROOT_STARTUP").not.toThrow();
  const turn: PolicyProposalTurn = { principalId: "odysseus", turnId: "missing-root-turn", sessionId: () => null,
    signal: new AbortController().signal, isAuthorized: () => true, isAvailable: () => true,
    approve: async () => { approvals++; return true; }, emit() {} };
  await expect(service.propose(turn, "missing-root", input)).rejects.toThrow();
  expect(existsSync(root)).toBe(false); expect(approvals).toBe(0); expect(observations).toBe(0); expect(events).toBe(0);
  mkdirSync(root);
  expect((await service.propose(turn, "root-now-present", input)).state).toBe("updated");
  expect(readFileSync(path, "utf8")).toBe(proposed); expect(approvals).toBe(1); expect(observations).toBe(1); expect(events).toBe(1);
});


test("unsupported proposals and current-policy section comparison never dispatch engines", async () => {
  const sentinel = frontmatterEngineSentinel();
  try {
    for (const language of ["js", "javascript", "JS", "JavaScript", "json", "odyssey", "unknown"]) {
      const f = fixture(), content = `---${language}\nschema_version: 1\n---\nOdysseus\n`;
      let error: unknown;
      const refused = f.service.propose(f.turn, "unsupported", { ...input, content }).catch(caught => { error = caught; });
      expect(sentinel.dispatched, "PROPOSAL_NO_ENGINE_DISPATCH").toEqual([]);
      await refused;
      expect(String(error)).toContain("use YAML data only");
      expect(f.count()).toBe(0); expect(f.edits).toEqual([]); expect(f.events).toEqual([]);
      expect(f.db.query("SELECT count(*) AS n FROM policy_proposals").get()).toEqual({ n: 0 });
      expect(readFileSync(f.path, "utf8")).toBe(original);
      // Invalid existing policy still gets an exact byte diff, without interpreting its engine.
      writeFileSync(f.path, content);
      const pending = f.service.propose(f.turn, "repair", input);
      expect(sentinel.dispatched, "POLICY_SECTIONS_NO_ENGINE_DISPATCH").toEqual([]);
      expect(f.count()).toBe(1); f.answer(true);
      const result = await pending;
      expect(result.state).toBe("updated"); expect(result.frontmatterDiff + result.bodyDiff).toContain(language);
      expect(readFileSync(f.path, "utf8")).toBe(proposed);
      expect(sentinel.dispatched).toEqual([]);
    }
  } finally { sentinel.restore(); }
});

test("post-approval validation refuses unsupported selection before dispatch or publication", async () => {
  const sentinel = frontmatterEngineSentinel();
  try {
    let revalidating = false;
    const f = fixture({ validate: bytes => parseGovernancePolicy(revalidating
      ? Buffer.from("---javascript\nschema_version: 1\n---\nOdysseus\n") : bytes) });
    const pending = f.service.propose(f.turn, "revalidation", input);
    expect(f.count()).toBe(1); revalidating = true; f.answer(true);
    const result = await pending;
    expect(sentinel.dispatched, "REVALIDATION_NO_ENGINE_DISPATCH").toEqual([]);
    expect(result.state).toBe("invalid"); expect(result.message).toContain("use YAML data only");
    expect(readFileSync(f.path, "utf8")).toBe(original); expect(f.edits).toEqual([]); expect(f.events).toEqual([]);
  } finally { sentinel.restore(); }
});
