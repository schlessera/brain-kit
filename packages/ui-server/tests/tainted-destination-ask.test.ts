/**
 * A tainted interactive session asks before reaching a destination outside
 * its taint allow-list (#3430). Every case runs the real turn proxy on
 * loopback with a permission bridge double at `requestPermission`, the
 * lowest request method every host's card goes through.
 */
import { expect, test } from "bun:test";
import { request } from "node:http";
import { connect } from "node:net";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events.js";
import { prepareTurnEgress, taintedDestinationDescription } from "../src/brain/turn-egress.js";

function get(socketPath: string, target: string): Promise<{ status: number; statusText: string; body: string }> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => {
      let body = ""; response.on("data", bytes => body += bytes);
      response.once("end", () => resolve({ status: response.statusCode!, statusText: response.statusMessage ?? "", body }));
      response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}
function tunnel(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; if (text.startsWith("HTTP/1.1 200")) socket.destroy(); });
    socket.on("close", () => resolve(text)); socket.on("error", reject);
  });
}

/** A session that fetched a web page earlier, and one host its proxy already reached. */
function taintedSession() {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
  recordGovernanceEvent(db, { kind: "taint", turnId: "turn-suitors", sessionId: "ithaca", actor: "interactive", model: null, profile: "governed",
    payload: { source: "web_fetch", tool: "WebFetch", detail: "https://suitors.example/letter" } });
  return db;
}
interface Asks { requests: PermissionRequest[]; answer(decision: PermissionDecision): void; asked: Promise<void> }
/** A bridge whose cards wait until the test answers them, in order. */
function cards(): { bridge: BackendBridge; asks: Asks } {
  const requests: PermissionRequest[] = [], waiting: Array<(decision: PermissionDecision) => void> = [];
  let notify: () => void = () => {};
  const asks: Asks = { requests, answer: decision => waiting.shift()?.(decision), asked: new Promise(resolve => { notify = resolve; }) };
  const bridge = { emit() {}, requestPermission: (request: PermissionRequest) => {
    requests.push(request);
    const pending = new Promise<PermissionDecision>(resolve => waiting.push(resolve));
    notify(); asks.asked = new Promise(resolve => { notify = resolve; });
    return pending;
  } } as unknown as BackendBridge;
  return { bridge, asks };
}
/** The card for `pending`, or a named failure when the connection settles without one (the pre-#3430 refusal). */
async function raised(asks: Asks, pending: Promise<unknown>): Promise<void> {
  const settled = pending.then(() => "settled" as const, () => "settled" as const);
  const outcome = await Promise.race([asks.asked.then(() => "asked" as const), settled]);
  expect(outcome, "TAINTED_ASK_CARD_RAISED").toBe("asked");
}
const turn = (db: ReturnType<typeof createUiDb>, bridge: BackendBridge, options: { turnId?: string; origin?: "interactive" | "voice"; policy?: GovernancePolicyInput; controller?: AbortController } = {}) =>
  prepareTurnEgress({ controller: options.controller ?? new AbortController(), policy: resolveGovernancePolicy(options.policy ?? { schema_version: 1 }),
    turnId: options.turnId ?? "turn-island", sessionId: () => "ithaca", model: () => "claude-haiku-4-5", profile: "governed",
    origin: options.origin ?? "interactive", bridge, record: event => recordGovernanceEvent(db, event), governanceDb: db });
const events = (db: ReturnType<typeof createUiDb>, kind: "egress_connection" | "egress_denial") =>
  queryGovernanceEvents(db, { sessionId: "ithaca", kinds: [kind], limit: 20 }).map(event => event.payload as Record<string, unknown>);

test("a tainted interactive session asks before a new host, naming it and the taint source; allowing admits and records it", async () => {
  const db = taintedSession(); let calls = 0;
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { calls++; return new Response("Aeaea"); } });
  const { bridge, asks } = cards();
  const proxy = await turn(db, bridge);
  try {
    const response = get(proxy.socketPath, island.url.href);
    await raised(asks, response);
    expect(calls, "TAINTED_ASK_WAITS_FOR_CARD").toBe(0);
    expect(asks.requests).toHaveLength(1);
    expect(asks.requests[0], "TAINTED_ASK_CARD_NAMES_DESTINATION_AND_SOURCE").toMatchObject({ toolName: "Network", kind: "command",
      input: { host: "127.0.0.2", port: island.port, method: "GET", target: `127.0.0.2:${island.port}` },
      description: taintedDestinationDescription({ host: "127.0.0.2", port: island.port!, method: "GET" }, "web_fetch") });
    expect(asks.requests[0]!.description).toContain("fetched a web page");
    asks.answer({ behavior: "allow" });
    expect((await response).status, "TAINTED_ASK_ALLOW_ADMITS").toBe(200);
    expect(calls).toBe(1);
    proxy.stop();
    expect(events(db, "egress_connection"), "TAINTED_ASK_ALLOW_RECORDS_CONNECTION").toMatchObject([{ host: "127.0.0.2", port: island.port, outcome: "completed" }]);
    expect(events(db, "egress_denial")).toEqual([]);
  } finally { asks.answer({ behavior: "deny", message: "Fixture cleanup" }); proxy.stop(); island.stop(true); db.close(); }
});

test("declining refuses with a reason the tool sees, records the denial and contacts nothing", async () => {
  const db = taintedSession(); let calls = 0;
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { calls++; return new Response("Aeaea"); } });
  const { bridge, asks } = cards();
  const proxy = await turn(db, bridge);
  try {
    const response = get(proxy.socketPath, island.url.href);
    await raised(asks, response); asks.answer({ behavior: "deny", message: "Penelope declines" });
    const refused = await response;
    expect(refused.status, "TAINTED_ASK_DENY_REFUSES").toBe(403);
    expect(refused.statusText, "TAINTED_ASK_DENY_STATUS_TEXT").toBe("Forbidden - declined by the user");
    expect(refused.body, "TAINTED_ASK_DENY_REASON_VISIBLE").toContain("the user declined the connection");
    const connecting = tunnel(proxy.socketPath, `127.0.0.2:${island.port}`);
    await raised(asks, connecting); asks.answer({ behavior: "deny", message: "Penelope declines" });
    const head = await connecting;
    expect(head, "TAINTED_ASK_DENY_CONNECT_REASON_VISIBLE").toStartWith("HTTP/1.1 403 Forbidden - declined by the user\r\n");
    expect(head).toContain("the user declined the connection");
    expect(calls).toBe(0);
    proxy.stop();
    expect(events(db, "egress_denial"), "TAINTED_ASK_DENY_RECORDED").toEqual([
      { host: "127.0.0.2", port: island.port, method: "GET", reason: "taint_allowlist", bytes: 0 },
      { host: "127.0.0.2", port: island.port, method: "CONNECT", reason: "taint_allowlist", bytes: 0 }]);
  } finally { asks.answer({ behavior: "deny", message: "Fixture cleanup" }); proxy.stop(); island.stop(true); db.close(); }
});

test("an allowed host stays admitted for the rest of the session without asking; a different host still asks", async () => {
  const db = taintedSession();
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("Aeaea") });
  const harbour = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("Ithaca") });
  const { bridge, asks } = cards();
  try {
    const first = await turn(db, bridge, { turnId: "turn-aeaea" });
    const response = get(first.socketPath, island.url.href);
    await raised(asks, response); asks.answer({ behavior: "allow" });
    expect((await response).status).toBe(200);
    expect((await get(first.socketPath, island.url.href)).status, "TAINTED_GRANT_SAME_TURN").toBe(200);
    first.stop();
    const second = await turn(db, bridge, { turnId: "turn-return" });
    try {
      expect((await get(second.socketPath, island.url.href)).status, "TAINTED_GRANT_LATER_TURN").toBe(200);
      expect(asks.requests, "TAINTED_GRANT_ASKS_ONCE").toHaveLength(1);
      const other = get(second.socketPath, harbour.url.href);
      await raised(asks, other);
      expect(asks.requests.at(-1)?.input, "TAINTED_GRANT_IS_PER_HOST").toMatchObject({ host: "127.0.0.3" });
      asks.answer({ behavior: "deny", message: "Not this one" });
      expect((await other).status).toBe(403);
    } finally { second.stop(); }
  } finally { asks.answer({ behavior: "deny", message: "Fixture cleanup" }); island.stop(true); harbour.stop(true); db.close(); }
});

test("concurrent connections to the same new host share one card", async () => {
  const db = taintedSession();
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("Aeaea") });
  const { bridge, asks } = cards();
  const proxy = await turn(db, bridge);
  try {
    const both = [get(proxy.socketPath, island.url.href), get(proxy.socketPath, `${island.url.href}again`)];
    await raised(asks, Promise.all(both));
    // Negative window, kept real time: nothing outside the proxy marks the
    // second connection reaching the shared card, and the bridge double sees
    // only cards, the action under test. 50 ms lets its loopback request
    // reach admission and raise a second card if the host does not share it.
    await Bun.sleep(50);
    expect(asks.requests, "TAINTED_ASK_ONE_CARD_PER_HOST").toHaveLength(1);
    asks.answer({ behavior: "allow" });
    expect((await Promise.all(both)).map(result => result.status)).toEqual([200, 200]);
  } finally { asks.answer({ behavior: "deny", message: "Fixture cleanup" }); proxy.stop(); island.stop(true); db.close(); }
});

test("voice refuses a narrowed host without a card, as before", async () => {
  const db = taintedSession(); let calls = 0;
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { calls++; return new Response("Aeaea"); } });
  // A bridge that would allow at once: only the missing grant surface can refuse.
  const asks: PermissionRequest[] = [];
  const bridge = { emit() {}, requestPermission: async (request: PermissionRequest) => { asks.push(request); return { behavior: "allow" }; } } as unknown as BackendBridge;
  const proxy = await turn(db, bridge, { origin: "voice" });
  try {
    const refused = await get(proxy.socketPath, island.url.href);
    expect(refused.status, "TAINTED_VOICE_REFUSES").toBe(403);
    // The tool learns taint was the cause, which source and what the user can do (#3431).
    expect(refused.statusText, "TAINTED_VOICE_STATUS_TEXT").toBe("Forbidden - untrusted session, host not allowed");
    expect(refused.body, "TAINTED_VOICE_REASON_NAMES_SOURCE").toBe("Blocked: this session read untrusted content (it fetched a web page), and 127.0.0.2 "
      + "is not on its taint allow-list or among the hosts it already reached. Do not retry it; tell the user. They can add the host to "
      + "taint.egress.allow in the brain's governance policy, or continue in a new session.\n");
    const head = await tunnel(proxy.socketPath, `127.0.0.2:${island.port}`);
    expect(head, "TAINTED_VOICE_CONNECT_REASON_VISIBLE").toStartWith("HTTP/1.1 403 Forbidden - untrusted session, host not allowed\r\n");
    expect(head).toContain("(it fetched a web page)");
    expect(asks, "TAINTED_VOICE_NO_CARD").toEqual([]);
    expect(calls).toBe(0);
    proxy.stop();
    expect(events(db, "egress_connection")).toMatchObject([{ outcome: "denied", reason: "taint_not_allowed" }, { outcome: "denied", reason: "taint_not_allowed" }]);
  } finally { proxy.stop(); island.stop(true); db.close(); }
});

test("deny and allowlist mode refuse first, without a card", async () => {
  const db = taintedSession(); let calls = 0;
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { calls++; return new Response("Aeaea"); } });
  const { bridge, asks } = cards();
  try {
    for (const policy of [{ schema_version: 1, egress: { deny: ["127.0.0.2"] } }, { schema_version: 1, egress: { mode: "allowlist", allow: ["ithaca.invalid"] } }] as GovernancePolicyInput[]) {
      const proxy = await turn(db, bridge, { policy });
      try {
        const refused = await get(proxy.socketPath, island.url.href);
        expect(refused.status).toBe(403);
        // Each says which list refused it, over HTTP and CONNECT alike (#3431).
        const list = policy.egress?.deny ? "deny" : "allow";
        expect(refused.statusText, "EGRESS_REFUSAL_STATUS_NAMES_LIST").toBe(`Forbidden - host ${list === "deny" ? "on" : "not on"} the egress ${list} list`);
        expect(refused.body, "EGRESS_REFUSAL_BODY_NAMES_LIST").toStartWith(`Blocked: 127.0.0.2 is ${list === "deny" ? "on" : "not on"} this brain's egress ${list} list.`);
        expect(await tunnel(proxy.socketPath, `127.0.0.2:${island.port}`), "EGRESS_REFUSAL_CONNECT_NAMES_LIST")
          .toStartWith(`HTTP/1.1 403 Forbidden - host ${list === "deny" ? "on" : "not on"} the egress ${list} list\r\n`);
      } finally { proxy.stop(); }
    }
    expect(asks.requests, "TAINTED_DENY_AND_ALLOWLIST_NO_CARD").toEqual([]);
    expect(calls).toBe(0);
    expect(events(db, "egress_denial").map(payload => payload.reason)).toEqual(["denied_host", "denied_host", "not_allowlisted", "not_allowlisted"]);
  } finally { island.stop(true); db.close(); }
});

test("cancelling the turn while the card is pending refuses the connection; a late allow admits nothing", async () => {
  const db = taintedSession(); let calls = 0;
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { calls++; return new Response("Aeaea"); } });
  const { bridge, asks } = cards();
  const controller = new AbortController();
  const proxy = await turn(db, bridge, { controller });
  try {
    const response = get(proxy.socketPath, island.url.href).catch(() => ({ status: 0, statusText: "", body: "" }));
    await raised(asks, response);
    controller.abort();
    asks.answer({ behavior: "allow" });
    expect((await response).status, "TAINTED_ASK_CANCEL_REFUSES").not.toBe(200);
    // Negative window, kept real time: a contact the late allow started would
    // reach the island over loopback after the refusal, and no frame on that
    // path can mark its absence. 50 ms gives such a connection its chance.
    await Bun.sleep(50);
    expect(calls, "TAINTED_ASK_CANCEL_NO_CONTACT").toBe(0);
    expect(events(db, "egress_connection"), "TAINTED_ASK_CANCEL_NOT_ADMITTED").toMatchObject([{ outcome: "cancelled", bytes: 0 }]);
  } finally { proxy.stop(); island.stop(true); db.close(); }
});
