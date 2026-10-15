import { createNativeJournalFixture } from "../../../ui-server/tests/helpers/native-journal-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../../ui-server/tests/helpers/fixture-native-startup.js";
import { createTurnJournal } from "../../../ui-server/src/brain/turn-journal.js";
import { createHostExecution } from "../../../ui-server/src/brain/host-execution.js";
import { createGovernedTurns } from "../../../ui-server/src/brain/governed-turn.js";
import { createAgentPolicyRoutes } from "../../../ui-server/src/routes/agent-policy.js";
import { workerHostBoundary, launchLimits } from "../../../ui-sdk/src/server/worker-launcher.js";
import { cors } from "hono/cors";
import { createPrincipal, resolvePrincipal, isUsablePrincipal } from "../../../ui-server/src/db/principals.js";
/** Policy review's real WS/auth/SQLite writer fixture; loopback only and keyless. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createPolicyProposals } from "../../../ui-server/src/brain/policy-proposal.js";
import { createPolicyProposalRoutes } from "../../../ui-server/src/routes/policy-proposals.js";
import { recordGovernanceEvent } from "../../../ui-server/src/governance/events.js";
import { WsHost } from "../../../ui-server/src/ws/host.js";
import { createWsHandlers } from "../../../ui-server/src/ws/connection.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createSessionCatalog } from "../../../ui-server/src/ws/session-catalog.js";
import { makeFakeBackend } from "../../../ui-server/tests/helpers/fake-backend.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
const root = mkdtempSync(join(tmpdir(), "policy-browser-"));
mkdirSync(join(root, "context/policies"), { recursive: true });
const path = join(root, "context/policies/governance.md");
const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the voyage policy.\n";
const proposed = original.replace("interactive: governed", "interactive: strict").replace("reviews", "approves");
writeFileSync(path, original);
const state = mkdtempSync(join(tmpdir(), "policy-state-")), dbPath = join(state, "ui.db");
const db = createUiDb(dbPath), principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
// This fake-model browser fixture proves UI/WS authority and real policy/journal
// writes. Worker containment is separately proven by native runtime tests.
// Match dispatch-browser-server's lowest external-runtime double; the qualified
// Docker diagnostic opts into the actual probe without changing production.
const originalProbe = workerHostBoundary.probe;
if (process.env.POLICY_BROWSER_ACTUAL_RUNTIME !== "1") workerHostBoundary.probe = () => ({ ok: true });
const execution = createHostExecution({ brainPath: root, dbPath, profile: "governed" }); execution.attach(db);
const admitted: Array<{ hash: string | null }> = [];
const native = createNativeJournalFixture(root,state), restoreAcquisition = replaceNativeStartupAcquisitionForFixture();
const governedTurns = createGovernedTurns({ nativeManager: native.client, brainPath: root, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {},
  recordPolicy: (_turn, _origin, _profile, policy) => { admitted.push({ hash: policy.hash }); } });
governedTurns.facts();
const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: root, dbPath, objectsRoot: join(state, "objects") });
const decisions: unknown[] = [];
// These milliseconds use the server process clock, independently of browser scene time.
const receiptTimeline: Array<Record<string, unknown>> = [];
let receiptSequence = 0;
function recordReceipt(detail: Record<string, unknown>) {
  if (receiptTimeline.length === 128) receiptTimeline.shift();
  receiptTimeline.push({ ms: performance.now(), ...detail });
}
let mode = "", principalNow = principal, writes = 0, proposals = 0, reads = 0;
const lock = createKeyedLock();
const service = createPolicyProposals({ root, db, lock, observeUserPolicy: (turnId, write) => journal.observeUserPolicy(turnId, () => { write(); writes++; }),
  validate: bytes => mode === "invalid" && proposals > 0 ? parseGovernancePolicy(Buffer.from("---\nschema_version: 9\n---\n")) : parseGovernancePolicy(bytes),
  recordEvent: (review, turn) => recordGovernanceEvent(db, { kind: "policy_change", actor: "user", sessionId: turn.sessionId(), turnId: turn.turnId, model: null, profile: null,
    payload: { requestId: review.requestId, baseHash: review.baseHash, proposedHash: review.proposedHash, sections: review.sections, outcome: "updated" }, dedupeKey: `${turn.turnId}:${review.requestId}` }),
});
const backend = makeFakeBackend({ id: "policy-fixture", startTurn: async req => {
  req.bridge.emit({ type: "session_info", sessionId: "policy-session", isNew: true });
  if (proposals > 0) { req.bridge.emit({ type: "result", sessionId: "policy-session", outcome: "success", isError: false, durationMs: 1, numTurns: 1 }); return; }
  const id = "policy-1"; proposals++;
  req.bridge.emit({ type: "tool_use_start", toolUseId: id, toolName: "propose_policy_change" });
  const content = mode === "bad-proposal" ? "---\nschema_version: 9\n---\n" : proposed;
  decisions.push(await req.bridge.requestPermission({ toolUseId: id, toolName: "propose_policy_change", input: { content, rationale: "Use strict for the next turn." } }));
  req.bridge.emit({ type: "result", sessionId: "policy-session", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
} });
const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], "policy-fixture"), catalog: createSessionCatalog(() => db), governedTurns, journal, policyProposals: service,
  isPrincipalAuthorized: id => { const current = resolvePrincipal(db, id); return current !== null && isUsablePrincipal(current, Date.now()); },
  isPrincipalValid: principal => { const current = resolvePrincipal(db, principal.id); return current !== null && isUsablePrincipal(current, Date.now()); },
  toolPermissions: { isAutoAllowed: () => true, add: () => { throw new Error("Policy grants must never be remembered"); } } });
const handlers = createWsHandlers(host, principal);
const app = new Hono<AppEnv>();
app.use("*", cors());
app.use("*", async (c, next) => {
  c.set("principal", principalNow);
  const receipt = c.req.path.startsWith("/api/policy-proposals")
    ? { requestId: ++receiptSequence, method: c.req.method, path: c.req.path, principal: principalNow.id } : undefined;
  if (receipt) { reads++; recordReceipt({ stage: "request", ...receipt }); }
  await next();
  if (receipt) recordReceipt({ stage: "response", ...receipt, status: c.res.status });
});
app.route("/api", createPolicyProposalRoutes(host));
app.route("/api", createAgentPolicyRoutes(host, () => launchLimits({}).status));
app.post("/fixture", async c => {
  const patch = await c.req.json(); if (patch.mode !== undefined) mode = patch.mode;
  if (patch.stale) writeFileSync(path, original + "Later outside-turn edit.\n");
  if (patch.account) principalNow = testPrincipal("telemachus");
  if (patch.invalidFile) writeFileSync(path, "---\nschema_version: 9\n---\nInvalid outside-turn edit.\n");
  if (patch.missingFile) { const { unlinkSync } = await import("node:fs"); unlinkSync(path); }
  return c.json({ bytes: (await import("node:fs")).existsSync(path) ? readFileSync(path, "utf8") : null, original, proposed, writes, proposals, reads, decisions, receiptTimeline, journalChanges: db.query("SELECT path,actor,class FROM turn_journal_changes").all(), journalPolicies: db.query("SELECT policy_hash FROM turn_journal_turns ORDER BY started_at").all(), admitted, policy: governedTurns.facts().policy, events: db.query("SELECT actor, kind, payload FROM governance_events").all() });
});
const contexts = new WeakMap<object, { send(data: string): void; close(code?: number, reason?: string): void }>();
const context = (ws: any) => {
  let value = contexts.get(ws);
  if (!value) { value = { send: (data: string) => { const frame = JSON.parse(data); if (mode === "drop-result" && frame.type === "tool_result") return; ws.send(data); }, close: (code, reason) => ws.close(code, reason) }; contexts.set(ws, value); }
  return value;
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(req, server) { if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return; return app.fetch(req); },
  websocket: { open(ws) { void handlers.onOpen(undefined as never, context(ws) as never); }, message(ws, data) { handlers.onMessage({ data: String(data) } as MessageEvent, context(ws) as never); }, close(ws) { handlers.onClose({ code: 1000 } as CloseEvent, context(ws) as never); } },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
process.on("SIGTERM", async () => { restoreAcquisition(); workerHostBoundary.probe = originalProbe; host.close(); server.stop(true); await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); process.exit(0); });
