import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
// Scripted in-process inference launches no worker. Containment has separate
// native proof; keep actual host admission, adapters and storage here.
workerHostBoundary.probe = () => ({ ok: true });
/** Durable transcript fixture: real adapters, host, SQLite file/write worker; inference is scripted. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { openSqliteWriter } from "../../../ui-server/src/db/write-worker.js";
import { createOffloopActivityStore } from "../../../ui-server/src/activity/store-writes.js";
import { createSessionCatalog } from "../../../ui-server/src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { WsHost } from "../../../ui-server/src/ws/host.js";
import { createWsHandlers } from "../../../ui-server/src/ws/connection.js";
import { createGeminiConversationProvider } from "../../../ui-server/src/voice/gemini-conversation.js";
import { createGptLiveConversationProvider } from "../../../ui-server/src/voice/gpt-live-conversation.js";
import { makeFakeBackend } from "../../../ui-server/tests/helpers/fake-backend.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import type {
  SessionHistoryMessage,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "../../../ui-server/src/ws/clients.js";
const root = mkdtempSync(join(tmpdir(), "odysseus-dialogue-browser-"));
const dbPath = join(root, "ui.db");
let db = createUiDb(dbPath),
  writer = openSqliteWriter(db);
let engine = process.argv[2] === "gemini" ? "gemini" : "gpt";
let frames: ServerMessage[] = [];
const sent: unknown[] = [],
  ingress: unknown[] = [];
let tasks = 0;
let quotaApplied = false, pressureApplied = false;
let complete: (() => void) | undefined;
let emitPrefix: ((text:string)=>void) | undefined;
const history: SessionHistoryMessage[] = [];
let backendTailQuota = false, multipart = false;
let FACT = "The departure signal is a bronze owl.";
const backend = makeFakeBackend({
  id: "fake",
  startTurn: async (req) => {
    tasks++;
    req.bridge.emit({
      type: "session_info",
      sessionId: "odysseus-ithaca",
      isNew: !req.sessionId,
    });
    history.push({ role: "user", content: req.prompt, toolCalls: [] });
    let prefix=""; emitPrefix=text=>{prefix+=text;req.bridge.emit({type:"text_delta",text});};
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    const failTail=backendTailQuota, useMultipart=multipart, reply=FACT;
    const first = useMultipart ? "The mast is ready. " : "";
    if (useMultipart) {
      req.bridge.emit({ type: "text_delta", text: first });
      req.bridge.emit({ type: "tool_use_start", toolUseId: "mast-read", toolName: "Read" });
    }
    await host.historySettled();
    if (failTail) {
      const controls = await import("../../../ui-server/tests/helpers/dialogue-test-writes.js");
      const q = writer.channel({url:controls.url,setup:controls.setup},{});
      await q.call("quota"); await q.close(); quotaApplied = true;
    }
    req.bridge.emit({ type: "text_delta", text: reply });
    if (useMultipart) {
      const {buildSessionHistory} = await import("../../../ui-backend-claude/src/history.js");
      const getNative = (async () => [{type:"assistant",uuid:"mast-native-answer",message:{content:[{type:"text",text:first},{type:"tool_use",id:"mast-read",name:"Read",input:{path:"notes/mast.md"}},{type:"text",text:reply}]}}]) as unknown as Parameters<typeof buildSessionHistory>[1];
      history.push(...await buildSessionHistory("odysseus-ithaca",getNative,root));
    } else history.push({ role: "assistant", content: prefix+reply, toolCalls: [] });
    req.bridge.emit({
      type: "result",
      sessionId: "odysseus-ithaca",
      outcome: "success",
      isError: false,
      durationMs: 1,
      numTurns: 1,
    });
  },
});
backend.getHistory = async (id) => (id === "odysseus-ithaca" ? history : []);
let remote: Bun.ServerWebSocket<undefined> | undefined;
const upstream = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response(null, { status: 400 });
  },
  websocket: {
    open(ws) {
      remote = ws;
    },
    message(ws, bytes) {
      const m = JSON.parse(String(bytes));
      sent.push(m);
      if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (m.type === "session.start")
        ws.send(
          JSON.stringify({
            type: "session.started",
            session: {
              id: "ithaca-live",
              model: "gpt-live-1",
              store: false,
              delegation: { type: "client" },
            },
          })
        );
      if (
        m.type === "session.thinking.append" ||
        m.type === "session.commentary.append"
      )
        ws.send(
          JSON.stringify({
            type: m.type + "ed",
            event_id: crypto.randomUUID(),
            client_event_id: m.event_id,
            start_ms: 3000,
            end_ms: 3000,
          })
        );
      if (m.type === "session.close")
        ws.send(
          JSON.stringify({ type: "session.closed", reason: "close_requested" })
        );
    },
  },
});
const Native = WebSocket as unknown as new (
  url: string,
  options?: Bun.WebSocketOptions
) => WebSocket;
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: class extends Native {
    constructor(_url: string, options?: Bun.WebSocketOptions) {
      super(`ws://127.0.0.1:${upstream.port}`, options);
    }
  },
});
function makeHost() {
  const catalog = createSessionCatalog(() => db, undefined, undefined, {
    writer, store: createOffloopActivityStore(db, writer), pricing: { resolve: () => null },
  });
  // Exercise an actual durable catalog without optional task/epoch recovery.
  if (process.argv[5] === "no-native-history") {
    catalog.saveConversationTask = undefined;
    catalog.saveConversationEpoch = undefined;
  }
  return new WsHost({
    brainPath: root,
    registry: createStaticBackendRegistry([backend], "fake"),
    catalog,
    isPrincipalAuthorized: () => true,
    conversationProvider:
      engine === "gemini"
        ? createGeminiConversationProvider("keyless-odyssey-placeholder")
        : createGptLiveConversationProvider("keyless-odyssey-placeholder"),
  });
}
let host = makeHost(),
  handlers = createWsHandlers(host, testPrincipal());
function fixtureSocket(){const sink=frames;return {send:(data:string)=>sink.push(JSON.parse(data))} as WSContext;}
let ws=fixtureSocket();
await handlers.onOpen(undefined as never, ws);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = (await req.json()) as {
      client?: unknown[];
      provider?: unknown[];
      release?: boolean;
      quota?: boolean;
      pressure?: boolean;
      finishDuring?: number;
      resultText?: string;
      backendTailQuota?: boolean;
      multipart?: boolean;
      backendPrefix?: string;
      seedLegacyVoice?: boolean;
      takeover?: boolean;
      restart?: boolean;
      engine?: string;
    };
    if (body.restart) {
      await closeHost();
      await writer.close();
      quotaApplied = false; pressureApplied = false;
      db.close();
      db = createUiDb(dbPath);
      writer = openSqliteWriter(db);
      if (body.engine) engine = body.engine;
      host = makeHost();
      handlers = createWsHandlers(host, testPrincipal());
      await handlers.onOpen(undefined as never, ws);
    }
    if(body.takeover){frames=[];ws=fixtureSocket();handlers=createWsHandlers(host,testPrincipal());await handlers.onOpen(undefined as never,ws);}
    for (const frame of body.client ?? [])
      handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
    await Bun.sleep(10);
    if(body.backendPrefix) emitPrefix?.(body.backendPrefix);
    if(body.seedLegacyVoice) await host.catalog.saveConversationEpoch!({id:"old-voice",principalId:testPrincipal().id,epoch:1,sessionId:"odysseus-ithaca"});
    let releaseQuota: (() => Promise<void>) | undefined;
    if (body.pressure) pressureApplied=true;
    if (body.quota || body.pressure) {
      const controls = await import(
        "../../../ui-server/tests/helpers/dialogue-test-writes.js"
      );
      const q = writer.channel(
        { url: controls.url, setup: controls.setup },
        {}
      );
      if (body.quota) { await q.call("quota"); quotaApplied = true; }
      const control = new Int32Array(new SharedArrayBuffer(8));
      const hold = q.call("hold", control);
      const deadline = Date.now() + 2000;
      while (!Atomics.load(control, 1)) {
        if (Date.now() > deadline)
          throw Error("quota writer did not enter hold");
        await Bun.sleep(1);
      }
      releaseQuota = async () => {
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        await hold;
        await q.close();
      };
    }
    let delivered=0;
    for (const frame of body.provider ?? []) {
      if(body.finishDuring===delivered){if(body.resultText)FACT=body.resultText;complete?.();await Bun.sleep(5);}
      ingress.push(frame);delivered++;
      if (remote?.readyState === WebSocket.OPEN) remote.send(JSON.stringify(frame));
      // Pace transport consumption while the real writer remains held, so
      // pressure reaches the journal rather than the adapter's event queue.
      if (body.pressure || body.finishDuring!==undefined) await Bun.sleep(1);
    }
    if (body.resultText) FACT=body.resultText;
    backendTailQuota=body.backendTailQuota===true; multipart=body.multipart===true;
    if (body.release) complete?.();
    await Bun.sleep(20);
    await releaseQuota?.();
    await host.historySettled();
    const rows = db
      .query(
        "SELECT sequence,owner_id,identity,payload FROM dialogue_records ORDER BY sequence"
      )
      .all();
    return Response.json({
      frames: frames.splice(0),
      sent: sent.splice(0),
      ingress,
      rows,
      tasks,
      dbPath,
    });
  },
});
async function closeHost() {
  try {
    await host.close();
  } catch (error) {
    const expected = error instanceof Error &&
      (quotaApplied && /full/i.test(error.message) || pressureApplied && error.message === "Dialogue pending writes exceeded their bound");
    if (!expected) throw error;
  }
}
process.on("SIGTERM", async () => {
  complete?.();
  await Promise.allSettled([...host.turnTasks]);
  await closeHost();
  await writer.close();
  db.close();
  remote?.close();
  upstream.stop(true);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
