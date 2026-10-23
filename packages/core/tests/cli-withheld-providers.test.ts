/**
 * Provider keys withheld from an agent worker (#1666). The launcher names
 * them in BRAIN_WITHHELD_KEYS; the real CLI names the missing provider with
 * the token the server records, and degrades where it can. A keyless brain
 * outside a worker keeps its ordinary behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseProviderUnavailable } from "@schlessera/brain-common/internal/provider-unavailable";
import { rerankSetup, resolveProviders } from "../src/lib/registry";
import { geminiCompletions } from "../src/providers/completions/gemini";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const WITHHELD = { BRAIN_WITHHELD_KEYS: "GEMINI_API_KEY,TYPESAFE_API_KEY" };
let root: string;
beforeAll(async () => {
  root = makeTempBrain();
  const index = await runCli(root, ["index", "--json"]);
  expect(index.code, index.stderr).toBe(0);
});
afterAll(() => cleanup(root));

describe("a withheld embeddings key", () => {
  test("hybrid search falls back to keyword results and names the provider", async () => {
    const result = await runCli(root, ["search", "Odysseus", "--json"], WITHHELD);
    expect(result.code, result.stderr).toBe(0);
    const { results, warnings } = JSON.parse(result.stdout) as { results: unknown[]; warnings: string[] };
    expect(results.length).toBeGreaterThan(0);
    expect(parseProviderUnavailable(warnings.join("\n")), "SEARCH_WITHHELD_EMBEDDINGS_NOTICE").toEqual([
      { provider: "gemini", capability: "embeddings", key: "GEMINI_API_KEY", degradedTo: "keyword_search" },
    ]);
    expect(warnings.join("\n")).toContain("results are FTS-only");
  });

  test("vector-only search has no fallback to name", async () => {
    const result = await runCli(root, ["search", "Odysseus", "--mode", "vector", "--json"], WITHHELD);
    const { warnings } = JSON.parse(result.stdout) as { warnings: string[] };
    expect(parseProviderUnavailable(warnings.join("\n"))).toEqual([
      { provider: "gemini", capability: "embeddings", key: "GEMINI_API_KEY", degradedTo: null },
    ]);
  });

  test("index --embeddings indexes by keyword and names the provider", async () => {
    const result = await runCli(root, ["index", "--embeddings", "--json"], WITHHELD);
    expect(result.code, result.stderr).toBe(0);
    expect(parseProviderUnavailable(result.stderr), "INDEX_WITHHELD_EMBEDDINGS_NOTICE").toEqual([
      { provider: "gemini", capability: "embeddings", key: "GEMINI_API_KEY", degradedTo: "keyword_index" },
    ]);
  });

  test("a keyless brain outside a worker still reports no provider, with no token", async () => {
    const result = await runCli(root, ["search", "Odysseus", "--json"]);
    const { warnings } = JSON.parse(result.stdout) as { warnings: string[] };
    expect(warnings).toContain("vector search unavailable: no embedding provider configured; results are FTS-only");
    expect(parseProviderUnavailable(`${result.stdout}${result.stderr}`)).toEqual([]);
  });
});

test("brain process refuses with the withheld completion provider named", async () => {
  const result = await runCli(root, ["process", "notes/anything.md"], WITHHELD);
  expect(result.code).not.toBe(0);
  expect(parseProviderUnavailable(`${result.stdout}${result.stderr}`), "PROCESS_WITHHELD_COMPLETIONS_NOTICE").toEqual([
    { provider: "gemini-flash", capability: "completions", key: "GEMINI_API_KEY", degradedTo: null },
  ]);
});

describe("resolution", () => {
  const withEnv = <T>(env: Record<string, string | undefined>, run: () => T): T => {
    const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return run(); } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };

  test("a withheld key is reported per seam; a set key is never withheld", () => {
    expect(withEnv({ GEMINI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, BRAIN_WITHHELD_KEYS: "ANTHROPIC_API_KEY,GEMINI_API_KEY" },
      () => resolveProviders({ completions: { provider: "anthropic-haiku" } } as never).withheld)).toEqual({
      embeddings: { provider: "gemini", key: "GEMINI_API_KEY" }, completions: { provider: "anthropic-haiku", key: "ANTHROPIC_API_KEY" },
    });
    expect(withEnv({ GEMINI_API_KEY: "odysseus-fixture-key", BRAIN_WITHHELD_KEYS: "GEMINI_API_KEY" },
      () => resolveProviders({}).withheld?.embeddings)).toBeUndefined();
  });

  test("an unknown configured provider name is the resolver's to report, never a withheld notice", () => {
    expect(withEnv({ GEMINI_API_KEY: undefined, BRAIN_WITHHELD_KEYS: "GEMINI_API_KEY" },
      () => resolveProviders({ completions: { provider: "ithaca/custom gateway", apiKeyEnv: "GEMINI_API_KEY" } } as never).withheld?.completions),
    "UNKNOWN_PROVIDER_NOT_WITHHELD").toBeUndefined();
  });

  test("a provider a command calls directly names its withheld key too", async () => {
    // `brain video watch` builds its Gemini completion provider itself.
    const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, BRAIN_WITHHELD_KEYS: process.env.BRAIN_WITHHELD_KEYS };
    delete process.env.GEMINI_API_KEY; process.env.BRAIN_WITHHELD_KEYS = "GEMINI_API_KEY";
    try {
      const failure = await geminiCompletions().complete({ prompt: "Odysseus" }).then(() => "", (error: Error) => error.message);
      expect(parseProviderUnavailable(failure), "DIRECT_PROVIDER_WITHHELD_NOTICE").toEqual([
        { provider: "gemini", capability: "completions", key: "GEMINI_API_KEY", degradedTo: null },
      ]);
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  test("an enabled jev reranker without its withheld key keeps lifecycle order and names it", () => {
    const setup = withEnv({ TYPESAFE_API_KEY: undefined, BRAIN_RERANK_MODE: undefined, ...WITHHELD },
      () => rerankSetup({ enabled: true, provider: "jev" } as never));
    expect(setup.rerank).toBe("heuristic");
    expect(parseProviderUnavailable(setup.warning ?? ""), "RERANK_WITHHELD_NOTICE").toEqual([
      { provider: "jev", capability: "reranking", key: "TYPESAFE_API_KEY", degradedTo: "lifecycle_order" },
    ]);
  });
});
