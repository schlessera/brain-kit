import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { WsHost } from "../src/ws/host.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { stageShare } from "../src/share/staging.js";
import { readLiveHistory } from "../src/ws/live-history.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";
const gpx = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';
async function until(c: () => boolean) { const end = Date.now() + 3000; while (!c()) { if (Date.now() > end) throw Error("timeout"); await Bun.sleep(2); } }
test("live history keeps track-file native identity joins before source normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "odysseus-track-"));
  const staged = await stageShare(root, { files: [new File([gpx], "loop.gpx")] }); const path = staged.files[0]!.path;
  const transcript: SessionHistoryMessage[] = [];
  const backend = makeFakeBackend({ id: "odysseus", async getHistory() { return transcript.map(m=>({...m})); }, async startTurn(req) {
    req.bridge.emit({ type: "session_info", sessionId: "odysseus-track-session", isNew: !req.sessionId });
    transcript.push({ role: "user", content: req.prompt, toolCalls: [] });
    const answer = transcript.length < 2 ? "The loop is short." : "Second answer.";
    req.bridge.emit({ type: "text_delta", text: answer });
    const failed=transcript.length>2;
    const failure={errorClass:"overloaded" as const,message:"Athena could not finish the second calculation."};
    transcript.push({ role: "assistant", content: answer, toolCalls: [{id:"mast-tool",name:"Read",input:{path:"notes/mast.md"},output:"The mast is ready."}],
      parts:[{kind:"text",text:answer.slice(0,5)},{kind:"text",text:answer.slice(5)}],...(failed?{failure}: {}) });
    req.bridge.emit({ type: "result", sessionId: "odysseus-track-session", isError: failed, durationMs: 1, numTurns: 1, ...(failed?{failure}: {}) });
  } });
  const db = createUiDb(":memory:"); const catalog = createSessionCatalog(() => db);
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog });
  const ws = { send: (_: string) => {} } as any; host.clients.add(ws, "test-principal");
  const connection = { principal: testPrincipal(), authorization: testAuthorization() };
  try {
    await handleClientMessage(host, ws, { type: "chat_message", text: "Show this file", files: [{ kind: "file", path }] }, connection);
    await until(() => transcript.length === 2 && !host.coordinator.isTurnActive());
    await handleClientMessage(host, ws, { type: "chat_message", text: "And then?", sessionId: "odysseus-track-session" }, connection);
    await until(() => transcript.length === 4 && !host.coordinator.isTurnActive());
    await host.historySettled();
    const raw = await backend.getHistory("odysseus-track-session");
    const ordinary = host.prepareHistory("odysseus-track-session", raw);
    let live: SessionHistoryMessage[] = [];
    const prepare = host.prepareHistory.bind(host);
    host.prepareHistory = (...args) => { live = prepare(...args); return live; };
    const env = await readLiveHistory(host, testPrincipal().id, { sessionId: "odysseus-track-session" }, () => true);
    expect(ordinary.filter(m=>m.role === "assistant").every(m=>!!m.turnId)).toBe(true);
    expect(live.map(m=>m.turnId), "LIVE_HISTORY_RETAINS_NATIVE_TURN_IDENTITIES").toEqual(ordinary.map(m=>m.turnId));
    expect(live.at(-1)!.failure,"LIVE_HISTORY_RETAINS_NATIVE_FAILURE_JOIN").toEqual(ordinary.at(-1)!.failure);
    expect(live.at(-1)!.toolCalls).toEqual(ordinary.at(-1)!.toolCalls);
    expect(env!.items.filter(i=>i.kind === "typed").map(i=>i.text)).toContain("The loop is short.");
  } finally { host.coordinator.reset(); await host.close(); db.close(); rmSync(root,{recursive:true,force:true}); }
});
