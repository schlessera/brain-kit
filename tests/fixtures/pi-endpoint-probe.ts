/** Real pi adapter in a network namespace; observe destinations without rewriting them. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiBackend } from "../../packages/ui-backend-pi/src/backend.js";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentBackend, ServerMessage } from "@schlessera/brain-ui-sdk/server";

const [scenario, root] = process.argv.slice(2) as [string, string];
const brainPath = join(root, "brain");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
for (const dir of [brainPath, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
}));

const oauth = scenario.startsWith("auth-");
const provider = oauth ? "github-copilot" : "anthropic";
const modelId = oauth ? "claude-sonnet-4.6" : "claude-sonnet-4-6";
const catalog = getBuiltinModel(provider, modelId as never);
if (!catalog) throw new Error("Fixture requires a real built-in chat model");
const firstEndpoint = "https://api.first.example.test";
const changedEndpoint = "https://api.changed.example.test";
const refreshedEndpoint = "https://api.refreshed.example.test";
const attempts: Array<{ url: string; kind: string; model?: string; promptPresent?: boolean; authPresent?: boolean }> = [];
const received: Array<{ url: string; model: string; promptPresent: boolean; tools: string[] }> = [];
const nativeAuth: Array<{ provider: string; model: string; source?: string; subscription: boolean; endpoint?: string }> = [];
const frames: ServerMessage[][] = [];
const refusals: string[] = [];
const identities: unknown[] = [];
let allowSeed = false;
let syntheticInferenceResponses = 0;
let requestsBeforeRefusal = 0;
let refreshedCredential = false;

function response(): Response {
  const events = [
    { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant",
      model: modelId, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus reached the fixture endpoint." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; messages?: unknown[]; input?: unknown[]; tools?: Array<{ name: string }> };
  received.push({ url: request.url, model: body.model, promptPresent: JSON.stringify(body.messages ?? body.input ?? []).includes("fixture prompt"),
    tools: body.tools?.map((tool) => tool.name) ?? [] });
  if (new URL(request.url).pathname.endsWith("/responses")) {
    return Response.json({ error: { message: "Fixture observed fallback inference" } }, { status: 400 });
  }
  return response();
} });
const configured = `http://127.0.0.1:${server.port}/configured/path`;
// The native runtime now lives in the worker. Install this transport observer
// as an ordinary project extension, before the configured ModelRuntime is built.
const extensionDir = join(brainPath, ".pi/extensions");
mkdirSync(extensionDir, { recursive: true });
function installObserver() {
  const settings = { oauth, provider, modelId, firstEndpoint, refreshedEndpoint,
    configuredOrigin: server.url.origin, allowSeed };
  writeFileSync(join(extensionDir, "endpoint-observer.ts"),
    `import { installEndpointObserver } from ${JSON.stringify(join(import.meta.dir, "pi-endpoint-worker-observer.ts"))};
export default function(pi) { installEndpointObserver(pi, ${JSON.stringify(settings)}); }`);
}

function credential(endpoint: string, expired = false) {
  return { type: "oauth", access: `tid=fixture;proxy-ep=${new URL(endpoint).hostname.replace(/^api\./, "proxy.")};`,
    refresh: "fixture-bogus-refresh", expires: expired ? 1 : Date.now() + 7200_000, availableModelIds: [modelId] };
}
function storeCredential(endpoint: string, expired = false) {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "github-copilot": credential(endpoint, expired) }));
}
if (oauth) storeCredential(firstEndpoint);
else writeFileSync(join(agentDir, "auth.json"), "{}");
const endpoint = scenario === "auth-matching" ? firstEndpoint : configured;
const noOverride = scenario === "auth-default";
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
  [provider]: { ...(noOverride ? {} : { baseUrl: endpoint }), ...(oauth ? {} : { apiKey: "fixture-bogus-key" }) },
} }));

function backend(model = modelId): AgentBackend {
  return createPiBackend({ brainPath, sessionDir, loadExtensions: true,
    profiles: [{ id: "fixture", label: "Fixture", vendor: provider, model, thinkingLevel: "off" }],
  });
}
async function turn(adapter: AgentBackend, autonomous = false, sessionId?: string) {
  installObserver();
  const emitted: ServerMessage[] = [];
  frames.push(emitted);
  try {
    await adapter.startTurn({ prompt: "Nonempty fixture prompt for Odysseus.", profileId: "fixture", sessionId,
      signal: AbortSignal.timeout(10_000),
      ...(autonomous ? { enforceAllowedTools: true, noGrantSurface: true,
        autonomous: { origin: "autonomous" as const, persistence: "none" as const, allowedTools: [], systemPromptAppend: "Fixture task." } } : {}),
      bridge: { emit: (frame) => {
        if (frame.type === "text_delta" && frame.text.startsWith("__pi_fixture_receipt__:")) {
          const receipt = JSON.parse(frame.text.slice("__pi_fixture_receipt__:".length));
          if (receipt.kind === "nativeAuth") nativeAuth.push(receipt.value);
          else if (receipt.kind === "attempt") attempts.push(receipt.value);
          else if (receipt.kind === "synthetic") syntheticInferenceResponses++;
        } else emitted.push(frame);
      }, requestPermission: async () => ({ behavior: "deny", message: "Fixture" }),
        checkpointPermission: () => {}, activity: (event) => identities.push(event) },
    });
  } catch (error) { refusals.push((error as Error).message); }
  return emitted.find((frame) => frame.type === "session_info")?.sessionId;
}
function transcripts(): string[] {
  return readdirSync(sessionDir, { recursive: true }).filter((name) => typeof name === "string" && name.endsWith(".jsonl")) as string[];
}
try {
  const adapter = backend(scenario === "invalid" ? "fixture-not-builtin" : modelId);
  if (scenario === "ordinary") {
    const id = await turn(adapter);
    if (id) { await turn(adapter, false, id); await turn(backend(), false, id); }
  } else if (scenario === "autonomous" || scenario === "auth-autonomous") {
    await turn(adapter, true);
  } else if (scenario === "unavailable-saved") {
    const id = await turn(adapter);
    requestsBeforeRefusal = attempts.length;
    // Remove the selected provider's auth and provide another valid built-in
    // profile, so native fallback is possible and its refusal is observable.
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: configured, apiKey: "fixture-bogus-fallback" },
    } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol",
      retry: { enabled: false }, cacheWarming: "off", compaction: { enabled: false } }));
    if (id) await turn(backend(), false, id);
  } else if (scenario === "auth-changed" || scenario === "auth-refreshed") {
    const id = await turn(adapter);
    storeCredential(scenario === "auth-changed" ? changedEndpoint : firstEndpoint, scenario === "auth-refreshed");
    if (id) await turn(adapter, false, id);
    if (scenario === "auth-refreshed") {
      const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
      refreshedCredential = auth["github-copilot"].access.includes("proxy.refreshed.example.test");
    }
  } else if (scenario === "auth-resume") {
    allowSeed = true;
    const id = await turn(adapter);
    allowSeed = false;
    if (id) await turn(backend(), false, id);
  } else {
    allowSeed = scenario === "auth-matching" || scenario === "auth-default";
    await turn(adapter);
  }
  const sessions = await adapter.listSessions();
  const history = await Promise.all(sessions.map((session) => adapter.getHistory(session.id)));
  const persisted = transcripts().map((file) => readFileSync(join(sessionDir, file), "utf8"));
  console.log(JSON.stringify({ scenario, provider, modelId, configured, firstEndpoint, changedEndpoint, refreshedEndpoint,
    catalogEndpoint: catalog.baseUrl, nativeModelApi: catalog.api, nativeAuth, attempts, received, frames, refusals, identities,
    sessions, history, persisted, requestsBeforeRefusal, refreshedCredential, syntheticInferenceResponses,
    configuredInput: JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers[provider]?.baseUrl ?? null,
  }));
} finally { server.stop(true); }
