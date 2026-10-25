/**
 * Which provider selectors map exactly onto folders (#2694, option C). The
 * real bubblewrap admissions live in private-index.test.ts; these pin the
 * definition itself.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerFolderRoots, providerMaskedFolders, providerTypeSelectors,
  retainedFolderRoots, translateProviderTypes, unsupportedProviderSelectors, type ProviderTaxonomy } from "../src/brain/governance-policy";
import { strayTypedDocuments, taxonomyProtection } from "../src/brain/provider-types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

type Policy = Parameters<typeof providerFolderRoots>[0];
const policy = (...providers: Array<{ paths?: string[]; types?: string[] }>): Policy =>
  ({ providers: providers.map(rule => ({ paths: rule.paths ?? [], ...(rule.types ? { types: rule.types } : {}), allow: ["anthropic"] })) }) as Policy;

const TAXONOMY: ProviderTaxonomy = { inbox: "note", types: {
  identity: { prefixes: ["me/"] }, note: { prefixes: ["notes/"] }, index: { prefixes: [] },
  project: { prefixes: ["projects/", "voyages/"] }, harbor: { prefixes: ["places/"] }, ship: { prefixes: ["places/ships/"] },
  crew: { prefixes: ["crew/*/"] },
} };

test("path selectors map onto a folder only when they select all of it", () => {
  const selected = policy({ paths: ["me/**", "ithaca/**/*", "me/*.md", "me/identity.md", "me", "**/oath/**", "{a,b}/**", "a/**/**/*", ".git/**", ".brain-index/**/*"] });
  expect(providerFolderRoots(selected), "WHOLE_FOLDER_SPELLINGS_TRANSLATE").toEqual(["ithaca", "me"]);
  expect(unsupportedProviderSelectors(selected), "PARTIAL_FILE_OR_RESERVED_SELECTORS_REFUSE")
    .toEqual(["**/oath/**", ".brain-index/**/*", ".git/**", "a/**/**/*", "me", "me/*.md", "me/identity.md", "{a,b}/**"]);
  // Both spellings match exactly the same paths, hidden ones included.
  for (const path of ["me/a.md", "me/x/y.md", "me/.hidden", "me", "mean/a.md"])
    expect(new Bun.Glob("me/**/*").match(path), path).toBe(new Bun.Glob("me/**").match(path));
});

test("a type maps onto its folders only when no other type's territory lies inside them", () => {
  const translated = translateProviderTypes(["identity", "project", "harbor", "ship", "note", "index", "voyage", "crew"], TAXONOMY);
  expect(translated.folders, "EXACT_TYPES_TRANSLATE").toEqual({ identity: ["me"], project: ["projects", "voyages"], ship: ["places/ships"] });
  expect(translated.refused, "INEXACT_TYPES_REFUSE_BY_NAME").toEqual([
    "type harbor (its folder holds type ship (places/ships))",
    "type note (the inbox type, which also covers every path outside the other types' folders)",
    "type index (it has no folder)",
    "type voyage (not a type this brain defines)",
    "type crew (its folders are not literal folders a turn can hide)",
  ]);
  // Two types claiming one folder is not exact for either.
  expect(translateProviderTypes(["identity"], { inbox: "note", types: { identity: { prefixes: ["me/"] }, bio: { prefixes: ["me"] } } }).refused)
    .toEqual(["type identity (its folder holds type bio (me))"]);
  // The launcher cannot mask these, so they refuse by name rather than fail later.
  for (const prefix of [".git/", ".brain-index/", "~vault/", "C:vault/", "a/../b/"])
    expect(translateProviderTypes(["vault"], { inbox: "note", types: { vault: { prefixes: [prefix] } } }).refused, prefix)
      .toEqual(["type vault (its folders are not literal folders a turn can hide)"]);
  // An inherited object key is not a type.
  expect(translateProviderTypes(["constructor"], TAXONOMY).refused).toEqual(["type constructor (not a type this brain defines)"]);
});

// The gate's reuse of a recorded translation is proven across real processes
// in writer-gate.test.ts (#2836).
test("one matched set feeds masks and retention", () => {
  const selected = policy({ paths: ["ithaca/**"], types: ["identity"] });
  expect(providerTypeSelectors(selected)).toEqual(["identity"]);
  expect(providerMaskedFolders(selected, { identity: ["me"] }), "MASKED_SET_IS_FOLDERS_PLUS_TYPE_FOLDERS").toEqual(["ithaca", "me"]);
  expect(retainedFolderRoots(policy({ types: ["identity"] }), ["me"]), "TYPE_FOLDERS_RETAINED_WITH_THE_INDEX").toEqual([".brain-index", "me"]);
  expect(retainedFolderRoots(policy({ types: ["identity"] })), "NOTHING_RETAINED_BEFORE_TRANSLATION").toEqual([]);
  // A folder inside another is hidden by the outer mask alone; bubblewrap
  // cannot mount inside that empty read-only tmpfs (#2718).
  const nested = policy({ paths: ["me/**", "me/sub/**", "mean/**", "ithaca/palace/**/*"] });
  expect(providerFolderRoots(nested), "NESTED_PATH_FOLDER_DROPPED").toEqual(["ithaca/palace", "me", "mean"]);
  expect(providerMaskedFolders(nested, { place: ["ithaca"], vault: ["me/vault"] }), "NESTED_FOLDERS_DROPPED_FROM_THE_MASKED_SET")
    .toEqual(["ithaca", "me", "mean"]);
  expect(retainedFolderRoots(nested, ["ithaca", "me/vault"]), "NESTED_FOLDERS_DROPPED_FROM_RETENTION").toEqual([".brain-index", "ithaca", "me", "mean"]);
});

test("a document declaring a translated type outside its folders is found wherever the turn can read it", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-stray-types-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  const typed = (type: string) => `---\ntype: ${type}\ntitle: Odysseus\n---\nBody.\n`;
  write("me/identity.md", typed("identity"));
  write("notes/second-name.md", typed("identity"));
  write(".obsidian/templates/IDENTITY.MD", typed("identity"));
  write("drafts/oath.md", typed("note"));
  write("notes/broken.md", "---\ntype: [identity\n---\n");
  write("notes/untyped.md", "No frontmatter, no type.\n");
  write(".git/identity.md", typed("identity"));
  write(".brain-index/identity.md", typed("identity"));
  write("node_modules/pkg/identity.md", typed("identity"));
  write("notes/secret.txt", typed("identity"));
  write("notes/README.md", "# Plain\n");
  symlinkSync(join(root, "me/identity.md"), join(root, "notes/masked-link.md"));
  symlinkSync("secret.txt", join(root, "notes/alias.md"));
  symlinkSync("missing.md", join(root, "notes/dangling.md"));
  symlinkSync("../me", join(root, "notes/folder-link.md"));
  symlinkSync("../drafts", join(root, "notes/drafts-link"));
  const outside = mkdtempSync(join(tmpdir(), "odysseus-outside-"));
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "identity.md"), typed("identity"));
  symlinkSync(outside, join(root, "notes/imported"));
  expect(strayTypedDocuments(root, ["identity"], ["me"]), "STRAYS_OUTSIDE_THE_FOLDER_ONLY").toEqual([
    { path: ".obsidian/templates/IDENTITY.MD", type: "identity" },
    { path: "node_modules/pkg/identity.md", type: "identity" },
    { path: "notes/alias.md", type: "identity" },
    // A folder link out of the brain is not followed; it is unverified.
    { path: "notes/imported" },
    { path: "notes/second-name.md", type: "identity" },
  ]);
  // A link into the masked folder of the live brain reads as masked too.
  const live = mkdtempSync(join(tmpdir(), "odysseus-live-brain-"));
  cleanup.push(() => rmSync(live, { recursive: true, force: true }));
  mkdirSync(join(live, "me")); writeFileSync(join(live, "me/identity.md"), typed("identity"));
  symlinkSync(join(live, "me/identity.md"), join(root, "notes/live-link.md"));
  expect(strayTypedDocuments(root, ["identity"], ["me"], live).map(stray => stray.path), "LIVE_MASKED_TARGET_SKIPPED").not.toContain("notes/live-link.md");
  symlinkSync(join(live, "me"), join(root, "notes/live-folder"));
  expect(strayTypedDocuments(root, ["identity"], ["me"], live).map(stray => stray.path), "LINK_INTO_THE_LIVE_BRAIN_NOT_UNVERIFIED").not.toContain("notes/live-folder");
  expect(strayTypedDocuments(root, ["identity"], ["me"]).map(stray => stray.path), "UNMASKED_TARGET_COUNTED").toContain("notes/live-link.md");
  expect(strayTypedDocuments(root, ["identity"], ["me", "notes", ".obsidian", "node_modules"]), "MASKED_FOLDERS_SKIPPED").toEqual([]);
});

test("taxonomy protection refuses an aliased brain path and an in-brain CLI however it is spelled (#2699)", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-taxonomy-protection-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "scripts"), { recursive: true }); writeFileSync(join(brain, "scripts/brain-cli"), "");
  const none = { protect: [], release: [] };
  expect(taxonomyProtection(brain, none, [process.execPath, "/opt/brain/cli.ts"]), "OUTSIDE_CLI_ACCEPTED").toMatchObject({ ok: true });
  expect(taxonomyProtection(brain, none), "FALLBACK_NAMED").toEqual({ ok: false,
    reason: "the brain has no packaged CLI (node_modules/.bin/brain), and the CLI it runs, scripts/brain-cli.ts, is not a protected path" });
  for (const arg of ["./scripts/brain-cli.ts", "node_modules/../scripts/brain-cli.ts", join(brain, "scripts/brain-cli.ts"), "scripts/brain-cli"])
    expect(taxonomyProtection(brain, none, [process.execPath, arg]), arg).toMatchObject({ ok: false, reason: expect.stringContaining("is not a protected path") });
  expect(taxonomyProtection(brain, none, [process.execPath, brain]), "THE_BRAIN_ITSELF_REFUSED")
    .toEqual({ ok: false, reason: "the CLI it runs, the brain itself, is not a protected path" });
  expect(taxonomyProtection(brain, { protect: ["scripts"], release: [] }, [process.execPath, "./scripts/brain-cli.ts"]), "PROTECTED_SCRIPT_ACCEPTED").toMatchObject({ ok: true });
  expect(taxonomyProtection(`${brain}/`, none, [process.execPath, "/opt/brain/cli.ts"]), "TRAILING_SLASH_ACCEPTED").toMatchObject({ ok: true });
  const shown = taxonomyProtection(brain, { protect: [".brain-ui/inbox", ".brain", "lib"], release: [] }, [process.execPath, "/opt/brain/cli.ts"]);
  expect(shown.ok && shown.visible, "TURN_STATE_NEVER_SHOWN").toEqual(expect.arrayContaining(["lib", "brain.config.ts"]));
  expect(shown.ok && shown.visible.filter(path => path.startsWith(".brain")), "TURN_STATE_NEVER_SHOWN").toEqual([]);
  symlinkSync(brain, join(root, "alias"));
  expect(taxonomyProtection(join(root, "alias"), none, [process.execPath, "/opt/brain/cli.ts"]), "ALIASED_BRAIN_REFUSED")
    .toEqual({ ok: false, reason: "the configured brain path is not its canonical path, so the live brain may be visible to the taxonomy under another name" });
});
