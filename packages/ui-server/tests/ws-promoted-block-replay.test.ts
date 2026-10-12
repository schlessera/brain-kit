import { expect, test } from "bun:test";
import type { ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { rewriteLinkDestinations } from "@schlessera/brain-ui-sdk/internal/client";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createTurnClassifier, loadMessageBlocks } from "../src/classification/index.js";
import { createUiDb } from "../src/db/client.js";
import { createSilentObservability } from "../src/observability/index.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { WsHost } from "../src/ws/host.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";

const TABLE = "| | Ithaca | Pylos |\n|---|---|---|\n| Days at sea | 0 | 4 |\n| Host | Penelope | Nestor |";
const SOURCE = "/tmp/brain-worker-scratch/voyage.pdf";
const SECOND_SOURCE = "/tmp/brain-worker-scratch/ports.pdf";
const ALIAS = "$BRAIN_WORKER_SCRATCH/voyage.pdf#page=2";
const TEXTS = [`[Voyage](${SOURCE}) and [ports](${SECOND_SOURCE})\n\n${TABLE}`, `[Second page](${ALIAS})\n\n${TABLE}`, `Ports:\n\n${TABLE}`];

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Promoted-block turn did not settle.");
}

for (const order of ["classification-first", "promotion-first", "no-promotion"] as const) {
  test(`WebSocket replay keeps classified blocks at the stored words: ${order} (#1704)`, async () => {
    const frames: ServerMessage[] = [];
    let releaseClassification!: () => void;
    const held = new Promise<void>(resolve => { releaseClassification = resolve; });
    let storedTexts = [...TEXTS];
    let turnId = "";
    const db = createUiDb(":memory:");
    const classifier = createTurnClassifier({
      db: () => db,
      log: createSilentObservability().logger("test"),
      jev: {
        enabled: true,
        breaker: () => ({ open: false, consecutiveFailures: 0, retryAt: null }),
        async classify() {
          if (order === "promotion-first") await held;
          return { outcome: "answered", durationMs: 1, answers: Object.fromEntries(TEXTS.flatMap((_, i) => [
            [`p${i}c0.shape`, { type: "choice", choice: "comparison", probabilities: { comparison: 0.9 }, confidence: 0.9 }],
            [`p${i}c0.recommended`, { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 }],
            [`p${i}c0.criteria_first`, { type: "noul", noul: 0.95 }],
          ])) };
        },
      },
    });
    const backend = makeFakeBackend({
      id: "voyage",
      async getHistory(): Promise<SessionHistoryMessage[]> {
        return [{ role: "assistant", content: storedTexts.join(""), toolCalls: [],
          parts: storedTexts.map(text => ({ kind: "text", text })) }];
      },
      async startTurn(req) {
        turnId = req.turnId!;
        req.bridge.emit({ type: "session_info", sessionId: "voyage-session", isNew: true });
        TEXTS.forEach((text, i) => {
          if (i) req.bridge.emit({ type: "thinking_delta", sessionId: "voyage-session", text: "Comparing ports." });
          req.bridge.emit({ type: "text_delta", sessionId: "voyage-session", text });
        });
        req.bridge.emit({ type: "result", sessionId: "voyage-session", durationMs: 1, numTurns: 1, isError: false, outcome: "success" });
        if (order === "classification-first") await until(() => frames.some(frame => frame.type === "message_blocks"));
        if (order !== "no-promotion") {
          const destination = `.brain/scratch/turns/${turnId}/voyage.pdf`;
          const secondDestination = `.brain/scratch/turns/${turnId}/ports.pdf`;
          const links = new Map([[SOURCE, destination], [ALIAS, `${destination}#page=2`], [SECOND_SOURCE, secondDestination]]);
          storedTexts = TEXTS.map(text => rewriteLinkDestinations(text, link => links.get(link) ?? link));
          const promotion = { kind: "promotion" as const, source: SOURCE, destination, bytes: 28,
            originalLink: SOURCE, rewrittenLink: destination,
            aliases: [{ originalLink: ALIAS, rewrittenLink: `${destination}#page=2` }] };
          req.bridge.activity?.(promotion);
          req.bridge.activity?.(promotion); // A duplicate must not shift the spans twice.
          req.bridge.activity?.({ kind: "promotion", source: SECOND_SOURCE, destination: secondDestination, bytes: 12,
            originalLink: SECOND_SOURCE, rewrittenLink: secondDestination });
        }
        releaseClassification();
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db), classifier });
    const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
    host.clients.add(ws, "test-principal");
    const connection = { principal: testPrincipal(), authorization: testAuthorization() };
    try {
      await handleClientMessage(host, ws, { type: "chat_message", text: "Compare the voyage ports.", attachments: [] }, connection);
      await until(() => frames.some(frame => frame.type === "message_blocks") && !host.coordinator.isTurnActive());
      const live = frames.find(frame => frame.type === "message_blocks");
      if (live?.type !== "message_blocks") throw new Error("No live blocks.");
      expect(live.blocks).toHaveLength(3);
      expect(live.turnId).toBe(turnId);
      await handleClientMessage(host, ws, { type: "session_resume", sessionId: "voyage-session" }, connection);
      const replay = frames.findLast(frame => frame.type === "session_history");
      if (replay?.type !== "session_history") throw new Error("No replay history.");
      expect(replay.messages).toHaveLength(1);
      const blocks = replay.messages[0]!.blocks;
      expect(blocks).toHaveLength(3);
      blocks!.forEach((block, i) => {
        expect(block.partIndex).toBe(i);
        expect(storedTexts[i]!.slice(block.start, block.end)).toBe(TABLE);
        expect(block.block).toEqual(live.blocks[i]!.block);
      });
      expect(loadMessageBlocks(db, "voyage-session", TEXTS[2]!)).toEqual([live.blocks[2]!]);
      expect(classifier.attach("different-session", replay.messages.map(message => ({ ...message, blocks: undefined }))))
        .toEqual(replay.messages.map(message => ({ ...message, blocks: undefined })));
      if (order === "no-promotion") expect(blocks).toEqual(live.blocks);
    } finally {
      releaseClassification();
      host.coordinator.reset(); host.close(); db.close();
    }
  });
}

test("delayed classification and promotion stay with their turn after queued slot reuse, and cancellation stores no blocks (#1704)", async () => {
  const frames: ServerMessage[] = [];
  const texts = ["First voyage", "Second voyage", "Cancelled voyage"].map(title => `${title}: [report](${SOURCE})\n\n${TABLE}`);
  const stored = [...texts];
  const ids: string[] = [];
  let firstBridge!: BackendBridge;
  let releaseFirstTurn!: () => void;
  let releaseFirstClassification!: () => void;
  const firstTurnHeld = new Promise<void>(resolve => { releaseFirstTurn = resolve; });
  const firstClassificationHeld = new Promise<void>(resolve => { releaseFirstClassification = resolve; });
  let passes = 0;
  const db = createUiDb(":memory:");
  const classifier = createTurnClassifier({ db: () => db, log: createSilentObservability().logger("test"), jev: {
    enabled: true, breaker: () => ({ open: false, consecutiveFailures: 0, retryAt: null }),
    async classify() {
      if (++passes === 1) await firstClassificationHeld;
      return { outcome: "answered", durationMs: 1, answers: {
        "p0c0.shape": { type: "choice", choice: "comparison", probabilities: { comparison: 0.9 }, confidence: 0.9 },
        "p0c0.recommended": { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
        "p0c0.criteria_first": { type: "noul", noul: 0.95 },
      } };
    },
  } });
  const promote = (bridge: BackendBridge, i: number) => {
    const destination = `.brain/scratch/turns/${ids[i]}/report.pdf`;
    stored[i] = rewriteLinkDestinations(texts[i]!, link => link === SOURCE ? destination : link);
    bridge.activity?.({ kind: "promotion", source: SOURCE, destination, bytes: 10, originalLink: SOURCE, rewrittenLink: destination });
  };
  const backend = makeFakeBackend({ id: "voyage", async getHistory() {
    return stored.slice(0, ids.length).map(content => ({ role: "assistant" as const, content, toolCalls: [] }));
  }, async startTurn(req) {
    const i = ids.length;
    ids.push(req.turnId!);
    req.bridge.emit({ type: "session_info", sessionId: "queued-voyages", isNew: i === 0 });
    req.bridge.emit({ type: "text_delta", sessionId: "queued-voyages", text: texts[i]! });
    req.bridge.emit({ type: "result", sessionId: "queued-voyages", durationMs: 1, numTurns: 1, isError: false,
      outcome: i === 2 ? "cancelled" : "success" });
    if (i === 0) { firstBridge = req.bridge; await firstTurnHeld; }
    else promote(req.bridge, i);
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db), classifier });
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
  host.clients.add(ws, "test-principal");
  const connection = { principal: testPrincipal(), authorization: testAuthorization() };
  try {
    await handleClientMessage(host, ws, { type: "chat_message", text: "First voyage", attachments: [] }, connection);
    await until(() => !!firstBridge && passes === 1);
    const originalSlot = [...host.coordinator.running][0]!;
    await handleClientMessage(host, ws, { type: "chat_message", sessionId: "queued-voyages", text: "Second voyage", attachments: [] }, connection);
    expect(frames.some(frame => frame.type === "status" && frame.status === "queued")).toBe(true);
    releaseFirstTurn();
    await until(() => ids.length === 2 && frames.some(frame => frame.type === "message_blocks" && frame.turnId === ids[1]));
    expect(originalSlot.turnId).toBe(ids[1]!);
    promote(firstBridge, 0);
    releaseFirstClassification();
    await until(() => frames.filter(frame => frame.type === "message_blocks").length === 2 && !host.coordinator.isTurnActive());
    await handleClientMessage(host, ws, { type: "chat_message", sessionId: "queued-voyages", text: "Cancelled voyage", attachments: [] }, connection);
    await until(() => ids.length === 3 && !host.coordinator.isTurnActive());
    expect(passes).toBe(2);
    await handleClientMessage(host, ws, { type: "session_resume", sessionId: "queued-voyages" }, connection);
    const history = frames.findLast(frame => frame.type === "session_history");
    if (history?.type !== "session_history") throw new Error("No queued replay.");
    expect(history.messages).toHaveLength(3);
    for (const i of [0, 1]) {
      expect(history.messages[i]!.content).toContain(ids[i]!);
      expect(history.messages[i]!.blocks).toHaveLength(1);
      const block = history.messages[i]!.blocks![0]!;
      expect(history.messages[i]!.content.slice(block.start, block.end)).toBe(TABLE);
    }
    expect(history.messages[2]!.blocks).toBeUndefined();
  } finally {
    releaseFirstTurn(); releaseFirstClassification();
    host.coordinator.reset(); host.close(); db.close();
  }
});
