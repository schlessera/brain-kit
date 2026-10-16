import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
/** Policy provenance reaches the real recorder and survives Activity detail pruning. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { compileWorkerCommandPolicy, denyWorkerCommand, requestPolicyPermission, workerCommandPolicyNote } from "@schlessera/brain-ui-sdk/internal";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";

const yaml = `---\nschema_version: 1\ncommands:\n  deny:\n    - { pattern: '[' }\n    - { pattern: '^git push (-f|--force)', reason: 'No force pushes.' }\n  confirm:\n    - { pattern: '(' }\n    - { pattern: '^git push', reason: 'Review pushing.' }\n---\nAthena reviews policy.\n`;
test("mixed invalid lists retain file indices, exact admitted hash and retained denial/confirmation receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-receipt-"));
  const brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(state);
  const path = join(brain, "context/policies/governance.md"); writeFileSync(path, yaml);
  const checked = parseGovernancePolicy(new TextEncoder().encode(yaml));
  expect(checked.commandRuleIndices).toEqual({ deny: [1], confirm: [1] });
  expect(JSON.parse(JSON.stringify(checked))).not.toHaveProperty("commandRuleIndices");
  const dbPath = join(state, "ui.db"), db = createUiDb(dbPath);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report: () => {} });
  const store = createActivityStore(db, { writer: "policy-test" });
  db.query("INSERT INTO sessions (id, title, created_at, last_active_at) VALUES ('sess-ithaca', 'Homeward', 1, 1)").run();
  const recorder = createTurnRecorder({ store, governance: input => { recordGovernanceEvent(db, input); } },
    { turnId: "turn-ithaca", sessionId: "sess-ithaca", posture: "voice" });
  const hold = await turns.begin("turn-ithaca", new AbortController().signal, "voice");
  try {
    recorder.setWorkerProfile(hold.sandbox.profile!);
    const captured = hold.sandbox.commandPolicy!;
    expect(Object.isFrozen(captured.deny[0])).toBe(true);
    writeFileSync(path, "---\nschema_version: 1\nunknown: true\n---\n");
    const policy = compileWorkerCommandPolicy(captured);
    const bridge = { emit: () => {}, activity: recorder.observeActivity,
      requestPermission: async () => ({ behavior: "deny" as const, message: "Declined." }) };
    expect(denyWorkerCommand(policy, { bridge, toolName: "Bash", shellToolName: "Bash", input: { command: "git push --force" }, toolUseId: "force-ithaca" })).toContain("commands.deny[1]");
    await requestPolicyPermission(policy, { bridge, shellToolName: "Bash", permission: {}, request: {
      toolUseId: "push-ithaca", toolName: "Bash", input: { command: "git push" }, kind: "command", description: "Review pushing.",
    } });
    const records = queryGovernanceEvents(db, { sessionId: "sess-ithaca", limit: 10 });
    expect(records).toHaveLength(2);
    expect(records.map(e => [e.kind, e.actor, e.profile, e.turnId])).toEqual([
      ["policy_block", "voice", hold.sandbox.profile ?? null, "turn-ithaca"], ["policy_confirm", "voice", hold.sandbox.profile ?? null, "turn-ithaca"],
    ]);
    expect(records[0]?.payload).toMatchObject({ input: JSON.stringify({ command: "git push --force" }), inputTruncated: false,
      rule: { list: "commands.deny", index: 1 }, policyHash: checked.content_hash });
    expect(records[1]?.payload).toMatchObject({ rule: { list: "commands.confirm", index: 1 }, policyHash: checked.content_hash, decision: "declined" });
    const note = workerCommandPolicyNote(captured, []);
    expect(note).toContain('commands.deny[1]: "^git push (-f|--force)"'); expect(note).toContain('commands.confirm[1]: "^git push"');
    recorder.finish("success");
    const pruned = store.prune({ digestFloorAt: Date.now() + 1, detailRetentionMs: 0, hardCeilingMs: 0, now: Date.now() + 1 });
    expect(pruned.runsPruned).toBe(1); expect(store.snapshotRun("turn-ithaca")).toBeNull();
    expect(queryGovernanceEvents(db, { sessionId: "sess-ithaca", limit: 10 })).toEqual(records);
  } finally { await hold.end(); await turns.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
