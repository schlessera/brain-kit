import { expect, test } from "bun:test";
import { isWithheldKey, parseProviderUnavailable, providerUnavailableNotice, withheldKeys } from "../src/provider-unavailable";

test("a notice round-trips through the parser the server uses", () => {
  const notice = providerUnavailableNotice({ provider: "gemini", capability: "embeddings", key: "GEMINI_API_KEY", degradedTo: "keyword_search" },
    "results are FTS-only");
  expect(notice).toBe("gemini embeddings unavailable: the host withholds GEMINI_API_KEY from agent workers; results are FTS-only"
    + " [provider_unavailable provider=gemini capability=embeddings key=GEMINI_API_KEY degraded_to=keyword_search]");
  expect(parseProviderUnavailable(`${notice}\n${notice}\n${providerUnavailableNotice({ provider: "openai", capability: "image",
    key: "OPENAI_API_KEY", degradedTo: null })}`)).toEqual([
    { provider: "gemini", capability: "embeddings", key: "GEMINI_API_KEY", degradedTo: "keyword_search" },
    { provider: "openai", capability: "image", key: "OPENAI_API_KEY", degradedTo: null },
  ]);
});

test("notice fields stay plain identifiers, so output cannot shape the token", () => {
  expect(() => providerUnavailableNotice({ provider: "gemini] [provider_unavailable", capability: "embeddings", key: "GEMINI_API_KEY",
    degradedTo: null })).toThrow("plain identifiers");
  expect(parseProviderUnavailable("[provider_unavailable provider=gemini capability=embeddings]")).toEqual([]);
});

test("a key is withheld only when the launcher named it and it is unset", () => {
  const env = { BRAIN_WITHHELD_KEYS: " GEMINI_API_KEY ,not a name,OPENAI_API_KEY", OPENAI_API_KEY: "odysseus-fixture-key" };
  expect(withheldKeys(env)).toEqual(["GEMINI_API_KEY", "OPENAI_API_KEY"]);
  expect(isWithheldKey("GEMINI_API_KEY", env)).toBe(true);
  expect(isWithheldKey("OPENAI_API_KEY", env)).toBe(false);
  expect(isWithheldKey("TYPESAFE_API_KEY", env)).toBe(false);
  expect(isWithheldKey("GEMINI_API_KEY", {})).toBe(false);
});
