import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync, renameSync, readdirSync } from "node:fs";
import * as fs from "node:fs";
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

for (const creating of [false, true]) test(`the concrete journal records user/policy bytes without host staging (${creating ? "creation" : "replacement"}) and the next admission captures the new hash`, async () => {
  let journal!: ReturnType<typeof createTurnJournal>;
  const f = fixture({ observeUserPolicy: async (id, write) => {
    const publication = journal.observeUserPolicy(id, write);
    // A scope/tool observation already queued during publication must also
    // see canonical versions, never extend the host staging lifetime.
    await Promise.all([publication, journal.observe()]);
  } });
  const objects = mkdtempSync(join(tmpdir(), "policy-journal-state-")); cleanup.push(() => rmSync(objects, { recursive: true, force: true }));
  const native = createNativeJournalFixture(f.root, objects); cleanup.push(() => native.close());
  journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: f.root, dbPath: ":memory:", objectsRoot: objects }); cleanup.push(() => journal.close());
  f.db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
  f.turn.sessionId = () => "ithaca";
  if (creating) rmSync(f.path);
  const agentPath = "context/policies/.brain-policy-agent-owned.md";
  writeFileSync(join(f.root, agentPath), "Odysseus starts a real note.\n");
  const reader = createGovernancePolicyReader(f.root), initial = reader.load();
  await journal.begin("policy-turn", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: initial.hash }, error => { throw error; });
  writeFileSync(join(f.root, agentPath), "Athena edits a similarly named real note.\n");
  const pending = f.service.propose(f.turn, "policy-1", input); f.answer(true); const result = await pending; expect(result.state).toBe("updated");
  await journal.finish("policy-turn");
  const details = journal.details("ithaca", "policy-turn")!, change = details.changes.find(change => change.path === "context/policies/governance.md")!;
  expect(details.changes.filter(item => item.path.includes("/.brain-policy-") && item.path !== agentPath), "POLICY_PUBLICATION_HAS_NO_AGENT_STAGING_NOISE").toEqual([]);
  expect(details.changes.filter(item => item.path === "context/policies/governance.md")).toHaveLength(1);
  expect(change).toMatchObject({ actor: "user", class: "policy" });
  if (creating) expect(change.before).toBeNull();
  else expect(journal.version("ithaca", "policy-turn", change.sequence, "before")!.bytes(1024).toString()).toBe(original);
  const agent = details.changes.find(item => item.path === agentPath)!;
  expect(agent, "POLICY_SIMILARLY_NAMED_AGENT_CHANGE_RETAINED").toMatchObject({ actor: "agent", class: "content" });
  expect(journal.version("ithaca", "policy-turn", agent.sequence, "after")!.bytes(1024).toString()).toBe("Athena edits a similarly named real note.\n");
  expect(readdirSync(join(f.root,"context/policies")).sort()).toEqual([".brain-policy-agent-owned.md","governance.md"]);
  expect(f.events).toHaveLength(1); expect(f.count()).toBe(1);
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


test("journal overflow after approved publication retains truthful partial/unknown receipts without staging noise", async () => {
  let journal!: ReturnType<typeof createTurnJournal>;
  const f=fixture({observeUserPolicy:(id,write)=>journal.observeUserPolicy(id,write)});
  const objects=mkdtempSync(join(tmpdir(),"policy-overflow-"));cleanup.push(()=>rmSync(objects,{recursive:true,force:true}));
  const native=createNativeJournalFixture(f.root,objects);cleanup.push(()=>native.close());
  journal=createTurnJournal(f.db,{nativeManager:native.manager,brainPath:f.root,dbPath:":memory:",objectsRoot:objects,capBytes:512*1024});cleanup.push(()=>journal.close());
  let stopped=false;
  await journal.begin("policy-turn",{sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",policyHash:null},()=>{stopped=true;});
  const content=proposed+"Odysseus records the approved boundary.\n".repeat(17000);
  const pending=f.service.propose(f.turn,"policy-overflow",{content,rationale:"Retain the exact approved policy."});f.answer(true);
  const result=await pending;
  expect(result.state,"POLICY_OVERFLOW_NEVER_CLAIMS_COMPLETE_RECEIPT").toBe("unknown");
  expect(readFileSync(f.path,"utf8")).toBe(content);expect(stopped).toBe(true);
  expect(journal.summary("policy-turn").state).toBe("partial");
  expect(journal.details("ithaca","policy-turn")?.changes.some(change=>change.path.includes("/.brain-policy-"))).toBe(false);
  expect(readdirSync(join(f.root,"context/policies"))).toEqual(["governance.md"]);
  expect(f.events).toHaveLength(0);
  try{await journal.finish("policy-turn");}catch{/* The retained partial state is authoritative. */}
});


test("a failed staged write cleans up before observation and leaves the approved policy unchanged", async () => {
  let journal!: ReturnType<typeof createTurnJournal>;
  const f=fixture({observeUserPolicy:(id,write)=>journal.observeUserPolicy(id,write)});
  const objects=mkdtempSync(join(tmpdir(),"policy-write-refusal-"));cleanup.push(()=>rmSync(objects,{recursive:true,force:true}));
  const native=createNativeJournalFixture(f.root,objects);cleanup.push(()=>native.close());
  journal=createTurnJournal(f.db,{nativeManager:native.manager,brainPath:f.root,dbPath:":memory:",objectsRoot:objects});cleanup.push(()=>journal.close());
  await journal.begin("policy-turn",{sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",policyHash:null},error=>{throw error;});
  const originalWrite=fs.writeFileSync;let refused=0;
  const write=spyOn(fs,"writeFileSync").mockImplementation((...args)=>{
    if(typeof args[0]==="number"){refused++;throw Object.assign(Error("fixture staged write unavailable"),{code:"EIO"});}
    return originalWrite(...args);
  });
  try{
    const pending=f.service.propose(f.turn,"policy-write-refusal",input);f.answer(true);
    expect((await pending).state).toBe("refused");expect(refused).toBe(1);
  }finally{write.mockRestore();}
  await journal.finish("policy-turn");
  expect(readFileSync(f.path,"utf8"),"POLICY_FAILED_STAGING_PRESERVES_ORIGINAL_BYTES").toBe(original);
  expect(journal.details("ithaca","policy-turn")?.changes,"POLICY_FAILED_STAGING_HAS_NO_AGENT_HISTORY").toEqual([]);
  expect(readdirSync(join(f.root,"context/policies"))).toEqual(["governance.md"]);
  expect(f.events).toHaveLength(0);
});


test("an occupied staging name never grants cleanup ownership of a real similarly named file", async () => {
  let journal!: ReturnType<typeof createTurnJournal>;
  const collision="11111111-1111-4111-8111-111111111111";
  const f=fixture({observeUserPolicy:(id,write)=>journal.observeUserPolicy(id,()=>{
    const uuid=spyOn(crypto,"randomUUID").mockReturnValue(collision);
    try{write();}finally{uuid.mockRestore();}
  })});
  const objects=mkdtempSync(join(tmpdir(),"policy-stage-collision-"));cleanup.push(()=>rmSync(objects,{recursive:true,force:true}));
  const native=createNativeJournalFixture(f.root,objects);cleanup.push(()=>native.close());
  journal=createTurnJournal(f.db,{nativeManager:native.manager,brainPath:f.root,dbPath:":memory:",objectsRoot:objects});cleanup.push(()=>journal.close());
  await journal.begin("policy-turn",{sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",policyHash:null},error=>{throw error;});
  const name=`context/policies/.brain-policy-${collision}`,bytes="Athena owns this real file.\n";
  writeFileSync(join(f.root,name),bytes);
  const pending=f.service.propose(f.turn,"policy-stage-collision",input);f.answer(true);expect((await pending).state).toBe("refused");
  await journal.finish("policy-turn");
  expect(existsSync(join(f.root,name)),"POLICY_COLLISION_PRESERVES_UNOWNED_STAGING_NAME").toBe(true);
  expect(readFileSync(join(f.root,name),"utf8")).toBe(bytes);
  expect(readFileSync(f.path,"utf8")).toBe(original);
  const changes=journal.details("ithaca","policy-turn")!.changes;
  expect(changes).toHaveLength(1);expect(changes[0]).toMatchObject({path:name,actor:"agent",class:"content"});
  expect(journal.version("ithaca","policy-turn",changes[0]!.sequence,"after")!.bytes(1024).toString()).toBe(bytes);
});
