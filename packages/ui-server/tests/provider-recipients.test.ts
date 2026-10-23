/**
 * Recipient names for provider policy rules (#2695): only an exact relay
 * origin names one, built in or operator-named; folders are judged per rule
 * and per recipient; a conversation's earlier exposures conflict with a turn
 * that would mask what they showed.
 */
import { expect, test } from "bun:test";
import { exposedAnything, exposureConflicts, providerDeniedFolders, providerMaskedFolders } from "../src/brain/governance-policy";
import { FIRST_PARTY_RECIPIENT_ORIGINS, parseProviderRecipientOrigins, providerRecipient } from "../src/brain/provider-recipients";
import { resolveServerConfig } from "../src/config/env";

test("a built-in vendor origin names its vendor and nothing else names a recipient", () => {
  expect(providerRecipient("https://api.anthropic.com"), "FIRST_PARTY_ANTHROPIC").toBe("anthropic");
  expect(providerRecipient("https://chatgpt.com"), "CODEX_IS_OPENAI").toBe("openai");
  expect(providerRecipient("https://generativelanguage.googleapis.com"), "FIRST_PARTY_GOOGLE").toBe("google");
  for (const unknown of [
    "https://gateway.ithaca.invalid", // a custom base URL, or an origin listed only for a credential
    "https://openrouter.ai", "https://ai-gateway.vercel.sh", "https://api.individual.githubcopilot.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com", "https://europe-west4-aiplatform.googleapis.com",
    "http://api.anthropic.com", "https://api.anthropic.com:8443", "https://api.anthropic.com/v1", "not a url",
  ]) expect(providerRecipient(unknown), `UNKNOWN_RECIPIENT ${unknown}`).toBeUndefined();
  expect(providerRecipient(undefined)).toBeUndefined();
  // A name is a lowercase policy word; the table never maps one origin to two vendors.
  for (const [origin, name] of Object.entries(FIRST_PARTY_RECIPIENT_ORIGINS)) {
    expect(new URL(origin).origin).toBe(origin);
    expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  }
});

test("an operator names a trusted gateway origin, never a built-in one, and a malformed entry refuses the boot", () => {
  const named = parseProviderRecipientOrigins(" anthropic = https://gateway.ithaca.invalid/ ,http://10.0.0.7:8080; google=https://generativelanguage.googleapis.com ");
  expect(providerRecipient("https://gateway.ithaca.invalid", named), "OPERATOR_GATEWAY_NAMED").toBe("anthropic");
  expect(providerRecipient("http://10.0.0.7:8080", named)).toBe("anthropic");
  expect(providerRecipient("https://gateway.ithaca.invalid"), "UNLISTED_GATEWAY_UNKNOWN").toBeUndefined();
  expect(parseProviderRecipientOrigins(undefined).size).toBe(0);
  for (const [value, reason] of [
    ["https://gateway.ithaca.invalid", "without a lowercase policy name"],
    ["Anthropic=https://gateway.ithaca.invalid", "without a lowercase policy name"],
    ["anthropic=", "lists no origin"],
    ["anthropic=https://gateway.ithaca.invalid/v1", "exact http(s) origin"],
    ["anthropic=ftp://gateway.ithaca.invalid", "exact http(s) origin"],
    ["openai=https://api.anthropic.com", "anthropic's own origin"],
    ["anthropic=https://gateway.ithaca.invalid;google=https://gateway.ithaca.invalid", "both anthropic and google"],
  ] as const) expect(() => parseProviderRecipientOrigins(value), `OPERATOR_MAPPING_REFUSED ${value}`).toThrow(reason);
  expect(() => resolveServerConfig({ BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS: "anthropic=https://gateway.ithaca.invalid/v1" }), "BOOT_REFUSES_MALFORMED_MAPPING")
    .toThrow("BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS");
  expect(resolveServerConfig({ BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS: "anthropic=https://gateway.ithaca.invalid" }).providerRecipientOrigins?.get("https://gateway.ithaca.invalid"))
    .toBe("anthropic");
});

test("a recipient is masked the folders of every rule that does not allow it", () => {
  const policy = { providers: [
    { paths: ["me/**"], allow: ["anthropic"] },
    { paths: ["finance/**/*"], types: ["health"], allow: ["google"] },
    { paths: ["me/letters/**"], allow: ["google"] },
  ] };
  const types = { health: ["health"] };
  expect(providerDeniedFolders(policy, types, undefined), "UNPROVEN_RECIPIENT_DENIED_EVERYTHING").toEqual(["finance", "health", "me"]);
  expect(providerMaskedFolders(policy, types)).toEqual(["finance", "health", "me"]);
  // Matching rules intersect, and only outermost folders are retained (#2718):
  // a denied folder inside an allowed one masks the outer folder whole.
  expect(providerDeniedFolders(policy, types, "anthropic"), "ANTHROPIC_DENIED").toEqual(["finance", "health", "me"]);
  expect(providerDeniedFolders(policy, types, "google"), "GOOGLE_DENIED").toEqual(["me"]);
  expect(providerDeniedFolders(policy, types, "mistral"), "OTHER_RECIPIENT_DENIED_EVERYTHING").toEqual(["finance", "health", "me"]);
  expect(providerDeniedFolders({ providers: [{ paths: ["me/**"], allow: ["anthropic", "google"] }] }, {}, "google")).toEqual([]);
});

test("a turn conflicts with what earlier turns showed and it would mask, never with what was hidden from them", () => {
  const shown = { recipient: "anthropic", visible: ["finance", "me"], hidden: ["finance", "me/letters"] };
  expect(exposedAnything(shown)).toBe(true);
  expect(exposedAnything({ visible: ["me"], hidden: ["me"] }), "NOTHING_SHOWN").toBe(false);
  expect(exposureConflicts([shown], ["me"]), "MASKED_FOLDER_THAT_WAS_SHOWN").toEqual([{ folder: "me", recipient: "anthropic" }]);
  expect(exposureConflicts([shown], ["me/notes"]), "MASKED_PART_OF_A_SHOWN_FOLDER").toEqual([{ folder: "me/notes", recipient: "anthropic" }]);
  expect(exposureConflicts([shown], ["finance", "me/letters/odes"]), "HIDDEN_FOLDERS_NEVER_CONFLICT").toEqual([]);
  expect(exposureConflicts([shown], ["notes"]), "UNRELATED_FOLDER").toEqual([]);
  expect(exposureConflicts([shown, { recipient: "google", visible: ["me"], hidden: [] }], ["me"]))
    .toEqual([{ folder: "me", recipient: "anthropic" }, { folder: "me", recipient: "google" }]);
});
