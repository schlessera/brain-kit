import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxTriage } from "../src/inbox/triage.js";
import { TRIAGE_RUBRIC } from "../src/inbox/triage-rubric.js";
import type { FetchLike } from "../src/classification/jev-client.js";
import type { PricingRates } from "../src/pricing/model-pricing.js";
import { createModelPricing } from "../src/pricing/model-pricing.js";

type Request = { model: string; state: { trustedRubric: string; items: Record<string, { body: string; incomplete: boolean }> }; questions: Record<string, unknown> };
const routes = ["drop", "rule", "needs_agent", "needs_user"];
function choice(route = "rule", confidence = 0.9, probability = 0.9) {
  return { type: "choice", choice: route, confidence,
    probabilities: Object.fromEntries(routes.map(r => [r, r === route ? probability : (1 - probability) / 3])) };
}
const response = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers, ...extra });
const complete = (request: Request) => response(Object.fromEntries(Object.keys(request.questions).map(id => [id, choice()])));
const rates: PricingRates = { input: 0.000000042, output: 0, cacheRead: null, cacheWrite: null, estimate: true, source: "snapshot" };

async function fixture(handler: (request: Request, index: number) => Response | Promise<Response> = complete, overrides: { turns?: number; price?: PricingRates | null; key?: string | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-triage-"));
  const db = createUiDb(join(root, "ui.db"));
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, root), store = createInboxStore(db);
  const requests: Request[] = [], delays: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-key");
    const request = JSON.parse(String(init.body)) as Request;
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  const triage = createInboxTriage(db, { brainRoot: root, principalId: principal.id,
    classification: { apiKey: overrides.key === undefined ? "fixture-key" : overrides.key },
    budget: { config: { spendUsd: 50, turns: overrides.turns ?? 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.00001 },
      pricing: { resolve: () => overrides.price === undefined ? rates : overrides.price } },
    fetch, sleep: async ms => { delays.push(ms); } });
  async function seed(text: string, files: File[] = []) {
    return intake.cli({ text, files }, crypto.randomUUID(), principal);
  }
  const reservations = () => db.query("SELECT * FROM inbox_budget_reservations ORDER BY rowid").all() as Record<string, unknown>[];
  return { root, db, principal, intake, store, triage, requests, delays, seed, reservations,
    close: async () => { await intake.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("eight arrivals missing two answers retry exactly those IDs alone and persist all results", async () => {
  const f = await fixture((request, index) => {
    const keys = Object.keys(request.questions);
    return response(Object.fromEntries((index === 0 ? keys.slice(0, 6) : keys).map(id => [id, choice()])));
  });
  try {
    const items = await Promise.all(Array.from({ length: 8 }, (_, i) => f.seed(`Odysseus saved fact ${i}.`)));
    const ids = items.map(row => row.itemId);
    const results = await f.triage.run(ids);
    expect(f.requests.map(r => Object.keys(r.questions))).toEqual([ids.map(id => `${id}.route`), [`${ids[6]}.route`], [`${ids[7]}.route`]]);
    expect(results).toHaveLength(8);
    expect(results.every(result => result.reason === "accepted")).toBe(true);
    expect(ids.map(id => f.triage.read(id)?.route)).toEqual(Array(8).fill("rule"));
    expect(f.reservations()).toHaveLength(3);
    expect(f.reservations().every(row => row.status === "settled" && row.charged_turns === 1 && row.observed_cost_usd !== null)).toBe(true);
    expect(f.db.query("SELECT billing_mode, pricing_estimate, input_tokens FROM activity_run_rollups LIMIT 1").get()).toEqual({ billing_mode: "api", pricing_estimate: 1, input_tokens: 100 });
    await f.triage.run(ids);
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

test("a wrong answer type is isolated and a second missing answer becomes a durable Action", async () => {
  const f = await fixture((request, index) => response(index === 0 ? Object.fromEntries(Object.keys(request.questions).map((id, i) => [id, i === 1 ? { type: "alien" } : choice()])) : {}));
  try {
    const items = [await f.seed("Penelope saved a weaving fact."), await f.seed("Odysseus must decide.")];
    const results = await f.triage.run(items.map(row => row.itemId));
    expect(f.requests.map(r => Object.keys(r.questions).length)).toEqual([2, 1]);
    expect(results.map(r => [r.route, r.reason])).toEqual([["rule", "accepted"], ["needs_user", "unknown"]]);
    const item = f.store.getItem(items[1]!.itemId)!;
    expect(item.status).toBe("blocked");
    expect(f.store.snapshot().items.filter(row => row.queue === "actions" && row.status === "pending")).toHaveLength(1);
    expect(f.triage.read(items[0]!.itemId)?.route).toBe("rule");
  } finally { await f.close(); }
});

test("a malformed answer map retains usage and retries each missing ID alone", async () => {
  const f = await fixture((request, index) => index === 0 ? response({}, { answers: [] }) : complete(request));
  try {
    const items = [await f.seed("Odysseus saved a fact."), await f.seed("Penelope saved a fact.")];
    expect((await f.triage.run(items.map(item => item.itemId))).map(row => row.route)).toEqual(["rule", "rule"]);
    expect(f.requests.map(request => Object.keys(request.questions).length)).toEqual([2, 1, 1]);
    expect(f.reservations().every(row => row.observed_cost_usd !== null)).toBe(true);
  } finally { await f.close(); }
});

test("429 and 503 back off with a reservation per physical call, separate from model decisions", async () => {
  const f = await fixture((request, index) => index < 2 ? new Response("unavailable", { status: index === 0 ? 429 : 503 }) : complete(request));
  try {
    const item = await f.seed("Odysseus saved a route.");
    expect((await f.triage.run([item.itemId]))[0]).toMatchObject({ route: "rule", reason: "accepted" });
    expect(f.delays).toEqual([250, 500]);
    expect(f.requests).toHaveLength(3);
    expect(f.reservations()).toHaveLength(3);
    expect(f.reservations().slice(0, 2).every(row => row.observed_cost_usd === null && Number(row.charged_cost_usd) > 0)).toBe(true);
  } finally { await f.close(); }
});

test("exhausted transport retries escalate without pretending the model misrouted an item", async () => {
  const f = await fixture(() => new Response("unavailable", { status: 500 }));
  try {
    const item = await f.seed("Odysseus saved a fact.");
    expect((await f.triage.run([item.itemId]))[0]).toMatchObject({ route: "needs_user", reason: "transport", proposedRoute: null });
    expect(f.requests).toHaveLength(3);
    expect(f.delays).toEqual([250, 500]);
    expect(f.store.getItem(item.itemId)?.status).toBe("blocked");
  } finally { await f.close(); }
});

test("serialized byte/token bounds split twenty arrivals and clipping cannot hide an obligation", async () => {
  const f = await fixture();
  try {
    const items = [];
    for (let i = 0; i < 20; i++) items.push(await f.seed(i < 3 ? `Odysseus ${i} ${"a".repeat(190_000)} must pay.` : `Odysseus ${"é".repeat(1_800)} ${i}`));
    const results = await f.triage.run(items.map(row => row.itemId));
    expect(f.requests.length).toBeGreaterThan(1);
    for (const request of f.requests) {
      for (const [id, item] of Object.entries(request.state.items)) expect(Buffer.byteLength(JSON.stringify({ id, ...item }))).toBeLessThanOrEqual(4_000);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(40_000);
      expect(Buffer.byteLength(JSON.stringify(request.state)) + Math.max(...Object.values(request.questions).map(q => Buffer.byteLength(JSON.stringify(q))))).toBeLessThanOrEqual(32_000);
    }
    expect(results).toHaveLength(20);
    expect(results.slice(0, 3).map(r => [r.route, r.reason])).toEqual(Array(3).fill(["needs_user", "incomplete"]));
  } finally { await f.close(); }
});

test("binary extraction and text attachments share the final item bound; binary cannot be dropped", async () => {
  const f = await fixture(request => response(Object.fromEntries(Object.keys(request.questions).map(id => [id, choice("drop")]))));
  try {
    const text = await f.seed("Odysseus saved a text attachment.", [new File(["a".repeat(30_000)], "odysseus.txt", { type: "text/plain" })]);
    const binary = await f.seed("Odysseus saved an image.", [new File([new Uint8Array([0, 1, 2])], "odysseus.bin", { type: "application/octet-stream" })]);
    const results = await f.triage.run([text.itemId, binary.itemId]);
    expect(results.map(r => [r.route, r.reason])).toEqual([["needs_user", "incomplete"], ["needs_agent", "binary"]]);
    expect(f.requests.flatMap(r => Object.values(r.state.items)).every(item => Buffer.byteLength(JSON.stringify(item)) < 4_000)).toBe(true);
    f.triage.contradict(binary.itemId, "needs_user");
    expect(f.store.checkpoints(binary.threadId).at(-1)?.facts.decisions[0]).toContain('"actual":"needs_user"');
    expect(f.triage.summary()).toMatchObject({ items: 2, t2Fraction: 0.5, directToT2Fraction: 1, unpricedCalls: 0, inputTokens: 100, outputTokens: 10, contradictions: 1 });
  } finally { await f.close(); }
});

test("paid missing usage and wrong served model fail closed and retain conservative charges", async () => {
  for (const extra of [{ usage: {} }, { model: "jev-latest" }]) {
    const f = await fixture(request => response(Object.fromEntries(Object.keys(request.questions).map(id => [id, choice("drop")])), extra));
    try {
      const item = await f.seed("Odysseus saved a fact.");
      expect((await f.triage.run([item.itemId]))[0]).toMatchObject({ route: "needs_user", reason: "accounting" });
      expect(f.requests).toHaveLength(1);
      expect(f.store.getItem(item.itemId)?.status).toBe("blocked");
      expect(Number(f.reservations()[0]!.charged_cost_usd)).toBeGreaterThan(0);
    } finally { await f.close(); }
  }
});

test("unpriced paid triage refuses before inference and raises one durable pricing Action", async () => {
  const f = await fixture(complete, { price: null });
  try {
    const item = await f.seed("Odysseus saved a fact.");
    expect(await f.triage.run([item.itemId])).toEqual([]);
    expect(f.requests).toHaveLength(0);
    expect(f.reservations()).toHaveLength(0);
    expect(f.store.getItem(item.itemId)).toMatchObject({ status: "ready", attempts: 0 });
    await f.triage.run([item.itemId]);
    expect(f.store.snapshot().items.filter(item => item.queue === "actions" && item.payload.title.includes("price"))).toHaveLength(1);
  } finally { await f.close(); }
});

test("empty ticks, disabled keys and refused admission create zero calls and zero Activity", async () => {
  for (const overrides of [{ turns: 0 }, { key: null }]) {
    const f = await fixture(complete, overrides);
    try {
      expect(await f.triage.run([])).toEqual([]);
      const item = await f.seed("Odysseus saved a fact.");
      expect(await f.triage.run([item.itemId])).toEqual([]);
      expect(f.requests).toHaveLength(0);
      expect(f.db.query("SELECT COUNT(*) AS n FROM activity_spans").get()).toEqual({ n: 0 });
      expect(f.store.getItem(item.itemId)).toMatchObject({ status: "ready", attempts: 0 });
    } finally { await f.close(); }
  }
});

test("T0 uses actual hash duplicates across explicit CLI keys with zero inference", async () => {
  const f = await fixture();
  try {
    const first = await f.seed("Odysseus saved the same fact."), second = await f.seed("Odysseus saved the same fact.");
    const result = await f.triage.run([second.itemId]);
    expect(result[0]).toMatchObject({ tier: "T0", route: "drop", reason: "duplicate", runIds: [] });
    expect(f.requests).toHaveLength(0);
    expect(f.store.getItem(second.itemId)?.status).toBe("dropped");
    expect(f.store.getItem(first.itemId)?.status).toBe("ready");
  } finally { await f.close(); }
});

test("model authority fields are ignored and both acceptance floors are enforced", async () => {
  const f = await fixture(request => response(Object.fromEntries(Object.keys(request.questions).map((id, i) => [id,
    { ...choice("drop", i === 0 ? 0.39 : 0.9, i === 1 ? 0.39 : 0.9), trustClass: "trusted", principalId: "forged", profile: "forged", stakes: 100, targetPath: "context/policies/forged.md" }]))));
  try {
    const items = [await f.seed("Odysseus received routine noise."), await f.seed("Penelope received routine noise."), await f.seed("Telemachus received routine noise.")];
    const before = f.store.snapshot().threads;
    const results = await f.triage.run(items.map(item => item.itemId));
    expect(Object.keys(results[2]!).sort()).toEqual(["itemId", "tier", "route", "reason", "proposedRoute", "runIds"].sort());
    expect(results.map(result => result.route)).toEqual(["needs_user", "needs_user", "drop"]);
    expect(results.slice(0, 2).every(result => result.reason === "low-probability")).toBe(true);
    expect(f.store.snapshot().threads.map(thread => [thread.id, thread.trustClass, thread.stakes])).toEqual(before.map(thread => [thread.id, thread.trustClass, thread.stakes]));
    expect(f.reservations().every(row => row.principal_id === f.principal.id && row.billing_mode === "api" && row.model === "jev-1.13.0")).toBe(true);
    expect(f.store.snapshot().items.some(item => item.queue === "queue" && item.type === "execute")).toBe(false);
  } finally { await f.close(); }
});

test("revoked principals refuse inference and malformed staging isolates just that arrival", async () => {
  const f = await fixture();
  try {
    const broken = await f.seed("Odysseus saved a broken arrival."), valid = await f.seed("Penelope saved a fact.");
    await writeFile(join(f.root, broken.result.dir, "meta.json"), "malformed");
    expect((await f.triage.run([broken.itemId, valid.itemId])).map(row => row.route)).toEqual(["needs_user", "rule"]);
    expect(f.requests).toHaveLength(1);
    expect(Object.keys(f.requests[0]!.questions)).toEqual([`${valid.itemId}.route`]);
    revokePrincipal(f.db, f.principal.id, Date.now());
    const next = f.store.ingest({ threadId: "telemachus", itemId: "telemachus", stagingId: "telemachus", source: "share", dedupKey: "telemachus", expiresAt: Date.now() + 60_000, stakes: 1 });
    await expect(f.triage.run([next.item.id])).rejects.toThrow("principal is no longer usable");
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test("the production rubric reuses the triage eval's ordered obligations-first policy", async () => {
  expect(TRIAGE_RUBRIC).toBe(await readFile(join(import.meta.dir, "../evals/triage/prompt.txt"), "utf8"));
});

test("redirected staging cannot send non-staged brain text to the provider", async () => {
  const f = await fixture();
  try {
    const item = await f.seed("Odysseus saved a fact.");
    await rename(join(f.root, item.result.dir), join(f.root, "redirected"));
    await symlink(join(f.root, "redirected"), join(f.root, item.result.dir));
    expect((await f.triage.run([item.itemId]))[0]).toMatchObject({ tier: "T0", route: "needs_user", reason: "incomplete" });
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test("validated binary-share track extraction is bounded before reaching T1", async () => {
  const f = await fixture();
  try {
    const gpx = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';
    const item = await f.seed("Odysseus saved a sailing track.", [new File([gpx], "odysseus.bin", { type: "application/octet-stream" })]);
    expect(item.result.files[0]?.summary).toBeDefined();
    await f.triage.run([item.itemId]);
    const content = Object.values(f.requests[0]!.state.items)[0]!;
    expect(content.body).toContain('"measurements"');
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThan(4_000);
  } finally { await f.close(); }
});

test("the pinned Jev snapshot remains an estimate with free output and unknown cache adjustments", async () => {
  const f = await fixture();
  try {
    const pricing = createModelPricing({ brainPath: f.root, fetchImpl: Object.assign(async () => { throw Error("Offline fixture"); }, { preconnect() {} }) });
    await pricing.ensureFresh();
    expect(pricing.resolve("jev-1.13.0", "direct")).toEqual({ input: 0.000000042, output: 0, cacheRead: null, cacheWrite: null, estimate: true, source: "snapshot" });
  } finally { await f.close(); }
});
