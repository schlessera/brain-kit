import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Draft } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { tracksFor, trackKey, stagedTrackViews } from "../src/lib/draft-tracks.ts";
import type { PendingAttachment } from "../src/lib/image-attachments.ts";

// The draft client (#951, D52 §5) against a small in-memory host that keeps
// #979's revision rules: If-Match, conflicts carrying the host's version,
// tombstones. What it proves is the client's side: only an acknowledged
// revision reads as saved, a refusal never overwrites what the reader has,
// and a silent host never gets a message twice. Odysseus fixtures only.

type Row = Draft & { deleted?: boolean };

// These are independent expectations, deliberately not imported from production.
const SAVE_PAUSE = 800;
const FIRST_RETRY = 2_000;
const RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
const nativeTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

type Operation = { held: boolean; done: Promise<void>; finish: () => void };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Only this file's registered JS timers move; native promises/body decoding run normally. */
function registeredClock() {
  const descriptors = Object.fromEntries(["setTimeout", "clearTimeout", "setInterval", "clearInterval"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)!]));
  const dateNow = Object.getOwnPropertyDescriptor(Date, "now")!;
  let now = Date.now();
  let sequence = 0;
  const timers = new Map<number, { at: number; delay: number; repeat: boolean; run: () => void }>();
  const events: { kind: "registered" | "cancelled" | "fired"; id: number; at: number; delay: number }[] = [];
  const register = (repeat: boolean) => (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = ++sequence;
    const normalized = Math.max(0, Number(delay) || 0);
    timers.set(id, { at: now + normalized, delay: normalized, repeat, run: () => callback(...args) });
    events.push({ kind: "registered", id, at: now, delay: normalized });
    return id;
  };
  const cancel = (id: number) => {
    const timer = timers.get(id);
    if (timer) events.push({ kind: "cancelled", id, at: now, delay: timer.delay });
    timers.delete(id);
  };
  for (const [key, value] of Object.entries({ setTimeout: register(false), setInterval: register(true), clearTimeout: cancel, clearInterval: cancel })) {
    Object.defineProperty(globalThis, key, { ...descriptors[key], value });
  }
  Object.defineProperty(Date, "now", { ...dateNow, value: () => now });
  const next = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  return {
    events,
    pending: () => [...timers.keys()],
    get now() { return now; },
    nextAt: () => next()?.[1].at,
    async advance(ms: number, allowHeld = false) {
      const end = now + ms;
      await settle(allowHeld);
      let count = 0;
      while (next() && next()![1].at <= end) {
        if (++count > 1_000) throw new Error("timer loop did not yield");
        const [id, timer] = next()!;
        now = timer.at;
        timers.delete(id);
        if (timer.repeat) timers.set(id, { ...timer, at: now + Math.max(1, timer.delay) });
        events.push({ kind: "fired", id, at: now, delay: timer.delay });
        timer.run();
        await settle(allowHeld);
      }
      now = end;
      await settle(allowHeld);
    },
    restore() {
      timers.clear();
      for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(globalThis, key, descriptor);
      Object.defineProperty(Date, "now", dateNow);
    },
  };
}

let clock: ReturnType<typeof registeredClock>;
const hosts: { settled(allowHeld?: boolean): Promise<void>; releaseAll(): void }[] = [];
/** Await every runnable request and native body, then its consumer's promise continuations.
 * A held request is allowed only at an explicit in-flight observation. It cannot
 * satisfy a completion barrier: release() awaits it, its body and any immediate
 * follow-up callbacks; future deadlines are advanced explicitly.
 */
async function settle(allowHeld = false): Promise<void> {
  await nativeTurn();
  for (const host of hosts) await host.settled(allowHeld);
  await nativeTurn();
}


function fakeHost() {
  const rows = new Map<string, Row>();
  const images = new Map<string, { draftId: string; mime: string; bytes: string; name: string | null }>();
  const calls: string[] = [];
  let down = false;
  let full = false;
  let losePut = false;
  let deleteHold: ReturnType<typeof deferred> | null = null;
  let deleteFailure = 0;
  let maxText = Infinity;
  let getHold: ReturnType<typeof deferred> | null = null;
  let slow: ReturnType<typeof deferred> | null = null;
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const pending = new Set<Operation>();
  const gates = new Set<ReturnType<typeof deferred>>();
  async function held(gate: ReturnType<typeof deferred>, operation: Operation) {
    operation.held = true;
    try { await gate.promise; } finally { operation.held = false; }
  }
  async function settled(allowHeld = false): Promise<void> {
    while (pending.size) {
      const runnable = [...pending].filter((operation) => !operation.held);
      if (!runnable.length) {
        if (allowHeld) return;
        throw new Error("completion barrier reached a held host response; release it explicitly");
      }
      await Promise.all(runnable.map((operation) => operation.done));
      // All fixture bodies are memory-backed Responses. No native IO is hidden
      // behind this turn: the actual request and json() promises finished above.
      await nativeTurn();
    }
  }
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const completion = deferred();
    const operation: Operation = { held: false, done: completion.promise, finish: completion.resolve };
    pending.add(operation);
    const finish = () => { pending.delete(operation); operation.finish(); };
    try {
      const response = await handle(operation, url, init);
      const json = response.json.bind(response);
      response.json = async () => {
        const completion = deferred();
        const body: Operation = { held: false, done: completion.promise, finish: completion.resolve };
        pending.add(body);
        try { return await json(); } finally { pending.delete(body); body.finish(); }
      };
      return response;
    } finally { finish(); }
  }

  async function handle(operation: Operation, url: string, init: RequestInit): Promise<Response> {
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
    if (method === "GET") {
      // The answer is what the host held when the read arrived, however late it lands.
      const now = rows.get(id);
      if (getHold) await held(getHold, operation);
      return now && !now.deleted ? json(now) : json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
    }
    if (method === "DELETE") {
      if (deleteHold) await held(deleteHold, operation);
      if (deleteFailure) { const status = deleteFailure; deleteFailure = 0; return json({ error: "unavailable" }, status); }
      if (!row) return json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      if (row.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if (ifMatch !== row.revision) return conflict(row);
      rows.set(id, { ...row, deleted: true, revision: row.revision + 1, text: "", attachments: [] });
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      if (slow) await held(slow, operation);
      const body = JSON.parse(String(init.body)) as { sessionId: string | null; text: string; attachmentIds: string[] };
      if (full && !row) return json({ error: "DRAFT_CAPACITY", message: "full", limit: 100, bound: "drafts" }, 507);
      if (body.text.length > maxText) return json({ error: "DRAFT_TOO_LARGE", message: "too large", limit: maxText, bound: "text" }, 413);
      if (row?.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if (row && ifMatch !== row.revision) return conflict(row);
      if (!row && ifMatch !== 0) return json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      const revision = (row?.revision ?? 0) + 1;
      const lose = losePut;
      losePut = false;
      rows.set(id, {
        draftId: id, sessionId: body.sessionId, revision, updatedAt: 9_000 + revision, text: body.text,
        attachments: body.attachmentIds.map((a) => ({ attachmentId: a, mime: images.get(a)!.mime as "image/png", bytes: images.get(a)!.bytes, name: null })),
      });
      // Stored, and the answer lost on the way back.
      if (lose) throw new TypeError("fetch failed");
      return json({ revision, updatedAt: 9_000 + revision });
    }
    return json({ error: "DRAFT_INVALID", message: "" }, 400);
  }
  const fixture = {
    rows, calls, request, settled,
    releaseAll: () => { for (const gate of gates) gate.resolve(); gates.clear(); },
    setDown: (value: boolean) => { down = value; },
    setFull: (value: boolean) => { full = value; },
    loseNextPut: () => { losePut = true; },
    failNextDelete: (status: number) => { deleteFailure = status; },
    holdDeletes: () => { const gate = deferred(); deleteHold = gate; gates.add(gate); return async () => { deleteHold = null; gates.delete(gate); gate.resolve(); await clock.advance(0); }; },
    setMaxText: (value: number) => { maxText = value; },
    /** Hold every draft read until the returned release is called. */
    holdGets: () => { const gate = deferred(); getHold = gate; gates.add(gate); return async () => { getHold = null; gates.delete(gate); gate.resolve(); await clock.advance(0); }; },
    /** Hold every save until the returned release is called. */
    hold: () => { const gate = deferred(); slow = gate; gates.add(gate); return async () => { slow = null; gates.delete(gate); gate.resolve(); await clock.advance(0); }; },
  };
  hosts.push(fixture);
  return fixture;
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
const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
const roots: BrainUiRoot[] = [];
beforeEach(() => { clock = registeredClock(); });
afterEach(async () => {
  try {
    // Dispose before releasing forgotten fixture gates so a failing assertion
    // cannot leak a late response into the next case.
    const failures: unknown[] = [];
    for (const r of roots.splice(0)) {
      try { r.dispose(); } catch (error) { failures.push(error); }
    }
    for (const host of hosts) host.releaseAll();
    await settle();
    expect(clock.pending(), "root disposal cancels every owned timer").toEqual([]);
    if (failures.length) throw new AggregateError(failures, "root disposal failed");
  } finally {
    hosts.splice(0);
    clock.restore();
    Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
  }
});

async function until(predicate: () => boolean, timeout = 5_000, allowHeld = false) {
  const end = clock.now + timeout;
  while (true) {
    await settle(allowHeld);
    if (predicate()) return;
    const next = clock.nextAt();
    if (next === undefined || next > end) throw new Error("condition never held before its logical deadline");
    await clock.advance(next - clock.now, allowHeld);
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
  test("host deletion refresh never uploads a rotated device-only transcript", async () => {
    const host = fakeHost(); const { drafts, socket } = boot(host);
    const id = drafts().idFor(ITHACA); drafts().edit(id, ITHACA, { text: "Inspect the fleet." });
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    const text = "Inspect the fleet.\nPenelope confirms the route.";
    drafts().edit(id, ITHACA, { text, deviceOnly: true }); await clock.advance(SAVE_PAUSE - 1);
    await clock.advance(1);
    await clock.advance(FIRST_RETRY + 1);
    const puts = host.calls.filter(c => c.startsWith("PUT"));
    host.rows.set(id, { ...host.rows.get(id)!, deleted: true, revision: 2 });
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await until(() => drafts().resolveId(id) !== id);
    const next = drafts().resolveId(id); await clock.advance(SAVE_PAUSE - 1);
    await clock.advance(1);
    await clock.advance(FIRST_RETRY + 1);
    expect(host.calls.filter(c => c.startsWith("PUT")), "rotation never automatically uploads the accepted transcript").toEqual(puts);
    expect(drafts().drafts[next]?.text).toBe(text);
    drafts().edit(next, null, { text: `${text} Bring the wax tablet.` });
    await until(() => host.rows.get(next)?.text === `${text} Bring the wax tablet.`);
  });

  test("explicit Send releases a local transcript draft's owed host cleanup", async () => {
    const host = fakeHost(); const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Penelope" });
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    const text = "Ask Penelope\nInspect the fleet.";
    drafts().edit(id, ITHACA, { text, deviceOnly: true });
    const before = host.calls.length; await clock.advance(SAVE_PAUSE - 1);
    await clock.advance(1);
    await clock.advance(FIRST_RETRY + 1);
    expect(host.calls.slice(before), "local transcript causes no host request").toEqual([]);
    drafts().beginSend({ requestId: "req-local-fleet", draftId: id, sessionId: ITHACA, text, attachments: [], message: { type: "chat_message", text, sessionId: ITHACA, requestId: "req-local-fleet", source: "typed" } }, text);
    drafts().accepted("req-local-fleet", ITHACA);
    await clock.advance(SAVE_PAUSE - 1);
    await clock.advance(1);
    await clock.advance(FIRST_RETRY + 1);
    expect(host.rows.get(id)?.deleted, "explicit Send cleans up the older saved host draft").toBe(true);
  });

  test("a host without the capability is never asked, and the draft says so", async () => {
    const host = fakeHost();
    const { drafts } = boot(host, { chatRequestAck: true });
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax" });
    await clock.advance(SAVE_PAUSE - 1);
    await clock.advance(1);
    await clock.advance(FIRST_RETRY + 1);
    expect(host.calls.filter((c) => c.startsWith("PUT") || c.startsWith("GET /drafts"))).toEqual([]);
    expect(drafts().supported).toBe(false);
  });

  test("saved only after the host acknowledged that revision; a newer edit is not saved", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    await settle(); // The hello's initial refresh has completed before typing.
    const id = drafts().idFor(ITHACA);
    const release = host.hold();
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax" });
    expect(drafts().drafts[id]?.host).toBeNull();
    expect(clock.events.at(-1)).toMatchObject({ kind: "registered", delay: SAVE_PAUSE });
    await clock.advance(SAVE_PAUSE - 1, true);
    expect(host.calls.filter((c) => c.startsWith("PUT")), "no save before the default pause").toEqual([]);
    await clock.advance(1, true);
    expect(host.calls.filter((c) => c.startsWith("PUT")), "save starts at the default deadline").toHaveLength(1);
    expect(drafts().drafts[id]?.host, "a started request is not an acknowledgement").toBeNull();
    await clock.advance(1, true);
    expect(drafts().drafts[id]?.host, "elapsed time cannot acknowledge a held response").toBeNull();
    await expect(settle()).rejects.toThrow("held host response");
    await release();
    await until(() => drafts().drafts[id]?.host?.revision === 1);
    expect(host.rows.get(id)).toMatchObject({ text: "Plug the ears with wax", sessionId: ITHACA, revision: 1 });
    expect(drafts().drafts[id]!.host!.edit).toBe(drafts().drafts[id]!.edit);
    const releaseNewer = host.hold();
    drafts().edit(id, ITHACA, { text: "Plug the ears with wax, and bind me" });
    expect(drafts().drafts[id]!.host!.edit).not.toBe(drafts().drafts[id]!.edit);
    await clock.advance(SAVE_PAUSE, true);
    expect(drafts().drafts[id]!.host!.edit, "the newer response is independently held").not.toBe(drafts().drafts[id]!.edit);
    await releaseNewer();
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
    await clock.advance(FIRST_RETRY - 1); await clock.advance(1); await clock.advance(1);
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
    await until(() => host.calls.includes(`PUT /drafts/${id}`), 5_000, true);
    drafts().edit(id, ITHACA, { text: "" });
    await release();
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
    await clock.advance(FIRST_RETRY - 1);
    expect(host.calls.filter((c) => c === "DELETE /drafts/d-gone")).toHaveLength(1);
    await clock.advance(1);
    expect(host.calls.filter((c) => c === "DELETE /drafts/d-gone"), "orphan retry fires at 2000 ms").toHaveLength(2);
    await clock.advance(1);
    expect(host.calls.filter((c) => c === "DELETE /drafts/d-gone"), "the next retry also backs off").toHaveLength(2);
  });
});

describe("stale answers", () => {
  test("a size refusal of an older edit does not block the shorter one typed since", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    host.setMaxText(10);
    const id = drafts().idFor(ITHACA);
    const release = host.hold();
    drafts().edit(id, ITHACA, { text: "Ask Aeolus for every wind in the bag" });
    await until(() => host.calls.includes(`PUT /drafts/${id}`), 5_000, true);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await release();
    await until(() => host.rows.get(id)?.text === "Ask Aeolus");
    expect(drafts().drafts[id]?.failure).toBeNull();
  });

  test("a read begun before this page's send consumed the draft does not bring it back", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => host.rows.get(id)?.revision === 1);
    // Another device saved a newer revision; a list starts a read of it.
    host.rows.set(id, { ...host.rows.get(id)!, revision: 2, text: "Ask Aeolus, from the phone" });
    const release = host.holdGets();
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await until(() => host.calls.includes(`GET /drafts/${id}`), 5_000, true);
    // Meanwhile the host accepts a send of it and deletes it.
    drafts().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Ask Aeolus", attachments: [], message: { type: "chat_message", text: "Ask Aeolus", sessionId: ITHACA, requestId: "req-1", source: "typed" } }, "Ask Aeolus");
    socket.deliver({ type: "status", status: "queued", sessionId: ITHACA, requestId: "req-1" });
    host.rows.set(id, { ...host.rows.get(id)!, deleted: true });
    await release();
    await clock.advance(200);
    expect(Object.values(drafts().drafts).some((d) => d.text === "Ask Aeolus, from the phone"), "the stale read restores nothing").toBe(false);
  });
});

describe("restoring, continued", () => {
  test("a session's draft replaced on another device is restored as itself", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const a = drafts().idFor(ITHACA);
    drafts().edit(a, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[a]?.host?.revision === 1);
    // The other device sent A and started B for the same session.
    host.rows.set(a, { ...host.rows.get(a)!, deleted: true });
    host.rows.set("d-b", { draftId: "d-b", sessionId: ITHACA, revision: 1, updatedAt: 5, text: "Ask Hermes", attachments: [] });
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await until(() => drafts().drafts["d-b"] !== undefined);
    expect(drafts().drafts[drafts().idFor(ITHACA)]).toMatchObject({ draftId: "d-b", text: "Ask Hermes", conflict: null });
  });
});

describe("uncertain answers", () => {
  test("a draft emptied after a save whose answer was lost is deleted on the host, not brought back", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    host.loseNextPut();
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.uncertain === true);
    expect(host.rows.get(id)?.revision, "the host stored it").toBe(1);
    drafts().edit(id, ITHACA, { text: "" });
    await until(() => host.rows.get(id)?.deleted === true);
    expect(drafts().drafts[id]).toBeUndefined();
  });

  test("a list that got no answer is asked again", async () => {
    const host = fakeHost();
    host.rows.set("d-letter", { draftId: "d-letter", sessionId: null, revision: 1, updatedAt: 2, text: "Letter to Penelope", attachments: [] });
    host.setDown(true);
    const { drafts } = boot(host);
    await clock.advance(100);
    expect(drafts().drafts["d-letter"]).toBeUndefined();
    host.setDown(false);
    await until(() => drafts().drafts["d-letter"]?.text === "Letter to Penelope", 5_000);
  });

  test("a host too old to send a hello keeps no drafts, and the line says so", async () => {
    globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
    const host = fakeHost();
    const ui = createBrainUiRoot({ storage: null, request: host.request, config: { backendUrl: "https://ithaca-harbour.example" } });
    roots.push(ui);
    ui.connection.connect();
    const socket = FixtureSocket.last!;
    socket.open();
    socket.deliver({ type: "status", status: "idle" });
    expect(ui.stores.drafts.getState().supported).toBe(false);
  });
});

describe("orphans, continued", () => {
  test("a read begun before the reader's choice deleted the other draft does not raise the conflict again", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const mine = drafts().idFor(ITHACA);
    drafts().edit(mine, ITHACA, { text: "Typed here" });
    await until(() => drafts().drafts[mine]?.host?.revision === 1);
    host.rows.set("d-other", { draftId: "d-other", sessionId: ITHACA, revision: 1, updatedAt: 5, text: "Typed on the phone", attachments: [] });
    const hello = () => socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    hello();
    await until(() => drafts().drafts[mine]?.conflict !== null);
    // Another list starts a read of the other draft; the reader keeps theirs meanwhile.
    const release = host.holdGets();
    const reads = host.calls.filter((c) => c === "GET /drafts/d-other").length;
    hello();
    await until(() => host.calls.filter((c) => c === "GET /drafts/d-other").length > reads, 5_000, true);
    drafts().resolve(mine, "mine");
    await until(() => host.rows.get("d-other")?.deleted === true, 5_000, true);
    await release();
    await clock.advance(200);
    expect(drafts().drafts[mine]?.conflict, "the choice stands").toBeNull();
  });
});

describe("uncertain answers, continued", () => {
  test("an emptied draft whose lost save another device has edited since is a conflict, not a delete", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    host.loseNextPut();
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.uncertain === true);
    host.rows.set(id, { ...host.rows.get(id)!, revision: 2, text: "Ask Aeolus, from the phone" });
    drafts().edit(id, ITHACA, { text: "" });
    await until(() => drafts().drafts[id]?.conflict !== null && drafts().drafts[id]?.conflict !== undefined);
    expect(host.rows.get(id)?.deleted, "the other device's words survive").toBeUndefined();
    expect(drafts().drafts[id]!.conflict!.other.text).toBe("Ask Aeolus, from the phone");
  });

  test("Send again moves the session's unconfirmed tracker to the new request", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    drafts().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Ask Aeolus", attachments: [], message: { type: "chat_message", text: "Ask Aeolus", sessionId: ITHACA, requestId: "req-1", source: "typed" } }, "Ask Aeolus");
    socket.close();
    await until(() => drafts().sends["req-1"]?.state === "unconfirmed");
    ui.stores.trackers.getState().track(ITHACA, { unconfirmedRequestId: "req-1", onlyUnconfirmed: true });
    ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    next.open();
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } });
    expect(ui.connection.drafts.resend("req-1")).toBe(true);
    const sent = next.frames("chat_message").at(-1)!;
    expect(ui.stores.trackers.getState().unconfirmed[ITHACA]).toBe(sent.requestId);
  });
});

describe("late answers", () => {
  test("a first message that fails before any session exists gives its words back", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const first = drafts().fresh;
    drafts().edit(first, null, { text: "Which harbour?" });
    drafts().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: { type: "chat_message", text: "Which harbour?", requestId: "req-1", source: "typed" } }, "Which harbour?");
    socket.deliver({ type: "error", code: "agent_error", message: "failed", requestId: "req-1", turnId: "t-1" });
    expect(drafts().sends["req-1"]?.state).toBe("refused");
    expect(drafts().drafts[first]?.text).toBe("Which harbour?");
  });

  test("a list taken while the reader's discarded version is being deleted does not raise it again", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const mine = drafts().idFor(ITHACA);
    drafts().edit(mine, ITHACA, { text: "Typed here" });
    await until(() => drafts().drafts[mine]?.host?.revision === 1);
    host.rows.set("d-other", { draftId: "d-other", sessionId: ITHACA, revision: 1, updatedAt: 5, text: "Typed on the phone", attachments: [] });
    const hello = () => socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    hello();
    await until(() => drafts().drafts[mine]?.conflict !== null);
    const release = host.holdDeletes();
    drafts().resolve(mine, "mine");
    await until(() => host.calls.includes("DELETE /drafts/d-other"), 5_000, true);
    const lists = host.calls.filter((c) => c === "GET /drafts").length;
    hello();
    await until(() => host.calls.filter((c) => c === "GET /drafts").length > lists, 5_000, true);
    await clock.advance(100, true);
    await release();
    await until(() => host.rows.get("d-other")?.deleted === true);
    await clock.advance(100);
    expect(drafts().drafts[mine]?.conflict, "the choice stands").toBeNull();
  });
});

describe("orphans, retried", () => {
  test("an orphan delete refused by a briefly unavailable host is tried again", async () => {
    const host = fakeHost();
    const { ui } = boot(host);
    host.rows.set("d-gone", { draftId: "d-gone", sessionId: null, revision: 3, updatedAt: 1, text: "Old", attachments: [] });
    host.failNextDelete(503);
    ui.stores.drafts.setState((s) => ({ orphans: [...s.orphans, { draftId: "d-gone", revision: 3 }] }));
    await until(() => host.rows.get("d-gone")?.deleted === true, 5_000);
  });
});

describe("capacity", () => {
  test("a send that consumes a saved draft frees a place for one refused as full", async () => {
    const host = fakeHost();
    const { socket, drafts } = boot(host);
    const sent = drafts().idFor("odysseus-raft");
    drafts().edit(sent, "odysseus-raft", { text: "Lash the beams" });
    await until(() => host.rows.get(sent)?.revision === 1);
    host.setFull(true);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await until(() => drafts().drafts[id]?.failure?.kind === "full");
    host.setFull(false);
    const ref = drafts().beginSend({ requestId: "req-raft", draftId: sent, sessionId: "odysseus-raft", text: "Lash the beams", attachments: [], message: { type: "chat_message", text: "Lash the beams", sessionId: "odysseus-raft", requestId: "req-raft", source: "typed" } }, "Lash the beams");
    expect(ref).toEqual({ draftId: sent, revision: 1 });
    socket.deliver({ type: "status", status: "queued", sessionId: "odysseus-raft", requestId: "req-raft" });
    await until(() => host.rows.get(id)?.revision === 1, 4_000);
  });
});

describe("restoring", () => {
  test("a hello lists the host's drafts and restores them; a dirty one is never overwritten", async () => {
    const host = fakeHost();
    host.rows.set("d-raft", { draftId: "d-raft", sessionId: "odysseus-raft", revision: 4, updatedAt: 1, text: "Lash the beams", attachments: [] });
    host.rows.set("d-letter", { draftId: "d-letter", sessionId: null, revision: 1, updatedAt: 2, text: "Letter to Penelope", attachments: [] });
    const { socket, drafts } = boot(host);
    await until(() => Object.keys(drafts().drafts).length === 2);
    expect(drafts().drafts[drafts().idFor("odysseus-raft")]?.text).toBe("Lash the beams");
    expect(drafts().drafts["d-letter"]).toMatchObject({ text: "Letter to Penelope", sessionId: null });
    drafts().edit("d-raft", "odysseus-raft", { text: "Keep the reader's rope" });
    host.rows.set("d-raft", { ...host.rows.get("d-raft")!, revision: 5, text: "The phone's rope" });
    const reads = host.calls.filter((c) => c === "GET /drafts/d-raft").length;
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await until(() => host.calls.filter((c) => c === "GET /drafts/d-raft").length > reads);
    await clock.advance(100);
    expect(drafts().drafts["d-raft"]?.text, "a host refresh never overwrites dirty words").toBe("Keep the reader's rope");
    expect(drafts().drafts["d-raft"]?.conflict?.other.text).toBe("The phone's rope");
  });
});

describe("sends", () => {
  test("the socket closing before acceptance holds the send for review, and nothing is sent again", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const id = drafts().idFor(ITHACA);
    ui.stores.chat.getState().setActiveSession(ITHACA);
    // Its history is here: a send into a session still restoring is refused (#1328).
    ui.connection.handleServerMessage({ type: "session_history", sessionId: ITHACA, messages: [] });
    drafts().edit(id, ITHACA, { text: "Ask Aeolus for the west wind" });
    const chat = ui.stores.chat.getState();
    chat.addUserMessage(ITHACA, "Ask Aeolus for the west wind", "typed", undefined, { requestId: "req-1" });
    chat.startAssistantMessage(ITHACA, undefined, "req-1");
    drafts().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Ask Aeolus for the west wind", attachments: [], message: { type: "chat_message", text: "Ask Aeolus for the west wind", sessionId: ITHACA, requestId: "req-1", source: "typed" } }, "Ask Aeolus for the west wind");
    socket.close();
    await until(() => drafts().sends["req-1"]?.state === "unconfirmed");
    // Its optimistic rows leave the transcript; the review block stands in.
    expect(ui.stores.chat.getState().buffers[ITHACA]!.messages.some((m) => m.requestId === "req-1")).toBe(false);
    await clock.advance(500);
    expect(socket.frames("chat_message")).toHaveLength(0);
    // A new socket: still nothing, until Send again.
    ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    next.open();
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await clock.advance(FIRST_RETRY + 1);
    expect(next.frames("chat_message")).toHaveLength(0);
    expect(ui.connection.drafts.resend("req-1")).toBe(true);
    const sent = next.frames("chat_message");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Ask Aeolus for the west wind");
    expect(sent[0].requestId).not.toBe("req-1");
  });

  test("acceptance moves the retained new-chat branch's later staged tracks to its own conversation", () => {
    const { ui, socket, drafts } = boot(fakeHost(), { chatRequestAck: true });
    const id = drafts().fresh;
    drafts().edit(id, null, { text: "Ask about the harbour." });
    drafts().beginSend({ requestId: "req-tracks", draftId: id, sessionId: null, text: "Ask about the harbour.", attachments: [],
      message: { type: "chat_message", requestId: "req-tracks", text: "Ask about the harbour." } }, "Ask about the harbour.");
    drafts().edit(id, null, { text: "Also compare the route." });
    const queue = tracksFor(ui, trackKey(null, drafts().originOf(id))).uploads;
    queue.setOnline(false);
    expect(queue.add([new File(['{"type":"LineString","coordinates":[[20.71,38.31],[20.72,38.31]]}'], "ithaca.gpx", { type: "application/octet-stream" })])).toEqual([]);
    drafts().keepDeviceBranch(id, "odysseus-branch", { draftId: id, sessionId: null, text: "Penelope keeps the original.", attachments: [], editedAt: 1, host: null }, null);
    socket.deliver({ type: "status", status: "queued", sessionId: ITHACA, requestId: "req-tracks" });
    expect(stagedTrackViews(ui), "acceptance moves the branch's nonempty staged queue using the send's editable target").toMatchObject([{ key: `session:${ITHACA}`, count: 1 }]);
    expect(tracksFor(ui, trackKey(null, drafts().originOf(id))).uploads.files).toHaveLength(0);
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
    // Its own words are the pending entry again, not the host's summary.
    expect(ui.stores.followUp.getState().local[ITHACA]?.map((l) => l.text)).toEqual(["Ask Aeolus"]);
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

  test("Send again for A's held first message never takes B's new chat transcript or announcement", async () => {
    const host = fakeHost();
    const { ui, socket, drafts } = boot(host);
    const chat = () => ui.stores.chat.getState();
    const firstSend = (text: string, rid: string) => {
      const id = drafts().fresh;
      drafts().edit(id, null, { text });
      chat().addUserMessage(null, text, "typed", undefined, { requestId: rid });
      chat().startAssistantMessage(null, undefined, rid);
      const correlation = chat().startDraftTurn();
      drafts().beginSend({ requestId: rid, draftId: id, sessionId: null, text, attachments: [], message: { type: "chat_message", text, requestId: rid, source: "typed" } }, text);
      return { id, correlation };
    };
    firstSend("Which harbour?", "req-a");
    socket.close();
    await until(() => drafts().sends["req-a"]?.state === "unconfirmed");
    ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    next.open();
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } });
    chat().clearMessages();
    const b = firstSend("Letter to Penelope", "req-b");
    expect(ui.connection.drafts.resend("req-a")).toBe(true);
    const resent = next.frames("chat_message").at(-1)!;
    next.deliver({ type: "session_info", sessionId: "odysseus-letter", isNew: true, requestId: "req-b", draftId: b.correlation });
    next.deliver({ type: "session_info", sessionId: "odysseus-harbour", isNew: true, requestId: resent.requestId, draftId: resent.draftId });
    const users = (key: string) => chat().buffers[key]?.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users("odysseus-harbour"), "A's session holds only A's message").toEqual(["Which harbour?"]);
    expect(users("odysseus-letter"), "B's session holds only B's message").toEqual(["Letter to Penelope"]);
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


test("a late host save cannot acknowledge the retained original after a device fork", async () => {
  const host = fakeHost();
  const { drafts } = boot(host);
  const original = drafts().idFor(ITHACA);
  const release = host.hold();
  drafts().edit(original, ITHACA, { text: "Odysseus surveys the fleet" });
  await until(() => host.calls.includes(`PUT /drafts/${original}`), 5_000, true);
  drafts().setSupport(false);
  drafts().edit(original, ITHACA, { text: "Telemachus checks the harbour" });
  drafts().keepDeviceBranch(original, "voyage-branch", { draftId: original, sessionId: ITHACA, text: "Penelope keeps the newer weave", attachments: [], editedAt: 2, host: null }, ITHACA);
  await release();
  await until(() => host.rows.has(original));
  await clock.advance(20);
  expect(drafts().drafts[original]!.host, "the old save cannot acknowledge another tab's replacement text").toBeNull();
  drafts().hostGone(original);
  expect(Object.values(drafts().drafts).some((d) => d.text === "Penelope keeps the newer weave"), "host consumption cannot discard the retained original").toBe(true);
});


test("a late host delete cannot rotate the retained original after a device fork", async () => {
  const host = fakeHost();
  const { drafts } = boot(host);
  const original = drafts().idFor(ITHACA);
  drafts().edit(original, ITHACA, { text: "Odysseus surveys the fleet" });
  await until(() => drafts().drafts[original]?.host?.revision === 1);
  const release = host.holdDeletes();
  drafts().edit(original, ITHACA, { text: "" });
  await until(() => host.calls.includes(`DELETE /drafts/${original}`), 5_000, true);
  drafts().setSupport(false);
  drafts().edit(original, ITHACA, { text: "Telemachus checks the harbour" });
  drafts().keepDeviceBranch(original, "voyage-branch", { draftId: original, sessionId: ITHACA, text: "Penelope keeps the newer weave", attachments: [], editedAt: 2, host: null }, ITHACA);
  await release();
  await until(() => host.rows.get(original)?.deleted === true);
  await clock.advance(20);
  expect(drafts().drafts[original]?.text, "an old host delete preserves the retained original identity").toBe("Penelope keeps the newer weave");
});


test("a delayed host save is fenced even when its predecessor rotated before the device fork", async () => {
  const host = fakeHost();
  const { drafts } = boot(host);
  const original = drafts().fresh;
  host.rows.set(original, { draftId: original, sessionId: null, revision: 1, text: "Inspect the fleet.", attachments: [], updatedAt: 1 });
  drafts().restoreLocal([{ draftId: original, sessionId: null, text: "Inspect the fleet.", attachments: [], editedAt: 1,
    host: { revision: 1, sessionId: null, updatedAt: 1, clean: true } }]);
  const release = host.hold();
  drafts().edit(original, null, { text: "Telemachus checks the harbour." });
  await until(() => host.calls.includes(`PUT /drafts/${original}`), 5_000, true);
  drafts().beginSend({ requestId: "voyage-rotated", draftId: original, sessionId: null, text: "Telemachus checks the harbour.", attachments: [],
    message: { type: "chat_message", requestId: "voyage-rotated", text: "Telemachus checks the harbour." } }, "Telemachus checks the harbour.");
  drafts().edit(original, null, { text: "Bring the oars." });
  drafts().accepted("voyage-rotated", "pylos");
  expect(drafts().drafts[original], "the predecessor is retired before fork completion").toBeUndefined();
  drafts().setSupport(false);
  drafts().keepDeviceBranch(original, "voyage-branch", { draftId: original, sessionId: null, text: "Penelope keeps the newer weave.", attachments: [], editedAt: 2,
    host: { revision: 1, sessionId: null, updatedAt: 1, clean: false } }, null);
  drafts().openDeviceVersion(original);
  const image: PendingAttachment = { attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" }, previewUrl: "blob:fixture/shroud", bytes: 8, name: "shroud.png" };
  drafts().edit(original, null, { text: "Penelope keeps the newer weave. Inspect the shroud.", attachments: [image] });
  await release();
  await until(() => host.rows.get(original)?.revision === 2);
  await clock.advance(20);
  expect(drafts().drafts[original]?.host?.edit, "the retired predecessor's reply cannot acknowledge the restored original's different text and images").not.toBe(drafts().drafts[original]!.edit);
  drafts().hostGone(original);
  expect(Object.values(drafts().drafts), "a missing-host refresh preserves the newer restored original's editable content").toContainEqual(expect.objectContaining({ text: "Penelope keeps the newer weave. Inspect the shroud.", attachments: [image] }));
});


test("a late host save cannot acknowledge an adopted additional device owner", async () => {
  const host = fakeHost();
  const { drafts } = boot(host);
  const original = drafts().idFor(ITHACA);
  const release = host.hold();
  drafts().edit(original, ITHACA, { text: "Odysseus surveys the fleet." });
  await until(() => host.calls.includes(`PUT /drafts/${original}`), 5_000, true);
  drafts().setSupport(false);
  const image: PendingAttachment = { attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" }, previewUrl: "blob:fixture/shroud", bytes: 8, name: "shroud.png" };
  drafts().adoptDeviceRecord({draftId:original,sessionId:ITHACA,text:"Penelope keeps the additional committed chart.",attachments:[image],editedAt:2,host:null});
  await release(); await until(() => host.rows.has(original)); await clock.advance(20);
  expect(drafts().drafts[original]?.host,"an old reply cannot acknowledge an additional owner's newly adopted text and images").toBeNull();
  drafts().hostGone(original);
  expect(Object.values(drafts().drafts)).toContainEqual(expect.objectContaining({text:"Penelope keeps the additional committed chart.",attachments:[image]}));
});


test("a late host save cannot acknowledge an explicitly opened newer device version", async () => {
  const host = fakeHost(); const { drafts } = boot(host);
  const original = drafts().idFor(ITHACA);
  drafts().edit(original, ITHACA, {text:"Odysseus checks the fleet."});
  drafts().keepDeviceBranch(original,"voyage-branch",{draftId:original,sessionId:ITHACA,text:"Penelope keeps the loom order.",attachments:[],editedAt:1,host:null},ITHACA);
  const release = host.hold();
  await until(()=>host.calls.includes(`PUT /drafts/${original}`), 5_000, true);
  drafts().setSupport(false);
  const image: PendingAttachment = {attachment:{data:"iVBORw0KGgo=",mediaType:"image/png"},previewUrl:"blob:fixture/shroud",bytes:8,name:"shroud.png"};
  drafts().openDeviceVersion(original,{draftId:original,sessionId:ITHACA,text:"Telemachus updates the device chart.",attachments:[image],editedAt:2,host:null});
  await release(); await until(()=>host.rows.has(original)); await clock.advance(20);
  expect(drafts().drafts[original]?.host,"an old reply cannot acknowledge an explicitly adopted version's different text and images").toBeNull();
  drafts().hostGone(original);
  expect(Object.values(drafts().drafts),"missing-host refresh preserves explicitly adopted work").toContainEqual(expect.objectContaining({text:"Telemachus updates the device chart.",attachments:[image]}));
});


describe("registered draft deadlines", () => {
  test("typing resets the default save pause and cancels the previous callback", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    await settle();
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Inspect the fleet" });
    const first = clock.events.at(-1)!;
    expect(first).toMatchObject({ kind: "registered", delay: 800 });
    await clock.advance(799);
    drafts().edit(id, ITHACA, { text: "Inspect the fleet at dawn" });
    const replacement = clock.events.at(-1)!;
    expect(replacement).toMatchObject({ kind: "registered", delay: 800, at: first.at + 799 });
    expect(clock.events, "the old callback was actually cancelled").toContainEqual({ kind: "cancelled", id: first.id, at: first.at + 799, delay: 800 });
    await clock.advance(1);
    expect(host.calls.filter((c) => c.startsWith("PUT")), "the retired deadline cannot save the new edit early").toEqual([]);
    await clock.advance(798);
    expect(host.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    await clock.advance(1);
    expect(host.rows.get(id)).toMatchObject({ text: "Inspect the fleet at dawn", revision: 1 });
    expect(clock.events).toContainEqual({ kind: "fired", id: replacement.id, at: replacement.at + 800, delay: 800 });
    await clock.advance(1);
    expect(host.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
  });

  test("save failures follow every default backoff and stop retrying after acknowledgement", async () => {
    const host = fakeHost();
    const { drafts } = boot(host);
    await settle();
    host.setDown(true);
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Ask Aeolus" });
    await clock.advance(800);
    let calls = 1;
    const puts = () => host.calls.filter((c) => c === `PUT /drafts/${id}`).length;
    expect(puts()).toBe(calls);
    // The final repeated 60s entry proves the cap as well as every independent default.
    for (const delay of [...RETRY_DELAYS, 60_000]) {
      expect(clock.events.filter((event) => event.kind === "registered" && event.delay === delay).length).toBeGreaterThan(0);
      await clock.advance(delay - 1);
      expect(puts(), `no retry before ${delay} ms`).toBe(calls);
      await clock.advance(1);
      expect(puts(), `retry at ${delay} ms`).toBe(++calls);
    }
    host.setDown(false);
    await clock.advance(60_000);
    expect(puts()).toBe(++calls);
    expect(drafts().drafts[id]?.host?.revision).toBe(1);
    await clock.advance(60_001);
    expect(puts(), "an acknowledged revision does not retry again").toBe(calls);
  });

  test("disposing cancels registered save and orphan retry callbacks", async () => {
    const host = fakeHost();
    const { ui, drafts } = boot(host);
    await settle();
    const id = drafts().idFor(ITHACA);
    drafts().edit(id, ITHACA, { text: "Inspect the fleet" });
    const save = clock.events.at(-1)!;
    host.failNextDelete(503);
    ui.stores.drafts.setState((state) => ({ orphans: [...state.orphans, { draftId: "d-gone", revision: 3 }] }));
    await settle();
    const retry = clock.events.at(-1)!;
    expect(save).toMatchObject({ kind: "registered", delay: 800 });
    expect(retry).toMatchObject({ kind: "registered", delay: 2_000 });
    ui.dispose();
    roots.splice(roots.indexOf(ui), 1);
    for (const timer of [save, retry]) expect(clock.events).toContainEqual({ kind: "cancelled", id: timer.id, at: clock.now, delay: timer.delay });
    const calls = [...host.calls];
    await clock.advance(60_001);
    expect(host.calls, "disposed timers cannot issue later requests").toEqual(calls);
  });
});
