import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { createTurnJournal } from "../../src/brain/turn-journal.js";
import { createTurnScope } from "../../src/brain/turn-scope.js";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { launchAgentWorker, prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import type { ScopeCapReceipt, ClientScopeDecision } from "@schlessera/brain-ui-sdk/protocol";
export function scopeFixture(overrides: { max_tool_calls?: number; max_files_changed?: number; max_minutes?: number; max_bytes_written?: number } = {}, clock?: () => number, brainRoot?: string) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-scope-")), brain = brainRoot ?? join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(brain, "workspaces"), { recursive: true });
  const db = createUiDb(path); db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  const journal = createTurnJournal(db, { brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  let connected = true, current = true, stopped = "";
  const scope = createTurnScope(db, { brainPath: brain, journal, connected: () => connected, changed: () => {}, ...(clock ? { now: clock } : {}) });
  const policy = resolveGovernancePolicy({ schema_version: 1, scope: overrides });
  function begin(origin: "interactive" | "voice" = "interactive") {
    journal.begin("voyage", { sessionId: "ithaca", actor: origin, model: null, profile: "governed", policyHash: null }, error => { current = false; stopped = error.message; });
    scope.begin("voyage", { sessionId: "ithaca", principalId: "athena", origin, profile: "governed", policy, source: "policy", hardTimeoutMs: 60 * 60_000,
      current: () => current, stop: reason => { current = false; stopped = reason; } });
  }
  const receipt = (): ScopeCapReceipt => journal.summary("voyage").scope!.receipts.at(-1)!;
  const message = (action: ClientScopeDecision["action"], submissionId = "athena-decision"): ClientScopeDecision => ({ type: "scope_decision", turnId: "voyage", sessionId: "ithaca", eventId: receipt().eventId, submissionId, action });
  function worker(command: string) {
    const child = launchAgentWorker({ brainPath: brain, sandbox: prepareWorkerSandbox(brain, { profile: "governed", areas: [] }),
      command: ["/bin/sh", "-c", command], env: { PATH: "/usr/bin:/bin" } });
    child.stdout.resume(); child.stderr.resume(); child.stdin.end(); scope.workerStarted("voyage", child); return child;
  }
  return { root, brain, db, journal, scope, begin, receipt, message, worker, policy, get stopped() { return stopped; }, disconnect() { connected = false; }, reconnect() { connected = true; },
    close() { scope.close(); journal.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
