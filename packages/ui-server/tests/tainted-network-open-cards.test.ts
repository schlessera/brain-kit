/**
 * A wider Network answer covers only connections that start after it
 * (maintainer ruling on #3595, 2026-11-27). Another destination's card that
 * was already open keeps its own question: when new evidence withdraws it,
 * that connection is asked again instead of being refused as covered.
 * Real turn proxy, real effective safety and the host's card withdrawal.
 */
import { expect, test } from "bun:test";
import { request } from "node:http";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createEffectiveSafety } from "../src/governance/effective-safety.js";
import { createGovernanceWrites } from "../src/governance/event-writes.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { occurrence } from "../src/governance/occurrence.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import type { OriginTrust } from "../src/brain/origin-trust.js";
import { connectedSafetySession } from "./helpers/connected-safety.js";
import { until } from "../../../tests/helpers/until";

function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject); });
    child.once("error", reject); child.end();
  });
}

for (const scope of ["once", "session"] as const) test(`after a ${scope} answer, another destination's withdrawn card asks again`, async () => {
  type Card = { req: PermissionRequest; resolve: (d: PermissionDecision) => void; settled: boolean };
  const cards: Card[] = [], withdrawn = new Set<string>();
  const db = createUiDb(":memory:"); connectedSafetySession(db, "voyage", "turn-voyage");
  const writes = createGovernanceWrites(db);
  const trust: OriginTrust = { revision: () => "1", read: () => ({ revision: "1", rules: [], policyHash: "a".repeat(64), ruleInstances: {} }), subscribe: () => () => {} };
  const safety = createEffectiveSafety(db, { turnId: "turn-voyage", sessionId: () => "voyage", policyHash: null, writes, trust, authority: () => ({ current: true, epoch: "0" }) });
  const bridge = { emit() {}, admissionSafety: safety,
    requestPermission: (req: PermissionRequest) => new Promise<PermissionDecision>(resolve => cards.push({ req, resolve, settled: false })) } as unknown as BackendBridge;
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), trust, controller: new AbortController(), turnId: "turn-voyage",
    sessionId: () => "voyage", model: () => null, profile: "governed", origin: "interactive", governanceDb: db, governanceWrites: writes, record: writes.record, bridge,
    networkRefusal: id => withdrawn.has(id) ? "superseded" : false });
  // The host's part: a card whose evidence moved is withdrawn as superseded.
  const stop = safety.subscribe(() => { for (const card of cards) {
    if (card.settled || !card.req.admissionSnapshot) continue;
    if (safety.read().evidenceRevision !== card.req.admissionSnapshot.evidenceRevision) { card.settled = true; withdrawn.add(card.req.toolUseId); card.resolve({ behavior: "deny", message: "stale" }); }
  } });
  const hits: string[] = [];
  const aeaea = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits.push("Aeaea"); return new Response("Aeaea"); } });
  const pylos = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits.push("Pylos"); return new Response("Pylos"); } });
  try {
    const epoch = (db.query("SELECT id FROM safety_collections WHERE turn_id='turn-voyage'").get() as { id: string }).id;
    await writes.firstTaint({ kind: "taint", turnId: "turn-voyage", sessionId: "voyage", actor: "interactive", profile: "governed", model: null,
      payload: { source: "web_search", tool: null, detail: null, occurrence: occurrence(epoch, "tool_web_input", crypto.randomUUID(), "finalized") } });
    const first = get(proxy.socketPath, aeaea.url.href).catch(() => 0);
    await until(() => cards.length === 1);
    const second = get(proxy.socketPath, pylos.url.href).catch(() => 0);
    await until(() => cards.length === 2);
    // Answering Aeaea records its input, which withdraws Pylos's open card.
    const answer = cards[0]!; answer.settled = true;
    answer.resolve({ behavior: "allow", networkScope: scope });
    expect(await first).toBe(200);
    const replaced = await Promise.race([until(() => cards.length > 2).then(() => true), second.then(() => false)]);
    expect(withdrawn.has(cards[1]!.req.toolUseId)).toBe(true);
    expect(replaced, "SESSION_ANSWER_LEAVES_OTHER_CARD_ASKING").toBe(true);
    // Each new piece of evidence may withdraw a replacement too; Pylos's
    // owner declines whichever of its cards is open.
    const decline = setInterval(() => { for (const card of cards.slice(2)) if (!card.settled) { card.settled = true; card.resolve({ behavior: "deny", message: "Penelope declines" }); } }, 10);
    try { expect(await second).toBe(403); } finally { clearInterval(decline); }
    expect(hits).toEqual(["Aeaea"]);
    await proxy.settled();
    const pylosRecord = queryGovernanceEvents(db, { kinds: ["egress_connection"], limit: 10 }).map(e => e.payload as Record<string, unknown>).find(p => p.port === pylos.port);
    expect(pylosRecord, "WITHDRAWN_CARD_ANSWERED_BY_ITS_REPLACEMENT").toMatchObject({ reason: "taint_not_approved" });
  } finally {
    stop(); for (const card of cards) if (!card.settled) card.resolve({ behavior: "deny", message: "cleanup" });
    proxy.stop(); aeaea.stop(true); pylos.stop(true); await proxy.settled(); db.close();
  }
});
