/** Offline CLI transport fixture. Loaded after the test network guard; no real request is made. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.BRAIN_ROOT!;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  appendFileSync(join(root, "propagation-requests.jsonl"), JSON.stringify({ url: String(url), request }) + "\n");
  if (String(url) !== "https://api.typesafe.ai/v1/systemone" || process.env.PROPAGATION_TEST_MODE === "forbid") throw new Error("Unexpected offline provider request");
  const negative = process.env.PROPAGATION_TEST_MODE === "needs_update";
  return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
    const q = value as { criteria: Record<string, string> };
    const selected = id === "currency" ? negative ? "needs_update" : "still_current" : "yes";
    return [id, { type: "choice", choice: selected, confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === selected ? 1 : 0])) }];
  })), usage: { input_tokens: 100 } });
}) as typeof fetch;
