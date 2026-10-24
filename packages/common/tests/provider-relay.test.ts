/** The CLI side of the provider relay (#1673): when a key is relayed, and what is never a key. */
import { expect, test } from "bun:test";
import { providerCredential, providerRelayFetch, providerRelaySocket, relayedKey } from "../src/provider-relay";
import { INFERENCE_RELAY_PLACEHOLDER, isWithheldKey } from "../src/provider-unavailable";

const RELAY = { BRAIN_PROVIDER_RELAY_SOCKET: "/run/brain-egress/providers.sock", BRAIN_WITHHELD_KEYS: "GEMINI_API_KEY,ANTHROPIC_API_KEY" };

test("a withheld key reaches its provider through the relay; a set or never-withheld key does not", () => {
  expect(relayedKey("GEMINI_API_KEY", RELAY), "WITHHELD_KEY_RELAYED").toBe(true);
  expect(relayedKey("GEMINI_API_KEY", { ...RELAY, GEMINI_API_KEY: "odysseus-admitted" })).toBe(false);
  expect(relayedKey("OPENAI_API_KEY", RELAY), "NEVER_WITHHELD_KEY_NOT_RELAYED").toBe(false);
  expect(relayedKey("GEMINI_API_KEY", { BRAIN_WITHHELD_KEYS: "GEMINI_API_KEY" }), "NO_SOCKET_NO_RELAY").toBe(false);
  expect(providerRelayFetch("gemini", "OPENAI_API_KEY", RELAY)).toBeUndefined();
  expect(typeof providerRelayFetch("gemini", "GEMINI_API_KEY", RELAY)).toBe("function");
});

test("only an absolute socket path names a relay", () => {
  expect(providerRelaySocket(RELAY)).toBe("/run/brain-egress/providers.sock");
  expect(providerRelaySocket({ BRAIN_PROVIDER_RELAY_SOCKET: "providers.sock" })).toBeUndefined();
  expect(providerRelaySocket({})).toBeUndefined();
});

test("the inference relay's placeholder is never a key", () => {
  const env = { ...RELAY, ANTHROPIC_API_KEY: INFERENCE_RELAY_PLACEHOLDER };
  expect(providerCredential("ANTHROPIC_API_KEY", env), "PLACEHOLDER_IS_NOT_A_CREDENTIAL").toBeUndefined();
  expect(isWithheldKey("ANTHROPIC_API_KEY", env), "PLACEHOLDER_KEY_COUNTS_AS_WITHHELD").toBe(true);
  expect(relayedKey("ANTHROPIC_API_KEY", env)).toBe(true);
  expect(providerCredential("ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "odysseus-real" })).toBe("odysseus-real");
});
