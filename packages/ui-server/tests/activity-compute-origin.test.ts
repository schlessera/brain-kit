/**
 * The additive `compute` Activity origin (#3108): a hosted job's run reaches
 * only connections whose client declared it parses compute-origin spans; an
 * older client, whose span schema knows three origins, never sees the run.
 */
import { expect, test } from "bun:test";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createUiDb } from "../src/db/client.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { WSContext } from "../src/ws/clients.js";

test("compute runs reach capable activity subscribers only, in snapshots and deltas", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db);
    const stream = createActivityStream(store);
    const socket = () => { const sent: string[] = []; return { sent, ws: { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext }; };
    store.startSpan({ spanId: "compute:cj_ithaca", runId: "compute:cj_ithaca", name: "compute_job", kind: "tool", origin: "compute", sessionId: "sess-ithaca", jobName: "boat-small", principalId: "odysseus" });
    store.startSpan({ spanId: "turn-ithaca", runId: "turn-ithaca", name: "invoke_agent", kind: "turn", origin: "session", sessionId: "sess-ithaca", principalId: "odysseus" });
    const capable = socket(), older = socket();
    stream.handleSubscribe(capable.ws, { type: "activity_subscribe", view: "index" }, "odysseus", true);
    stream.handleSubscribe(older.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    const runs = (sent: string[]) => sent.flatMap(text => { const parsed = JSON.parse(text); return [...(parsed.spans ?? []), ...(parsed.span ? [parsed.span] : [])].map((span: { runId: string }) => span.runId); });
    expect(runs(capable.sent).sort(), "CAPABLE_SNAPSHOT_HAS_COMPUTE").toEqual(["compute:cj_ithaca", "turn-ithaca"]);
    expect(runs(older.sent), "OLDER_SNAPSHOT_WITHOUT_COMPUTE").toEqual(["turn-ithaca"]);
    store.appendEvent("compute:cj_ithaca", "compute_state", { state: "running", cleanup: "pending" });
    store.endSpan("compute:cj_ithaca", { outcome: "success" });
    stream.pump();
    expect(older.sent.some(text => text.includes("compute:")), "OLDER_DELTAS_WITHOUT_COMPUTE").toBe(false);
    expect(capable.sent.filter(text => text.includes("compute:cj_ithaca") && text.includes("activity_delta")).length, "CAPABLE_DELTAS_HAVE_COMPUTE").toBeGreaterThan(0);
    // Every frame a capable client receives parses with the current schema.
    for (const text of capable.sent) expect(parseServerMessage(text).ok, "COMPUTE_FRAMES_PARSE").toBe(true);
    stream.close();
  } finally { db.close(); }
});
