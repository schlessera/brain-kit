/**
 * Real-provider verification of the restricted inference relay and the gated
 * dispatcher (#1548). Opt-in, paid, never run by tests or CI.
 *
 * One staged Odysseus arrival goes through the fixture-host activation of the
 * production dispatcher (`INBOX_DISPATCH_FIXTURE`) with one installed
 * first-party runtime, in the restricted envelope, and its inference upstream
 * set to the real provider. T1 classification stays the keyless fixture; only
 * the agent tier reaches the provider, and only through the server's relay.
 *
 *   bun scripts/measure-real-provider-dispatch.ts <profile> --out <dir> [--spent-before <usd>] [--dry-run]
 *
 * Profiles: `claude-api` (needs ANTHROPIC_API_KEY), `claude-subscription`
 * (needs CLAUDE_CODE_OAUTH_TOKEN), `pi-api` (needs ANTHROPIC_API_KEY). The
 * parent passes the server stage only that one credential, a disposable home
 * and empty runtime config directories. `--dry-run` swaps the provider for a
 * keyless loopback fixture and a fake credential, to exercise the harness
 * before a paid run.
 *
 * Bounds enforced here as well as by the server's own budget admission: the
 * authorized model only, at most MAX_MESSAGES inference requests, and a spend
 * guard that refuses a request whose estimate (observed spend so far, its body
 * priced as 1h cache writes, and OUTPUT_ALLOWANCE) would take the run past
 * MAX_RUN_USD, or past TOTAL_USD given `--spent-before` (earlier runs' actual
 * spend). The receipt records method and path, never headers or
 * bodies, and credentials only as placeholder/empty/absent/other classes.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { SONNET55_USD_PER_MTOK } from "./measure-sonnet55-cost";

const REPO = resolve(import.meta.dir, "..");
const MODEL = "claude-sonnet-5-5";
const MAX_MESSAGES = 8;
const MAX_RUN_USD = 1;
/** Hard stop on actual provider spend across every run of a verification. */
const TOTAL_USD = 2;
const PLACEHOLDER = "brain-inference-relay-placeholder";
const PROVIDER = "https://api.anthropic.com";
const CREDENTIAL_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const PROFILES = {
  "claude-api": { adapter: "claude", billing: "api", credential: "ANTHROPIC_API_KEY" },
  "claude-subscription": { adapter: "claude", billing: "subscription", credential: "CLAUDE_CODE_OAUTH_TOKEN" },
  "pi-api": { adapter: "pi", billing: "api", credential: "ANTHROPIC_API_KEY" },
} as const;
type ProfileName = keyof typeof PROFILES;
const SECRET = "measurement-cookie-secret-0123456789abcdef";
const ARRIVAL = { title: "From the harbor", text: "Penelope asks that her loom be recorded in Ithaca's notes." };

/**
 * Output a request is assumed to spend before its usage arrives. The runtimes
 * ask for up to the model's 128k, which alone would price past the run cap, and
 * thinking is billed without being streamed, so a response cannot be metered
 * mid-flight. Spent usage is exact after each response; this allowance bounds
 * the next one.
 */
const OUTPUT_ALLOWANCE = 16_000;
/** Conservative per-token rates for the guard: 1h cache writes and the older cache-read rate. */
const GUARD = { input: SONNET55_USD_PER_MTOK.input / 1e6, output: SONNET55_USD_PER_MTOK.output / 1e6,
  cacheRead: 0.2 / 1e6, cacheWrite: SONNET55_USD_PER_MTOK.cacheWrite1h / 1e6 };

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/measure-real-provider-dispatch.ts <${Object.keys(PROFILES).join("|")}> --out <dir> [--spent-before <usd>] [--dry-run]`);
  process.exit(2);
}

async function parent(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[0] as ProfileName;
  const profile = PROFILES[name];
  if (!profile) usage("Unknown profile");
  const outIndex = args.indexOf("--out");
  const out = outIndex > 0 ? args[outIndex + 1] : undefined;
  if (!out) usage("--out is required");
  const dry = args.includes("--dry-run");
  const priorIndex = args.indexOf("--spent-before");
  const prior = priorIndex > 0 ? Number(args[priorIndex + 1]) : 0;
  if (!Number.isFinite(prior) || prior < 0 || prior >= TOTAL_USD) usage("--spent-before must be a USD amount below the total cap");
  const credential = dry ? `odysseus-dry-run-${crypto.randomUUID()}` : process.env[profile.credential]?.trim();
  if (!credential) usage(`${profile.credential} is not set`);
  const root = mkdtempSync(join(tmpdir(), "real-provider-dispatch-"));
  for (const dir of ["home", "claude", "pi", "run"]) mkdirSync(join(root, dir), { recursive: true });
  // One attempt: pi retries nothing, compacts nothing and warms no cache.
  writeFileSync(join(root, "pi/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
  const child = Bun.spawn([process.execPath, import.meta.path, "--server", name, root, dry ? "dry" : "live", String(prior)], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: join(root, "home"), TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(root, "claude"), PI_CODING_AGENT_DIR: join(root, "pi"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", [profile.credential]: credential } });
  const [exit, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
  const receiptPath = join(root, "receipt.json");
  const text = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null;
  const logs = `${stdout}\n${stderr}`;
  rmSync(root, { recursive: true, force: true });
  // Nothing that carries the credential leaves this process.
  if (text?.includes(credential) || logs.includes(credential)) {
    console.error("Refusing to write output: the credential value appeared in it.");
    process.exit(3);
  }
  mkdirSync(out, { recursive: true });
  if (text) writeFileSync(join(out, `${name}${dry ? "-dry" : ""}.json`), text);
  writeFileSync(join(out, `${name}${dry ? "-dry" : ""}.log`), logs.slice(-20_000));
  const spent = text ? (JSON.parse(text) as { harnessUsage: { guardSpentUsd: number } }).harnessUsage.guardSpentUsd : null;
  console.log(JSON.stringify({ profile: name, dry, exit, guardSpentUsd: spent, receipt: text ? join(out, `${name}${dry ? "-dry" : ""}.json`) : null }));
  process.exit(exit === 0 && text ? 0 : 1);
}

type CredentialClass = "placeholder" | "empty" | "absent" | "other";

async function server(name: ProfileName, root: string, mode: "dry" | "live", prior: number): Promise<void> {
  const profile = PROFILES[name];
  // The run may spend what remains of the total, and never more than its own cap.
  const runCap = Math.min(MAX_RUN_USD, TOTAL_USD - prior);
  const credential = process.env[profile.credential]!;
  const brainPath = join(root, "brain");
  const NOTE = "notes/ithaca-loom.md";

  cpSync(join(REPO, "packages/core/fixtures/corpus"), brainPath, { recursive: true });
  const config = join(brainPath, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(join(REPO, "packages/core/src/index.ts"))));
  // A fresh offline price table, so no catalog fetch happens: T1 is the keyless
  // fixture model, the agent tier is Sonnet 5.5 at its list rates.
  mkdirSync(join(brainPath, ".brain-ui"), { recursive: true });
  const later = Date.now() + 3_600_000;
  const r = SONNET55_USD_PER_MTOK;
  writeFileSync(join(brainPath, ".brain-ui/model-pricing.json"), JSON.stringify({ version: 1, fetchedAt: later,
    litellm: { fetchedAt: later, rates: { "jev-1.13.0": { input: 4.2e-8, output: 0, cacheRead: null, cacheWrite: null },
      [MODEL]: { input: r.input / 1e6, output: r.output / 1e6, cacheRead: r.cacheRead / 1e6, cacheWrite: r.cacheWrite5m / 1e6 } } },
    openrouter: { fetchedAt: later, rates: {} } }));

  // Dry run: a keyless loopback model that proposes the note, then finishes.
  let fixture: ReturnType<typeof Bun.serve> | undefined;
  const fixtureMaxTokens: number[] = [];
  const injected: boolean[] = [];
  if (mode === "dry") {
    fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      injected.push((request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /i, "")) === credential);
      const body = await request.json() as { max_tokens?: number; messages?: Array<{ role: string }>; tools?: Array<{ name: string }> };
      if (typeof body.max_tokens === "number") fixtureMaxTokens.push(body.max_tokens);
      const write = (body.tools ?? []).map(t => t.name).find(n => n.endsWith("write_file"));
      const step = (body.messages ?? []).filter(m => m.role === "assistant").length;
      const call = step === 0 && write ? { name: write, input: { path: NOTE, expectedBaseHash: null, content: "Penelope keeps the loom.\n" } } : null;
      const events: unknown[] = [{ type: "message_start", message: { id: "msg_dry", type: "message", role: "assistant", model: MODEL, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
      if (call) events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_dry", name: call.name, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }, { type: "content_block_stop", index: 0 });
      else events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }, { type: "content_block_stop", index: 0 });
      events.push({ type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
      return new Response(events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
  }
  const upstream = fixture ? `http://127.0.0.1:${fixture.port}` : PROVIDER;
  if (profile.adapter === "pi" && fixture) writeFileSync(join(root, "pi/models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: upstream } } }));

  const classify = (value: string | undefined): CredentialClass =>
    value === undefined ? "absent" : value === "" ? "empty" : value === PLACEHOLDER ? "placeholder" : "other";
  // --- Observation: the relay socket, the upstream transport and worker launches.
  const relayEvents: Array<{ method: string; path: string; status: number; inbound: Record<string, CredentialClass> }> = [];
  let relays = 0;
  const realServe = Bun.serve;
  Bun.serve = ((options: any) => {
    if (typeof options?.unix === "string" && /\/brain-inference-[^/]+\/relay\.sock$/.test(options.unix)) {
      relays++;
      const inner = options.fetch;
      options = { ...options, async fetch(request: Request, owner: unknown) {
        const method = request.method, path = new URL(request.url).pathname;
        // What the worker itself presented, as a class: the relay replaces it.
        const inbound = { "x-api-key": classify(request.headers.get("x-api-key") ?? undefined),
          authorization: classify(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? undefined) };
        const response: Response = await inner.call(this, request, owner);
        relayEvents.push({ method, path, status: response.status, inbound });
        return response;
      } };
    }
    return realServe(options);
  }) as typeof Bun.serve;

  const forwarded: Array<{ method: string; path: string; status: number | null; model: string | null; refused?: string }> = [];
  const blocked: Array<{ method: string; path: string; loopback: false }> = [];
  const observedModels = new Set<string>();
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheCreationTokens: 0 };
  let messages = 0, spentUsd = 0, pendingUsd = 0, usageMissing = 0;
  const guardStops: string[] = [];
  const upstreamOrigin = new URL(upstream).origin;
  const realFetch = globalThis.fetch;
  const refuse = (message: string) => Response.json({ type: "error", error: { type: "invalid_request_error", message: `measurement guard: ${message}` } }, { status: 400 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== upstreamOrigin) {
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return realFetch(input as any, init);
      blocked.push({ method, path: url.pathname, loopback: false });
      throw new Error("measurement guard: egress outside the inference upstream");
    }
    const raw = init?.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    let body: { model?: unknown; max_tokens?: unknown } = {};
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* recorded as model null */ }
    const model = typeof body.model === "string" ? body.model : null;
    const entry: (typeof forwarded)[number] = { method, path: url.pathname, status: null, model };
    forwarded.push(entry);
    if (method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) { entry.refused = "route"; guardStops.push("route"); return refuse("route"); }
    if (model !== MODEL) { entry.refused = "model"; guardStops.push(`model ${model}`); return refuse("model"); }
    let estimate = 0;
    if (url.pathname === "/v1/messages") {
      if (messages >= MAX_MESSAGES) { entry.refused = "turns"; guardStops.push("turns"); return refuse("turn cap"); }
      const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : OUTPUT_ALLOWANCE;
      estimate = (raw.byteLength / 3) * GUARD.cacheWrite + Math.min(maxTokens, OUTPUT_ALLOWANCE) * GUARD.output;
      if (profile.billing === "api" && spentUsd + pendingUsd + estimate > runCap) {
        entry.refused = "spend"; guardStops.push(`spend ${(spentUsd + pendingUsd + estimate).toFixed(4)}`); return refuse("spend cap");
      }
      messages++;
    }
    pendingUsd += estimate;
    let response: Response;
    try { response = await realFetch(input as any, init); }
    catch (error) { pendingUsd -= estimate; spentUsd += estimate; throw error; }
    entry.status = response.status;
    if (url.pathname !== "/v1/messages" || !response.body) { pendingUsd -= estimate; return response; }
    // Read usage from a copy of the stream; the runtime gets the original.
    const [mine, theirs] = response.body.tee();
    void (async () => {
      let found = false, cost = 0;
      try {
        const text = await new Response(mine).text();
        const events = text.trimStart().startsWith("{") ? [{ type: "json", message: JSON.parse(text) }]
          : text.split("\n").filter(l => l.startsWith("data: ")).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
        let start: any = null, output = 0;
        for (const e of events as any[]) {
          if (e.type === "message_start") start = e.message;
          if (e.type === "json") { start = e.message; output = e.message?.usage?.output_tokens ?? 0; }
          if (e.type === "message_delta" && typeof e.usage?.output_tokens === "number") output = e.usage.output_tokens;
        }
        const u = start?.usage;
        if (typeof start?.model === "string") observedModels.add(start.model);
        if (u && typeof u.input_tokens === "number") {
          found = true;
          const read = u.cache_read_input_tokens ?? 0, creation = u.cache_creation_input_tokens ?? 0;
          const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          usageTotals.inputTokens += u.input_tokens; usageTotals.outputTokens += output; usageTotals.cacheReadTokens += read;
          usageTotals.cacheCreationTokens += creation; usageTotals.cacheCreation1hTokens += oneHour;
          usageTotals.cacheCreation5mTokens += u.cache_creation?.ephemeral_5m_input_tokens ?? (creation - oneHour);
          cost = u.input_tokens * GUARD.input + output * GUARD.output + read * GUARD.cacheRead + creation * GUARD.cacheWrite;
        }
      } catch { /* missing usage keeps the estimate */ }
      if (!found) usageMissing++;
      pendingUsd -= estimate;
      spentUsd += found ? cost : estimate;
    })();
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;

  const carries = (values: Iterable<string>) => [...values].some(v => v.includes(credential));
  const launches: Array<{ restricted: boolean; command: string; envNames: string[]; credentials: Record<string, CredentialClass>; realCredential: boolean }> = [];
  const processes = new Map<number, { comm: string; credentials: Record<string, CredentialClass>; realCredential: boolean }>();
  let unreadable = 0;
  const watched = new Set<number>();
  const scan = () => {
    const parents = new Map<number, number>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try { const stat = readFileSync(`/proc/${entry}/stat`, "utf8"); parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])); }
      catch { /* exited */ }
    }
    const tree = new Set<number>([...watched].filter(pid => parents.has(pid)));
    for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of parents) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
    for (const pid of tree) {
      if (processes.has(pid)) continue;
      try {
        const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(kv => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as [string, string]));
        processes.set(pid, { comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
          credentials: Object.fromEntries(CREDENTIAL_NAMES.map(n => [n, classify(env.get(n))])), realCredential: carries(env.values()) });
      } catch { unreadable++; }
    }
  };
  const poll = setInterval(scan, 100);
  const realSpawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const options = (Array.isArray(args[0]) ? args[1] : args[0]) as { env?: Record<string, string> } | undefined;
    const launch = options?.env?.BRAIN_WORKER_LAUNCH;
    const child = realSpawn(...args);
    if (launch && !launch.includes("worker-boundary-pass")) {
      const spec = JSON.parse(launch) as { env?: Record<string, string>; argv: string[] };
      const env = new Map(Object.entries(spec.env ?? {}));
      for (let i = 0; i < spec.argv.length; i++) if (spec.argv[i] === "--setenv") env.set(spec.argv[i + 1]!, spec.argv[i + 2]!);
      const command = spec.argv[spec.argv.lastIndexOf("--") + 1] ?? "";
      launches.push({ restricted: spec.argv.includes("--unshare-net"),
        command: command.startsWith(`${REPO}/`) ? relative(REPO, command) : basename(command), envNames: [...env.keys()].sort(),
        credentials: Object.fromEntries(CREDENTIAL_NAMES.map(n => [n, classify(env.get(n))])),
        realCredential: carries([...env.values(), launch]) });
      watched.add(child.pid);
      scan();
    }
    return child;
  }) as typeof Bun.spawn;

  // --- The app, as the fixture host boots it, with an installed runtime.
  const { createApp } = await import("../packages/ui-server/src/app.js");
  const { resolveServerConfig } = await import("../packages/ui-server/src/config/env.js");
  const { createStaticBackendRegistry } = await import("../packages/ui-server/src/agent/backend.js");
  const { createSilentObservability } = await import("../packages/ui-server/src/observability/index.js");
  const { createPrincipal } = await import("../packages/ui-server/src/db/principals.js");
  const { createInboxStore } = await import("../packages/ui-server/src/inbox/store.js");
  const { INBOX_DISPATCH_FIXTURE } = await import("../packages/ui-server/src/inbox/dispatch-fixture.js");
  const { createClaudeBackend, defineProfiles } = await import("../packages/ui-backend-claude/src/index.js");
  const { createPiBackend } = await import("../packages/ui-backend-pi/src/backend.js");
  const { serializeSigned } = await import("hono/utils/cookie");

  const backend = profile.adapter === "claude"
    ? createClaudeBackend({ brainPath, log: () => {}, profiles: defineProfiles([{ id: name, label: name, model: MODEL,
      ...(profile.billing === "api" ? { apiKeyEnv: "ANTHROPIC_API_KEY" } : {}), ...(fixture ? { baseUrl: upstream } : {}) }]) })
    : createPiBackend({ brainPath, sessionDir: join(root, "pi-sessions"), confirmBashPatterns: [], loadExtensions: false,
      profiles: [{ id: name, label: name, vendor: "anthropic", model: MODEL }] });
  // Admission estimate: priced at list rates this reserves $0.915, inside the $1.00 day cap.
  const maximumTokens = { inputTokens: 150_000, outputTokens: 20_000, cacheReadTokens: 400_000, cacheCreationTokens: 150_000 };
  const classification = async (_url: string, init: { body?: unknown }) => {
    const ids = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(ids.map(id => [id,
      { type: "choice", choice: "needs_agent", confidence: 0.9, probabilities: { drop: 0.03, rule: 0.03, needs_agent: 0.91, needs_user: 0.03 } }])) });
  };
  const tokenFile = join(root, "run/inbox-poke.token");
  const app = await createApp({
    config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "measurement-hash", COOKIE_SECRET: SECRET, HOST: "127.0.0.1",
      DB_PATH: join(root, "ui.sqlite"), BRAIN_PATH: brainPath, BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "1",
      BRAIN_UI_INBOX_POKE_TOKEN_FILE: tokenFile, BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "2", BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY: String(MAX_RUN_USD),
      BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD: "0", BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS: "0" }),
    observability: createSilentObservability(),
    registry: createStaticBackendRegistry([backend], backend.id),
    [INBOX_DISPATCH_FIXTURE]: { classificationKey: "measurement-classification-key", fetch: classification,
      select: async (registry: { getDefaultBackend(): Promise<typeof backend> }) => ({ backend: await registry.getDefaultBackend(), profileId: name,
        model: MODEL, billingMode: profile.billing, maximumTokens }) },
  } as Parameters<typeof createApp>[0]);
  const listener = realServe({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  const origin = `http://127.0.0.1:${listener.port}`;
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const cookie = await serializeSigned("brain_ui_session", principal.id, SECRET);

  const form = new FormData();
  form.set("title", ARRIVAL.title);
  form.set("text", ARRIVAL.text);
  const shared = await realFetch(`${origin}/api/share`, { method: "POST", headers: { cookie, origin }, body: form });
  const startedAt = Date.now();
  const poke = await (await realFetch(`${origin}/api/internal/inbox/poke`, { method: "POST",
    headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` } })).json() as Record<string, unknown>;
  const durationMs = Date.now() - startedAt;
  for (let i = 0; i < 50 && pendingUsd > 0; i++) await Bun.sleep(100);
  scan();
  clearInterval(poll);

  const store = createInboxStore(app.db);
  const snapshot = store.snapshot();
  const runs = app.db.query(`SELECT r.run_id, r.origin, r.outcome, r.billing_mode, r.input_tokens, r.output_tokens, r.cache_read_tokens,
    r.cache_creation_tokens, r.cost_usd, r.effective_cost_usd, r.ended_at IS NOT NULL AS ended FROM activity_run_rollups r ORDER BY r.started_at`).all() as Array<Record<string, unknown>>;
  const reservations = app.db.query(`SELECT run_id, purpose, model, billing_mode, reserve_kind, reserved_cost_usd, reserved_turns, status,
    charged_cost_usd, charged_turns, observed_cost_usd, observed_billing_mode FROM inbox_budget_reservations ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  /** What the decision is about, without its model-authored text: a tool name, a proposal or a question. */
  const escalation = (item: unknown): string => {
    const title = String((item as { payload?: { title?: unknown } }).payload?.title ?? "");
    return title.match(/^Queued work asked to use ([\w.-]+)$/)?.[1] ?? (title.startsWith("Apply a change to ") ? "proposal" : "question");
  };
  const runIds = new Map<string, string>();
  const runLabel = (id: unknown) => typeof id === "string" ? (runIds.get(id) ?? runIds.set(id, `run-${runIds.size + 1}`).get(id)!) : null;
  const version = (pkg: string) => JSON.parse(readFileSync(join(REPO, "node_modules", pkg, "package.json"), "utf8")).version as string;
  const cli = join(REPO, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
  const run = (cmd: string[], env?: Record<string, string>) => Bun.spawnSync(cmd, { cwd: REPO, env, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  const receipt = {
    profile: name, mode, adapter: profile.adapter, billingMode: profile.billing, model: MODEL,
    upstream: mode === "live" ? PROVIDER : "loopback fixture",
    brainKitSha: run(["git", "rev-parse", "HEAD"]),
    versions: { "@anthropic-ai/claude-agent-sdk": version("@anthropic-ai/claude-agent-sdk"),
      claudeCli: existsSync(cli) ? run([cli, "--version"], { PATH: "/usr/bin:/bin", HOME: join(root, "home") }) : null,
      "@earendil-works/pi-coding-agent": version("@earendil-works/pi-coding-agent"), "@earendil-works/pi-ai": version("@earendil-works/pi-ai"),
      bun: Bun.version, bubblewrap: run(["bwrap", "--version"]) },
    bounds: { maxMessages: MAX_MESSAGES, maxRunUsd: MAX_RUN_USD, totalUsd: TOTAL_USD, spentBefore: prior, runCap, maximumTokens },
    share: { status: shared.status }, poke, durationMs,
    items: snapshot.items.map(item => ({ queue: item.queue, type: item.type, status: item.status, attempts: (item as { attempts?: number }).attempts,
      options: (item as { options?: Array<{ id: string }> }).options?.map(o => o.id), ...(item.queue === "actions" ? { escalation: escalation(item) } : {}) })),
    relay: { started: relays, events: relayEvents },
    upstreamRequests: forwarded, blockedEgress: blocked, guardStops, observedModels: [...observedModels],
    harnessUsage: { ...usageTotals, guardSpentUsd: Number(spentUsd.toFixed(6)), usageMissing },
    worker: { launches, processes: [...processes.values()], unreadable },
    runs: runs.map(run => ({ ...run, run_id: runLabel(run.run_id) })),
    reservations: reservations.map(row => ({ ...row, run_id: runLabel(row.run_id) })),
    ...(fixture ? { fixture: { maxTokens: fixtureMaxTokens, serverCredentialInjected: injected } } : {}),
  };
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  listener.stop(true); await app.close(); fixture?.stop(true);
  rmSync(join(root, "pi-sessions"), { recursive: true, force: true });
  process.exit(0);
}

if (process.argv[2] === "--server") await server(process.argv[3] as ProfileName, process.argv[4]!, process.argv[5] as "dry" | "live", Number(process.argv[6]));
else await parent();
