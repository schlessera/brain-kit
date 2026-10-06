import { afterEach, describe, expect, test } from "bun:test";
import type { Draft } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import type { PendingAttachment } from "../src/lib/image-attachments.ts";

// The draft client (#951, D52 §5) against a small in-memory host that keeps
// #979's revision rules: If-Match, conflicts carrying the host's version,
// tombstones. What it proves is the client's side: only an acknowledged
// revision reads as saved, a refusal never overwrites what the reader has,
// and a silent host never gets a message twice. Odysseus fixtures only.

type Row = Draft & { deleted?: boolean };

function fakeHost() {
  const rows = new Map<string, Row>();
  const images = new Map<string, { draftId: string; mime: string; bytes: string; name: string | null }>();
  const calls: string[] = [];
  let down = false;
  let full = false;
  let slow: Promise<void> | null = null;
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const { pathname } = new URL(url, "http://localhost");
    const method = init.method ?? "GET";
    calls.push(`${method} ${pathname.replace(/^\/api/, "")}`);
    if (down) throw new TypeError("fetch failed");
    const headers = new Headers(init.headers);
    const m = /^\/api\/drafts(?:\/([^/]+))?(\/attachments|\/bind)?$/.exec(pathname);
    const recovery = /^\/api\/sessions\/([^/]+)\/recovery$/.exec(pathname);
    if (recovery) return json({ sessionId: recovery[1], backendId: null, revision: 3, latest: { requestId: "req-newer", turnId: "t-3", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 }, pending: [] });
    if (!m) return json({ error: "not_found" }, 404);
    const [, id, sub] = m;
    if (!id) return json({ drafts: [...rows.values()].filter((r) => !r.deleted).map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text.split("\n")[0] ?? "", attachmentCount: r.attachments.length })) });
    const row = rows.get(id);
    const ifMatch = Number(headers.get("if-match"));
    const conflict = (r: Row) => json({ error: "DRAFT_CONFLICT", message: "changed", current: { ...r, deleted: undefined } }, 409);
    if (sub === "/attachments") {
      const bytes = Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()).toString("base64");
      const attachmentId = `att-${++seq}`;
      images.set(attachmentId, { draftId: id, mime: headers.get("content-type")!, bytes, name: null });
      return json({ attachmentId });
    }
    if (method === "GET") return row && !row.deleted ? json(row) : json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
    if (method === "DELETE") {
      if (!row) return json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      if (row.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if (ifMatch !== row.revision) return conflict(row);
      rows.set(id, { ...row, deleted: true, revision: row.revision + 1, text: "", attachments: [] });
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      if (slow) await slow;
      const body = JSON.parse(String(init.body)) as { sessionId: string | null; text: string; attachmentIds: string[] };
      if (full && !row) return json({ error: "DRAFT_CAPACITY", message: "full", limit: 100, bound: "drafts" }, 507);
      if (row?.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if (row && ifMatch !== row.revision) return conflict(row);
      if (!row && ifMatch !== 0) return json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      const revision = (row?.revision ?? 0) + 1;
      rows.set(id, {
        draftId: id, sessionId: body.sessionId, revision, updatedAt: 9_000 + revision, text: body.text,
        attachments: body.attachmentIds.map((a) => ({ attachmentId: a, mime: images.get(a)!.mime as "image/png", bytes: images.get(a)!.bytes, name: null })),
      });
      return json({ revision, updatedAt: 9_000 + revision });
    }
    return json({ error: "DRAFT_INVALID", message: "" }, 400);
  }
  return {
    rows, calls, request,
    setDown: (value: boolean) => { down = value; },
    setFull: (value: boolean) => { full = value; },
    /** Hold every save until the returned release is called. */
    hold: () => { let release!: () => void; slow = new Promise<void>((r) => { release = r; }); return () => { slow = null; release(); }; },
  };
}

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
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type); }
}

const ITHACA = "odysseus-ithaca";
const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose();
  globalThis.WebSocket = realSocket;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition never held");
    await wait(20);
  }
}

function boot(host: ReturnType<typeof fakeHost>, capabilities: Record<string, boolean> = { chatRequestAck: true, sessionDrafts: true }) {
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  const ui = createBrainUiRoot({ storage: null, request: host.request, config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(ui);
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  socket.open();
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities });
  return { ui, socket, drafts: () => ui.stores.drafts.getState() };
}

describe("saving", () => {
  test("a host without the capability is never asked, and the draft says so", async () => {
    const host = fakeHost();
    const { drafts } = boot(host, { chatRequestAck: true });
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax" });
    await wait(1_000);
    expect(host.calls.filter((c) => c.startsWith("PUT") || c.startsWith("GET /drafts"))).toEqual([]);
    expect(drafts().supported).toBe(false);
  });

  test("saved only after the host acknowledged that revision; a newer edit is not saved", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax" });
    expect(drafts().drafts[id]?.host).toBeNull();
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    expect(host.rows.get(id)).toMatchObject({ text: "Plug the ears with wax", sessionId: ITHACA, revision: 1 });
    expect(drafts().drafts[id]!.host!.edit).toBe(drafts().drafts[id]!.edit);
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax, and bind me" });
    expect(drafts().drafts[id]!.host!.edit).not.toBe(drafts().drafts[id]!.edit);
    await until(() => host.rows.get(id)?.revision === 2);
    expect(host.calls.filter((c) => c === `PUT /drafts/${id}`)).toHaveLength(2);
  });

  test("images upload before the save that lists them", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    const map: PendingAttachment = { attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" }, previewUrl: "blob:fixture/map", bytes: 8, name: "map.png" };
    drafts().edit(id, ITHACA, { text: "", attachments: [map] });
    await until(() => host.rows.get(id)?.revision === 1);
    expect(host.calls.filter((c) => c.includes(id))).toEqual([`POST /drafts/${id}/attachments`, `PUT /drafts/${id}`]);
    expect(host.rows.get(id)!.attachments).toHaveLength(1);
  });

  test("another device's newer save is a conflict: the reader's words stay, nothing is written over", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Eumaeus" });
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    host.rows.set(id, { ...host.rows.get(id)!, revision: 2, text: "Ask Eumaeus at dawn" });
    drafts().edit(id, ITHACA, { text: "Ask Eumaeus about the dog" });
    await until(() => drafts().drafts[id]?.conflict !== null);
    expect(drafts().drafts[id]).toMatchObject({ text: "Ask Eumaeus about the dog" });
    expect(drafts().drafts[id]!.conflict!.other.text).toBe("Ask Eumaeus at dawn");
    expect(host.rows.get(id)!.text).toBe("Ask Eumaeus at dawn");
    // No retry writes over it while the reader has not chosen.
    await wait(1_200);
    expect(host.rows.get(id)!.revision).toBe(2);
    drafts().resolve(id, "mine");
    await until(() => host.rows.get(id)?.revision === 3);
    expect(host.rows.get(id)!.text).toBe("Ask Eumaeus about the dog");
  });

  test("an unreachable host leaves the draft unsaved, and it saves once the host answers", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    host.setDown(true);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.failure?.kind === "unsaved");
    expect(drafts().drafts[id]?.host).toBeNull();
    host.setDown(false);
    await until(() => drafts().drafts[id]?.host?.revision === 1, 6_000);
  });

  test("emptying a saved draft deletes it at its revision", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    drafts().edit(id, ITHACA, { text: "" });
    await until(() => host.rows.get(id)?.deleted === true);
    expect(drafts().drafts[id]).toBeUndefined();
  });
});

describe("saving, continued", () => {
  test("a draft emptied while its first save is out is deleted once the host acknowledges it", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    const release = host.hold();
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => host.calls.includes(`PUT /drafts/${id}`));
    drafts().edit(id, ITHACA, { text: "" });
    release();
    await until(() => host.rows.get(id)?.deleted === true);
    expect(drafts().drafts[id]).toBeUndefined();
  });

  test("a draft refused for capacity saves once deleting another makes room", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const older = drafts().idFor("odysseus-raft");
    drafts().edit(older, "odysseus-raft", { text: "Lash the beams" });
    await until(() => host.rows.get(older)?.revision === 1);
    host.setFull(true);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.failure?.kind === "full");
    host.setFull(false);
    drafts().edit(older, "odysseus-raft", { text: "" });
    await until(() => host.rows.get(older)?.deleted === true);
    await until(() => host.rows.get(id)?.revision === 1, 4_000);
  });
});

describe("orphans", () => {
  test("a delete that gets no answer is retried with backoff, not at once", async () => {
    const host = fakeHost();
    const { ui } = boot(host);
    host.setDown(true);
    ui.stores.drafts.setState((s) => ({ orphans: [...s.orphans, { draftId: "d-gone", revision: 3 }] }));
    await wait(300);
    expect(host.calls.filter((c) => c === "DELETE /drafts/d-gone").length).toBeLessThanOrEqual(1);
  });
});

describe("restoring", () => {
  test("a hello lists the host's drafts and restores them; a dirty one is never overwritten", async () => {
    const host = fakeHost();
    host.rows.set("d-raft", { draftId: "d-raft", sessionId: "odysseus-raft", revision: 4, updatedAt: 1, text: "Lash the beams", attachments: [] });
    host.rows.set("d-letter", { draftId: "d-letter", sessionId: null, revision: 1, updatedAt: 2, text: "Letter to Penelope", attachments: [] });
    const { drafts } = boot(host);
    await until(() => Object.keys(drafts().drafts).length === 2);
    expect(drafts().drafts[drafts().idFor("odysseus-raft")]?.text).toBe("Lash the beams");
    expect(drafts().drafts["d-letter"]).toMatchObject({ text: "Letter to Penelope", sessionId: null });
  });
});

describe("sends", () => {
  test("the socket closing before acceptance holds the send for review, and nothing is sent again", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    ui.stores.chat.getState().setActiveSession(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus for the west wind" });
    const chat = ui.stores.chat.getState();
    chat.addUserMessage(ITHACA, "Ask Aeolus for the west wind", "typed", undefined, { requestId: "req-1" });
    chat.startAssistantMessage(ITHACA, undefined, "req-1");
    drafts().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Ask Aeolus for the west wind", attachments: [], message: { type: "chat_message", text: "Ask Aeolus for the west wind", sessionId: ITHACA, requestId: "req-1", source: "typed" } }, "Ask Aeolus for the west wind");
    socket.close();
    await until(() => drafts().sends["req-1"]?.state === "unconfirmed");
    // Its optimistic rows leave the transcript; the review block stands in.
    expect(ui.stores.chat.getState().buffers[ITHACA]!.messages.some((m) => m.requestId === "req-1")).toBe(false);
    await wait(500);
    expect(socket.frames("chat_message")).toHaveLength(0);
    // A new socket: still nothing, until Send again.
    ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    next.open();
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await wait(200);
    expect(next.frames("chat_message")).toHaveLength(0);
    expect(ui.connection.drafts.resend("req-1")).toBe(true);
    const sent = next.frames("chat_message");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Ask Aeolus for the west wind");
    expect(sent[0].requestId).not.toBe("req-1");
  });

  test("a first message answered after New chat becomes its own session without taking the view", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const chat = ui.stores.chat.getState();
    const first = drafts().fresh;
    drafts().edit(first, null, { text: "Which harbour is safest?" });
    chat.addUserMessage(null, "Which harbour is safest?", "typed", undefined, { requestId: "req-first" });
    chat.startAssistantMessage(null, undefined, "req-first");
    const correlation = chat.startDraftTurn();
    drafts().beginSend({ requestId: "req-first", draftId: first, sessionId: null, text: "Which harbour is safest?", attachments: [], message: { type: "chat_message", text: "Which harbour is safest?", requestId: "req-first", source: "typed" } }, "Which harbour is safest?");
    drafts().edit(first, null, { text: "Also the fees" });
    // New chat before the host answered, and a new chat started there.
    ui.stores.chat.getState().clearMessages();
    const second = drafts().fresh;
    drafts().edit(second, null, { text: "Letter to Penelope" });
    ui.stores.chat.getState().addUserMessage(null, "/stats", "typed");
    socket.deliver({ type: "session_info", sessionId: ITHACA, isNew: true, requestId: "req-first", draftId: correlation });
    const after = ui.stores.chat.getState();
    expect(after.activeSessionId, "the view stays on the new chat").toBeNull();
    expect(after.draft?.messages.map((m) => m.content), "the new chat keeps its own transcript").toEqual(["/stats"]);
    expect(after.buffers[ITHACA]?.messages.find((m) => m.role === "user")?.content, "the transcript is its session's").toBe("Which harbour is safest?");
    expect(drafts().drafts[second]?.text).toBe("Letter to Penelope");
    expect(drafts().drafts[drafts().idFor(ITHACA)]?.text, "the newer words are that session's draft").toBe("Also the fees");
  });

  test("a queue report settles a held send it names: it is the host's, and Send again has nothing to do", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    drafts().beginSend({ requestId: "req-q", draftId: id, sessionId: ITHACA, text: "Ask Aeolus", attachments: [], message: { type: "chat_message", text: "Ask Aeolus", sessionId: ITHACA, requestId: "req-q", source: "typed" } }, "Ask Aeolus");
    socket.close();
    await until(() => drafts().sends["req-q"]?.state === "unconfirmed");
    ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    next.open();
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, followUpQueue: true } });
    next.deliver({ type: "session_queue", sessionId: ITHACA, followUps: [{ id: "fu-1", requestId: "req-q", text: "Ask Aeolus", queuedAt: 1 }] });
    expect(drafts().sends["req-q"]?.state).toBe("accepted");
    expect(ui.connection.drafts.resend("req-q")).toBe(false);
    expect(next.frames("chat_message")).toHaveLength(0);
  });

  test("an error naming A's request refuses A and leaves B waiting", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    for (const [rid, session] of [["req-a", ITHACA], ["req-b", "odysseus-raft"]] as const) {
      const id = drafts().idFor(session);
      drafts().edit(id, session, { text: rid });
      drafts().beginSend({ requestId: rid, draftId: id, sessionId: session, text: rid, attachments: [], message: { type: "chat_message", text: rid, sessionId: session, requestId: rid, source: "typed" } }, rid);
    }
    socket.deliver({ type: "error", code: "INTERNAL_ERROR", message: "failed", sessionId: ITHACA, requestId: "req-a" });
    expect(drafts().sends["req-a"]?.state).toBe("refused");
    expect(drafts().sends["req-b"]?.state).toBe("pending");
    // One that names nothing may have been either: what still waits is held.
    socket.deliver({ type: "error", code: "INTERNAL_ERROR", message: "failed" });
    expect(drafts().sends["req-b"]?.state).toBe("unconfirmed");
  });

  test("Check again with another request as the host's latest proves nothing either way", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host, { chatRequestAck: true, sessionDrafts: true, sessionRecovery: true });
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    drafts().beginSend({ requestId: "req-old", draftId: id, sessionId: ITHACA, text: "Ask Aeolus", attachments: [], message: { type: "chat_message", text: "Ask Aeolus", sessionId: ITHACA, requestId: "req-old", source: "typed" } }, "Ask Aeolus");
    socket.close();
    await until(() => drafts().sends["req-old"]?.state === "unconfirmed");
    await ui.connection.drafts.check("req-old");
    expect(drafts().sends["req-old"]).toMatchObject({ state: "unconfirmed", checked: "cant_check", checkReason: "the host's latest is another message" });
  });

  test("a late acceptance for A settles only A's send, never another draft's words", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const a = drafts().idFor(ITHACA);
    drafts().edit(a, ITHACA, { text: "Ask Aeolus" });
    drafts().beginSend({ requestId: "req-a", draftId: a, sessionId: ITHACA, text: "Ask Aeolus", attachments: [], message: { type: "chat_message", text: "Ask Aeolus", sessionId: ITHACA, requestId: "req-a", source: "typed" } }, "Ask Aeolus");
    const b = drafts().idFor("odysseus-raft");
    drafts().edit(b, "odysseus-raft", { text: "Lash the beams" });
    ui.stores.chat.getState().setActiveSession("odysseus-raft");
    socket.deliver({ type: "session_info", sessionId: ITHACA, isNew: false, requestId: "req-a" });
    expect(drafts().sends["req-a"]?.state).toBe("accepted");
    expect(drafts().drafts[b]?.text).toBe("Lash the beams");
    expect(ui.stores.chat.getState().activeSessionId).toBe("odysseus-raft");
  });
});
