import { expect,test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createSafetyStore } from "../src/stores/safety-state";
import { createSafetyClient } from "../src/lib/safety-client";
import type { BrainUiServices } from "../src/root";
import { SAFETY_READ_CAPABILITIES, type ClientMessage, type SafetyPage } from "@schlessera/brain-ui-sdk/protocol";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";

const hello = { type: "server_hello" as const, protocolRev: 5,
  capabilities: { sessionSafetyHistory: true }, safetyCapabilities: SAFETY_READ_CAPABILITIES };
const page: SafetyPage = {
  version: 1, identity: { sessionId: "ithaca", historyOwnerId: "odysseus", historyGeneration: "1" },
  snapshotId: "voyage_snapshot", cursor: null, highWater: "0", records: [], nextCursor: null,
  snapshotComplete: true, detailPruned: false,
  projection: { session: { sessionId: "ithaca", historyOwnerId: "odysseus", historyGeneration: "1" },
    evidenceRevision: "0", unresolvedCount: 0, earliestUnresolvedId: null, pendingCount: 0,
    restriction: "restricted", reasons: ["coverage_unknown"],
    coverage: { detectorVersion: 1, state: "incomplete", epochs: [], exclusions: [] } },
};

function supportedClient(activeSessionId: string) {
  const chat = createStore<{ activeSessionId: string | null }>(() => ({ activeSessionId }));
  const safety = createSafetyStore(), sent: ClientMessage[] = [];
  const root = { stores: { chat, safety } } as unknown as BrainUiServices;
  const client = createSafetyClient(root, message => { sent.push(message); return true; });
  const checkWire = () => {
    for (const message of sent) {
      expect(parseClientMessage(JSON.stringify(message)), "SAFETY_CLIENT_FRAMES_MATCH_PUBLISHED_PARSER").toMatchObject({ ok: true });
    }
  };
  return { chat, safety, sent, client, checkWire };
}

test("an old host receives no safety read or unsubscribe frames and remains explicitly unavailable",()=>{
  for(const id of [null,"ithaca"]){
    const chat=createStore<{activeSessionId:string|null}>(()=>({activeSessionId:id})),safety=createSafetyStore(),sent:ClientMessage[]=[];
    const root={stores:{chat,safety}} as unknown as BrainUiServices;
    const client=createSafetyClient(root,message=>{sent.push(message);return true;});
    try{
      client.frame({type:"server_hello",protocolRev:2,capabilities:{multiSession:true}});
      expect(safety.getState().status,"OLD_HOST_SAFETY_UNAVAILABLE").toBe("unavailable");expect(safety.getState().normal).toBe(false);
      expect(sent,"OLD_HOST_RECEIVES_NO_UNKNOWN_SAFETY_FRAME").toEqual([]);
      chat.setState({activeSessionId:"troy"});client.refresh();expect(sent).toEqual([]);
    }finally{client.dispose();}
  }
});

test("host-only and invalid selections remain unavailable across selection, reload and reconnect", () => {
  for (const id of ["dialogue:7f9e2c1a-0000-4000-8000-000000000001", "voyage notes", "", "a".repeat(129)]) {
    const { chat, safety, sent, client, checkWire } = supportedClient(id);
    try {
      client.frame(hello);
      checkWire();
      expect(sent.some(message => message.type === "safety_read"), "INVALID_SELECTION_STARTS_NO_READ").toBe(false);
      expect(safety.getState()).toMatchObject({ status: "unavailable", requestId: null, normal: false });

      chat.setState({ activeSessionId: "ithaca" });
      const read = sent.find(message => message.type === "safety_read");
      if (read?.type !== "safety_read") throw new Error("Valid selection did not start its read");
      expect(safety.getState().status).toBe("loading");
      chat.setState({ activeSessionId: id });
      expect(sent.at(-1)?.type, "INVALID_SELECTION_UNSUBSCRIBES").toBe("safety_unsubscribe");
      client.frame({ type: "safety_history", requestId: read.requestId, page });
      expect(safety.getState(), "OLD_PAGE_CANNOT_SETTLE_INVALID_SELECTION").toMatchObject({ status: "unavailable", requestId: null });

      client.disconnected();
      client.frame(hello);
      client.refresh();
      checkWire();
      expect(sent.filter(message => message.type === "safety_read")).toHaveLength(1);
      expect(safety.getState()).toMatchObject({ status: "unavailable", requestId: null, normal: false });
    } finally { client.dispose(); }
  }
});

test("valid sessions keep paging, subscription and gap recovery on the published wire", () => {
  const { chat, safety, sent, client, checkWire } = supportedClient("ithaca");
  try {
    client.frame(hello);
    const read = sent.find(message => message.type === "safety_read");
    if (read?.type !== "safety_read") throw new Error("Missing initial read");
    expect(read.target).toEqual({ sessionId: "ithaca" });
    client.frame({ type: "safety_history", requestId: read.requestId,
      page: { ...page, nextCursor: "voyage_page_2", snapshotComplete: false } });
    expect(sent.at(-1)).toMatchObject({ type: "safety_read", requestId: read.requestId,
      target: { sessionId: "ithaca" }, cursor: "voyage_page_2" });
    expect(safety.getState().status).toBe("partial");
    client.frame({ type: "safety_history", requestId: read.requestId, page: { ...page, cursor: "voyage_page_2" } });
    expect(sent.at(-1)).toMatchObject({ type: "safety_subscribe", identity: page.identity, snapshotId: page.snapshotId });
    expect(safety.getState().status).toBe("ready");
    checkWire();

    client.frame({ type: "safety_unavailable", version: 1, reason: "gap" });
    expect(sent.at(-1)).toMatchObject({ type: "safety_read", target: { sessionId: "ithaca" } });
    expect(safety.getState().status).toBe("loading");
    chat.setState({ activeSessionId: "dialogue:odysseus" });
    chat.setState({ activeSessionId: "7f9e2c1a-0000-4000-8000-000000000001" });
    expect(sent.at(-1)).toMatchObject({ type: "safety_read", target: { sessionId: chat.getState().activeSessionId } });
    client.refresh();
    checkWire();
  } finally { client.dispose(); }
});
