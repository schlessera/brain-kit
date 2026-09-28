/**
 * Every built-in core provider through the published contract suite for its
 * seam (`@schlessera/brain/testing`, #342) — the same suites a third-party
 * provider runs.
 *
 * Keyless and offline. The vendor SDKs and the Messages API are driven
 * through a stand-in `fetch` that answers the two vendor hosts and refuses
 * every other request, with the Gemini SDK's routing variables cleared so it
 * cannot be pointed elsewhere; it is installed for this file alone and
 * restored after. The agent runners are in agent-runner-contracts.test.ts:
 * they spawn their CLIs by name, which needs a `PATH` set before the process
 * starts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  runCompletionProviderContract,
  runEmbeddingProviderContract,
  runRerankerContract,
  runSkillEmitterContract,
} from "@schlessera/brain/testing";

import { COMPLETION_PROVIDERS, EMBEDDING_PROVIDERS, RERANKERS } from "../src/lib/registry";
import { BUILTIN_EMITTERS } from "../src/lib/skills/index";

const primitives = { describe, expect, test };

// A variable only this file sets, so no real key is ever read or sent.
const KEY_ENV = "BRAIN_SEAM_CONTRACT_TEST_KEY";

// ---------------------------------------------------------------------------
// Stand-in vendors
// ---------------------------------------------------------------------------

const vendor = {
  /** What the stand-in model answers a completion with. */
  answer: "",
  /** When true, embedding requests wait for their abort signal and never answer. */
  hang: false,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Never answers; rejects when the request is cancelled, as fetch does. */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The Gemini API: batched embeddings honour `outputDimensionality`. */
async function gemini(url: URL, init: RequestInit | undefined): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.pathname.endsWith(":batchEmbedContents")) {
    if (vendor.hang) return hangUntilAborted(init?.signal);
    return json({
      embeddings: body.requests.map((r: { outputDimensionality: number }, i: number) => ({
        values: Array.from({ length: r.outputDimensionality }, (_, j) => (i + 1) / (j + 2)),
      })),
    });
  }
  if (url.pathname.endsWith(":generateContent")) {
    return json({ candidates: [{ content: { role: "model", parts: [{ text: vendor.answer }] } }] });
  }
  return new Response("not found", { status: 404 });
}

/** TypeSafe System One: a Choice answers with a probability per option. */
let typesafeRequests = 0;
async function typesafe(url: URL, init: RequestInit | undefined): Promise<Response> {
  if (url.pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
  typesafeRequests++;
  if (vendor.hang) return hangUntilAborted(init?.signal);
  if (init?.signal?.aborted) throw init.signal.reason;
  const body = JSON.parse(String(init?.body ?? "{}"));
  const ids = Object.keys(body.questions.ranking.criteria);
  const probabilities = Object.fromEntries(ids.map((id, i) => [id, (ids.length - i) / ((ids.length * (ids.length + 1)) / 2)]));
  return json({
    model: body.model,
    answers: { ranking: { type: "choice", choice: ids[0], confidence: 0.5, probabilities } },
    usage: { input_tokens: 100, output_tokens: 0 },
  });
}

/** The Anthropic Messages API. */
async function anthropic(url: URL): Promise<Response> {
  if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
  return json({ content: [{ type: "text", text: vendor.answer }] });
}

const realFetch = globalThis.fetch;

/**
 * Every variable the installed Gemini SDK reads besides the key it is handed:
 * a base-URL override would route its requests past the stand-in, Vertex mode
 * to another host, and GOOGLE_API_KEY only draws a warning. Cleared for this
 * file, restored after.
 */
const GEMINI_SDK_ENV = [
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
];
const savedEnv = Object.fromEntries(GEMINI_SDK_ENV.map((name) => [name, process.env[name]]));

beforeAll(() => {
  process.env[KEY_ENV] = "contract-test-key";
  for (const name of GEMINI_SDK_ENV) delete process.env[name];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "generativelanguage.googleapis.com") return gemini(url, init);
      if (url.host === "api.anthropic.com") return anthropic(url);
      if (url.host === "api.typesafe.ai") return typesafe(url, init);
      // Nothing in this file may reach a network.
      throw new Error(`seam-contracts.test.ts refused a request to ${url.origin}`);
    },
    { preconnect: realFetch.preconnect }
  ) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env[KEY_ENV];
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[name] = value;
  }
});

// ---------------------------------------------------------------------------
// The built-ins, through their suites
// ---------------------------------------------------------------------------

test("every built-in registry entry is run through its suite below", () => {
  expect(Object.keys(EMBEDDING_PROVIDERS).sort()).toEqual(["gemini"]);
  expect(Object.keys(COMPLETION_PROVIDERS).sort()).toEqual(["anthropic-haiku", "gemini-flash"]);
  expect(Object.keys(BUILTIN_EMITTERS).sort()).toEqual(["claude", "codex", "gemini", "pi"]);
  expect(Object.keys(RERANKERS).sort()).toEqual(["jev"]);
});

for (const [name, factory] of Object.entries(RERANKERS)) {
  runRerankerContract(
    {
      name,
      reranker() {
        vendor.hang = false;
        return factory({ apiKeyEnv: KEY_ENV });
      },
      hanging() {
        vendor.hang = true;
        return factory({ apiKeyEnv: KEY_ENV });
      },
      sent: () => typesafeRequests,
    },
    primitives
  );
}

for (const [name, factory] of Object.entries(EMBEDDING_PROVIDERS)) {
  runEmbeddingProviderContract(
    {
      name,
      provider() {
        vendor.hang = false;
        return factory({ apiKeyEnv: KEY_ENV, dimensions: 8 });
      },
      hanging() {
        vendor.hang = true;
        return factory({ apiKeyEnv: KEY_ENV, dimensions: 8 });
      },
    },
    primitives
  );
}

for (const [name, factory] of Object.entries(COMPLETION_PROVIDERS)) {
  runCompletionProviderContract(
    {
      name,
      answering(text) {
        vendor.answer = text;
        return factory({ apiKeyEnv: KEY_ENV });
      },
    },
    primitives
  );
}

// Codex discovers `.agents/skills/` itself; its emitter delivers the contract.
for (const [name, emitter] of Object.entries(BUILTIN_EMITTERS)) {
  runSkillEmitterContract(
    { name, emitter: () => emitter, readsCanonicalHome: name === "codex" },
    primitives
  );
}
