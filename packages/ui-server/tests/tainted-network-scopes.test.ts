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
  record?: (event: GovernanceEventInput) => unknown; origin?: "interactive" | "voice" } = {}) =>
  prepareTurnEgress({ controller: options.controller ?? new AbortController(), policy: resolveGovernancePolicy(options.policy ?? { schema_version: 1 }),
    turnId: `turn-voyage-${++turns}`, sessionId: () => options.sessionId ?? "ithaca", model: () => "claude-haiku-4-5", profile: "governed",
    origin: options.origin ?? "interactive", bridge, record: options.record ?? (event => recordGovernanceEvent(db, event)), governanceDb: db });
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
  // The grant's own store refuses it: the write fails in its transaction.
  if (failure === "failed record") db.exec("CREATE TRIGGER ithaca_grant_store BEFORE INSERT ON governance_events WHEN NEW.kind='network_grant' BEGIN SELECT RAISE(FAIL,'Odysseus grant store unavailable'); END");
  let proxy = await turn(db, bridge, { controller });
  try {
    const first = get(proxy.socketPath, aeaea.url.href).catch(() => 0);
    await raised(cards.next(), first);
    if (failure === "cancelled") { controller.abort(); await Bun.sleep(10); }
    cards.answer(failure === "deny" ? { behavior: "deny", message: "Penelope declines" } : { behavior: "allow", networkScope: "session" });
    expect(await first, "UNGRANTED_ANSWER_ADMITS_NOTHING").not.toBe(200);
    expect(grantRows(db), "UNGRANTED_ANSWER_COMMITS_NO_GRANT").toEqual([]);
    expect(hits).toEqual([]);
    await proxy.settled(); proxy.stop();
    if (failure === "failed record") { expect(connections(db).at(-1)).toMatchObject({ reason: "network_approval_unconfirmed" }); db.exec("DROP TRIGGER ithaca_grant_store"); }
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

test("a wider answer for a connection that already closed grants nothing, while its turn runs on", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  const controller = new AbortController();
  let proxy = await turn(db, bridge, { controller });
  try {
    const card = cards.next();
    const client = request({ socketPath: proxy.socketPath, path: aeaea.url.href });
    client.on("error", () => {}); client.end();
    await card;
    client.destroy();
    await Bun.sleep(50);
    cards.answer({ behavior: "allow", networkScope: "session" });
    await Bun.sleep(50);
    expect(controller.signal.aborted).toBe(false);
    expect(grantRows(db), "CLOSED_CONNECTION_ANSWER_COMMITS_NO_GRANT").toEqual([]);
    expect(hits).toEqual([]);
    await proxy.settled(); proxy.stop();
    proxy = await turn(db, bridge);
    const later = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), later, "CLOSED_CONNECTION_ANSWER_ASKS_AGAIN");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await later).toBe(403);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); db.close(); }
});

test("the grant is what the session's own reader grants: a stored row it refuses grants nothing", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits);
  const { bridge, cards } = cardBridge();
  // The row lands, but as a version the reader does not understand.
  db.exec("CREATE TRIGGER ithaca_grant_version AFTER INSERT ON governance_events WHEN NEW.kind='network_grant' BEGIN UPDATE governance_events SET schema_version=2 WHERE id=NEW.id; END");
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow", networkScope: "origin" });
    expect(await first, "GRANT_ROW_IS_WHAT_THE_READER_GRANTS").toBe(403);
    expect(hits).toEqual([]);
    await proxy.settled(); proxy.stop();
    expect(connections(db).at(-1)).toMatchObject({ reason: "network_approval_unconfirmed" });
    proxy = await turn(db, bridge);
    const later = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), later, "REFUSED_ROW_ASKS_AGAIN");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await later).toBe(403);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); db.close(); }
});

test("a session grant made on a typed turn never widens a later voice turn", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits), pylos = island("Pylos", hits);
  const { bridge, cards } = cardBridge();
  let proxy = await turn(db, bridge);
  try {
    const first = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), first);
    cards.answer({ behavior: "allow", networkScope: "session" });
    expect(await first).toBe(200);
    await proxy.settled(); proxy.stop();
    proxy = await turn(db, bridge, { origin: "voice" });
    expect(await get(proxy.socketPath, pylos.url.href), "VOICE_TURN_NEVER_USES_A_SESSION_GRANT").toBe(403);
    expect(cards.requests).toHaveLength(1);
    expect(hits).toEqual(["Aeaea"]);
  } finally { proxy.stop(); aeaea.stop(true); pylos.stop(true); db.close(); }
});

test("only a stored grant this version understands is read back as one", () => {
  const db = sessions();
  try {
    const insert = (version: number, payload: unknown) => db.query(`INSERT INTO governance_events (session_id, turn_id, at, kind, schema_version, actor, model, profile, payload)
      VALUES ('ithaca', 'turn-ithaca-old', 0, 'network_grant', ?, 'interactive', NULL, 'governed', ?)`).run(version, JSON.stringify(payload));
    insert(1, { scope: "forever", toolUseId: "card-forever", transport: "http", host: "aeaea.invalid", port: 80 });
    insert(1, { scope: "origin", toolUseId: "card-partial", host: "aeaea.invalid", port: 80 });
    insert(1, { scope: "session", toolUseId: "card-extra", transport: "http", host: "aeaea.invalid", port: 80 });
    insert(2, { scope: "session", toolUseId: "card-future" });
    const grants = networkGrants(db, "ithaca");
    expect(grants.session, "UNSUPPORTED_GRANT_NEVER_REACHES_THE_SESSION").toBe(false);
    expect([...grants.origins], "MALFORMED_GRANT_NEVER_BECOMES_AN_ORIGIN").toEqual([]);
    insert(1, { scope: "origin", toolUseId: "card-ok", transport: "connect", host: "aeaea.invalid", port: 443 });
    expect(networkGrants(db, "ithaca").origins.size).toBe(1);
  } finally { db.close(); }
});

/** A managed GitHub acquisition through the turn proxy; resolves whether it was admitted. */
const managed = (proxy: Awaited<ReturnType<typeof turn>>) => {
  const op = proxy.managedReference(new URL("https://github.com/"), new AbortController().signal);
  return { admitted: op.admit().finally(() => op.finish("denied")) };
};
const grantRow = (db: Db, payload: Record<string, unknown>) => recordGovernanceEvent(db, { kind: "network_grant", turnId: "turn-ithaca-earlier", sessionId: "ithaca",
  actor: "interactive", model: null, profile: "governed", payload: { toolUseId: `card-${crypto.randomUUID()}`, ...payload } as never });

test("a managed acquisition's card offers no scope, and its answer never covers a worker tunnel", async () => {
  const db = sessions();
  const { bridge, cards } = cardBridge();
  const proxy = await turn(db, bridge);
  try {
    const acquisition = managed(proxy);
    const card = await raised(cards.next(), acquisition.admitted, "MANAGED_ACQUISITION_ASKS");
    expect(card?.network, "MANAGED_CARD_OFFERS_NO_SCOPE").toBeUndefined();
    cards.answer({ behavior: "allow", networkScope: "origin" });
    await acquisition.admitted;
    expect(grantRows(db)).toEqual([]);
    const worker = tunnel(proxy.socketPath, "github.com:443").catch(() => 0);
    const next = await raised(cards.next(), worker, "MANAGED_ANSWER_NEVER_GRANTS_A_TUNNEL");
    expect(next?.network).toMatchObject({ transport: "connect", host: "github.com", port: 443 });
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    await worker;
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); db.close(); }
});

for (const grant of ["tunnel origin", "session"] as const) test(`a ${grant} grant never covers a managed acquisition`, async () => {
  const db = sessions();
  grantRow(db, grant === "session" ? { scope: "session" } : { scope: "origin", transport: "connect", host: "github.com", port: 443 });
  const { bridge, cards } = cardBridge();
  const proxy = await turn(db, bridge);
  try {
    const acquisition = managed(proxy);
    await raised(cards.next(), acquisition.admitted, grant === "session" ? "SESSION_GRANT_EXCLUDES_MANAGED_ACQUISITION" : "TUNNEL_ORIGIN_GRANT_EXCLUDES_MANAGED_ACQUISITION");
    cards.answer({ behavior: "deny", message: "Penelope declines" });
    expect(await acquisition.admitted).toBe(false);
  } finally { cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); db.close(); }
});

test("a grant committed while a connection is already under way never covers it", async () => {
  const db = sessions(); const hits: string[] = [];
  const aeaea = island("Aeaea", hits), ogygia = island("Ogygia", hits, "127.0.0.3");
  const { bridge, cards } = cardBridge();
  // The host's admission view: one held recording wait, for the next
  // connection to start admission, keeps it before its taint check.
  const gate = Promise.withResolvers<void>(); let holdNext = false;
  const snapshot = { evidenceRevision: "1", trustRevision: "1", authorityEpoch: "1", scope: "ithaca", policyHash: null, restricted: true, recordingAvailable: true, authorityCurrent: true };
  (bridge as { admissionSafety?: unknown }).admissionSafety = { read: () => snapshot, subscribe: () => () => {},
    *pendingRecording() { if (holdNext) { holdNext = false; yield gate.promise; } } };
  const proxy = await turn(db, bridge);
  try {
    holdNext = true;
    const early = get(proxy.socketPath, ogygia.url.href);
    await Bun.sleep(50);
    expect(cards.requests, "EARLY_CONNECTION_HELD_BEFORE_ITS_CARD").toHaveLength(0);
    const granting = get(proxy.socketPath, aeaea.url.href);
    await raised(cards.next(), granting, "LATER_CONNECTION_ASKS");
    cards.answer({ behavior: "allow", networkScope: "session" });
    expect(await granting).toBe(200);
    expect(networkGrants(db, "ithaca").session).toBe(true);
    // The early connection began before that grant: it asks for itself.
    const card = cards.next();
    gate.resolve();
    const asked = await Promise.race([card.then(() => "asked" as const), early.then(() => "settled" as const)]);
    expect(asked, "GRANT_EXCLUDES_CONNECTION_STARTED_BEFORE_IT").toBe("asked");
    cards.answer({ behavior: "deny", message: "Calypso declines" });
    expect(await early).toBe(403);
    expect(hits).toEqual(["Aeaea"]);
  } finally { gate.resolve(); cards.answer({ behavior: "deny", message: "cleanup" }); proxy.stop(); aeaea.stop(true); ogygia.stop(true); db.close(); }
});
