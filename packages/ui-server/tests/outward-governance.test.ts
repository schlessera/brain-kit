import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { observeOutwardPlan, prepareOutwardPlan } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../src/db/client";
import { createActivityStore } from "../src/activity/store";
import { createTurnRecorder } from "../src/activity/recorder";
import { createTurnJournal } from "../src/brain/turn-journal";
import { createGovernancePolicyReader } from "../src/brain/governance-policy";
import { recordGovernanceEvent, queryGovernanceEvents } from "../src/governance/events";
import { createJournalRoutes } from "../src/routes/journal";

test("mixed invalid outward rules retain file positions and all-invalid edits retain the last valid policy", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-outward-policy-"));
  const yaml = "---\nschema_version: 1\noutward:\n  allow:\n    - { command: '[', remotes: ['github.com/*'] }\n    - { command: '^git push ', remotes: ['github.com/odysseus/*'] }\n---\n";
  try {
    mkdirSync(join(root, "context/policies"), { recursive: true });
    const path = join(root, "context/policies/governance.md");
    writeFileSync(path, yaml);
    const check = parseGovernancePolicy(Buffer.from(yaml));
    expect(check.ok).toBe(true); expect(check.outwardRuleIndices).toEqual([1]);
    expect(check.warnings[0]).toContain("outward.allow[0]");
    expect(JSON.parse(JSON.stringify(check))).not.toHaveProperty("outwardRuleIndices");
    const reader = createGovernancePolicyReader(root), valid = reader.load();
    expect(valid.outwardRuleIndices).toEqual([1]);
    writeFileSync(path, yaml.replace("'^git push '", "'('"));
    const invalid = reader.load();
    expect(invalid.source).toBe("last_valid"); expect(invalid.hash).toBe(valid.hash);
    expect(invalid.policy.outward.allow).toEqual(valid.policy.outward.allow);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retained outward attribution survives Activity pruning and appears in the existing journal as non-revertible admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-outward-receipt-")), brain = join(root, "brain"), dbPath = join(root, "ui.db");
  mkdirSync(brain); writeFileSync(join(brain, "voyage.md"), "Homeward\n");
  const db = createUiDb(dbPath), store = createActivityStore(db, { writer: "outward-test" });
  const native = createNativeJournalFixture(brain,root);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(root, "objects") });
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Homeward',1,1)").run();
  await journal.begin("voyage", { sessionId: "ithaca", actor: "voice", profile: "governed", model: null, policyHash: null }, error => { throw error; });
  const recorder = createTurnRecorder({ store, governance: input => { recordGovernanceEvent(db, input); } }, { turnId: "voyage", sessionId: "ithaca", posture: "voice" });
  recorder.setWorkerProfile("governed");
  try {
    const input = { command: "git push https://github.com/odysseus/voyage.git main" };
    const allow = [{ command: "^git push ", remotes: ["github.com/odysseus/*"], index: 1 }];
    const plan = prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input, allow, voice: true });
    observeOutwardPlan(plan, { bridge: { activity: recorder.observeActivity }, toolName: "Bash", toolUseId: "push-voyage", input, decision: "refused" });
    const records = queryGovernanceEvents(db, { sessionId: "ithaca", turnId: "voyage", limit: 10 });
    expect(records, "OUTWARD_RETAINED_RECEIPT").toHaveLength(1);
    expect(records[0]).toMatchObject({ actor: "voice", model: null, profile: "governed", turnId: "voyage", kind: "outward_action", payload: { decision: "refused", target: "github.com/odysseus/voyage.git", rule: { list: "outward.allow", index: 1 } } });
    recorder.finish("success"); await journal.finish("voyage");
    store.prune({ digestFloorAt: Date.now() + 1, detailRetentionMs: 0, hardCeilingMs: 0, now: Date.now() + 1 });
    expect(store.snapshotRun("voyage")).toBeNull();
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", turnId: "voyage", limit: 10 })).toEqual(records);
    const routes = createJournalRoutes({ journal });
    const response = await routes.request("/sessions/ithaca/turns/voyage/journal");
    expect(response.status).toBe(200);
    expect(await response.json(), "OUTWARD_JOURNAL_IRREVERSIBLE_RECEIPT").toMatchObject({ outwardActions: [{ decision: "refused", revertible: false, target: "github.com/odysseus/voyage.git" }], outwardActionsTruncated: false });
    expect(journal.details("other-session", "voyage")).toBeNull();
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
