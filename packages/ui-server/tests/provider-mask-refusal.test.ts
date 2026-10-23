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
