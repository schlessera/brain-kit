/**
 * The trusted Apify run service (#3161): reservation, dispatch, bounded wait,
 * results, abort, settlement and reconciliation, through the real authority,
 * consent and ledger, a real governance file and a loopback fake of the
 * Apify REST API and hosted MCP server. Tokens are synthetic sentinels, the
 * Actor and its prices are fictional, and nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { ApifyAuthorityError, createApifyAuthority, governanceApifyPolicy, type ApifyAuthority } from "@schlessera/brain-common/internal/apify";
import { ApifyConsentError, ApifyInputError, createApifyConsent, governanceApifyConsentPolicy, type ApifyCallContext, type ApifyConsent } from "@schlessera/brain-common/internal/apify";
import { openApifyLedger, utcDay, type ApifyLedger } from "@schlessera/brain-common/internal/apify";
import { qualifyProfile, type ApifyQualifiedProfile } from "@schlessera/brain-common/internal/apify";
import {
  APIFY_COVERAGE, ApifyRunError, createApifyRequestMeter, createApifyRuns, governanceApifyRunPolicy, type ApifyRuns, type ApifyRunsOptions,
} from "@schlessera/brain-common/internal/apify";
import { SEA_CHARTS_PRICING, SEA_CHARTS_SCHEMA, seaChartsProfile } from "./fixtures/apify-odysseus.js";

const SENTINEL = "apify_api_ODYSSEUS_SENTINEL_0f1e2d3c";
const ACCOUNT = { id: "IthacaHousehold01", username: "penelope" };

interface Step { status: string; counts?: Record<string, number>; pricingInfo?: unknown; usageTotalUsd?: number; metamorphs?: unknown[] }
interface Seen { method: string; path: string; query: URLSearchParams; authorization: string | null; body: unknown }
interface Fake {
  origin: string; seen: Seen[];
  pricing: unknown[];
  start: "ok" | "hang" | "500" | "402" | "garbage" | "wrong_build";
  script: Step[];
  abort: "ok" | "fail";
  items: unknown[];
  itemsRedirect: boolean;
  runs: Map<string, { query: URLSearchParams; step: number; aborted: boolean }>;
  stop(): void;
}

function fakeApify(): Fake {
  const fake: Fake = { origin: "", seen: [], pricing: structuredClone(SEA_CHARTS_PRICING), start: "ok", script: [{ status: "RUNNING" }],
    abort: "ok", items: [], itemsRedirect: false, runs: new Map(), stop: () => undefined };
  const runObject = (id: string, entry: { query: URLSearchParams; step: number; aborted: boolean }, step: Step) => ({
    id, actId: "SeaCharts01", userId: ACCOUNT.id, buildId: fake.start === "wrong_build" ? "SirenBuild01" : "SeaBuild142", buildNumber: "1.4.2",
    status: entry.aborted ? "ABORTED" : step.status, startedAt: "2026-07-12T09:00:00.000Z",
    options: { build: entry.query.get("build"), timeoutSecs: Number(entry.query.get("timeout")), memoryMbytes: Number(entry.query.get("memory")),
      diskMbytes: 2048, maxTotalChargeUsd: Number(entry.query.get("maxTotalChargeUsd")), restartOnError: entry.query.get("restartOnError") === "true" },
    defaultDatasetId: `VoyageData${id.slice(-2)}`, defaultKeyValueStoreId: "VoyageStore01", defaultRequestQueueId: "VoyageQueue01",
    // A signed link the host must never follow.
    output: { results: "https://api.apify.com/v2/key-value-stores/VoyageStore01/records/OUTPUT?signature=ODYSSEUS" },
    ...(step.usageTotalUsd !== undefined ? { usageTotalUsd: step.usageTotalUsd } : {}),
    ...(step.counts ? { chargedEventCounts: step.counts } : {}),
    ...(step.pricingInfo ? { pricingInfo: step.pricingInfo } : {}),
    ...(step.metamorphs ? { metamorphs: step.metamorphs } : {}),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const text = request.method === "POST" ? await request.text() : "";
    const body = text ? JSON.parse(text) : null;
    const authorization = request.headers.get("authorization");
    fake.seen.push({ method: request.method, path: url.pathname, query: url.searchParams, authorization, body });
    if (authorization !== `Bearer ${SENTINEL}`) return Response.json({ error: { type: "token-not-valid" } }, { status: 401 });
    if (url.pathname === "/") return mcp(request, body);
    if (url.pathname === "/v2/users/me") return Response.json({ data: ACCOUNT });
    if (url.pathname === "/v2/acts/SeaCharts01" && request.method === "GET")
      return Response.json({ data: { id: "SeaCharts01", username: "odysseus", name: "sea-charts", title: "Sea charts of the Aegean",
        description: "Collects published sea charts for a voyage plan.", isDeprecated: false, actorPermissionLevel: "LIMITED_PERMISSIONS",
        defaultRunOptions: { build: "latest", timeoutSecs: 3600, memoryMbytes: 1024 },
        taggedBuilds: { latest: { buildId: "SeaBuild142", buildNumber: "1.4.2" } }, pricingInfos: fake.pricing } });
    if (url.pathname === "/v2/actor-builds/SeaBuild142")
      return Response.json({ data: { id: "SeaBuild142", actId: "SeaCharts01", buildNumber: "1.4.2", status: "SUCCEEDED", actorDefinition: { input: SEA_CHARTS_SCHEMA } } });
    if (url.pathname === "/v2/acts/SeaCharts01/runs" && request.method === "POST") {
      if (fake.start === "hang") return new Promise<Response>(() => undefined);
      if (fake.start === "500") return Response.json({ error: { type: "internal-error" } }, { status: 500 });
      if (fake.start === "402") return Response.json({ error: { type: "not-enough-usage-to-run-paid-actor" } }, { status: 402 });
      if (fake.start === "garbage") return new Response("<html>gateway</html>", { status: 201 });
      const id = `VoyageRun${String(fake.runs.size + 1).padStart(2, "0")}`;
      const entry = { query: url.searchParams, step: 0, aborted: false };
      fake.runs.set(id, entry);
      return Response.json({ data: runObject(id, entry, { status: "READY", counts: { "apify-actor-start": 1 } }) }, { status: 201 });
    }
    const run = /^\/v2\/actor-runs\/([A-Za-z0-9]+)(\/abort)?$/.exec(url.pathname);
    if (run) {
      const entry = fake.runs.get(run[1]!);
      if (!entry) return Response.json({ error: { type: "record-not-found" } }, { status: 404 });
      if (run[2]) {
        if (fake.abort === "fail") return Response.json({ error: { type: "internal-error" } }, { status: 500 });
        entry.aborted = true;
        return Response.json({ data: runObject(run[1]!, entry, fake.script[Math.min(entry.step, fake.script.length - 1)]!) });
      }
      const step = fake.script[Math.min(entry.step, fake.script.length - 1)]!;
      entry.step += 1;
      return Response.json({ data: runObject(run[1]!, entry, step) });
    }
    const items = /^\/v2\/datasets\/([A-Za-z0-9]+)\/items$/.exec(url.pathname);
    if (items) {
      if (fake.itemsRedirect) return new Response(null, { status: 302, headers: { location: "https://downloads.example/signed?token=ODYSSEUS" } });
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 1000);
      return Response.json(fake.items.slice(offset, offset + limit));
    }
    return Response.json({ error: { type: "record-not-found" } }, { status: 404 });
  } });
  function mcp(request: Request, body: { id?: number; method?: string; params?: { name?: string } } | null): Response {
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "IthacaSession7" } });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "apify-mcp-server", version: "0" } });
    if (body.params?.name === "search-actors")
      return reply({ content: [{ type: "text", text: "# Search results" }], structuredContent: { actors: [{ id: "SeaCharts01", fullName: "odysseus/sea-charts",
        title: "Sea charts of the Aegean", description: "Collects published sea charts.", pricing: { model: "PAY_PER_EVENT" } }] } });
    return reply({ content: [{ type: "text", text: "# Sea charts\n\nCollects published sea charts." }] });
  }
  fake.origin = `http://127.0.0.1:${server.port}`;
  fake.stop = () => { void server.stop(true); };
  return fake;
}

const LIMITS = { run_usd: 3, turn_usd: 5, session_usd: 10, day_usd: 20, max_runs_per_turn: 2, max_requests_per_turn: 80,
  max_concurrent_runs: 2, max_runtime_seconds: 600, max_result_items: 50, max_result_bytes: 262_144, max_retention_seconds: 86_400 };
const START = Date.parse("2026-07-12T09:00:00.000Z");
const INPUT = { startUrls: [{ url: "https://ithaca.example/charts" }], maxPages: 3 };
/** $2 cap + 20 lifecycle requests at $0.0004 + 50 estimated items x 4096 B kept 7 days at $0.5/GB-day (717 micro-USD, rounded up). */
const RESERVED = 2 + 0.008 + 0.000717;
/** One start at $0.05 and three chart pages at $0.01. */
const SETTLED_EVENTS = 0.08;

let root: string;
let brain: string;
let fake: Fake;
let token: string | undefined;
let stored: unknown;
let clock: number;
let authority: ApifyAuthority;
let ledgerPath: string;
let ledgers: ApifyLedger[];
let asked: PermissionRequest[];
let answer: (request: PermissionRequest) => PermissionDecision;
let untrusted: string[];
let spent: { turn_usd: number | null; session_usd: number | null; day_usd: number | null };

const PROFILE = qualifyProfile(seaChartsProfile());

function policy(apify: Record<string, unknown> = {}, extra = "") {
  const block = { enabled: true, discovery: "allow", actors: "ask", limits: LIMITS, ...apify };
  writeFileSync(join(brain, "context/policies/governance.md"), `---\nschema_version: 1\n${extra}apify: ${JSON.stringify(block)}\n---\nOdysseus decides what leaves Ithaca.\n`);
}
function openLedger(): ApifyLedger { const ledger = openApifyLedger(ledgerPath); ledgers.push(ledger); return ledger; }

interface Harness { consent: ApifyConsent; runs: ApifyRuns; ledger: ApifyLedger }
function harness(overrides: Partial<ApifyRunsOptions> & { brainPath?: string; brainId?: string; ledgerFactory?: () => ApifyLedger } = {}): Harness {
  const path = overrides.brainPath ?? brain;
  const ledger = openLedger();
  const factory = overrides.ledgerFactory ?? (() => ledger);
  const brainId = overrides.brainId ?? "brain-ithaca";
  const runPolicy = governanceApifyRunPolicy(path);
  const consent = createApifyConsent({ authority: overrides.authority ?? authority, policy: governanceApifyConsentPolicy(path), profiles: overrides.profiles ?? [PROFILE], ledger: factory, brain_id: brainId, budgetAvailability: (context, account) => runs.budgetAvailability(context, account),
    now: () => clock, meter: createApifyRequestMeter({ ledger: factory, policy: runPolicy, brain_id: brainId }) });
  const runs = createApifyRuns({ authority, consent, ledger: factory, policy: runPolicy, brain_id: brainId, profiles: [PROFILE],
    inference: async () => spent, now: () => clock, sleep: async ms => { clock += ms; }, ...overrides });
  return { consent, runs, ledger };
}
function context(overrides: Partial<ApifyCallContext> = {}): ApifyCallContext {
  return { principal_id: "p-penelope", session_id: "s-voyage", turn_id: "t-1", posture: "interactive",
    approvals: { requestPermission: async request => { asked.push(request); return answer(request); } },
    exposures: () => [], untrusted: event => { untrusted.push(event.operation); }, ...overrides };
}
async function proposal(h: Harness, ctx = context(), input: Record<string, unknown> = INPUT, cap = 2): Promise<string> {
  const found = await h.consent.discover(ctx, { query: "sea charts" });
  const candidate = found.candidates[0]!.candidate;
  await h.consent.inspect(ctx, { candidate });
  return (await h.consent.prepare(ctx, { candidate, input, max_charge_usd: cap })).proposal;
}
type Refusal = ApifyRunError | ApifyConsentError | ApifyAuthorityError;
async function refusal(promise: Promise<unknown>, label: string): Promise<Refusal> {
  try { await promise; } catch (error) {
    if (error instanceof ApifyRunError || error instanceof ApifyConsentError || error instanceof ApifyAuthorityError) return error;
    throw error;
  }
  throw new Error(`${label}: expected a refusal, but the call was admitted`);
}
const starts = () => fake.seen.filter(seen => seen.method === "POST" && seen.path === "/v2/acts/SeaCharts01/runs");
const aborts = () => fake.seen.filter(seen => seen.method === "POST" && seen.path.endsWith("/abort"));
const scope = (ctx = context()) => ({ account_id: ACCOUNT.id, session_id: ctx.session_id, turn_id: ctx.turn_id });
const usdOf = (h: Harness, name: string, ctx = context()) => h.runs.coverage(scope(ctx)).scopes.find(entry => entry.scope === name)!;
const close = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThan(1e-9);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apify-runs-ithaca-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  ledgerPath = join(root, "host-state", "apify-ledger.sqlite");
  fake = fakeApify();
  token = SENTINEL; stored = undefined; clock = START; ledgers = []; asked = []; untrusted = [];
  answer = () => ({ behavior: "allow" });
  spent = { turn_usd: 0, session_usd: 0, day_usd: 0 };
  authority = createApifyAuthority({ policy: governanceApifyPolicy(brain), token: () => token, origin: fake.origin, mcpOrigin: fake.origin, timeoutMs: 400,
    store: { read: () => stored ?? null, write: record => { stored = JSON.parse(JSON.stringify(record)); } } });
  policy();
});
afterEach(() => { for (const ledger of ledgers) ledger.close(); fake.stop(); rmSync(root, { recursive: true, force: true }); });

describe("qualified profiles", () => {
  test("only an all-in pay-per-event, exactly-targeted, fully bounded build qualifies", () => {
    expect(qualifyProfile(PROFILE).id).toBe("odysseus-sea-charts@1");
    const cases: Array<[string, Partial<ApifyQualifiedProfile>]> = [
      ["pay per result", { billing: { ...PROFILE.billing, model: "PRICE_PER_DATASET_ITEM" as "PAY_PER_EVENT" } }],
      ["usage billed separately", { billing: { ...PROFILE.billing, platform_usage: "billed" as "included" } }],
      ["unverified cap", { billing: { ...PROFILE.billing, currency_cap: "unverified" as "verified" } }],
      ["unpriced events", { billing: { ...PROFILE.billing, events: {} } }],
      ["crawler", { site: { ...PROFILE.site, expansion: "same_origin" as "none" } }],
      ["no targets", { targets: [] }],
      ["no work bound", { work_limits: [] }],
      ["unbounded retention", { lifecycle: { ...PROFILE.lifecycle, remote_retention_days: 0 } }],
      ["schema drift", { schema_sha256: "0".repeat(64) }],
      ["robots with permitted origins", { site: { ...PROFILE.site, authorization: "robots" } }],
    ];
    for (const [label, change] of cases) expect(() => qualifyProfile({ ...PROFILE, ...change }), `APIFY_PROFILE_QUALIFY: ${label}`).toThrow();
    const secret = { ...SEA_CHARTS_SCHEMA, properties: { ...SEA_CHARTS_SCHEMA.properties, harbourKey: { type: "string", isSecret: true } } };
    expect(() => qualifyProfile(seaChartsProfile({}, secret)), "APIFY_PROFILE_NO_SECRET").toThrow(/secret/);
    const unknownKeyword = { ...SEA_CHARTS_SCHEMA, properties: { ...SEA_CHARTS_SCHEMA.properties, maxPages: { type: "integer", oneOf: [] } } };
    expect(() => qualifyProfile(seaChartsProfile({}, unknownKeyword)), "APIFY_PROFILE_FULL_SCHEMA").toThrow(/cannot validate/);
  });

  test("prepare preserves ordinary Actor inputs without profile restrictions and still applies the monetary cap", async () => {
    const h = harness();
    const ctx = context();
    const found = await h.consent.discover(ctx, { query: "sea charts" });
    const candidate = found.candidates[0]!.candidate;
    await h.consent.inspect(ctx, { candidate });
    const inputs = [ { ...INPUT, maxPages: 101 }, { harbour: "troy" }, { startUrls: [{ url: "https://troy.example/walls", method: "POST" }] },
      { proxyConfiguration: { useApifyProxy: true }, outputMode: "full", ordinarySecretLabel: "an ordinary label" } ];
    for (const input of inputs) expect((await h.consent.prepare(ctx, { candidate, input, max_charge_usd: 2 })).review.input).toEqual(input);
    await expect(h.consent.prepare(ctx, { candidate, input: INPUT, max_charge_usd: 0.25 })).rejects.toThrow(/minimum run charge/);
  });

  test("a changed price list is visible without requiring a qualified build", async () => {
    const h = harness();
    (fake.pricing[0] as { pricingPerEvent: { actorChargeEvents: Record<string, { eventPriceUsd: number }> } }).pricingPerEvent.actorChargeEvents["chart-page"]!.eventPriceUsd = 0.02;
    const ctx = context();
    const found = await h.consent.discover(ctx, { query: "sea charts" });
    const inspected = await h.consent.inspect(ctx, { candidate: found.candidates[0]!.candidate });
    expect(inspected.eligibility, "APIFY_APPROVED_ACTOR_NOT_PROFILE_GATED").toEqual({ executable: true, reasons: [] });
    expect(inspected.profile_id).toBeNull();
  });
});

describe("dispatch", () => {
  test("terminal preliminary counts retain liability until a later billing observation, including after restart", async () => {
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 0, "chart-page": 0 } },
      { status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    const h = harness({ waitSeconds: 0 });
    const view = await h.runs.run(context(), { proposal: await proposal(h) });
    await h.runs.status(context(), { run: view.run });
    expect(h.runs.accounting(view.run).settled, "APIFY_PRELIMINARY_HOLDS_RESERVATION").toBe(false);
    close(h.runs.accounting(view.run).liability_usd, RESERVED);
    clock += 11_000;
    const restarted = harness({ waitSeconds: 0 });
    await restarted.runs.reconcile();
    expect(restarted.runs.accounting(view.run).settled, "APIFY_LATE_BILLING_RECONCILED").toBe(true);
    close(restarted.runs.accounting(view.run).charged_usd!, SETTLED_EVENTS);
  });

  test("authenticated run totals cover pay-per-usage without an event profile and later totals raise liability", async () => {
    fake.script = [{ status: "SUCCEEDED", usageTotalUsd: 0 }, { status: "SUCCEEDED", usageTotalUsd: 0.125 }];
    const h = harness({ profiles: [], waitSeconds: 0 });
    const view = await h.runs.run(context(), { proposal: await proposal(h) });
    await h.runs.status(context(), { run: view.run });
    expect(h.runs.accounting(view.run).settled).toBe(false);
    clock += 11_000;
    await h.runs.reconcile();
    close(h.runs.accounting(view.run).charged_usd!, 0.125);
    expect(h.runs.accounting(view.run).settled).toBe(true);
    const before = h.runs.accounting(view.run).liability_usd;
    h.ledger.charge(view.run, { counts: {}, status: "SUCCEEDED", micro: 150_000, price_changed: false }, clock);
    close(h.runs.accounting(view.run).liability_usd, before + 0.025);
  });

  test("reserves before one start request that carries the limits as run options, then settles from the charge report", async () => {
    fake.script = [{ status: "RUNNING", counts: { "apify-actor-start": 1, "chart-page": 1 } }, { status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    fake.items = [{ chart: "Ithaca harbour", depth_fathoms: 12 }, { chart: "Pylos approach", depth_fathoms: 9 }, { chart: "Sparta coast", depth_fathoms: 4 }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    expect(starts(), "APIFY_ONE_START").toHaveLength(1);
    const start = starts()[0]!;
    expect(Object.fromEntries(start.query), "APIFY_RUN_OPTIONS").toEqual({ build: "1.4.2", timeout: "600", memory: "1024", maxTotalChargeUsd: "2",
      waitForFinish: "0", restartOnError: "false" });
    // The limits are run options, never smuggled into or read from Actor input.
    expect(start.body, "APIFY_INPUT_UNCHANGED").toEqual(INPUT);
    expect(start.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(start.query.toString(), "APIFY_NO_TOKEN_IN_URL").not.toContain(SENTINEL);
    expect(view).toMatchObject({ state: "succeeded", results: { available: true, partial: false }, remote_outcome_unknown: false });
    expect(JSON.stringify(view), "APIFY_VIEW_NO_ACCOUNTING").not.toMatch(/usd|micro|ledger/);

    const account = h.runs.accounting(view.run);
    expect(account).toMatchObject({ settled: true, cost_basis: "events", remote_run_id: "VoyageRun01", build_number: "1.4.2" });
    close(account.reserved_usd, RESERVED);
    close(account.charged_usd!, SETTLED_EVENTS);
    // Lifecycle requests and remote storage stay owed after the run.
    close(account.liability_usd, SETTLED_EVENTS + 0.008 + 0.000717);
    const turn = usdOf(h, "turn");
    close(turn.residual_usd, 0.008 + 0.000717);
    expect(h.runs.coverage(scope()).coverage, "APIFY_COVERAGE_STATED").toBe(APIFY_COVERAGE);

    const page = await h.runs.results(ctx, { run: view.run, limit: 2 });
    expect(page).toMatchObject({ items: fake.items.slice(0, 2), partial: false, truncated: false, untrusted: true });
    expect(untrusted, "APIFY_RESULTS_TAINT_FIRST").toContain("results");
    const rest = await h.runs.results(ctx, { run: view.run, cursor: page.next_cursor! });
    expect(rest.items).toEqual(fake.items.slice(2));
    expect(fake.seen.some(seen => seen.path.includes("key-value-stores")), "APIFY_SIGNED_OUTPUT_NOT_FOLLOWED").toBe(false);
  });

  test("refuses without limits, without a ledger, past the run cap and past the global budget, before any start", async () => {
    policy({ limits: undefined });
    let h = harness();
    let ctx = context({ turn_id: "t-nolimits" });
    const unset = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_NO_LIMITS");
    expect([unset.code, unset.reason], "APIFY_NO_LIMITS").toEqual(["budget_exceeded", "limits_unset"]);

    policy();
    let broken = false;
    const healthy = openLedger();
    h = harness({ ledgerFactory: () => { if (broken) throw new Error("disk full"); return healthy; } });
    ctx = context({ turn_id: "t-noledger" });
    const ref = await proposal(h, ctx);
    broken = true;
    const unavailable = await refusal(h.runs.run(ctx, { proposal: ref }), "APIFY_LEDGER_UNAVAILABLE");
    expect([unavailable.code, unavailable.reason], "APIFY_LEDGER_UNAVAILABLE").toEqual(["accounting_unavailable", "ledger"]);

    policy({ limits: { ...LIMITS, run_usd: 2 } });
    h = harness();
    ctx = context({ turn_id: "t-runcap" });
    const runCap = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_RUN_USD");
    // The cap alone fits; the cap plus lifecycle and storage does not.
    expect([runCap.code, runCap.reason], "APIFY_RUN_USD_COVERS_LIFECYCLE").toEqual(["budget_exceeded", "run_usd"]);

    policy({}, "budgets: { turn: { warn_usd: 1, block_usd: 4 } }\n");
    spent = { turn_usd: 2.5, session_usd: 2.5, day_usd: 2.5 };
    h = harness();
    ctx = context({ turn_id: "t-global" });
    const global = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_GLOBAL_TURN_BUDGET");
    expect([global.code, global.reason], "APIFY_GLOBAL_TURN_BUDGET").toEqual(["budget_exceeded", "turn_usd"]);

    spent = { turn_usd: 0, session_usd: 0, day_usd: 0 };
    h = harness({ inference: async () => { throw new Error("turn budgets unavailable"); } });
    ctx = context({ turn_id: "t-inference" });
    const blind = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_INFERENCE_UNAVAILABLE");
    expect(blind.code).toBe("accounting_unavailable");
    expect(starts(), "APIFY_REFUSED_NOTHING_STARTED").toEqual([]);
  });

  test("user-approved Actors do not require a host robots or input-target qualification", async () => {
    const h = harness({ profiles: [], waitSeconds: 0, sitePermission: async () => { throw new Error("A host crawler check must not gate the remote service"); } });
    const ctx = context();
    const input = { identifiers: ["odysseus"], mode: "complete", extra: { arbitrary: true } };
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx, input) });
    expect(view.state).toBe("running");
    expect(starts()[0]!.body, "APIFY_GENERIC_INPUT_UNCHANGED").toEqual(input);
  });

  test("a run whose returned identity or options differ is aborted and its results withheld", async () => {
    fake.start = "wrong_build";
    const h = harness();
    const ctx = context();
    const error = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_RUN_VALIDATED");
    expect([error.code, error.reason], "APIFY_RUN_VALIDATED").toEqual(["upstream_incompatible", "run_build"]);
    expect(aborts(), "APIFY_MISMATCH_ABORTED").toHaveLength(1);
    const [row] = h.ledger.unsettled("brain-ithaca");
    expect(row?.validated).toBe(0);
    close(usdOf(h, "turn").liability_usd, RESERVED);
  });
});

describe("races and shared accounting", () => {
  test("two concurrent sessions cannot both spend the account's remaining day", async () => {
    policy({ limits: { ...LIMITS, day_usd: 3 } });
    const h = harness();
    const a = context({ session_id: "s-telemachus", turn_id: "t-a" });
    const b = context({ session_id: "s-eumaeus", turn_id: "t-b" });
    const [pa, pb] = [await proposal(h, a), await proposal(h, b)];
    const outcomes = await Promise.allSettled([h.runs.run(a, { proposal: pa }), h.runs.run(b, { proposal: pb })]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled"), "APIFY_RACE_ONE_ADMITTED").toHaveLength(1);
    const refused = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
    expect([(refused.reason as ApifyRunError).code, (refused.reason as ApifyRunError).reason]).toEqual(["budget_exceeded", "day_usd"]);
    expect(starts(), "APIFY_RACE_ONE_START").toHaveLength(1);
  });

  test("another brain on the same account shares the account-wide day and concurrency limits", async () => {
    policy({ limits: { ...LIMITS, day_usd: 3 } });
    const pylos = join(root, "pylos");
    mkdirSync(join(pylos, "context/policies"), { recursive: true });
    writeFileSync(join(pylos, "context/policies/governance.md"), `---\nschema_version: 1\napify: ${JSON.stringify({ enabled: true, discovery: "allow", actors: "ask", limits: { ...LIMITS, day_usd: 3 } })}\n---\nNestor's brain.\n`);
    const ithaca = harness();
    const ctx = context();
    await ithaca.runs.run(ctx, { proposal: await proposal(ithaca, ctx) });
    const nestorAuthority = createApifyAuthority({ policy: governanceApifyPolicy(pylos), token: () => token, origin: fake.origin, mcpOrigin: fake.origin,
      store: { read: () => null, write: () => undefined } });
    const nestor = harness({ brainPath: pylos, brainId: "brain-pylos", authority: nestorAuthority });
    const other = context({ principal_id: "p-nestor", session_id: "s-pylos" });
    const refused = await refusal(nestor.runs.run(other, { proposal: await proposal(nestor, other) }), "APIFY_ACCOUNT_WIDE_DAY");
    expect([refused.code, refused.reason], "APIFY_ACCOUNT_WIDE_DAY").toEqual(["budget_exceeded", "day_usd"]);
    expect(nestor.ledger.id, "APIFY_SHARED_LEDGER_IDENTITY").toBe(ithaca.ledger.id);
    // Nestor cannot see or touch Ithaca's run.
    const [mine] = ithaca.ledger.unsettled("brain-ithaca");
    const foreign = await refusal(nestor.runs.status(other, { run: mine!.handle }), "APIFY_FOREIGN_HANDLE");
    expect([foreign.code, foreign.reason]).toEqual(["proposal_stale", "unknown_run"]);
  });

  test("two processes racing for the same remaining allowance admit exactly one", async () => {
    const go = join(root, "go");
    const child = join(import.meta.dir, "fixtures", "apify-ledger-race-child.ts");
    openLedger();
    const procs = [0, 1, 2, 3].map(index => Bun.spawn([process.execPath, child, ledgerPath, go, String(index)], { stdout: "pipe", stderr: "pipe" }));
    // Every child has opened the ledger and is waiting at the start line before
    // it opens, so all four contend for the allowance at once.
    const ready = procs.map((_, index) => `${go}.${index}.ready`);
    let outputs: { code: number; out: string; err: string }[];
    try {
      // The deadline is a failure maximum: a child that never gets ready fails
      // the named check instead of the runner's timeout.
      for (const end = Date.now() + 10_000; !ready.every(path => existsSync(path)) && procs.every(proc => proc.exitCode === null) && Date.now() < end;) await Bun.sleep(5);
      expect(ready.every(path => existsSync(path)), "APIFY_RACE_CHILDREN_READY").toBe(true);
      writeFileSync(go, "");
      outputs = await Promise.all(procs.map(async proc => ({ code: await proc.exited, out: (await new Response(proc.stdout).text()).trim(), err: await new Response(proc.stderr).text() })));
    } finally { for (const proc of procs) if (proc.exitCode === null) proc.kill(); }
    for (const output of outputs) expect(output.code, `APIFY_RACE_CHILD_EXIT: ${output.err}`).toBe(0);
    const results = outputs.map(output => output.out);
    expect(results.filter(result => result === "admitted"), `APIFY_TWO_PROCESS_RACE: ${results.join(",")}`).toHaveLength(1);
    expect(results.filter(result => result === "refused:day_usd")).toHaveLength(3);
  });
});

describe("lifecycle evidence", () => {
  test("an unconfirmed start keeps its reservation, is never sent again and needs an operator to resolve", async () => {
    fake.start = "hang";
    const h = harness();
    const ctx = context();
    const ref = await proposal(h, ctx);
    const lost = await refusal(h.runs.run(ctx, { proposal: ref }), "APIFY_UNKNOWN_START");
    expect([lost.code, lost.reason], "APIFY_UNKNOWN_START").toEqual(["remote_outcome_unknown", "start_unconfirmed"]);
    const again = await refusal(h.runs.run(ctx, { proposal: ref }), "APIFY_NO_DUPLICATE_START");
    expect(again.code).toBe("proposal_stale");
    expect(starts(), "APIFY_NO_DUPLICATE_START").toHaveLength(1);
    close(usdOf(h, "day").liability_usd, RESERVED);
    expect(usdOf(h, "day").unknown_runs).toBe(1);

    // Reconciliation never releases it, and no results exist.
    clock += 3_600_000;
    await h.runs.reconcile();
    const [row] = h.ledger.unsettled("brain-ithaca");
    expect(row?.state, "APIFY_UNKNOWN_RETAINED").toBe("unknown");
    close(usdOf(h, "day").liability_usd, RESERVED);
    const noResults = await refusal(h.runs.results(ctx, { run: row!.handle }), "APIFY_UNKNOWN_NO_RESULTS");
    expect(noResults.code).toBe("remote_outcome_unknown");

    const attested = await h.runs.resolveUnknown(row!.handle, { not_started: { attested_by: "penelope (Console runs list)" } });
    expect(attested).toMatchObject({ cost_basis: "operator", liability_usd: 0, note: "operator_not_started:penelope (Console runs list)" });
    expect(usdOf(h, "day").operator_resolved, "APIFY_OPERATOR_RESOLUTION_VISIBLE").toBe(1);
  });

  test("a 5xx or unreadable start is unknown; an operator can attach the run it did start", async () => {
    for (const mode of ["500", "garbage"] as const) {
      fake.start = mode;
      const h = harness();
      const ctx = context({ turn_id: `t-${mode}` });
      const error = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), `APIFY_AMBIGUOUS_${mode}`);
      expect(error.code, `APIFY_AMBIGUOUS_${mode}`).toBe("remote_outcome_unknown");
    }
    // The run did start: Console shows VoyageRun01.
    fake.start = "ok";
    fake.runs.set("VoyageRun01", { query: new URLSearchParams({ build: "1.4.2", timeout: "600", memory: "1024", maxTotalChargeUsd: "2" }), step: 0, aborted: false });
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    const h = harness();
    const [row] = h.ledger.unsettled("brain-ithaca");
    const attached = await h.runs.resolveUnknown(row!.handle, { remote_run: "VoyageRun01" });
    expect(attached).toMatchObject({ remote_run_id: "VoyageRun01", settled: false });
    clock += 11_000;
    await h.runs.reconcile();
    expect(h.runs.accounting(row!.handle)).toMatchObject({ settled: true, cost_basis: "events" });
    expect(starts(), "APIFY_AMBIGUOUS_NOT_RETRIED").toHaveLength(2);
  });

  test("Apify's refusal to start owes nothing; a store failure after the start aborts and keeps liability", async () => {
    fake.start = "402";
    let h = harness();
    let ctx = context({ turn_id: "t-402" });
    const funds = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_START_REJECTED");
    expect(funds.code).toBe("budget_exceeded");
    close(usdOf(h, "turn", ctx).liability_usd, 0);

    fake.start = "ok";
    const real = openLedger();
    const failing: ApifyLedger = { ...real, update: (handle, change, now) => {
      const probe = change(real.get(handle)!);
      if (probe && "remote_run_id" in probe) throw new Error("disk I/O error");
      return real.update(handle, change, now);
    } };
    h = harness({ ledgerFactory: () => failing });
    ctx = context({ turn_id: "t-store" });
    const store = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_STORE_FAILURE");
    expect(store.code, "APIFY_STORE_FAILURE").toBe("accounting_unavailable");
    expect(aborts().map(seen => seen.path), "APIFY_STORE_FAILURE_ABORTS").toEqual(["/v2/actor-runs/VoyageRun01/abort"]);
    clock += 10 * 60_000;
    await harness().runs.reconcile();
    const [row] = real.unsettled("brain-ithaca");
    expect(row?.state, "APIFY_STORE_FAILURE_UNKNOWN").toBe("unknown");
    close(usdOf(h, "turn", ctx).liability_usd, RESERVED);
  });

  test("duplicate and late charge reports raise one liability exactly once", async () => {
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    close(h.runs.accounting(view.run).charged_usd!, SETTLED_EVENTS);
    // The same report again: nothing changes.
    await h.runs.reconcile();
    const duplicate = h.ledger.charge(view.run, { counts: { "apify-actor-start": 1, "chart-page": 3 }, status: "SUCCEEDED", micro: 80_000, price_changed: false }, clock);
    expect(duplicate.fresh, "APIFY_DUPLICATE_RECEIPT").toBe(false);
    close(h.runs.accounting(view.run).liability_usd, SETTLED_EVENTS + 0.008 + 0.000717);
    // A late report with two more pages raises it by their price only.
    h.ledger.charge(view.run, { counts: { "apify-actor-start": 1, "chart-page": 5 }, status: "SUCCEEDED", micro: 100_000, price_changed: false }, clock);
    close(h.runs.accounting(view.run).liability_usd, 0.1 + 0.008 + 0.000717);
    // A stale, lower report never lowers it.
    h.ledger.charge(view.run, { counts: { "apify-actor-start": 1, "chart-page": 2 }, status: "RUNNING", micro: 70_000, price_changed: false }, clock);
    close(h.runs.accounting(view.run).liability_usd, 0.1 + 0.008 + 0.000717);
    close(usdOf(h, "session").liability_usd, 0.1 + 0.008 + 0.000717);
  });

  test("a price the run reports above the qualified one settles at the higher price", async () => {
    const pricingInfo = { pricingModel: "PAY_PER_EVENT", pricingPerEvent: { actorChargeEvents: { "apify-actor-start": { eventPriceUsd: 0.05 }, "chart-page": { eventPriceUsd: 0.03 } } } };
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 }, pricingInfo }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    const account = h.runs.accounting(view.run);
    expect(account.price_changed, "APIFY_PRICE_CHANGE_RECORDED").toBe(true);
    close(account.charged_usd!, 0.05 + 0.09);
  });

  test("a finished run without a priced report keeps its reservation", async () => {
    fake.script = [{ status: "SUCCEEDED" }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    const account = h.runs.accounting(view.run);
    expect(account, "APIFY_MISSING_RECEIPT_RETAINED").toMatchObject({ settled: false, cost_basis: "unknown", charged_usd: 0.05 });
    close(account.liability_usd, RESERVED);
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 1, "sirens-song": 4 } }];
    fake.runs.get("VoyageRun01")!.step = 0;
    await h.runs.reconcile();
    expect(h.runs.accounting(view.run).settled, "APIFY_UNPRICED_EVENT_UNSETTLED").toBe(false);
  });

  test("a restart across UTC midnight keeps the open run's liability on the new day until it settles", async () => {
    policy({ limits: { ...LIMITS, day_usd: 3 } });
    clock = Date.parse("2026-07-12T23:58:00.000Z");
    const first = harness();
    const ctx = context();
    await first.runs.run(ctx, { proposal: await proposal(first, ctx) });
    for (const ledger of ledgers.splice(0)) ledger.close();
    // Restart after midnight: a fresh process, ledger and service.
    clock = Date.parse("2026-07-13T00:05:00.000Z");
    const second = harness();
    expect(utcDay(clock)).toBeGreaterThan(utcDay(Date.parse("2026-07-12T23:58:00.000Z")));
    close(usdOf(second, "day").liability_usd, RESERVED);
    const next = context({ session_id: "s-dawn", turn_id: "t-dawn" });
    const refused = await refusal(second.runs.run(next, { proposal: await proposal(second, next) }), "APIFY_ROLLOVER_HELD");
    expect([refused.code, refused.reason], "APIFY_ROLLOVER_HELD").toEqual(["budget_exceeded", "day_usd"]);
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    await second.runs.reconcile();
    clock += 11_000;
    const summary = await second.runs.reconcile();
    expect(summary.settled).toBe(1);
    // Settled, it belongs to the day it started; the new day is free again.
    close(usdOf(second, "day").liability_usd, 0);
  });
});

describe("stopping work", () => {
  test("a failed remote abort stays unresolved and keeps the liability", async () => {
    fake.abort = "fail";
    const h = harness({ waitSeconds: 0 });
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    expect(view.state).toBe("running");
    const aborted = await h.runs.abort(ctx, { run: view.run });
    expect(aborted.outcome, "APIFY_FAILED_ABORT_UNRESOLVED").toBe("unresolved");
    expect(aborted.warnings.join(" "), "APIFY_ABORT_NOT_ZERO").toMatch(/does not mean nothing was charged/);
    close(h.runs.accounting(view.run).liability_usd, RESERVED);
  });

  test("a confirmed abort still settles only from the charge report", async () => {
    fake.script = [{ status: "RUNNING", counts: { "apify-actor-start": 1, "chart-page": 2 } }];
    const h = harness({ waitSeconds: 0 });
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    const aborted = await h.runs.abort(ctx, { run: view.run });
    expect(aborted.outcome).toBe("confirmed");
    const account = h.runs.accounting(view.run);
    expect(account.state).toBe("aborted");
    close(account.charged_usd!, 0.07);
    expect(account.liability_usd, "APIFY_ABORT_NOT_ZERO_LIABILITY").toBeGreaterThan(0);
  });

  test("local cancellation during the wait, a turn stop and disablement each abort the owned run", async () => {
    const controller = new AbortController();
    const h = harness({ sleep: async ms => { clock += ms; controller.abort(); } });
    const ctx = context({ signal: controller.signal });
    const cancelled = await h.runs.run(ctx, { proposal: await proposal(h, context()) });
    expect([cancelled.state, cancelled.abort], "APIFY_CANCEL_ABORTS").toEqual(["aborted", "confirmed"]);

    const quiet = harness({ waitSeconds: 0 });
    const turn = context({ turn_id: "t-2" });
    const running = await quiet.runs.run(turn, { proposal: await proposal(quiet, turn) });
    const stopped = await quiet.runs.stop({ session_id: turn.session_id, turn_id: turn.turn_id }, "budget_exhausted");
    expect(stopped.map(entry => entry.outcome), "APIFY_BUDGET_STOP_ABORTS").toEqual(["confirmed"]);
    expect(quiet.runs.accounting(running.run).note).toContain("stopped:budget_exhausted");

    const third = context({ turn_id: "t-3" });
    const open = await quiet.runs.run(third, { proposal: await proposal(quiet, third) });
    policy({ enabled: false });
    const disabled = await refusal(quiet.runs.status(third, { run: open.run }), "APIFY_DISABLED_STATUS");
    expect(disabled.code, "APIFY_DISABLED_REFUSES").toBe("provider_disabled");
    expect(quiet.runs.accounting(open.run).abort, "APIFY_DISABLED_ABORTS").toBe("confirmed");
    expect(aborts()).toHaveLength(3);
  });

  test("a run past its runtime is aborted on reconciliation", async () => {
    const h = harness({ waitSeconds: 0 });
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    clock += (600 + 121) * 1000;
    const summary = await h.runs.reconcile();
    expect(summary.aborted, "APIFY_RUNTIME_ABORT").toBe(1);
    expect(h.runs.accounting(view.run).note).toContain("stopped:timeout");
  });
});

describe("results", () => {
  test("results are owned, bounded, expire, and never follow a redirect", async () => {
    policy({ limits: { ...LIMITS, max_result_bytes: 120 } });
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    fake.items = [{ chart: "Ithaca harbour", note: "a".repeat(40) }, { chart: "Pylos approach", note: "b".repeat(40) }, { chart: "Sparta coast", note: "c".repeat(40) }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    const page = await h.runs.results(ctx, { run: view.run, limit: 3 });
    expect(page.items, "APIFY_RESULTS_NOT_CONTENT_LIMITED").toHaveLength(3);
    expect(page.truncated).toBe(false);
    expect(page.next_cursor).toEqual(expect.any(String));
    expect((await h.runs.results(ctx, { run: view.run, cursor: page.next_cursor! })).items).toEqual([]);

    const fork = context({ session_id: "s-forked" });
    const foreign = await refusal(h.runs.results(fork, { run: view.run }), "APIFY_RESULT_OWNERSHIP");
    expect([foreign.code, foreign.reason], "APIFY_RESULT_OWNERSHIP").toEqual(["proposal_stale", "unknown_run"]);
    const forged = await h.runs.results(ctx, { run: view.run, cursor: "a.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).catch(error => error);
    expect(forged, "APIFY_CURSOR_FORGED").toBeInstanceOf(ApifyInputError);
    expect(await h.runs.results(ctx, { run: view.run, limit: 101 }).catch(error => error)).toBeInstanceOf(ApifyInputError);

    fake.itemsRedirect = true;
    policy();
    const redirected = await refusal(h.runs.results(ctx, { run: view.run }), "APIFY_RESULT_REDIRECT");
    expect(redirected.code, "APIFY_RESULT_REDIRECT_REFUSED").toBe("upstream_incompatible");
    expect(fake.seen.some(seen => seen.path.includes("signed")), "APIFY_REDIRECT_NOT_FOLLOWED").toBe(false);

    clock += 86_400_001;
    const expired = await refusal(h.runs.results(ctx, { run: view.run }), "APIFY_RESULT_EXPIRED");
    expect(expired.code, "APIFY_RESULT_EXPIRED").toBe("result_expired");
    // Local expiry releases nothing: remote storage is still owed.
    expect(usdOf(h, "session").residual_usd).toBeGreaterThan(0);
  });

  test("result reads count against the run's reserved allowance and the turn's request bound", async () => {
    fake.script = [{ status: "SUCCEEDED", counts: { "apify-actor-start": 1, "chart-page": 3 } }];
    fake.items = [{ chart: "Ithaca" }, { chart: "Pylos" }, { chart: "Sparta" }];
    const h = harness();
    const ctx = context();
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    for (let read = 0; read < PROFILE.lifecycle.result_requests; read += 1) await h.runs.results(ctx, { run: view.run, limit: 1 });
    const spentReads = await refusal(h.runs.results(ctx, { run: view.run, limit: 1 }), "APIFY_RESULT_REQUESTS");
    expect([spentReads.code, spentReads.reason], "APIFY_RESULT_REQUESTS").toEqual(["budget_exceeded", "result_requests"]);

    policy({ limits: { ...LIMITS, max_requests_per_turn: 4 } });
    const tight = context({ turn_id: "t-tight" });
    await h.consent.discover(tight, { query: "sea charts" });
    const capped = await refusal(h.consent.discover(tight, { query: "sea charts" }).then(() => h.consent.discover(tight, { query: "sea charts" }))
      .then(() => h.consent.discover(tight, { query: "sea charts" })).then(() => h.consent.discover(tight, { query: "sea charts" })), "APIFY_TURN_REQUESTS");
    expect([capped.code, capped.reason], "APIFY_TURN_REQUESTS_DURABLE").toEqual(["budget_exceeded", "requests_per_turn"]);
  });

  test("limits on runs per turn and concurrent runs apply", async () => {
    policy({ limits: { ...LIMITS, max_runs_per_turn: 1, max_concurrent_runs: 1 } });
    const h = harness({ waitSeconds: 0 });
    const ctx = context();
    await h.runs.run(ctx, { proposal: await proposal(h, ctx) });
    const second = await refusal(h.runs.run(ctx, { proposal: await proposal(h, ctx) }), "APIFY_RUNS_PER_TURN");
    expect([second.code, second.reason]).toEqual(["budget_exceeded", "max_runs_per_turn"]);
    const other = context({ session_id: "s-other", turn_id: "t-other" });
    const concurrent = await refusal(h.runs.run(other, { proposal: await proposal(h, other) }), "APIFY_CONCURRENT");
    expect([concurrent.code, concurrent.reason]).toEqual(["budget_exceeded", "max_concurrent_runs"]);
    expect(starts()).toHaveLength(1);
  });
});

describe("Actor-scoped approval and module availability", () => {
  test("approve always persists for one Actor across sessions and restarts, revokes, and stays principal/brain scoped", async () => {
    policy({ limits: { ...LIMITS, max_concurrent_runs: 10 } });
    const h = harness({ profiles: [], waitSeconds: 0 });
    const first = context();
    expect(await h.consent.availability(first, "SeaCharts01")).toMatchObject({ state: "approval_required" });
    expect(starts()).toHaveLength(0);
    answer = () => ({ behavior: "allow", always: true });
    await h.runs.run(first, { proposal: await proposal(h, first, { publicIdentifiers: ["odysseus"] }) });
    expect(asked.at(-1)?.kind, "APIFY_ACTOR_SPECIFIC_CARD").toBe("actor");
    const before = asked.length;
    answer = () => ({ behavior: "deny", message: "An unexpected card must not be accepted" });
    const restarted = harness({ profiles: [], waitSeconds: 0 });
    const next = context({ session_id: "s-pylos", turn_id: "t-pylos" });
    expect(await restarted.consent.availability(next, "SeaCharts01")).toMatchObject({ state: "ready" });
    const searches = () => fake.seen.filter(entry => (entry.body as { params?: { name?: string } } | null)?.params?.name === "search-actors").length;
    const beforeSearches = searches();
    const approved = await restarted.consent.approvals(next);
    const candidate = approved[0]!.candidate!;
    expect(typeof candidate, "APIFY_APPROVED_HOST_CANDIDATE").toBe("string");
    await expect(restarted.consent.inspect(context(), { candidate }), "APIFY_APPROVED_CANDIDATE_SESSION_BOUND").rejects.toMatchObject({ reason: "unknown_reference" });
    await expect(restarted.consent.inspect(context({ ...next, principal_id: "p-antinous" }), { candidate }), "APIFY_APPROVED_CANDIDATE_PRINCIPAL_BOUND").rejects.toMatchObject({ reason: "unknown_reference" });
    await restarted.consent.inspect(next, { candidate });
    const prepared = await restarted.consent.prepare(next, { candidate, input: { mode: "another input", nested: { value: 1 } }, max_charge_usd: 2 });
    await restarted.runs.run(next, { proposal: prepared.proposal });
    expect(searches(), "APIFY_APPROVED_RESTART_NO_SEARCH").toBe(beforeSearches);
    expect(asked.length, "APIFY_ALWAYS_SURVIVES_SESSION_RESTART").toBe(before);
    expect(h.ledger.actorApprovals({ brain_id: "brain-ithaca", principal_id: first.principal_id, account_id: "SuitorsHall02" })).toEqual([]);
    expect(await restarted.consent.availability(next, "SirenSong02")).toMatchObject({ state: "approval_required" });
    expect(await restarted.consent.availability(context({ principal_id: "p-antinous" }), "SeaCharts01")).toMatchObject({ state: "approval_required" });
    expect(await harness({ brainId: "brain-pylos" }).consent.availability(next, "SeaCharts01")).toMatchObject({ state: "approval_required" });
    await restarted.consent.revoke(next, "SeaCharts01");
    expect(await h.consent.availability(first, "SeaCharts01")).toMatchObject({ state: "approval_required" });
    expect(await restarted.consent.approvals(next)).toEqual([]);
  });

  test("a remembered candidate preserves discovery policy and rechecks revocation at execution", async () => {
    const h = harness({ profiles: [], waitSeconds: 0 });
    const ctx = context();
    h.ledger.setActorApproval({ brain_id: "brain-ithaca", principal_id: ctx.principal_id, account_id: ACCOUNT.id },
      { actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: clock }, true);
    const candidate = (await h.consent.approvals(ctx))[0]!.candidate!;
    policy({ discovery: "deny" });
    const before = fake.seen.length;
    await expect(h.consent.inspect(ctx, { candidate }), "APIFY_APPROVED_INSPECTION_POLICY").rejects.toMatchObject({ reason: "discovery_denied" });
    expect(fake.seen).toHaveLength(before);
    policy();
    await h.consent.inspect(ctx, { candidate });
    const prepared = await h.consent.prepare(ctx, { candidate, input: INPUT, max_charge_usd: 2 });
    await h.consent.revoke(ctx, "SeaCharts01");
    answer = () => ({ behavior: "deny", message: "This Actor was revoked." });
    await expect(h.runs.run(ctx, { proposal: prepared.proposal }), "APIFY_REUSABLE_REFERENCE_NOT_APPROVAL").rejects.toMatchObject({ reason: "declined" });
    expect(asked.map(request => request.kind)).toEqual(["actor"]);
    expect(starts()).toHaveLength(0);
  });

  test("unavailable providers list remembered approvals without issuing candidate references", async () => {
    const h = harness();
    const ctx = context();
    await authority.status();
    h.ledger.setActorApproval({ brain_id: "brain-ithaca", principal_id: ctx.principal_id, account_id: ACCOUNT.id },
      { actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: clock }, true);
    const before = fake.seen.length;
    policy({ enabled: false });
    expect(await h.consent.approvals(ctx)).toEqual([{ actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: clock, candidate: null }]);
    expect(fake.seen).toHaveLength(before);
    expect(await h.consent.approvals(context({ principal_id: "p-antinous" }))).toEqual([]);
    policy();
    token = undefined;
    expect((await h.consent.approvals(ctx))[0]!.candidate).toBeNull();
    expect(starts()).toHaveLength(0);
  });

  test("a large approval list never returns a candidate that its own bounded insertion evicts", async () => {
    const h = harness();
    const ctx = context();
    const scope = { brain_id: "brain-ithaca", principal_id: ctx.principal_id, account_id: ACCOUNT.id };
    for (let index = 0; index < 200; index += 1) h.ledger.setActorApproval(scope,
      { actor_id: `IthacaActor${index}`, actor: `odysseus/charts-${index}`, approved_at: clock - 200 + index }, true);
    h.ledger.setActorApproval(scope, { actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: clock }, true);
    const approved = await h.consent.approvals(ctx);
    expect(approved).toHaveLength(201);
    expect(approved[0]!.candidate, "APIFY_APPROVED_REFERENCE_BOUND").toBeNull();
    expect(approved.filter(entry => entry.candidate !== null)).toHaveLength(200);
    // At capacity, listing again evicts the previous list, but keeps all newly returned references.
    const again = await h.consent.approvals(ctx);
    const candidate = again.at(-1)!.candidate!;
    expect(candidate).not.toBe(approved.at(-1)!.candidate);
    expect((await h.consent.inspect(ctx, { candidate })).actor_id).toBe("SeaCharts01");
    expect(starts()).toHaveLength(0);
  });

  test("revocation racing admission is checked inside the reservation transaction", async () => {
    const h = harness({ profiles: [], waitSeconds: 0 });
    answer = () => ({ behavior: "allow", always: true });
    await h.runs.run(context(), { proposal: await proposal(h) });
    const scope = { brain_id: "brain-ithaca", principal_id: "p-penelope", account_id: ACCOUNT.id };
    const racing = harness({ profiles: [], waitSeconds: 0, ledgerFactory: () => {
      const store = openLedger();
      return { ...store, reserve(...args: Parameters<ApifyLedger["reserve"]>) {
        store.setActorApproval(scope, { actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: clock }, false);
        return store.reserve(...args);
      } };
    } });
    const ctx = context({ session_id: "s-race", turn_id: "t-race" });
    const pending = await proposal(racing, ctx);
    await expect(racing.runs.run(ctx, { proposal: pending }), "APIFY_REVOKE_BEFORE_RESERVE").rejects.toMatchObject({ reason: "approval_revoked" });
    expect(starts()).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  test("approve once and deny create no remembered Actor grant", async () => {
    const h = harness({ profiles: [], waitSeconds: 0 });
    const ctx = context();
    await h.runs.run(ctx, { proposal: await proposal(h, ctx, {}) });
    expect(await h.consent.availability(ctx, "SeaCharts01")).toMatchObject({ state: "approval_required" });
    answer = () => ({ behavior: "deny", message: "No" });
    const pending = await proposal(h, ctx, { arbitrary: true });
    await expect(h.runs.run(ctx, { proposal: pending })).rejects.toMatchObject({ reason: "declined" });
    expect(starts()).toHaveLength(1);
    expect(await h.consent.approvals(ctx)).toEqual([]);
  });

  test("credential extraction is blocked in inputs and outputs without filtering ordinary Actor fields", async () => {
    const h = harness({ profiles: [], waitSeconds: 0 });
    const ctx = context();
    const found = await h.consent.discover(ctx, { query: "sea charts" });
    const candidate = found.candidates[0]!.candidate;
    await h.consent.inspect(ctx, { candidate });
    for (const input of [{ token: SENTINEL }, { script: "cat /proc/self/environ" }])
      await expect(h.consent.prepare(ctx, { candidate, input, max_charge_usd: 2 })).rejects.toMatchObject({ reason: "credential_extraction" });
    expect(starts(), "APIFY_CREDENTIAL_INPUT_NEVER_DISPATCHED").toHaveLength(0);
    const input = { credentialLabel: "Authentication configuration", harbourKey: "an ordinary user-supplied value", extra: ["odysseus"] };
    const view = await h.runs.run(ctx, { proposal: await proposal(h, ctx, input) });
    const ordinary = { captain: "Odysseus", details: "x".repeat(10_000), fields: ["email", "authentication"] };
    fake.items = [ordinary];
    expect((await h.runs.results(ctx, { run: view.run })).items, "APIFY_ORDINARY_OUTPUT_UNCHANGED").toEqual([ordinary]);
    fake.items = [{ recovered: SENTINEL }];
    await expect(h.runs.results(ctx, { run: view.run })).rejects.toMatchObject({ reason: "credential_extraction" });
  });

  test("module availability exposes disabled, missing authentication, approval and budget states without dispatch", async () => {
    const h = harness({ profiles: [], waitSeconds: 0 });
    const ctx = context();
    policy({ enabled: false });
    expect(await h.consent.availability(ctx)).toMatchObject({ state: "unavailable", reason: "not_enabled" });
    policy(); token = undefined;
    expect(await h.consent.availability(ctx)).toMatchObject({ state: "unavailable", reason: "token_missing" });
    token = SENTINEL;
    expect(await h.consent.availability(ctx, "SeaCharts01")).toMatchObject({ state: "approval_required" });
    policy({ limits: { ...LIMITS, day_usd: 0 } });
    expect(await h.consent.availability(ctx)).toMatchObject({ state: "unavailable", reason: "budget_exhausted" });
    expect(starts()).toHaveLength(0);
    expect(asked).toEqual([]);
  });
});
