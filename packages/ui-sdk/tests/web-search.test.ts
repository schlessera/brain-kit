import { describe, expect, test } from "bun:test";
import { buildSystemPromptAppend } from "../src/server/index.js";
import {
  WEB_SEARCH_PROVIDERS,
  hasWebSearchCredential,
  readWebSearchOverride,
  readWebSearchRouting,
  resolveWebSearchConfigPath,
  webSearchBrief,
  webSearchProvider,
} from "../src/server/web-search.js";

describe("web-search config path", () => {
  test("mirrors the extension's own precedence", () => {
    expect(resolveWebSearchConfigPath({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe(
      "/x/agent/web-search.json"
    );
    expect(resolveWebSearchConfigPath({ XDG_CONFIG_HOME: "/x/cfg" })).toBe(
      "/x/cfg/pi/web-search.json"
    );
    expect(resolveWebSearchConfigPath({ HOME: "/home/u" })).toBe("/home/u/.pi/web-search.json");
  });

  test("is NOT pi's agent dir", () => {
    // pi resolves its agent dir to ~/.pi/agent, one level deeper. Reading the
    // config from there finds nothing and would report no providers at all.
    expect(resolveWebSearchConfigPath({ HOME: "/home/u" })).not.toContain("/.pi/agent/");
  });
});

describe("provider catalog", () => {
  test("free providers sort ahead of paid ones", () => {
    const ranks = WEB_SEARCH_PROVIDERS.map((p) => p.costRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const firstPaid = WEB_SEARCH_PROVIDERS.findIndex((p) => !p.keyless);
    expect(WEB_SEARCH_PROVIDERS.slice(0, firstPaid).every((p) => p.keyless)).toBe(true);
  });

  test("every paid provider is reachable by key or environment", () => {
    for (const p of WEB_SEARCH_PROVIDERS) {
      if (p.keyless) continue;
      expect(p.keyField).toBeTruthy();
      expect(p.envVar).toBeTruthy();
    }
  });

  test("ids are unique", () => {
    const ids = WEB_SEARCH_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("credential detection", () => {
  const perplexity = webSearchProvider("perplexity")!;

  test("a keyless provider always has one", () => {
    expect(hasWebSearchCredential(webSearchProvider("exa")!, {}, {})).toBe(true);
  });

  test("finds a stored key", () => {
    expect(hasWebSearchCredential(perplexity, { perplexityApiKey: "k" }, {})).toBe(true);
    expect(hasWebSearchCredential(perplexity, { perplexityApiKey: "  " }, {})).toBe(false);
  });

  test("finds a key in the environment", () => {
    // The extension runs in this process, so its env is ours — checking only
    // the file would wrongly call an env-configured provider unusable.
    expect(hasWebSearchCredential(perplexity, {}, { PERPLEXITY_API_KEY: "k" })).toBe(true);
    expect(hasWebSearchCredential(perplexity, {}, { PERPLEXITY_API_KEY: "" })).toBe(false);
  });
});

describe("reading a config", () => {
  test("reads the chain, dropping ids outside the catalog", () => {
    expect(
      readWebSearchRouting({ searchRouting: { providers: ["exa", "nope", "brave"] } })
    ).toEqual(["exa", "brave"]);
    expect(readWebSearchRouting({})).toEqual([]);
    expect(readWebSearchRouting({ searchRouting: "nonsense" })).toEqual([]);
  });

  test("spots a single-provider selection under either key", () => {
    expect(readWebSearchOverride({ provider: "brave" })).toBe("brave");
    expect(readWebSearchOverride({ searchProvider: "kagi" })).toBe("kagi");
    // "auto" is the extension's default, not an override.
    expect(readWebSearchOverride({ provider: "auto" })).toBeNull();
    expect(readWebSearchOverride({})).toBeNull();
    // An array selection is a parallel fan-out — still an override.
    expect(readWebSearchOverride({ provider: ["exa", "brave"] })).toBe("exa, brave");
  });
});

describe("the brief handed to the model", () => {
  test("lists the chain in order, marking what costs money", () => {
    const brief = webSearchBrief(
      { searchRouting: { providers: ["exa", "perplexity"] }, perplexityApiKey: "k" },
      { toolName: "web_search", env: {} }
    );
    expect(brief.providers.map((p) => p.id)).toEqual(["exa", "perplexity"]);
    expect(brief.providers[0]!.paid).toBe(false);
    expect(brief.providers[1]!.paid).toBe(true);
  });

  test("drops a provider with no credential", () => {
    // The extension would skip it at search time; naming it would send the
    // model after a provider that always errors.
    const brief = webSearchBrief(
      { searchRouting: { providers: ["exa", "perplexity"] } },
      { toolName: "web_search", env: {} }
    );
    expect(brief.providers.map((p) => p.id)).toEqual(["exa"]);
  });

  test("follows a single-provider override rather than the chain", () => {
    const brief = webSearchBrief(
      { provider: "brave", braveApiKey: "k", searchRouting: { providers: ["exa"] } },
      { toolName: "web_search", env: {} }
    );
    expect(brief.providers.map((p) => p.id)).toEqual(["brave"]);
  });
});

describe("buildSystemPromptAppend — web search", () => {
  test("says nothing when the backend has no configurable search", () => {
    const prompt = buildSystemPromptAppend({});
    expect(prompt).not.toContain("Web search");
  });

  test("names the enabled providers, the default, and the override argument", () => {
    const prompt = buildSystemPromptAppend({
      webSearch: webSearchBrief(
        { searchRouting: { providers: ["exa", "perplexity"] }, perplexityApiKey: "k" },
        { toolName: "web_search", env: {} }
      ),
    });
    expect(prompt).toContain("`exa` (free)");
    expect(prompt).toContain("`perplexity` (paid)");
    expect(prompt).toContain("keeps searches on exa");
    expect(prompt).toContain('provider: "perplexity"');
    // The extension's own tool description names ~28 providers regardless of
    // config; the brief has to contradict it or the model will ask for one.
    expect(prompt).toContain("none of");
  });

  test("uses the tool's configured name", () => {
    const prompt = buildSystemPromptAppend({
      webSearch: webSearchBrief(
        { searchRouting: { providers: ["exa"] } },
        { toolName: "search_the_web", env: {} }
      ),
    });
    expect(prompt).toContain("`search_the_web`");
    expect(prompt).not.toContain("`web_search`");
  });

  test("tells the model to choose when nothing is configured", () => {
    const prompt = buildSystemPromptAppend({
      webSearch: webSearchBrief({}, { toolName: "web_search", env: {} }),
    });
    expect(prompt).toContain("picks its own provider");
    expect(prompt).toContain("Omit the `provider` argument");
  });
});
