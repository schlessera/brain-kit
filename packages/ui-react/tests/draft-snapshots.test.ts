import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { createDraftStore, snapshotSaveList, type ComposerSnapshot } from "../src/stores/draft-state.ts";
import { SESSION, snapshotHost, type SnapshotHost } from "./snapshot-host.ts";

// Outgoing snapshots (#3155, design brief rev 5 §2): the draft store's list
// and the draft client's saves, dispatch and recovery, against the fixture
// host that keeps #3588's rules. Odysseus fixtures only; no key, no network.

class FixtureSocket {
  static last: FixtureSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { FixtureSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" } as CloseEvent); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  messages() { return this.sent.map((raw) => JSON.parse(raw) as ClientMessage).filter((f): f is Extract<ClientMessage, { type: "chat_message" }> => f.type === "chat_message"); }
}

const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
const roots: BrainUiRoot[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose();
  Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
});

async function until(predicate: () => boolean, what: string, timeout = 4_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const HELLO = {
  type: "server_hello", protocolRev: 5,
  capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true, sessionRecovery: true },
  attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 },
  sessionDraftLimits: { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456, maxOutgoingSnapshots: 10 },
};

function boot(host: SnapshotHost, hello: Record<string, unknown> = HELLO) {
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  const ui = createBrainUiRoot({ storage: null, request: host.request, config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(ui);
  ui.stores.chat.getState().setActiveSession(SESSION);
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  socket.open();
  socket.deliver(hello);
  socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false });
  socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] });
  socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  return { ui, socket, drafts: () => ui.stores.drafts.getState(), id: () => ui.stores.drafts.getState().idFor(SESSION) };
}

const snap = (over: Partial<ComposerSnapshot> & Pick<ComposerSnapshot, "snapshotId" | "requestId">): ComposerSnapshot =>
  ({ text: "Row past the Sirens.", files: [], state: "dispatched", createdAt: null, dispatch: "due",
    message: { type: "chat_message", text: over.text ?? "Row past the Sirens.", sessionId: SESSION, requestId: over.requestId, source: "typed" }, ...over });

describe("the snapshot list", () => {
  test("Send again is two saves: the old one returns, then leaves as its successor is created", () => {
    const old = snap({ snapshotId: "s-old", requestId: "r-old", retiring: true, dispatch: undefined });
    const fresh = snap({ snapshotId: "s-new", requestId: "r-new", replaces: "s-old" });
    const write = { snapshotId: "s-old", requestId: "r-old", text: old.text, fileIds: [] };
    const first = snapshotSaveList({ snapshots: [old, fresh], host: { revision: 2, edit: 1, sessionId: SESSION, attachmentIds: [], updatedAt: 0, snapshots: [{ ...write, state: "dispatched" }] } });
    expect(first).toEqual({ writes: [{ ...write, state: "returned" }], complete: false });
    const second = snapshotSaveList({ snapshots: [old, fresh], host: { revision: 3, edit: -1, sessionId: SESSION, attachmentIds: [], updatedAt: 0, snapshots: [{ ...write, state: "returned" }] } });
    expect(second).toEqual({ writes: [{ snapshotId: "s-new", requestId: "r-new", text: fresh.text, fileIds: [], state: "dispatched" }], complete: true });
  });

  test("a refused creation gives the text and files back and names the full chat; Edit never merges", () => {
    const store = createDraftStore();
    const id = "draft-ithaca";
    store.getState().edit(id, SESSION, { text: "Ask Aeolus for the bag." });
    store.getState().createSnapshot(id, SESSION, snap({ snapshotId: "s1", requestId: "r1", text: "Ask Aeolus for the bag." }), "Ask Aeolus for the bag.");
    expect(store.getState().drafts[id]!.text).toBe("");
    store.getState().snapshotsRefused(id, ["s1"], 10);
    expect(store.getState().drafts[id]!.text).toBe("Ask Aeolus for the bag.");
    expect(store.getState().drafts[id]!.snapshots).toEqual([]);
    expect(store.getState().outgoingFull).toEqual({ draftId: id, sessionId: SESSION, limit: 10 });
    // A returned snapshot beside a newer draft: Edit is refused, nothing concatenated.
    store.getState().createSnapshot(id, SESSION, snap({ snapshotId: "s2", requestId: "r2", text: "Ask Aeolus for the bag.", state: "returned", dispatch: undefined }), "Ask Aeolus for the bag.");
    store.getState().edit(id, SESSION, { text: "Steer for Ithaca." });
    expect(store.getState().editSnapshot(id, "s2")).toBe(false);
    expect(store.getState().drafts[id]!.text).toBe("Steer for Ithaca.");
    store.getState().edit(id, SESSION, { text: "" });
    expect(store.getState().editSnapshot(id, "s2")).toBe(true);
    expect(store.getState().drafts[id]!.text).toBe("Ask Aeolus for the bag.");
    expect(store.getState().drafts[id]!.snapshots).toEqual([]);
  });

  test("Delete… removes only a returned snapshot", () => {
    const store = createDraftStore();
    store.getState().createSnapshot("d", SESSION, snap({ snapshotId: "held", requestId: "r1", state: "held", dispatch: undefined }), "");
    store.getState().deleteSnapshot("d", "held");
    expect(store.getState().drafts.d!.snapshots).toHaveLength(1);
    store.getState().patchSnapshot("d", "held", { state: "returned", why: { kind: "cancelled" } });
    store.getState().deleteSnapshot("d", "held");
    expect(store.getState().drafts.d!.snapshots).toHaveLength(0);
  });
});

describe("the draft client", () => {
  test("a host without maxOutgoingSnapshots keeps the tab-local path", () => {
    const host = snapshotHost();
    const { drafts } = boot(host, { ...HELLO, sessionDraftLimits: undefined });
    expect(drafts().snapshotsOn).toBe(false);
  });

  test("an all-ready Send records a dispatched snapshot in the save that clears the composer, then sends once from that revision", async () => {
    const host = snapshotHost();
    const { drafts, socket, id } = boot(host);
    const draftId = id();
    const fileId = host.storeFile(draftId, "crew-list.txt");
    const file = { ...host.files.get(fileId)! } as never;
    drafts().edit(draftId, SESSION, { text: "Read the crew list.", files: [{ file, lineage: draftId }] });
    drafts().createSnapshot(draftId, SESSION, snap({ snapshotId: "s1", requestId: "r1", text: "Read the crew list.", files: [{ fileId, file }] }), "Read the crew list.");
    await until(() => socket.messages().length === 1, "the message is sent");
    const creating = host.saves.find((s) => s.body.snapshots?.length)!;
    expect(creating.body.text, "the same save clears the composer").toBe("");
    expect(creating.body.fileIds ?? [], "the files moved into the snapshot").toEqual([]);
    expect(creating.body.snapshots).toEqual([{ snapshotId: "s1", requestId: "r1", text: "Read the crew list.", fileIds: [fileId], state: "dispatched" }]);
    const frame = socket.messages()[0]!;
    expect(frame.requestId).toBe("r1");
    expect(frame.draftRef).toEqual({ draftId, revision: host.rows.get(draftId)!.revision });
    expect(frame.attachmentRefs).toEqual([{ kind: "attachment", fileId }]);
    // Accepted: the host releases it in place, and this tab drops it before any later save (#3733).
    host.accept(frame);
    socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false, requestId: "r1" });
    expect(drafts().drafts[draftId]?.snapshots ?? []).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.messages(), "sent once").toHaveLength(1);
  });

  test("Send reaches the host with the page's timers paused: the snapshot step waits on no timer tick", async () => {
    // A page whose clock is paused (answer delivery's liveness proof installs
    // one) still sends: before snapshots Send emitted its frame at once, and
    // the snapshot save that now precedes it must not wait for a timer.
    const host = snapshotHost();
    const { drafts, socket, id } = boot(host);
    const draftId = id();
    await until(() => drafts().supported === true, "drafts are on");
    const real = globalThis.setTimeout;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    Object.defineProperty(globalThis, "setTimeout", { ...descriptor, value: (() => 0) as unknown as typeof setTimeout });
    try {
      drafts().edit(draftId, SESSION, { text: "Hold fast to the mast." });
      drafts().createSnapshot(draftId, SESSION, snap({ snapshotId: "s1", requestId: "r1", text: "Hold fast to the mast." }), "Hold fast to the mast.");
      const end = Date.now() + 4_000;
      while (socket.messages().length === 0 && Date.now() < end) await new Promise((resolve) => real(resolve, 10));
    } finally {
      Object.defineProperty(globalThis, "setTimeout", descriptor);
    }
    expect(host.saves.some((s) => s.body.snapshots?.some((x) => x.snapshotId === "s1")), "the creating save went out").toBe(true);
    expect(socket.messages().map((m) => m.requestId), "and the message after it").toEqual(["r1"]);
  });

  test("a held snapshot grows as its uploads store, then dispatches once with all of them", async () => {
    const host = snapshotHost();
    const { drafts, socket, id } = boot(host);
    const draftId = id();
    drafts().createSnapshot(draftId, SESSION, snap({ snapshotId: "s1", requestId: "r1", text: "Chart and permit.", state: "held", dispatch: undefined, uploads: ["q1"] }), "");
    await until(() => host.snapshotsOf(draftId).length === 1, "the held snapshot is saved");
    expect(host.snapshotsOf(draftId)[0]!.state).toBe("held");
    expect(socket.messages()).toHaveLength(0);
    const fileId = host.storeFile(draftId, "chart.txt");
    drafts().snapshotStored(draftId, "s1", "q1", { ...host.files.get(fileId)! } as never);
    await until(() => socket.messages().length === 1, "dispatched once its file is stored");
    expect(host.saves.filter((s) => s.status === 200).map((s) => s.body.snapshots?.[0]?.state)).toEqual(["held", "held", "dispatched"]);
    expect(socket.messages()[0]!.attachmentRefs).toEqual([{ kind: "attachment", fileId }]);
  });

  test("409 DRAFT_OUTGOING_FULL sends nothing and gives the text back; Cancel of a held one still saves at 10 of 10", async () => {
    const host = snapshotHost();
    const { drafts, socket, id } = boot(host);
    const draftId = id();
    drafts().createSnapshot(draftId, SESSION, snap({ snapshotId: "held", requestId: "r-held", text: "Wait for the wind.", state: "held", dispatch: undefined, uploads: ["q1"] }), "");
    await until(() => host.count() === 1, "the held one is saved");
    host.seed("draft-other-device", Array.from({ length: 9 }, (_, i) => ({ snapshotId: `o${i}`, requestId: `ro${i}`, text: `Oar ${i}`, state: "returned" as const })));
    drafts().edit(draftId, SESSION, { text: "Turn back to Aeaea." });
    drafts().createSnapshot(draftId, SESSION, snap({ snapshotId: "s11", requestId: "r11", text: "Turn back to Aeaea." }), "Turn back to Aeaea.");
    await until(() => drafts().outgoingFull !== null, "the chat is full");
    expect(socket.messages()).toHaveLength(0);
    expect(drafts().drafts[draftId]!.text).toBe("Turn back to Aeaea.");
    drafts().patchSnapshot(draftId, "held", { state: "returned", why: { kind: "cancelled" }, uploads: [] });
    await until(() => host.snapshotsOf(draftId)[0]?.state === "returned", "Cancel saves in place at 10 of 10");
    expect(host.count()).toBe(10);
  });

  test("acceptance with other snapshots left keeps the draft at the next revision, without a conflict", async () => {
    const host = snapshotHost();
    host.seed("draft-ithaca", [{ snapshotId: "kept", requestId: "r0", text: "Moly for Circe.", state: "returned" }]);
    const { drafts, socket, id } = boot(host);
    await until(() => (drafts().drafts["draft-ithaca"]?.snapshots?.length ?? 0) === 1, "the returned snapshot is restored");
    expect(id()).toBe("draft-ithaca");
    drafts().createSnapshot("draft-ithaca", SESSION, snap({ snapshotId: "s1", requestId: "r1" }), "");
    await until(() => socket.messages().length === 1, "sent");
    const frame = socket.messages()[0]!;
    expect(host.accept(frame)).toBe("consumed");
    socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false, requestId: "r1" });
    expect(drafts().drafts["draft-ithaca"]!.host!.revision, "the host's next revision, known without a read").toBe(host.rows.get("draft-ithaca")!.revision);
    drafts().edit("draft-ithaca", SESSION, { text: "Steer between Scylla and Charybdis." });
    await until(() => host.rows.get("draft-ithaca")!.text === "Steer between Scylla and Charybdis.", "the next edit saves");
    expect(host.saves.filter((s) => s.status === 409), "never a conflict").toHaveLength(0);
    expect(host.snapshotsOf("draft-ithaca").map((s) => s.snapshotId), "the accepted one is never listed again").toEqual(["kept"]);
    expect(drafts().drafts["draft-ithaca"]!.conflict).toBeNull();
  });

  test("a dispatched snapshot restored after reload reads as unconfirmed and never sends by itself", async () => {
    const host = snapshotHost();
    host.seed("draft-ithaca", [{ snapshotId: "s1", requestId: "r1", text: "Did Penelope get my word?", state: "dispatched" }]);
    const { drafts, socket } = boot(host);
    await until(() => drafts().sends.r1?.state === "unconfirmed", "the restored send is unconfirmed");
    expect(drafts().sends.r1!.snapshotId).toBe("s1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.messages()).toHaveLength(0);
    // Check: one recovery read, which proves acceptance.
    host.setRecovery({ revision: 4, latestRequestId: "r1" });
    await roots[0]!.connection.drafts.check("r1");
    expect(host.recoveryReads).toEqual([SESSION]);
    expect(drafts().drafts["draft-ithaca"]?.snapshots ?? []).toEqual([]);
  });

  test("Send again returns the old snapshot, then replaces it, and sends the new request once", async () => {
    const host = snapshotHost();
    host.seed("draft-ithaca", [{ snapshotId: "s1", requestId: "r1", text: "Did Penelope get my word?", state: "dispatched" }]);
    const { drafts, socket } = boot(host);
    await until(() => drafts().sends.r1?.state === "unconfirmed", "restored as unconfirmed");
    expect(roots[0]!.connection.drafts.resendSnapshot("r1")).toBe(true);
    await until(() => socket.messages().length === 1, "the new request is sent");
    const frame = socket.messages()[0]!;
    expect(frame.requestId).not.toBe("r1");
    expect(host.snapshotsOf("draft-ithaca").map((s) => [s.requestId, s.state])).toEqual([[frame.requestId!, "dispatched"]]);
    expect(host.saves.filter((s) => s.status === 200).map((s) => s.body.snapshots!.map((x) => `${x.requestId}:${x.state}`).join())).toEqual(["r1:returned", `${frame.requestId}:dispatched`]);
  });
});
