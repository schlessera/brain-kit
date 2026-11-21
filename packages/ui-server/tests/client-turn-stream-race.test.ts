import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";

for (const legacy of [false, true]) for (const view of ["index", "session", "run"] as const) {
  test(`${view} lifecycle snapshot cannot hide a racing receipt delta${legacy ? " on a prior store" : ""}`, () => {
    const folder = mkdtempSync(join(tmpdir(), "brain-client-receipt-"));
    const db = createUiDb(join(folder, "ui.db")), foreign = createUiDb(join(folder, "ui.db"));
    const store = createActivityStore(db), writer = createActivityStore(foreign);
    if (legacy) Object.defineProperty(store, "snapshotLifecycles", { value: undefined });
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus");
    lifecycle.finish("success");
    const stream = createActivityStream(store);
    const query = db.query.bind(db), own = Object.getOwnPropertyDescriptor(db, "query");
    let raced = false;
    const timing = { sendToFirstHostFrameMs: 7 };
    Object.defineProperty(db, "query", { configurable: true, value: ((sql: string, ...args: unknown[]) => {
      const statement = Reflect.apply(query, db, [sql, ...args]);
      if (!sql.includes("CAST(substr(CAST(receipt AS BLOB)")) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === "get") return (...bindings: unknown[]) => {
          const row = Reflect.apply(target.get, target, bindings);
          if (!raced) { raced = true; expect(writer.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true); }
          return row;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof db.query });
    try {
      const frames: ServerMessage[] = [];
      const ws = { send: (text: string) => frames.push(JSON.parse(text)) };
      stream.handleSubscribe(ws, { type: "activity_subscribe", view,
        ...(view === "session" ? { sessionId: "ithaca" } : view === "run" ? { runId: "turn-ithaca" } : {}) }, "odysseus");
      stream.pump();
      expect(raced).toBe(true);
      const snapshot = frames.find(frame => frame.type === "activity_snapshot")!;
      const delta = frames.find(frame => frame.type === "activity_delta" && frame.lifecycle?.turnId === "turn-ithaca")!;
      expect(snapshot.type).toBe("activity_snapshot");
      expect(delta.type).toBe("activity_delta");
      if (snapshot.type !== "activity_snapshot" || delta.type !== "activity_delta") throw new Error("Missing Activity frames");
      const atSnapshot = snapshot.lifecycles?.find(record => record.turnId === "turn-ithaca")?.clientTiming;
      // This is the shipped client's sequence rule: a delta at or below the
      // snapshot watermark is discarded. The receipt must be visible in one.
      const visible = atSnapshot ?? (delta.seq > (snapshot.highWaterSeq[delta.runId] ?? 0) ? delta.lifecycle?.clientTiming : undefined);
      expect(visible).toEqual(timing);
      if (!atSnapshot) expect(delta.seq).toBeGreaterThan(snapshot.highWaterSeq[delta.runId]!);
    } finally {
      if (own) Object.defineProperty(db, "query", own); else Reflect.deleteProperty(db, "query");
      stream.close(); foreign.close(); db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}

test("index span data cannot acquire a sequence that already includes a later patch", () => {
  const folder = mkdtempSync(join(tmpdir(), "brain-client-receipt-"));
  const db = createUiDb(join(folder, "ui.db")), foreign = createUiDb(join(folder, "ui.db"));
  const store = createActivityStore(db), writer = createActivityStore(foreign);
  store.startSpan({ spanId: "ithaca-root", runId: "turn-ithaca", kind: "turn", origin: "session", name: "invoke_agent", startedAt: 1000 });
  const stream = createActivityStream(store);
  const read = store.openRootSpans.bind(store);
  let raced = false;
  store.openRootSpans = () => {
    const roots = read();
    if (!raced) { raced = true; expect(writer.patchSpan("ithaca-root", { attrs: { voyage: "sailing" } })).toBe(true); }
    return roots;
  };
  try {
    const frames: ServerMessage[] = [];
    const ws = { send: (text: string) => frames.push(JSON.parse(text)) };
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    const snapshot = frames.find(frame => frame.type === "activity_snapshot")!;
    const delta = frames.find(frame => frame.type === "activity_delta")!;
    if (snapshot.type !== "activity_snapshot" || delta.type !== "activity_delta") throw new Error("Missing Activity frames");
    const visible = snapshot.spans[0]?.attrs?.voyage ?? (delta.seq > (snapshot.highWaterSeq[delta.runId] ?? 0) ? delta.span?.attrs?.voyage : undefined);
    expect(visible).toBe("sailing");
  } finally { stream.close(); foreign.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
});

for (const list of [false, true]) {
  test(`${list ? "list" : "single"} lifecycle joins do not combine an unfinished host record with a later receipt`, () => {
    const folder = mkdtempSync(join(tmpdir(), "brain-client-receipt-"));
    const db = createUiDb(join(folder, "ui.db")), foreign = createUiDb(join(folder, "ui.db"));
    const store = createActivityStore(db), writer = createActivityStore(foreign);
    createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1000, "odysseus");
    const query = db.query.bind(db), own = Object.getOwnPropertyDescriptor(db, "query");
    let raced = false;
    Object.defineProperty(db, "query", { configurable: true, value: ((sql: string, ...args: unknown[]) => {
      const statement = Reflect.apply(query, db, [sql, ...args]);
      if (!sql.startsWith("SELECT record FROM activity_turn_lifecycles")) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === "get" || property === "all") return (...bindings: unknown[]) => {
          const rows = Reflect.apply(target[property], target, bindings);
          if (!raced) {
            raced = true;
            writer.writeLifecycle({ ...writer.lifecycle("turn-ithaca")!, endedAt: 1100, outcome: "success" }, "odysseus");
            expect(writer.writeClientReceipt!("turn-ithaca", "odysseus", { sendToFirstHostFrameMs: 7 })).toBe(true);
          }
          return rows;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof db.query });
    try {
      const record = list ? store.lifecycles()[0]! : store.lifecycle("turn-ithaca")!;
      expect(raced).toBe(true);
      expect(record.endedAt).toBeNull();
      expect(record.clientTiming).toBeUndefined();
      expect(writer.lifecycle("turn-ithaca")?.clientTiming).toEqual({ sendToFirstHostFrameMs: 7 });
    } finally {
      if (own) Object.defineProperty(db, "query", own); else Reflect.deleteProperty(db, "query");
      foreign.close(); db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}
