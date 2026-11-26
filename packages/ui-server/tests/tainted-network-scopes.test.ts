/**
 * Explicit scopes on a tainted Network card (#3595): once, this origin for the
 * session, or every origin for the session. Every case runs the real turn
 * proxy on loopback with a permission bridge double at `requestPermission`,
 * and a later turn is a fresh proxy reading the same durable record.
 */
import { expect, test } from "bun:test";
import { request } from "node:http";
import { connect } from "node:net";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { queryGovernanceEvents, recordGovernanceEvent, type GovernanceEventInput } from "../src/governance/events.js";
import { contactedHosts, networkGrants } from "../src/governance/session-taint.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";

type Db = ReturnType<typeof createUiDb>;
function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject); });
    child.once("error", reject); child.end();
  });
}
function tunnel(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; if (/^HTTP\/1.1 \d+/.test(text)) socket.destroy(); });
    socket.on("close", () => resolve(Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1] ?? 0))); socket.on("error", reject);
  });
}
/** Two chat sessions; Ithaca fetched a web page earlier, so it is tainted. */
function sessions() {
  const db = createUiDb(":memory:");
  for (const id of ["ithaca", "troy"]) db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?,?,0,0)").run(id, id);
  for (const sessionId of ["ithaca", "troy"]) recordGovernanceEvent(db, { kind: "taint", turnId: `turn-${sessionId}-letters`, sessionId, actor: "interactive", model: null, profile: "governed",
    payload: { source: "web_fetch", tool: "WebFetch", detail: "https://suitors.example/letter" } });
  return db;
}
interface Cards { requests: PermissionRequest[]; answer(decision: PermissionDecision): void; next(): Promise<PermissionRequest> }
/** A bridge whose cards wait until the test answers them, in order. */
function cardBridge(): { bridge: BackendBridge; cards: Cards } {
  const requests: PermissionRequest[] = [], waiting: Array<(decision: PermissionDecision) => void> = [];
  const listeners: Array<(request: PermissionRequest) => void> = [];
  const cards: Cards = { requests, answer: decision => waiting.shift()?.(decision),
    next: () => new Promise(resolve => listeners.push(resolve)) };
  const bridge = { emit() {}, requestPermission: (request: PermissionRequest) => {
    requests.push(request);
    const pending = new Promise<PermissionDecision>(resolve => waiting.push(resolve));
    listeners.splice(0).forEach(listener => listener(request));
    return pending;
  } } as unknown as BackendBridge;
  return { bridge, cards };
}
/** The card for `pending`, or a named failure when the connection settles without one. */
async function raised(next: Promise<PermissionRequest>, pending: Promise<unknown>, name = "SCOPED_CARD_RAISED"): Promise<PermissionRequest | undefined> {
  const outcome = await Promise.race([next, pending.then(() => "settled" as const, () => "settled" as const)]);
  expect(outcome === "settled" ? "settled" : "asked", name).toBe("asked");
  return outcome === "settled" ? undefined : outcome;
}
let turns = 0;
const turn = (db: Db, bridge: BackendBridge, options: { sessionId?: string; policy?: GovernancePolicyInput; controller?: AbortController;
  record?: (event: GovernanceEventInput) => unknown } = {}) =>
  prepareTurnEgress({ controller: options.controller ?? new AbortController(), policy: resolveGovernancePolicy(options.policy ?? { schema_version: 1 }),
    turnId: `turn-voyage-${++turns}`, sessionId: () => options.sessionId ?? "ithaca", model: () => "claude-haiku-4-5", profile: "governed",
    origin: "interactive", bridge, record: options.record ?? (event => recordGovernanceEvent(db, event)), governanceDb: db });
const grantRows = (db: Db) => queryGovernanceEvents(db, { kinds: ["network_grant"], limit: 20 }).map(event => event.payload as Record<string, unknown>);
const connections = (db: Db) => queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["egress_connection"], limit: 50 }).map(event => event.payload as Record<string, unknown>);
const island = (name: string, hits: string[], hostname = "127.0.0.2") => Bun.serve({ hostname, port: 0, fetch() { hits.push(name); return new Response(name); } });

test("a tainted Network card offers once, origin and session for its exact origin", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  const proxy = await turn(db, bridge);
  try {
    const plain = get(proxy.socketPath, aeaea.url.href);
    const card = await raised(cards.next(), plain);
    expect(card?.network, "NETWORK_CARD_ADVERTISES_ORIGIN_AND_SCOPES").toEqual({ transport: "http", host: "127.0.0.2", port: aeaea.port!, scopes: ["once", "origin", "session"] });
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await plain).toBe(403);
    const opaque = tunnel(proxy.socketPath, `127.0.0.2:${aeaea.port}`);
    expect((await raised(cards.next(), opaque))?.network, "CONNECT_IS_ITS_OWN_OPAQUE_ORIGIN").toEqual({ transport: "connect", host: "127.0.0.2", port: aeaea.port!, scopes: ["once", "origin", "session"] });
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await opaque).toBe(403);
  } finally { proxy.stop(); aeaea.stop(true); db.close(); }
});

test("once permits one connection and asks again, in this turn and later ones", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow", networkScope: "once" });
    expect(await first, "ONCE_ADMITS_ITS_CONNECTION").toBe(200);
    const again = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), again, "ONCE_ASKS_AGAIN_IN_THIS_TURN");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await again).toBe(403);
    await proxy.settled(); proxy.stop();
    expect(connections(db)[0], "ONCE_RECORDS_ITS_SCOPE").toMatchObject({ host: "127.0.0.2", outcome: "completed", networkScope: "once" });
    expect(contactedHosts(db, "ithaca"), "ONCE_IS_NEVER_A_CONTACTED_HOST").toEqual([]);
    expect(grantRows(db), "ONCE_COMMITS_NO_GRANT").toEqual([]);
    proxy = await turn(db, bridge);
    const later = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), later, "ONCE_ASKS_AGAIN_IN_A_LATER_TURN");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await later).toBe(403);
    expect(hits).toEqual(["Aeaea"]);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); db.close(); }
});

test("concurrent one-time connections do not share one grant", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  const proxy = await turn(db, bridge);
  try {
    const firstCard = cards.next();
    const both = [get(proxy.socketPath, aeaea.url.href), get(proxy.socketPath, aeaea.url.href)];
    await firstCard;
    await Bun.sleep(50);
    expect(cards.requests, "CONCURRENT_CONNECTIONS_SHARE_THE_PENDING_CARD").toHaveLength(1);
    const second = cards.next();
    cards.answer({ behavior: "allow", networkScope: "once" });
    const outcome = await Promise.race([second.then(() => "asked"), Promise.all(both).then(() => "settled")]);
    expect(outcome, "ONCE_IS_NOT_SHARED_BY_A_CONCURRENT_CONNECTION").toBe("asked");
    expect(cards.requests).toHaveLength(2);
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect((await Promise.all(both)).sort()).toEqual([200, 403]);
    expect(hits).toHaveLength(1);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); db.close(); }
});

test("an origin grant commits before admission and covers only its transport, host and port, in this session", async () => {
  const db = sessions(); const hits: string[] = [];
  let grantedBeforeDispatch = false;
  const aeaea = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch() { hits.push("Aeaea"); grantedBeforeDispatch ||= grantRows(db).length === 1; return new Response("Aeaea"); } });
  const pylos = island("Pylos", hits);
  const { bridge, cards } = cardBridge();
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow", networkScope: "origin" });
    expect(await first).toBe(200);
    expect(grantedBeforeDispatch, "ORIGIN_GRANT_COMMITS_BEFORE_ADMISSION").toBe(true);
    expect(grantRows(db)).toMatchObject([{ scope: "origin", transport: "http", host: "127.0.0.2", port: aeaea.port }]);
    expect(await get(proxy.socketPath, aeaea.url.href), "ORIGIN_GRANT_COVERS_ITS_ORIGIN").toBe(200);
    const otherPort = get(proxy.socketPath, pylos.url.href);
    await raised(cards.next(), otherPort, "ORIGIN_GRANT_EXCLUDES_ANOTHER_PORT");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await otherPort).toBe(403);
    const opaque = tunnel(proxy.socketPath, `127.0.0.2:${aeaea.port}`);
    await raised(cards.next(), opaque, "HTTP_ORIGIN_GRANT_EXCLUDES_CONNECT");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await opaque).toBe(403);
    await proxy.settled(); proxy.stop();
    expect(contactedHosts(db, "ithaca"), "ORIGIN_GRANT_NEVER_WIDENS_TO_THE_HOST").toEqual([]);
    proxy = await turn(db, bridge);
    expect(await get(proxy.socketPath, aeaea.url.href), "ORIGIN_GRANT_SURVIVES_A_LATER_TURN").toBe(200);
    const otherLater = get(proxy.socketPath, pylos.url.href);
    await raised(cards.next(), otherLater, "LATER_TURN_STILL_EXCLUDES_ANOTHER_PORT");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await otherLater).toBe(403);
    proxy.stop();
    proxy = await turn(db, bridge, { sessionId: "troy" });
    const otherSession = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), otherSession, "ORIGIN_GRANT_STAYS_IN_ITS_SESSION");
    cards.answer({ behavior: "deny", message: "Hector declines" });
    expect(await otherSession).toBe(403);
    expect(hits).toEqual(["Aeaea", "Aeaea", "Aeaea"]);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); pylos.stop(true); db.close(); }
});

test("a session grant covers every later destination but never deny, allowlist, byte or outward rules", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits), pylos = island("Pylos", hits), sparta = island("Sparta", hits, "127.0.0.3");
  const { bridge, cards } = cardBridge();
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow", networkScope: "session" });
    expect(await first).toBe(200);
    expect(await get(proxy.socketPath, pylos.url.href), "SESSION_GRANT_COVERS_ANOTHER_ORIGIN_IN_THIS_TURN").toBe(200);
    expect(cards.requests).toHaveLength(1);
    await proxy.settled(); proxy.stop();
    expect(networkGrants(db, "ithaca").session).toBe(true);
    expect(connections(db).map(row => row.networkScope)).toEqual(["session", "session"]);
    expect(contactedHosts(db, "ithaca"), "SESSION_GRANT_NEVER_READS_BACK_AS_CONTACTED_HOSTS").toEqual([]);
    proxy = await turn(db, bridge);
    expect(await get(proxy.socketPath, sparta.url.href), "SESSION_GRANT_SURVIVES_A_LATER_TURN").toBe(200);
    proxy.stop();
    proxy = await turn(db, bridge, { policy: { schema_version: 1, egress: { deny: ["127.0.0.3"] } } });
    expect(await get(proxy.socketPath, sparta.url.href), "SESSION_GRANT_KEEPS_THE_DENY_LIST").toBe(403);
    proxy.stop();
    proxy = await turn(db, bridge, { policy: { schema_version: 1, egress: { mode: "allowlist", allow: ["127.0.0.2"] } } });
    expect(await get(proxy.socketPath, sparta.url.href), "SESSION_GRANT_KEEPS_THE_ALLOWLIST").toBe(403);
    proxy.stop();
    proxy = await turn(db, bridge, { policy: { schema_version: 1, egress: { max_bytes_per_turn: 1 } } });
    expect(await get(proxy.socketPath, sparta.url.href), "SESSION_GRANT_KEEPS_THE_BYTE_LIMIT").toBe(403);
    proxy.stop();
    proxy = await turn(db, bridge, { policy: { schema_version: 1, outward: { hosts: ["127.0.0.3"] } } });
    const outward = get(proxy.socketPath, sparta.url.href);
    const outwardCard = await raised(cards.next(), outward, "SESSION_GRANT_KEEPS_OUTWARD_APPROVAL");
    expect(outwardCard?.network, "OUTWARD_CARD_OFFERS_NO_NETWORK_SCOPE").toBeUndefined();
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await outward).toBe(403);
    expect(hits.filter(hit => hit === "Sparta")).toEqual(["Sparta"]);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); pylos.stop(true); sparta.stop(true); db.close(); }
});

for (const failure of ["deny", "failed record", "cancelled"] as const) test(`a ${failure} wider answer grants no access`, async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  const controller = new AbortController();
  let proxy = await turn(db, bridge, { controller, record: event => {
    if (failure === "failed record" && event.kind === "network_grant") throw new Error("Odysseus grant store unavailable");
    return recordGovernanceEvent(db, event);
  } });
  try {
    const first = get(proxy.socketPath, aeaea.url.href).catch(() => 0);
    await raised(cards.next(), first);
    if (failure === "cancelled") { controller.abort(); await Bun.sleep(10); }
    cards.answer(failure === "deny" ? { behavior: "deny", message: "Penelope declines" } : { behavior: "allow", networkScope: "session" });
    expect(await first, "UNGRANTED_ANSWER_ADMITS_NOTHING").not.toBe(200);
    expect(grantRows(db), "UNGRANTED_ANSWER_COMMITS_NO_GRANT").toEqual([]);
    expect(hits).toEqual([]);
    await proxy.settled(); proxy.stop();
    if (failure === "failed record") expect(connections(db).at(-1)).toMatchObject({ reason: "network_approval_unconfirmed" });
    proxy = await turn(db, bridge);
    const later = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), later, "UNGRANTED_ANSWER_ASKS_AGAIN");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await later).toBe(403);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); db.close(); }
});

test("a legacy reply without a scope keeps the host-wide session behaviour", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits), pylos = island("Pylos", hits);
  const { bridge, cards } = cardBridge();
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow" });
    expect(await first).toBe(200);
    expect(await get(proxy.socketPath, pylos.url.href), "LEGACY_ALLOW_COVERS_THE_HOST").toBe(200);
    await proxy.settled(); proxy.stop();
    expect(connections(db).every(row => row.networkScope === undefined), "LEGACY_RECORD_NAMES_NO_SCOPE").toBe(true);
    expect(grantRows(db)).toEqual([]);
    proxy = await turn(db, bridge);
    expect(await get(proxy.socketPath, pylos.url.href), "LEGACY_ALLOW_SURVIVES_A_LATER_TURN").toBe(200);
    expect(cards.requests).toHaveLength(1);
  } finally { proxy.stop(); aeaea.stop(true); pylos.stop(true); db.close(); }
});
