/**
 * Subscription and current-model web search through host-owned Pi auth
 * (#3688): the real Pi backend's model access, the production broker and the
 * real executor running the pinned extension. The turn's admitted model is a
 * fictional ChatGPT/Codex login in a host Pi agent directory; its endpoint
 * and token service are one Odysseus loopback server, reached through the
 * host's lowest fetch method, as the inference relay's own tests do. No real
 * login, key or paid inference is involved.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebModelAccess } from "@schlessera/brain-ui-sdk/tool-contracts";
import { piWebModelAccess } from "../../ui-backend-pi/src/host-inference.js";
import * as piInternal from "../../ui-backend-pi/src/internal.js";
import type { WebBroker, WebReceipt } from "../src/web-tools/broker.js";
import { createHostWebTools } from "../src/web-tools/host.js";
import { createWebAccess } from "../src/ws/bridge-capabilities/web.js";

const jwt = (account: string, label: string) => ["{\"alg\":\"none\"}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })]
  .map(part => Buffer.from(part).toString("base64").replace(/=+$/, "")).join(".") + `.${label}`;
/** Fictional host-only login material; none of it may appear outside the host. */
const SECRETS = {
  access: jwt("odysseus-account", "odysseus-stale-signature"), refreshed: jwt("odysseus-account-refreshed", "odysseus-refreshed-signature"),
  refresh: "odysseus-host-refresh-token", rotated: "odysseus-rotated-refresh-token",
};
const MODEL = "gpt-6-luna";

let root: string, brain: string, agentDir: string, hostConfig: string, stateRoot: string, broker: WebBroker | undefined;
let upstream: ReturnType<typeof Bun.serve>, nativeFetch: typeof fetch;
let refreshes: number, refreshFails: boolean, slow: boolean, aborted: number;
let requests: Array<{ path: string; authorization: string | null; account: string | null; model: unknown }>;
let receipts: WebReceipt[], egress: import("@schlessera/brain-ui-sdk/internal").EgressRecord[];
/** Everything the executor process could hold while it served a request: its files, environment and argv. */
let executorView: string[];

function executorPids(): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(stateRoot); } catch { return false; }
  });
}
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    try { return statSync(path).isDirectory() ? filesUnder(path) : statSync(path).isFile() ? [readFileSync(path, "latin1")] : []; } catch { return []; }
  });
}
function observeExecutor(): void {
  executorView.push(...filesUnder(stateRoot));
  for (const pid of executorPids()) for (const part of ["environ", "cmdline"]) {
    try { executorView.push(readFileSync(`/proc/${pid}/${part}`, "latin1")); } catch { /* Gone. */ }
  }
}

function writeLogin(auth: Record<string, unknown> | undefined): void {
  rmSync(join(agentDir, "auth.json"), { force: true });
  if (auth) writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
}
const login = (expires: number) => ({ "openai-codex": { type: "oauth", access: SECRETS.access, refresh: SECRETS.refresh, expires, accountId: "odysseus-account" } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-web-subscription-"));
  brain = join(root, "brain"); agentDir = join(root, "agent"); stateRoot = join(root, "executor-state");
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(agentDir); mkdirSync(join(root, "host"));
  refreshes = 0; refreshFails = false; slow = false; aborted = 0; requests = []; receipts = []; egress = []; executorView = []; lentInto = [];
  writeLogin(login(1));
  hostConfig = join(root, "host", "web-search.json");
  writeFileSync(hostConfig, JSON.stringify({ searchRouting: { providers: ["openai"], fallbackOn: ["transient"] }, ssrf: { allowRanges: ["127.0.0.0/8"] } }));
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/token") {
      refreshes++;
      const form = new URLSearchParams(await request.text());
      if (refreshFails || form.get("refresh_token") !== SECRETS.refresh) return new Response("unknown refresh token", { status: 400 });
      return Response.json({ access_token: SECRETS.refreshed, refresh_token: SECRETS.rotated, expires_in: 3600 });
    }
    observeExecutor();
    const body = await request.json() as { model?: unknown };
    requests.push({ path: url.pathname, authorization: request.headers.get("authorization"), account: request.headers.get("chatgpt-account-id"), model: body.model });
    if (slow) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 20_000);
        request.signal.addEventListener("abort", () => { aborted++; clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    return Response.json({ output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Odysseus raft", sources: [{ type: "url", url: "https://ithaca.example/log" }] } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The raft reaches Ithaca at dawn.",
        annotations: [{ type: "url_citation", url: "https://ithaca.example/log", title: "Ithaca harbour log", start_index: 0, end_index: 31 }] }] },
    ] });
  } });
  // The host's lowest fetch method: the first-party origins reach the loopback fixture.
  nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!["https://chatgpt.com", "https://auth.openai.com"].includes(target.origin)) return nativeFetch(input, init);
    const local = new URL(upstream.url); local.pathname = target.pathname; local.search = target.search;
    return nativeFetch(local, init);
  }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
});
afterEach(async () => {
  await broker?.close(); broker = undefined;
  globalThis.fetch = nativeFetch;
  upstream.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function startBroker(): WebBroker {
  return broker = createHostWebTools({ module: piInternal, root: stateRoot, hostConfigPath: () => hostConfig, env: {}, runtime: process.execPath,
    path: process.env.PATH!, onReceipt: receipt => receipts.push(receipt), limits: { callDeadlineMs: 25_000 },
    // The relayed endpoint is admitted at its own name; the fixture answers for it on loopback.
    lookup: async host => { if (host === "chatgpt.com") return [{ address: "127.0.0.1", family: 4 }]; throw new Error(`ENOTFOUND ${host}`); },
    egressPorts: [443], onEgress: record => egress.push(record) });
}

/** The egress directories the turn's model was lent into, to see its relay stop. */
let lentInto: string[] = [];
const turnModel = (modelId = MODEL): WebModelAccess => {
  const access = piWebModelAccess({ provider: "openai-codex", modelId, agentDir, brainPath: brain, environment: {} });
  return { ...access, open: (egress, signal) => { lentInto.push(egress.dir); return access.open(egress, signal); } };
};

function recordingBudgets() {
  const attempts: Array<{ turnId: string; host: string }> = [];
  return { attempts, budgets: { providerAdmission: async () => undefined,
    observeWebProvider: async (turnId: string, attempt: { host: string }) => { attempts.push({ turnId, host: attempt.host }); return undefined; } } };
}

async function search(model: WebModelAccess | undefined, options: { providers?: unknown[]; exposures?: unknown[]; budgets?: unknown; signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const host = { webTools: broker, ...(options.exposures ? { governedTurns: { exposures: async () => options.exposures } } : {}),
    ...(options.budgets ? { budgets: options.budgets } : {}) };
  const web = createWebAccess({ host, turn: { sessionId: "s-ithaca" }, turnId: "turn-ithaca", principalId: "p-penelope", signal: controller.signal,
    backendId: "pi", workerProfile: { origin: "interactive", actualProfile: "governed" }, current: () => !controller.signal.aborted,
    recordingAvailable: () => true } as never, { collectedSessionId: "s-ithaca" },
    { policy: { hash: "rev-odyssey", policy: { providers: options.providers ?? [] } } } as never);
  return web.webAccess!({ tool: "web_search", input: { query: "Odysseus raft" }, toolCallId: `call-${Math.random().toString(36).slice(2)}`, ...(model ? { model } : {}) });
}

/** No login material outside the host: not in the executor's files, environment or argv, nor in anything returned. */
function credentialStaysOnHost(envelope: unknown): void {
  const seen = [...executorView, JSON.stringify(envelope), JSON.stringify(egress)].join("\n");
  for (const [name, secret] of Object.entries(SECRETS)) expect(seen.includes(secret), `WEB_SUBSCRIPTION_${name.toUpperCase()}_NEVER_LEAVES_HOST`).toBe(false);
  expect(seen.includes("odysseus-account"), "WEB_SUBSCRIPTION_ACCOUNT_NEVER_LEAVES_HOST").toBe(false);
}

test("subscription search runs on the turn's admitted login: the host refreshes it, and only a placeholder reaches the executor", async () => {
  startBroker();
  const { attempts, budgets } = recordingBudgets();
  const envelope = await search(turnModel(), { budgets });
  expect(envelope, "WEB_SUBSCRIPTION_SEARCH_SUCCEEDS").toMatchObject({ ok: true, tool: "web_search" });
  expect((envelope as { text: string }).text, "WEB_SUBSCRIPTION_PROVIDER_RESULT").toContain("The raft reaches Ithaca at dawn.");
  expect(requests, "WEB_SUBSCRIPTION_HOST_CREDENTIAL_REACHES_PROVIDER").toEqual([{ path: "/backend-api/codex/responses",
    authorization: `Bearer ${SECRETS.refreshed}`, account: "odysseus-account-refreshed", model: MODEL }]);
  expect(refreshes, "WEB_SUBSCRIPTION_REFRESHED_ON_HOST").toBe(1);
  const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["openai-codex"];
  expect(stored, "WEB_SUBSCRIPTION_ROTATION_WRITTEN_ON_HOST").toMatchObject({ access: SECRETS.refreshed, refresh: SECRETS.rotated });
  expect(executorView.length, "WEB_SUBSCRIPTION_EXECUTOR_OBSERVED").toBeGreaterThan(0);
  credentialStaysOnHost(envelope);
  // The relayed request met the executor route's per-call admission and was counted for the turn.
  expect(egress.filter(record => record.host === "chatgpt.com").map(record => record.outcome), "WEB_SUBSCRIPTION_ON_EXECUTOR_ROUTE").toEqual(["completed"]);
  expect(attempts, "WEB_SUBSCRIPTION_COUNTED_FOR_TURN").toEqual([{ turnId: "turn-ithaca", host: "chatgpt.com" }]);
}, 60_000);

test("current-model search uses exactly the admitted model", async () => {
  writeFileSync(hostConfig, JSON.stringify({ searchRouting: { providers: ["openai"], fallbackOn: ["transient"], useCurrentModel: true }, ssrf: { allowRanges: ["127.0.0.0/8"] } }));
  writeLogin(login(Date.now() + 3_600_000));
  startBroker();
  const envelope = await search(turnModel("gpt-6-sol"));
  expect(envelope, "WEB_CURRENT_MODEL_SEARCH_SUCCEEDS").toMatchObject({ ok: true });
  expect(requests.map(request => request.model), "WEB_CURRENT_MODEL_IS_ADMITTED_MODEL").toEqual(["gpt-6-sol"]);
  expect(refreshes, "a valid login is not refreshed").toBe(0);
  credentialStaysOnHost(envelope);
}, 60_000);

test("a search for another model than the admitted one is refused before anything is sent", async () => {
  writeFileSync(hostConfig, JSON.stringify({ searchRouting: { providers: ["openai"], fallbackOn: ["transient"] }, openaiSearchModel: "gpt-6-sol", ssrf: { allowRanges: ["127.0.0.0/8"] } }));
  startBroker();
  const envelope = await search(turnModel());
  expect(envelope.ok, "WEB_MODEL_MISMATCH_REFUSED").toBe(false);
  expect(JSON.stringify(envelope), "WEB_MODEL_MISMATCH_NAMES_ADMITTED_MODEL").toContain(`admitted for openai-codex/${MODEL} only`);
  expect(requests, "WEB_MODEL_MISMATCH_NOTHING_SENT").toEqual([]);
}, 60_000);

test("a missing login, or an expired one the host cannot refresh, refuses honestly with nothing sent", async () => {
  startBroker();
  writeLogin(undefined);
  const missing = await search(turnModel());
  expect(missing, "WEB_SUBSCRIPTION_MISSING_LOGIN_REFUSED").toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(JSON.stringify(missing)).toContain("no credential for openai-codex");
  writeLogin(login(1));
  refreshFails = true;
  const expired = await search(turnModel());
  expect(expired.ok, "WEB_SUBSCRIPTION_EXPIRED_LOGIN_REFUSED").toBe(false);
  expect(refreshes, "the refresh was tried on the host").toBeGreaterThan(0);
  expect(requests, "WEB_SUBSCRIPTION_NOTHING_SENT_WITHOUT_CREDENTIAL").toEqual([]);
  expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["openai-codex"].refresh, "a failed refresh changes nothing").toBe(SECRETS.refresh);
}, 60_000);

test("without the turn's model the executor has no Pi login to search with", async () => {
  startBroker();
  const envelope = await search(undefined);
  expect(envelope.ok, "WEB_NO_MODEL_NO_SUBSCRIPTION").toBe(false);
  expect(requests, "WEB_NO_MODEL_NOTHING_SENT").toEqual([]);
  expect(refreshes).toBe(0);
}, 60_000);

test("data routing applies to the relayed model's recipient", async () => {
  startBroker();
  const envelope = await search(turnModel(), { providers: [{ paths: ["notes/**"], allow: ["anthropic"] }],
    exposures: [{ recipient: "anthropic", visible: ["notes"], hidden: [] }] });
  expect(envelope, "WEB_SUBSCRIPTION_ROUTING_REFUSED").toMatchObject({ ok: false, error: { code: "policy_denied" } });
  expect(requests, "WEB_SUBSCRIPTION_ROUTING_NOTHING_SENT").toEqual([]);
}, 60_000);

test("a cancelled subscription search stops the relayed request and stops the relay", async () => {
  startBroker();
  slow = true;
  const controller = new AbortController();
  const pending = search(turnModel(), { signal: controller.signal });
  for (let wait = 0; wait < 500 && !requests.length; wait++) await Bun.sleep(20);
  expect(requests.length, "WEB_SUBSCRIPTION_REQUEST_STARTED").toBe(1);
  controller.abort();
  const envelope = await pending;
  expect(envelope.ok, "WEB_SUBSCRIPTION_CANCEL_SETTLES").toBe(false);
  for (let wait = 0; wait < 100 && !aborted; wait++) await Bun.sleep(20);
  expect(aborted, "WEB_SUBSCRIPTION_CANCEL_REACHES_PROVIDER").toBe(1);
  // The relay's socket is gone from the executor's route once the turn's call is done.
  expect(lentInto).toHaveLength(1);
  const link = join(lentInto[0]!, "inference.sock");
  for (let wait = 0; wait < 100 && existsSync(link); wait++) await Bun.sleep(20);
  expect(existsSync(link), "WEB_SUBSCRIPTION_RELAY_STOPPED").toBe(false);
}, 60_000);
