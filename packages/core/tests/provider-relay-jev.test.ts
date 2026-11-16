/**
 * The jev reranker through the host's provider relay (#3792). A governed or
 * strict worker has no `TYPESAFE_API_KEY`; with a relay socket it reranks
 * anyway, sending its native request to the socket with the `typesafe` family,
 * the key's name and the first-party origin, and never a credential. Without
 * the relay it keeps the `provider_unavailable` notice. (Until #3792 the relay
 * had no Jev family, so every hosted search ran in lifecycle order.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseProviderUnavailable } from "@schlessera/brain-common/internal/provider-unavailable";
import { rerankSetup } from "../src/lib/registry.js";
import { JEV_MODEL } from "../src/lib/llm-defaults.js";
import type { RerankCandidate } from "../src/lib/seams.js";

const NAMES = ["TYPESAFE_API_KEY", "BRAIN_WITHHELD_KEYS", "BRAIN_PROVIDER_RELAY_SOCKET", "BRAIN_RERANK_MODE"] as const;
const SOCKET = "/run/brain-egress/providers.sock";
const saved = new Map<string, PropertyDescriptor | undefined>();
const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
interface Sent { method: string; url: string; unix: unknown; headers: Record<string, string>; body: { model?: string } }
let sent: Sent[];

beforeEach(() => {
  for (const name of NAMES) { saved.set(name, Object.getOwnPropertyDescriptor(process.env, name)); delete process.env[name]; }
  process.env.BRAIN_WITHHELD_KEYS = "TYPESAFE_API_KEY";
  sent = [];
  // The relay as the worker sees it, or the provider when the key is held: ranks the last candidate first.
  Object.defineProperty(globalThis, "fetch", { ...savedFetch, value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    sent.push({ method: request.method, url: `${url.origin}${url.pathname}${url.search}`, unix: (init as { unix?: unknown } | undefined)?.unix,
      headers: Object.fromEntries(request.headers), body: await request.json() as { model?: string } });
    return Response.json({ model: JEV_MODEL, answers: { ranking: { type: "choice", choice: "C003", confidence: 0.8,
      probabilities: { C001: 0.1, C002: 0.2, C003: 0.7 } } }, usage: { input_tokens: 700, output_tokens: 4 } });
  } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "fetch", savedFetch);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(process.env, name, descriptor); else delete process.env[name];
  }
});

const candidates: RerankCandidate[] = ["Ithaca harbour", "Ithaca palace", "Ithaca olive grove"].map((title, index) => ({
  id: `notes/${index}.md`, title, type: "note", tags: "ithaca", summary: `${title} at dawn`, excerpt: `Odysseus at ${title}`, score: 1 / (index + 1),
}));
const enabled = { enabled: true, provider: "jev" } as never;

test("an enabled jev reranker whose key the host withholds reranks through the relay, with no notice", async () => {
  process.env.BRAIN_PROVIDER_RELAY_SOCKET = SOCKET;
  const setup = rerankSetup(enabled);
  expect(setup.rerank, "RELAYED_JEV_SELECTED").toBe("jev");
  expect(setup.warning, "RELAYED_JEV_NO_NOTICE").toBeUndefined();
  const ranked = await setup.deps.reranker!.rerank({ query: "Ithaca", candidates });
  expect(ranked.map(entry => entry.item.title), "RELAYED_JEV_ORDERS_BY_ANSWER").toEqual(["Ithaca olive grove", "Ithaca palace", "Ithaca harbour"]);
  expect(sent).toHaveLength(1);
  const [request] = sent;
  expect({ unix: request!.unix, method: request!.method, path: new URL(request!.url).pathname }, "RELAYED_JEV_GOES_TO_SOCKET")
    .toEqual({ unix: SOCKET, method: "POST", path: "/v1/systemone" });
  expect(request!.headers, "RELAYED_JEV_NAMES_FAMILY_KEY_ORIGIN").toMatchObject({ "x-brain-provider": "typesafe",
    "x-brain-provider-key": "TYPESAFE_API_KEY", "x-brain-provider-origin": "https://api.typesafe.ai" });
  expect(request!.headers.authorization, "RELAYED_JEV_SENDS_NO_CREDENTIAL").toBeUndefined();
  expect(request!.body.model).toBe(JEV_MODEL);
});

test("without the relay the withheld key keeps lifecycle order and the notice", () => {
  const setup = rerankSetup(enabled);
  expect(setup.rerank).toBe("heuristic");
  expect(parseProviderUnavailable(setup.warning ?? ""), "UNRELAYED_JEV_NOTICE").toEqual([
    { provider: "jev", capability: "reranking", key: "TYPESAFE_API_KEY", degradedTo: "lifecycle_order" },
  ]);
});

test("a key the worker holds is sent directly, never through the relay", async () => {
  process.env.BRAIN_PROVIDER_RELAY_SOCKET = SOCKET;
  process.env.TYPESAFE_API_KEY = "odysseus-worker-typesafe-key";
  const setup = rerankSetup(enabled);
  expect(setup.warning).toBeUndefined();
  await setup.deps.reranker!.rerank({ query: "Ithaca", candidates });
  expect(sent.map(request => ({ url: request.url, unix: request.unix, authorization: request.headers.authorization })), "HELD_JEV_KEY_DIRECT")
    .toEqual([{ url: "https://api.typesafe.ai/v1/systemone", unix: undefined, authorization: "Bearer odysseus-worker-typesafe-key" }]);
});

test("a relay socket without a withheld key is not a key: the reranker stays off", () => {
  process.env.BRAIN_PROVIDER_RELAY_SOCKET = SOCKET;
  delete process.env.BRAIN_WITHHELD_KEYS;
  const setup = rerankSetup(enabled);
  expect(setup.rerank, "NEVER_WITHHELD_NOT_RELAYED").toBe("heuristic");
  expect(sent).toEqual([]);
});
