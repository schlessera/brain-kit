/**
 * Real pi workers on a governed turn proxy with host-held credentials (#1665),
 * inside the caller's offline namespace. Every upstream is a loopback fixture;
 * first-party origins reach it only through the host's lowest fetch method.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiBackend } from "../../src/backend.js";
import { prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { startFixtureTurn } from "../../../../tests/fixtures/worker-input-fixture.js";

const scratch = process.argv[2]!;
const jwt = (account: string, label: string) => ["{\"alg\":\"none\"}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })]
  .map(part => Buffer.from(part).toString("base64").replace(/=+$/, "")).join(".") + `.${label}`;
const SECRETS = {
  openai: "odysseus-openai-host-key", anthropic: "odysseus-anthropic-host-key", anthropicOAuth: "sk-ant-oat01-odysseus-host-login",
  codex: jwt("odysseus-account", "odysseus-host-signature"), codexRefreshed: jwt("odysseus-account-refreshed", "odysseus-refreshed-signature"),
  refresh: "odysseus-host-refresh-token", rotated: "odysseus-rotated-refresh-token",
  gateway: "odysseus-configured-gateway-token", router: "odysseus-ambient-router-key", bearer: "odysseus-ambient-anthropic-bearer",
};
type Request = { path: string; authorization: string | null; apiKey: string | null; account: string | null; encoding: string | null; beta: string | null };
/** Which fictional secret a header carries, never its value. */
const credentialName = (value: string | null) => value === null ? null
  : Object.entries(SECRETS).find(([, secret]) => value === secret || value === `Bearer ${secret}`)?.[0] ?? (value.includes("brain-inference-relay-placeholder") ? "placeholder" : "other");
let requests: Request[] = [];
/** A scenario whose model first asks its bash tool to fetch through the turn proxy. */
let toolCall: string | undefined;
let toolFetches = 0, toolOutputSeen = false;
let refreshes = 0;
let worker: { pid: number; turnTemp?: { root: string } } | undefined;
let observed = "";
let hostCredentialFiles: string[] = [];
/** Host credential files the worker's own view could open, and whether its view was observed at all. */
let viewed = 0, controlViewed = false;
/** The live worker's process environments and private files, while it serves a request. */
function observeWorker(): void {
  const pending = [worker?.pid ?? 0];
  for (let count = 0; pending.length && count < 200; count++) {
    const pid = pending.shift()!;
    try { observed += readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { /* exited */ }
    // The worker's own view of the host's credential files: only processes in
    // its mount namespace, not the launcher that still shares the host's.
    let ownView = false;
    try { ownView = readlinkSync(`/proc/${pid}/ns/mnt`) !== readlinkSync("/proc/self/ns/mnt"); } catch { /* exited */ }
    if (ownView) for (const path of hostCredentialFiles) try { observed += readFileSync(`/proc/${pid}/root${path}`, "utf8"); viewed++; } catch { /* masked or absent */ }
    // A readable control beside them proves this was the worker's view.
    if (ownView && hostCredentialFiles[0]) try { readFileSync(`/proc/${pid}/root${dirname(hostCredentialFiles[0])}/visible.txt`); controlViewed = true; } catch { /* another process */ }
    try { pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch { /* exited */ }
  }
  const files = (path: string): string => { try { return readdirSync(path, { withFileTypes: true }).map(entry => entry.isDirectory()
    ? files(join(path, entry.name)) : entry.isFile() ? readFileSync(join(path, entry.name), "utf8") : "").join("\n"); } catch { return ""; } };
  if (worker?.turnTemp) observed += files(worker.turnTemp.root);
}
const sse = (events: object[]) => new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
function responsesReply(model: string, input: unknown): Response {
  const answered = JSON.stringify(input).includes("function_call_output");
  if (answered && JSON.stringify(input).includes("Ithaca road")) toolOutputSeen = true;
  if (toolCall && !answered) {
    const call = { type: "function_call", id: "fc_odysseus", call_id: "call_odysseus", name: "bash", arguments: JSON.stringify({ command: toolCall }) };
    const response = { id: "resp_odysseus_tool", object: "response", status: "completed", model, output: [call],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
    return sse([{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: call.arguments },
      { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response }]);
  }
  const answer = { type: "message", role: "assistant", id: "msg_odysseus", status: "completed",
    content: [{ type: "output_text", text: "Odysseus checks the mast.", annotations: [] }] };
  const response = { id: "resp_odysseus", object: "response", status: "completed", model, output: [answer],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
  return sse([{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } },
    { type: "response.content_part.added", item_id: answer.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: answer.id, output_index: 0, content_index: 0, delta: answer.content[0]!.text },
    { type: "response.output_item.done", output_index: 0, item: answer }, { type: "response.completed", response }]);
}
function messagesReply(model: string): Response {
  return sse([{ type: "message_start", message: { id: "msg_odysseus", type: "message", role: "assistant", model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus checks the mast." } },
  { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" }]);
}
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/voyage") { toolFetches++; return new Response("Ithaca road"); }
  if (url.pathname === "/oauth/token") {
    refreshes++;
    const form = new URLSearchParams(await request.text());
    if (form.get("refresh_token") !== SECRETS.refresh) return new Response("unknown refresh token", { status: 400 });
    return Response.json({ access_token: SECRETS.codexRefreshed, refresh_token: SECRETS.rotated, expires_in: 3600 });
  }
  observeWorker();
  const bytes = Buffer.from(await request.arrayBuffer());
  const encoding = request.headers.get("content-encoding");
  const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()) as { model: string; input?: unknown };
  requests.push({ path: url.pathname, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"),
    account: request.headers.get("chatgpt-account-id"), encoding, beta: request.headers.get("anthropic-beta") });
  return url.pathname.endsWith("/v1/messages") ? messagesReply(body.model) : responsesReply(body.model, body.input);
} });
// The host's lowest fetch method: first-party origins reach the loopback fixture.
const nativeFetch = globalThis.fetch;
const firstParty = ["https://api.openai.com", "https://chatgpt.com", "https://api.anthropic.com", "https://auth.openai.com"];
/** Every request the host itself makes, refresh and inference alike. */
let hostFetches: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  hostFetches.push(target.origin + target.pathname);
  if (!firstParty.includes(target.origin) && target.origin !== upstream.url.origin) throw new Error(`UNEXPECTED_HOST_DESTINATION ${target.origin}`);
  const local = new URL(upstream.url); local.pathname = target.pathname; local.search = target.search;
  return nativeFetch(local, init);
}) as typeof fetch;

interface Scenario { provider: string; model: string; auth?: object; models?: object; env?: Record<string, string>; origins?: string; aliasAuth?: boolean; marker?: boolean; turns?: number;
  /** An agent directory outside every host mask (the caller binds scratch over /opt). */
  outsideMasks?: boolean;
  /** The model's first answer runs this bash command. */
  tool?: string;
  /** pi's models.json is a link into the brain. */
  brainModels?: boolean }
const custom = upstream.url.origin;
const scenarios: Record<string, Scenario> = {
  "openai-env-key": { provider: "openai", model: "gpt-4o-mini", env: { OPENAI_API_KEY: SECRETS.openai }, turns: 2 },
  "configured-header-wins": { provider: "openai", model: "gpt-4o-mini", env: { OPENAI_API_KEY: SECRETS.openai, ODYSSEUS_GATEWAY_TOKEN: SECRETS.gateway },
    models: { providers: { openai: { headers: { Authorization: "Bearer $ODYSSEUS_GATEWAY_TOKEN" } } } } },
  "agent-only-keys": { provider: "openai", model: "gpt-4o-mini",
    env: { OPENAI_API_KEY: SECRETS.openai, OPENROUTER_API_KEY: SECRETS.router, ANTHROPIC_AUTH_TOKEN: SECRETS.bearer } },
  "command-model-override-header": { provider: "openai", model: "gpt-4o-mini", marker: true, env: { OPENAI_API_KEY: SECRETS.openai },
    models: { providers: { openai: { modelOverrides: { "gpt-4o-mini": { headers: { "x-odysseus": `!touch ${join(scratch, "command-ran")}` } } } } } } },
  "radius-overlay": { provider: "anthropic", model: "claude-haiku-4-5",
    // The model keeps the first-party route while the login implementation points elsewhere.
    models: { providers: { anthropic: { oauth: "radius", baseUrl: "https://gateway.ithaca.invalid",
      models: [{ id: "claude-haiku-4-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }] } } },
    auth: { anthropic: { type: "oauth", access: SECRETS.anthropicOAuth, refresh: SECRETS.refresh, expires: 1 } } },
  "brain-models-literal-key": { provider: "anthropic", model: "claude-haiku-4-5", brainModels: true,
    models: { providers: { anthropic: { apiKey: SECRETS.anthropic } } } },
  "codex-custom-unlisted-expired": { provider: "openai-codex", model: "gpt-5.3-codex-spark",
    models: { providers: { "openai-codex": { baseUrl: `${custom}/backend-api` } } },
    auth: { "openai-codex": { type: "oauth", access: SECRETS.codex, refresh: SECRETS.refresh, expires: 1, accountId: "odysseus-account" } } },
  "stored-key-outside-masks": { provider: "openai", model: "gpt-4o-mini", outsideMasks: true,
    auth: { openai: { type: "api_key", key: SECRETS.openai } }, models: { providers: { openai: { headers: { "x-odysseus-voyage": "ithaca" } } } } },
  "tool-network": { provider: "openai", model: "gpt-4o-mini", env: { OPENAI_API_KEY: SECRETS.openai },
    tool: `curl --silent --show-error --max-time 5 http://localhost:${upstream.port}/voyage` },
  "codex-oauth": { provider: "openai-codex", model: "gpt-5.3-codex-spark",
    auth: { "openai-codex": { type: "oauth", access: SECRETS.codex, refresh: SECRETS.refresh, expires: Date.now() + 3_600_000, accountId: "odysseus-account" } } },
  "codex-oauth-expired": { provider: "openai-codex", model: "gpt-5.3-codex-spark",
    auth: { "openai-codex": { type: "oauth", access: SECRETS.codex, refresh: SECRETS.refresh, expires: 1, accountId: "odysseus-account" } } },
  "anthropic-oauth": { provider: "anthropic", model: "claude-haiku-4-5",
    auth: { anthropic: { type: "oauth", access: SECRETS.anthropicOAuth, refresh: SECRETS.refresh, expires: Date.now() + 3_600_000 } } },
  "anthropic-custom-listed": { provider: "anthropic", model: "claude-haiku-4-5", origins: `anthropic=${custom}`,
    models: { providers: { anthropic: { baseUrl: custom, apiKey: "$ODYSSEUS_ANTHROPIC_KEY" } } }, env: { ODYSSEUS_ANTHROPIC_KEY: SECRETS.anthropic } },
  "anthropic-custom-unlisted": { provider: "anthropic", model: "claude-haiku-4-5", origins: "anthropic=https://gateway.ithaca.invalid",
    models: { providers: { anthropic: { baseUrl: custom, apiKey: SECRETS.anthropic } } } },
  "anthropic-custom-other-provider": { provider: "anthropic", model: "claude-haiku-4-5", origins: `openai=${custom}`,
    models: { providers: { anthropic: { baseUrl: custom, apiKey: SECRETS.anthropic } } } },
  "command-key-models": { provider: "anthropic", model: "claude-haiku-4-5", marker: true,
    models: { providers: { anthropic: { apiKey: `!touch ${join(scratch, "command-ran")}` } } } },
  "command-key-stored": { provider: "openai", model: "gpt-4o-mini", marker: true,
    auth: { openai: { type: "api_key", key: `!touch ${join(scratch, "command-ran")}` } } },
  "command-header": { provider: "openai", model: "gpt-4o-mini", marker: true, env: { OPENAI_API_KEY: SECRETS.openai },
    models: { providers: { openai: { headers: { "x-odysseus": `!touch ${join(scratch, "command-ran")}` } } } } },
  "copilot-oauth": { provider: "github-copilot", model: getBuiltinModels("github-copilot" as never)[0]!.id,
    auth: { "github-copilot": { type: "oauth", access: "odysseus-copilot-token", refresh: SECRETS.refresh, expires: Date.now() + 3_600_000 } } },
  "auth-in-brain": { provider: "openai", model: "gpt-4o-mini", aliasAuth: true, auth: { openai: { type: "api_key", key: SECRETS.openai } } },
};
const only = process.argv.slice(3);
const results: Record<string, unknown> = {};
try {
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name)) continue;
    requests = []; refreshes = 0; observed = ""; hostFetches = []; worker = undefined; viewed = 0; controlViewed = false;
    toolCall = scenario.tool; toolFetches = 0; toolOutputSeen = false;
    rmSync(join(scratch, "command-ran"), { force: true });
    const root = join(scratch, name), brain = join(root, "brain"), agent = scenario.outsideMasks ? join("/opt", name, "agent") : join(root, "agent");
    hostCredentialFiles = [join(agent, "auth.json"), join(agent, "models.json")];
    mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(agent, { recursive: true });
    writeFileSync(join(brain, "notes", "ithaca.md"), "---\ntype: note\ntitle: Ithaca\nupdated: 2026-07-12\n---\nOdysseus sails home.\n");
    if (scenario.auth) {
      if (scenario.aliasAuth) { writeFileSync(join(brain, "auth.json"), JSON.stringify(scenario.auth)); symlinkSync(join(brain, "auth.json"), join(agent, "auth.json")); }
      else writeFileSync(join(agent, "auth.json"), JSON.stringify(scenario.auth), { mode: 0o600 });
    }
    if (scenario.models && scenario.brainModels) {
      writeFileSync(join(brain, "pi-models.json"), JSON.stringify(scenario.models)); symlinkSync(join(brain, "pi-models.json"), join(agent, "models.json"));
    } else if (scenario.models) writeFileSync(join(agent, "models.json"), JSON.stringify(scenario.models));
    writeFileSync(join(agent, "visible.txt"), "Odysseus control");
    process.env.PI_CODING_AGENT_DIR = agent;
    for (const name of ["OPENAI_API_KEY", "ODYSSEUS_ANTHROPIC_KEY", "ODYSSEUS_GATEWAY_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "BRAIN_UI_PI_CREDENTIAL_ORIGINS"]) delete process.env[name];
    Object.assign(process.env, scenario.env ?? {}, scenario.origins ? { BRAIN_UI_PI_CREDENTIAL_ORIGINS: scenario.origins } : {});
    const records: EgressRecord[] = [];
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), loadExtensions: false,
      profiles: [{ id: "fixture", label: "Fixture", vendor: scenario.provider, model: scenario.model, thinkingLevel: "off" }], confirmBashPatterns: [] });
    const frames: ServerMessage[] = [];
    const outcomes: Array<string | null> = [];
    let thrown: string | undefined, sessionId: string | undefined, relayLinkRemoved = true;
    for (let turn = 0; turn < (scenario.turns ?? 1) && !thrown; turn++) {
      const controller = new AbortController();
      const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 8 * 1024 * 1024,
        signal: controller.signal, observe: record => records.push(record) });
      const timer = setTimeout(() => controller.abort(), 40_000);
      // Only this turn's frames decide its outcome.
      const firstFrame = frames.length;
      try {
        // A resumed turn names only its session: the relay follows the saved model.
        await startFixtureTurn(backend, brain, { prompt: "Odysseus checks the route to Ithaca.", ...(sessionId ? { sessionId } : { profileId: "fixture" }),
          signal: controller.signal, turnId: `odysseus-${name}-${turn}`,
          workerSandbox: { ...prepareFixtureWorkerSandbox(brain, { profile: "governed" }), egress: proxy },
          workerStarted: started => { worker = started as unknown as typeof worker; },
          bridge: { emit(frame) { frames.push(frame); }, async requestPermission() { return { behavior: "allow" as const }; } } });
      } catch (error) { thrown = error instanceof Error ? error.message : String(error); }
      finally {
        clearTimeout(timer);
        const result = frames.slice(firstFrame).findLast(frame => frame.type === "result") as Extract<ServerMessage, { type: "result" }> | undefined;
        outcomes.push(thrown ? null : result?.outcome ?? null); sessionId = result?.sessionId;
        // The relay and its link live exactly as long as the worker.
        for (let wait = 0; wait < 40 && existsSync(join(proxy.dir, "inference.sock")); wait++) await Bun.sleep(50);
        relayLinkRemoved &&= !existsSync(join(proxy.dir, "inference.sock"));
        controller.abort(); proxy.stop();
      }
    }
    const hostAuth = existsSync(join(agent, "auth.json")) ? JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")) : undefined;
    results[name] = {
      outcomes, thrown: thrown ?? null, refreshes, toolFetches, toolOutputSeen, hostFetches,
      requests: requests.map(request => ({ ...request, authorization: credentialName(request.authorization), apiKey: credentialName(request.apiKey) })),
      inference: records.map(record => ({ inference: record.inference ?? false, host: record.host, path: record.path ?? null, outcome: record.outcome })),
      workerObserved: observed.length > 0, hostCredentialFilesVisible: viewed, workerViewObserved: controlViewed,
      secretInWorker: Object.values(SECRETS).some(secret => observed.includes(secret)),
      placeholderInWorker: observed.includes("brain-inference-relay-placeholder"),
      commandRan: existsSync(join(scratch, "command-ran")),
      hostRefreshed: hostAuth?.["openai-codex"]?.refresh === SECRETS.rotated && hostAuth?.["openai-codex"]?.access === SECRETS.codexRefreshed,
      relayLinkRemoved,
    };
  }
  console.log(JSON.stringify({ namespace: readlinkSync("/proc/self/ns/net"), results }));
} finally { globalThis.fetch = nativeFetch; upstream.stop(true); }
