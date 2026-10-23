/** The refusal names the `providers` rule whose selector maps onto the masked folder (#2690, #2694). */
import { expect, test } from "bun:test";
import { createProviderMaskGuard, isProviderMasked, type ProviderMaskRefusal } from "../src/brain/provider-mask-refusal.js";

test("each masked folder is attributed to the path or type selector that maps onto it", () => {
  const refusals: ProviderMaskRefusal[] = [];
  const guard = createProviderMaskGuard({ folders: ["journal", "me", "studies"],
    policy: { providers: [{ paths: ["notes/raft.md"], allow: ["anthropic"] }, { paths: ["me/**/*"], allow: ["anthropic"] },
      { paths: [], types: ["journal"], allow: ["anthropic"] }, { paths: ["studies/**"], allow: ["anthropic"] }] },
    typeFolders: { journal: ["journal"] }, record: refusal => refusals.push(refusal) });
  for (const path of ["me/identity.md", "journal/2026-07-12.md", "studies/troy.md"]) expect(() => guard.assert("brain_read_base", [path])).toThrow("provider_masked");
  expect(() => guard.assert("brain_read_base", ["notes/raft.md", "mention/me.md"]), "UNMASKED_PATHS_PASS").not.toThrow();
  expect(refusals.map(refusal => refusal.rule), "RULE_NAMES_THE_MAPPING_SELECTOR").toEqual([
    { list: "providers", index: 1, pattern: "me/**/*" },
    { list: "providers", index: 2, pattern: "type journal" },
    { list: "providers", index: 3, pattern: "studies/**" },
  ]);
});

test("a masked root matches whole segments, case-sensitively, after dot segments resolve", () => {
  expect(isProviderMasked("me/identity.md", ["me"])).toBe(true);
  expect(isProviderMasked("notes/../me/identity.md", ["me"])).toBe(true);
  expect(isProviderMasked("me", ["me"])).toBe(true);
  expect(isProviderMasked("meadow/notes.md", ["me"])).toBe(false);
  expect(isProviderMasked("Me/identity.md", ["me"])).toBe(false);
  expect(isProviderMasked("group/private/x.md", ["group/private"])).toBe(true);
  expect(isProviderMasked("group/x.md", ["group/private"])).toBe(false);
});

test("overlapping rules name the first path selector, ahead of a type that maps onto the same folder", () => {
  const refusals: ProviderMaskRefusal[] = [];
  const guard = createProviderMaskGuard({ folders: ["me"],
    policy: { providers: [{ paths: [], types: ["identity"], allow: ["anthropic"] }, { paths: ["me/**"], allow: ["anthropic"] }, { paths: ["me/**/*"], allow: ["anthropic"] }] },
    typeFolders: { identity: ["me"] }, record: refusal => refusals.push(refusal) });
  expect(() => guard.assert("brain_read_base", ["me/identity.md"])).toThrow("provider_masked");
  expect(refusals.map(refusal => refusal.rule), "FIRST_PATH_RULE_WINS").toEqual([{ list: "providers", index: 1, pattern: "me/**" }]);
});

test("a nested selector collapses into its outer folder, which refuses everything below it (#2718)", async () => {
  const { providerMaskedFolders } = await import("../src/brain/governance-policy.js");
  const policy = { providers: [{ paths: ["me/**"], allow: ["anthropic"] }, { paths: ["me/journal/**"], allow: ["anthropic"] }] };
  const folders = providerMaskedFolders(policy);
  expect(folders, "NESTED_MASK_COLLAPSED").toEqual(["me"]);
  const refusals: ProviderMaskRefusal[] = [];
  const guard = createProviderMaskGuard({ folders, policy, record: refusal => refusals.push(refusal) });
  expect(() => guard.assert("brain_read_base", ["me/journal/2026-07-12.md"]), "OUTER_FOLDER_COVERS_NESTED_PATHS").toThrow("provider_masked");
  expect(refusals.map(refusal => refusal.rule)).toEqual([{ list: "providers", index: 0, pattern: "me/**" }]);
});
