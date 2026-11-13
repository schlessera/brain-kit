/**
 * The web executor's model scope (#3688): the cases the real executor
 * (`packages/ui-server/tests/web-pi-subscription.test.ts`) cannot reach.
 * Built on Pi's real runtime and built-in catalog; no credential exists.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createWebModelScope, parseWebModelGrant, WEB_MODEL_SOCKET, type WebModelGrant } from "../src/web-model-scope.js";

const grant = (overrides: Partial<WebModelGrant> = {}): WebModelGrant =>
  ({ provider: "openai-codex", model: "gpt-6-luna", credential: "oauth", basePath: "/backend-api", socket: WEB_MODEL_SOCKET, ...overrides });

async function scoped() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-web-model-scope-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const current: unknown[] = [];
  const scope = createWebModelScope(runtime as never, model => { current.push(model && (model as { id: string }).id); });
  return { runtime, registry: new ModelRegistry(runtime), scope, current, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a grant is parsed exactly, or refused", () => {
  expect(parseWebModelGrant(undefined)).toBeUndefined();
  expect(parseWebModelGrant(grant())).toEqual(grant());
  for (const bad of [null, "openai-codex", grant({ credential: "cookie" as never }), grant({ socket: "/tmp/elsewhere.sock" }),
    grant({ basePath: "backend-api" }), grant({ provider: "" })]) {
    expect(() => parseWebModelGrant(bad), "WEB_MODEL_GRANT_MALFORMED_REFUSED").toThrow("malformed model grant");
  }
});

test("between calls the registry knows no model and no credential; with a grant, exactly the admitted one", async () => {
  const { registry, scope, current, cleanup } = await scoped();
  try {
    expect(registry.getAll(), "WEB_MODEL_NONE_BETWEEN_CALLS").toEqual([]);
    const leave = scope.enter(grant());
    const all = registry.getAll();
    expect(all.map(model => `${model.provider}/${model.id}`), "WEB_MODEL_ONLY_ADMITTED").toEqual(["openai-codex/gpt-6-luna"]);
    expect(registry.find("openai-codex", "gpt-6-sol"), "another model of the same provider is unknown").toBeUndefined();
    expect(registry.find("openai", "gpt-6-luna")).toBeUndefined();
    const auth = await registry.getApiKeyAndHeaders(all[0]!);
    expect(auth.ok && auth.apiKey, "WEB_MODEL_PLACEHOLDER_ONLY").toContain(".brain-inference-relay-placeholder");
    expect(registry.isUsingOAuth(all[0]!)).toBe(true);
    const other = await registry.getApiKeyAndHeaders({ ...all[0]!, provider: "openai" });
    expect(other.ok ? other.apiKey : undefined, "no other provider resolves a key").toBeUndefined();
    expect(() => registry.complete(all[0]!, { messages: [] } as never), "WEB_MODEL_RUNS_NOTHING").toThrow("runs no model");
    leave();
    expect(registry.getAll()).toEqual([]);
    expect(current, "the session's current model follows the grant").toEqual(["gpt-6-luna", undefined]);
  } finally { cleanup(); }
});

test("one model at a time, from Pi's catalog only", async () => {
  const { scope, cleanup } = await scoped();
  try {
    const first = scope.enter(grant());
    const again = scope.enter(grant());
    expect(() => scope.enter(grant({ model: "gpt-6-sol" })), "WEB_MODEL_SECOND_GRANT_REFUSED").toThrow("another turn's model");
    expect(() => scope.enter(undefined), "a call without the grant waits its turn").toThrow("another turn's model");
    first(); again();
    expect(() => scope.enter(grant({ model: "gpt-odysseus-custom" })), "WEB_MODEL_NOT_IN_CATALOG").toThrow("not in Pi's built-in catalog");
    scope.enter(undefined)();
  } finally { cleanup(); }
});

test("only the admitted model's endpoint is routed to the relay, and only for that model", async () => {
  const { scope, cleanup } = await scoped();
  try {
    const body = (model: string) => ({ method: "POST", body: JSON.stringify({ model, input: [] }) });
    expect(scope.route("https://chatgpt.com/backend-api/codex/responses", body("gpt-6-luna")), "no grant, nothing routed").toBeUndefined();
    const leave = scope.enter(grant({ basePath: "/relayed" }));
    expect(scope.route("https://chatgpt.com/backend-api/codex/responses?stream=1", body("gpt-6-luna")), "WEB_MODEL_ROUTED_TO_RELAY")
      .toMatchObject({ url: "http://relay/relayed/codex/responses?stream=1", init: { unix: WEB_MODEL_SOCKET, redirect: "manual" } });
    expect(scope.route("https://api.exa.ai/search", body("gpt-6-luna")), "another host is the route's").toBeUndefined();
    expect(scope.route("https://chatgpt.com/elsewhere", body("gpt-6-luna")), "outside the endpoint path").toBeUndefined();
    expect(() => scope.route("https://chatgpt.com/backend-api/codex/responses", body("gpt-6-sol")), "WEB_MODEL_MISMATCH_REFUSED")
      .toThrow("admitted for openai-codex/gpt-6-luna only");
    expect(() => scope.route("https://chatgpt.com/backend-api/codex/responses", { method: "GET" })).toThrow("Only the extension's model requests");
    expect(() => scope.route(new Request("https://chatgpt.com/backend-api/codex/responses", body("gpt-6-luna")))).toThrow("Request object");
    leave();
  } finally { cleanup(); }
});
