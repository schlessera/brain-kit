/** Count the captured installed-CLI surface; never generate an answer. */
import { createHash } from "node:crypto";
import { captureSurface, SURFACE_MODEL } from "./capture-turn-surface";
import { attributeTokenCounts, tokenGroupPayloads, type TokenGroup } from "./turn-surface-token-groups";

export async function countSurfaceTokens(apiKey: string, doFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
  if (!apiKey.trim()) throw Error("Token-count instrument requires its authorized API key");
  const capture = await captureSurface({ corpus: true,
    decision: Promise.resolve({ arm: "baseline", routed: false, tools: [], skills: [] }),
  });
  const counts: Array<{ group: TokenGroup; inputTokens: number }> = [];
  for (const entry of tokenGroupPayloads(capture.request)) {
    const response = await doFetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(entry.body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Error(`Token count failed for ${entry.group}: HTTP ${response.status}`);
    const value = await response.json() as { input_tokens?: unknown };
    if (!Number.isSafeInteger(value.input_tokens) || (value.input_tokens as number) < 0) throw Error("Missing actual token-count receipt");
    counts.push({ group: entry.group, inputTokens: value.input_tokens as number });
  }
  return {
    evidence: "provider-counted-installed-cli-surface", model: SURFACE_MODEL, runtime: capture.runtime,
    observedRequestSha: createHash("sha256").update(JSON.stringify(capture.request)).digest("hex"),
    rows: attributeTokenCounts(counts),
    method: "Ordered cumulative marginals: everything else, built-in definitions/deferred names, core MCP definitions/deferred names, bridge definitions/deferred names, then actual CLI skill listing. Shipped core tools are deferred name-only entries, not eight loaded schemas. Shared ToolSearch/placeholder definitions are counted with built-ins; server instructions remain in everything else. The final payload retains original tool order and message blocks; fragments are not independently tokenized and summed.",
    billingRoute: "API key for count_tokens only; no inference", countTokensAdditionalChargeUsd: 0,
    billingSource: "https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing",
    limitations: "One fictional representative turn. CLI skill listing includes project and built-in CLI entries. Loopback capture changes authentication/endpoint only; it measures serialization, not subscription quota, cache hits or tool-use quality.",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || process.env.BRAIN_LIVE_EVAL !== "587") {
    throw Error("Require the reviewed #587 protocol and BRAIN_LIVE_EVAL=587; usage: --out report.json");
  }
  await Bun.write(args[1], JSON.stringify(await countSurfaceTokens(process.env.ANTHROPIC_API_KEY ?? ""), null, 2) + "\n");
}
