/** Data source and omission proof; provider-frame proof is in live-history-adapters. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readConversationOrientation } from "../src/voice/conversation-orientation";
import { governancePolicyReaderFor } from "../src/brain/governance-policy";
import { conversationOrientation, projectConversationGuidance } from "@schlessera/brain-ui-sdk/internal";
import { BRAIN_UI_SYSTEM_PROMPT_APPEND } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import type { WsHost } from "../src/ws/host";
import * as walker from "../src/files/walker";

let root: string;
const restore: (() => void)[] = [];
afterEach(() => { for (const cleanup of restore.splice(0).reverse()) cleanup(); if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "odyssey-orientation-"));
  mkdirSync(join(root, "me")); mkdirSync(join(root, "context"));
  const backend = makeFakeBackend({ id: "fake" });
  backend.conversationGuidance = projectConversationGuidance("# Personal Rules\nUse short answers.\n# Response surface\nRender diagrams.", "configured systemPromptAppend");
  const host = { brainPath: root, registry: createStaticBackendRegistry([backend], "fake"), catalog: {} } as WsHost;
  const read = () => readConversationOrientation(host, {}, () => true);
  return { backend, host, read, write: (path: string, content: string) => writeFileSync(join(root, path), content) };
}

test("root overlays, safe JSON canonicals and module names are classified without importing procedures", async () => {
  const f = fixture();
  f.write("AGENTS.md", "# Personal Rules\nAsk one clear question at a time.\n# Frontmatter schema\nHOST_ONLY_SCHEMA\n");
  f.write("CLAUDE.md", "@AGENTS.md\n# Capture policy\nAsk before capturing an emerging preference.\n# Modules\n<!-- brain:generated:module-travel -->\nHOST_ONLY_MODULE_TOOLS\n<!-- /brain:generated:module-travel -->\n");
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: "me/odysseus.md", currentFocus: "context/watch.md" } } }));
  f.write("me/odysseus.md", "---\nsummary: Odysseus returns to Ithaca.\n---\nHe commands the raft.\n\n## Private detail\nHOST_ONLY_IDENTITY_TAIL\n");
  f.write("context/watch.md", "# Current focus\nRepair the mast on 2026-07-12.\n\n## Later\nHOST_ONLY_FOCUS_TAIL\n");
  const orientation = await f.read();
  const encoded = conversationOrientation(orientation);
  expect(orientation.guidance.map(g => g.source)).toEqual(["configured systemPromptAppend", "AGENTS.md", "CLAUDE.md"]);
  expect(orientation.knowledge.map(k => k.topic)).toEqual(["domains", "identity", "current_focus"]);
  expect(encoded, "CANONICAL_IDENTITY_LEAD_INCLUDED").toContain("Odysseus returns to Ithaca.");
  expect(encoded).toContain("Repair the mast on 2026-07-12."); expect(encoded).toContain("travel");
  expect(encoded).not.toContain("HOST_ONLY"); expect(encoded).not.toContain("Render diagrams");
  expect(encoded).not.toContain("@AGENTS.md");
});

test("missing brain files and absent configured policy remain explicit gaps in a fresh chat", async () => {
  const f = fixture(); f.backend.conversationGuidance = [];
  const orientation = await f.read();
  expect(orientation.guidance).toEqual([]); expect(orientation.knowledge).toEqual([]);
  expect(orientation.unavailable.some(value => value.startsWith("identity:"))).toBe(true);
  expect(orientation.unavailable.some(value => value.startsWith("current_focus:"))).toBe(true);
  expect(orientation.unavailable).toContain("configured append: guidance absent or withheld");
  expect(BRAIN_UI_SYSTEM_PROMPT_APPEND).toContain("if that policy is missing, ask before capturing an emerging fact");
});

test("TypeScript configuration is never evaluated and its runtime paths are not presented as canonical", async () => {
  const f = fixture();
  f.write("brain.config.ts", 'throw Error("ORIENTATION_MUST_NOT_EXECUTE_CONFIG");\n');
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: "me/other.md" } } }));
  f.write("me/identity.md", "Odysseus sails for Ithaca.\n"); f.write("me/other.md", "HOST_ONLY_INACTIVE_JSON_CANONICAL\n");
  const orientation = await f.read();
  expect(orientation.knowledge[0]).toMatchObject({ source: "conventional me/identity.md", text: "Odysseus sails for Ithaca." });
  expect(orientation.unavailable).toContain("runtime canonical paths not evaluated; conventional identity/focus candidates only");
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY");
});

test("fresh indexed content supplies an observed partial map even when runtime taxonomy is TypeScript", async () => {
  const f = fixture(); mkdirSync(join(root, "voyages")); mkdirSync(join(root, "watch"));
  f.write("brain.config.ts", 'throw Error("ORIENTATION_MUST_NOT_EXECUTE_CONFIG");\n');
  f.write("_index.md", "---\nsummary: Odysseus prepares the return to Ithaca.\n---\n## Registry\nHOST_ONLY_ROOT_REGISTRY\n");
  f.write("voyages/_index.md", "---\nsummary: Routes and raft decisions.\n---\n## Children\nHOST_ONLY_CHILD_REGISTRY\n");
  f.write("watch/_index.md", "# Watch\n\nPenelope's watch arrangements on 2026-07-12.\n\n| Child | Status |\n| --- | --- |\nHOST_ONLY_TABLE\n");
  const orientation = await f.read();
  const map = orientation.knowledge.find(entry => entry.topic === "content_map");
  expect(map?.text ?? "", "OBSERVED_INDEX_MAP_REACHES_FRESH_START").toContain("Routes and raft decisions.");
  expect(map?.text).toContain("voyages/_index.md"); expect(map?.text).toContain("watch/_index.md");
  expect(map?.text).toContain("Odysseus prepares the return to Ithaca.");
  expect(map?.text).toContain("Penelope's watch arrangements on 2026-07-12.");
  expect(map?.text).toContain("OBSERVED"); expect(map?.text).toContain("partial");
  expect(map?.text).toContain("not runtime taxonomy");
  const encoded = conversationOrientation(orientation);
  expect(encoded).toContain('"topic":"content_map"'); expect(encoded).not.toContain("HOST_ONLY");
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(3200);
});

test("observed map excludes hidden/tooling roots, linked directories/sources and deeper indexes", async () => {
  const f = fixture();
  for (const name of ["voyages", ".hidden", "skills", "node_modules", "workspaces", "charted", "deeper/sea"]) {
    mkdirSync(join(root, name), { recursive: true });
    if (name !== "charted") f.write(`${name}/_index.md`, name === "voyages" ? "Routes to Ithaca." : "HOST_ONLY_EXCLUDED");
  }
  symlinkSync(join(root, "voyages"), join(root, "linked-inside"));
  symlinkSync(join(root, ".."), join(root, "linked-outside"));
  symlinkSync(join(root, "voyages", "_index.md"), join(root, "charted", "_index.md"));
  symlinkSync(join(root, "voyages", "_index.md"), join(root, "_index.md"));
  const orientation = await f.read();
  const map = orientation.knowledge.find(entry => entry.topic === "content_map");
  expect(map?.text).toContain("Routes to Ithaca."); expect(map?.text).toContain("voyages/_index.md");
  const encoded = conversationOrientation(orientation);
  expect(encoded).not.toContain("HOST_ONLY"); expect(encoded).not.toContain('"path":"_index.md"');
  for (const name of [".hidden/", "skills/", "node_modules/", "workspaces/", "charted/", "linked-inside/", "linked-outside/", "deeper/sea/"]) expect(encoded).not.toContain(name);
  expect(map?.text).toContain("excluded");
});

test("map source bounds and malformed, executable or invalid UTF-8 indexes are explicit gaps", async () => {
  const f = fixture();
  for (const name of ["voyages", "bad-yaml", "bad-code", "bad-utf8", "long-lead"]) mkdirSync(join(root, name));
  f.write("_index.md", "---\nsummary: HOST_ONLY_OVERSIZE_MAP\n---\n## Registry\n" + "x".repeat(8192));
  f.write("bad-yaml/_index.md", "---\nsummary: [\n---\nHOST_ONLY_MALFORMED");
  f.write("bad-code/_index.md", "---js\nthrow Error('HOST_ONLY_EXECUTABLE')\n---\nHOST_ONLY_EXECUTABLE");
  writeFileSync(join(root, "bad-utf8/_index.md"), Buffer.from([0xc3, 0x28]));
  f.write("long-lead/_index.md", "HOST_ONLY_LONG_LEAD " + "🦉".repeat(80));
  f.write("voyages/_index.md", "Routes and raft decisions.");
  const orientation = await f.read();
  const map = orientation.knowledge.find(entry => entry.topic === "content_map");
  expect(conversationOrientation(orientation), "OVERSIZED_INDEX_MUST_NOT_DISCLOSE_EVEN_A_SHORT_SUMMARY").not.toContain("HOST_ONLY_OVERSIZE_MAP");
  expect(map?.text).toContain("Routes and raft decisions.");
  expect(map?.text).toContain("7 missing/unreadable/malformed/oversized or without a short lead");
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY");
});

test("map enumeration, source count and bytes are bounded and omissions survive projection", async () => {
  const f = fixture();
  f.write("_index.md", "---\nsummary: Odysseus's return to Ithaca.\n---\n");
  for (let i = 0; i < 80; i++) {
    const name = `voyage-${String(i).padStart(2, "0")}`; mkdirSync(join(root, name));
    f.write(`${name}/_index.md`, "---\nsummary: " + "The raft follows Athena's olive mark. ".repeat(5) + "\n---\n");
  }
  const open = fsPromises.opendir; let enumerated = 0;
  const directorySpy = spyOn(fsPromises, "opendir").mockImplementation((async (...args: Parameters<typeof open>) => {
    const directory = await open(...args), read = directory.read.bind(directory);
    const readSpy = spyOn(directory, "read").mockImplementation((async () => { enumerated++; return read(); }) as typeof directory.read);
    restore.push(() => readSpy.mockRestore()); return directory;
  }) as typeof open);
  restore.push(() => directorySpy.mockRestore());
  const sourceSpy = spyOn(walker, "readAnchoredSnapshot"); restore.push(() => sourceSpy.mockRestore());
  const orientation = await f.read();
  const map = orientation.knowledge.find(entry => entry.topic === "content_map")!;
  expect(enumerated, "MAP_DIRECTORY_ENUMERATION_IS_BOUNDED").toBeLessThanOrEqual(64);
  const reads = sourceSpy.mock.calls.filter(call => call[2].endsWith("_index.md"));
  expect(reads.length, "MAP_SOURCE_COUNT_IS_BOUNDED").toBe(9);
  expect(reads.every(call => call[3] === 8192), "MAP_SOURCE_BYTES_ARE_BOUNDED").toBe(true);
  expect(Buffer.byteLength(map.text), "MAP_TEXT_HAS_EXACT_BYTE_CEILING").toBeLessThanOrEqual(900);
  expect(map.text).toContain("entry cap reached"); expect(map.text).toContain("9 index sources attempted");
  expect(map.text).toMatch(/[1-9]\d* omitted by count\/bytes/u);
  const encoded = conversationOrientation(orientation);
  expect(encoded).toContain("OBSERVED"); expect(encoded).toContain("omitted by count/bytes");
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(3200);
});

test("authorization loss during map enumeration withholds the entire new map", async () => {
  const f = fixture(); f.write("_index.md", "HOST_ONLY_REVOKED_MAP");
  let authorized = true;
  const open = fsPromises.opendir;
  const spy = spyOn(fsPromises, "opendir").mockImplementation((async (...args: Parameters<typeof open>) => {
    const directory = await open(...args); authorized = false; return directory;
  }) as typeof open);
  restore.push(() => spy.mockRestore());
  const orientation = await readConversationOrientation(f.host, {}, () => authorized);
  expect(authorized, "ENUMERATION_REVOKES_AUTHORIZATION").toBe(false);
  expect(orientation.knowledge, "REVOKED_MAP_IS_WITHHELD").toEqual([]);
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY_REVOKED_MAP");
});

test("source read cap, escaped paths and executable frontmatter do not reach the provider seed", async () => {
  const f = fixture();
  f.write("AGENTS.md", "# Personal Rules\n" + "🦉".repeat(20000));
  // The escaped path names a real file beside the brain, so omitting it is the refusal, not a missing file.
  const outside = mkdtempSync(join(tmpdir(), "odyssey-orientation-outside-"));
  restore.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "outside.md"), "HOST_ONLY_ESCAPED_PATH\n");
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: `../${basename(outside)}/outside.md`, currentFocus: "context/watch.md" } } }));
  f.write("context/watch.md", "---js\nthrow Error('ORIENTATION_MUST_NOT_EXECUTE_FRONTMATTER')\n---\nHOST_ONLY_EXECUTABLE\n");
  const orientation = await f.read();
  expect(orientation.knowledge).toEqual([]);
  expect(orientation.unavailable).toContain("AGENTS.md: missing, unreadable or too large");
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY");
});

test("a source symlink escaping the brain is omitted", async () => {
  const f = fixture();
  // The escaped target exists and has content, so an empty result is the refusal, not a missing file.
  const outside = mkdtempSync(join(tmpdir(), "odyssey-orientation-outside-"));
  restore.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "identity.md"), "HOST_ONLY_ESCAPED_IDENTITY\n");
  symlinkSync(outside, join(root, "me", "outside"));
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: "me/outside/identity.md", currentFocus: "" } } }));
  const orientation = await f.read();
  expect(orientation.knowledge, "ESCAPING_SYMLINK_SOURCE_OMITTED").toEqual([]);
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY_ESCAPED_IDENTITY");
});

test("provider rules and invalid governance withhold new repository sources", async () => {
  const f = fixture(); mkdirSync(join(root, "context", "policies"));
  f.write("CLAUDE.md", "# Personal Rules\nHOST_ONLY_WITHHELD\n");
  f.write("me/identity.md", "HOST_ONLY_WITHHELD_IDENTITY\n");
  f.write("_index.md", "HOST_ONLY_WITHHELD_MAP\n");
  const enumeration = spyOn(fsPromises, "opendir"); restore.push(() => enumeration.mockRestore());
  const valid = "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\n";
  for (const policy of [valid, "---\nschema_version: invalid\n---\n"]) {
    f.write("context/policies/governance.md", policy);
    if (policy === valid) {
      const checked = governancePolicyReaderFor(root).load();
      expect(checked.errors).toEqual([]); expect(checked.policy.providers).toHaveLength(1);
    }
    const orientation = await f.read();
    expect(conversationOrientation(orientation), "PROVIDER_POLICY_WITHHOLDS_OBSERVED_MAP").not.toContain("HOST_ONLY_WITHHELD_MAP");
    expect(orientation.knowledge).toEqual([]);
    expect(conversationOrientation(orientation), "REPOSITORY_POLICY_WITHHOLDS_NEW_STARTUP_CONTENT").not.toContain("HOST_ONLY");
    expect(enumeration, "RESTRICTIVE_POLICY_PREVENTS_MAP_ENUMERATION").not.toHaveBeenCalled();
  }
});

test("a policy change while reading the map withholds every new repository entry", async () => {
  const f = fixture(); mkdirSync(join(root, "context", "policies"));
  f.write("_index.md", "HOST_ONLY_POLICY_CHANGED_MAP");
  const read = walker.readAnchoredSnapshot; let changed = false;
  const spy = spyOn(walker, "readAnchoredSnapshot").mockImplementation((...args: Parameters<typeof read>) => {
    const snapshot = read(...args);
    if (args[2] === "_index.md") { changed = true; f.write("context/policies/governance.md", "---\nschema_version: invalid\n---\n"); }
    return snapshot;
  });
  restore.push(() => spy.mockRestore());
  const orientation = await f.read();
  expect(changed, "MAP_READ_CHANGED_POLICY").toBe(true);
  expect(orientation.knowledge, "CHANGED_POLICY_WITHHOLDS_MAP").toEqual([]);
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY_POLICY_CHANGED_MAP");
});

test("revoked authorization never obtains configured guidance or brain knowledge", async () => {
  const f = fixture();
  const orientation = await readConversationOrientation(f.host, {}, () => false);
  expect(orientation.guidance).toEqual([]); expect(orientation.knowledge).toEqual([]);
});

test("whole oversized policies are omitted; a long knowledge lead keeps whole short paragraphs with an omission marker", () => {
  const text = conversationOrientation({ guidance: [{ source: "CLAUDE.md", topic: "capture_policy", text: "POLICY_START " + "x".repeat(1000) + " Never capture." }],
    knowledge: [{ source: "me/identity.md", topic: "identity", text: "Odysseus returns to Ithaca.\n\n" + "Background. ".repeat(200) }], unavailable: [] });
  expect(text).not.toContain("POLICY_START"); expect(text).toContain("Odysseus returns to Ithaca.");
  expect(text).toContain("Further lead context omitted"); expect(text).toContain('"omitted":true');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3200);
});

test("selected capture policy preserves its complete nested exceptions", async () => {
  const f = fixture();
  const policy = "Capture useful facts automatically.\n### Exceptions\nNever capture private watch details unless explicitly asked.\n#### Clarification\nAsk when the meaning is uncertain.";
  f.write("CLAUDE.md", `## Capture Policy\n${policy}\n## Execution\nHOST_ONLY_EXECUTION\n`);
  const orientation = await f.read();
  expect(orientation.guidance.find(entry => entry.topic === "capture_policy")?.text,
    "CAPTURE_POLICY_MUST_BE_WHOLE_OR_WITHHELD").toBe(policy);
  const encoded = conversationOrientation(orientation);
  expect(encoded).toContain("Never capture private watch details");
  expect(encoded).not.toContain("HOST_ONLY_EXECUTION");
});

for (const [label, restriction] of [
  ["generated region", "<!-- brain:generated:module-travel -->\nNever capture private watch details.\n<!-- /brain:generated:module-travel -->"],
  ["import", "@capture-rules.md"],
  ["fenced block", "```text\nNever capture private watch details.\n```"],
] as const) test(`selected capture policy with a ${label} is wholly withheld with an explicit gap`, async () => {
  const f = fixture();
  f.write("CLAUDE.md", `## Personal Rules\nBe concise.\n## Capture Policy\nCapture useful facts automatically.\n${restriction}\nAsk before preserving watch decisions.\n`);
  const orientation = await f.read();
  expect(orientation.guidance.filter(entry => entry.source === "CLAUDE.md"),
    "CAPTURE_POLICY_MUST_BE_WHOLE_OR_WITHHELD").toEqual([]);
  expect(conversationOrientation(orientation)).not.toContain("Capture useful facts automatically");
  expect(orientation.unavailable.some(value => value.startsWith("CLAUDE.md:") && value.includes("withheld")),
    "WITHHELD_GUIDANCE_IS_EXPLICIT").toBe(true);
});

test("map ordering preserves useful navigation and whole policy under count and byte pressure", () => {
  const policy = "Ask before capturing watch decisions.\n### Exceptions\nNever save a private watch detail.";
  const map = { source: "observed _index.md", topic: "content_map" as const,
    text: "OBSERVED partial map; not runtime taxonomy.\n\nvoyages/_index.md: Routes and raft decisions.\n\nCoverage: registry tables/deeper paths omitted; explore through host." };
  const orientation = { guidance: [{ source: "CLAUDE.md", topic: "capture_policy" as const, text: policy }],
    knowledge: [map, ...Array.from({ length: 8 }, () => ({ source: "me/identity.md", topic: "identity" as const, text: "Ω".repeat(440) }))], unavailable: [] };
  const encoded = conversationOrientation(orientation);
  expect(encoded, "MAP_SURVIVES_SUPPLEMENTAL_KNOWLEDGE_PRESSURE").toContain("voyages/_index.md");
  expect(encoded).toContain(JSON.stringify(policy)); expect(encoded).toContain('"omitted":true');
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(3200);
  orientation.guidance.push(...Array.from({ length: 7 }, () => ({ source: "AGENTS.md", topic: "capture_policy" as const, text: "ω".repeat(440) })));
  const dense = conversationOrientation(orientation);
  expect(dense).toContain(JSON.stringify(policy)); expect(dense).not.toContain("voyages/_index.md");
  expect(dense).toContain('"omitted":true'); expect(Buffer.byteLength(dense)).toBeLessThanOrEqual(3200);
});

function replacementBrains(canonical = false) {
  const f = fixture();
  const first = join(root, "first"), second = join(root, "second"), alias = join(root, "current");
  for (const directory of [first, second]) {
    mkdirSync(join(directory, "me"), { recursive: true });
    mkdirSync(join(directory, "context", "policies"), { recursive: true });
    writeFileSync(join(directory, "AGENTS.md"), "## Personal Rules\nKeep replies brief.\n");
  }
  writeFileSync(join(first, "me", "identity.md"), "Odysseus commands the raft.\n");
  mkdirSync(join(first, "voyages"));
  writeFileSync(join(first, "voyages", "_index.md"), "Odysseus's routes to Ithaca.\n");
  mkdirSync(join(second, "WITHHELD_REPLACEMENT_AREA"));
  writeFileSync(join(second, "WITHHELD_REPLACEMENT_AREA", "_index.md"), "WITHHELD_REPLACEMENT_MAP\n");
  writeFileSync(join(second, "me", "identity.md"), "WITHHELD_REPLACEMENT_IDENTITY\n");
  writeFileSync(join(second, "context", "policies", "governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\n");
  symlinkSync(first, alias);
  const host = { ...f.host, brainPath: canonical ? first : alias } as WsHost;
  return { ...f, host, read: () => readConversationOrientation(host, {}, () => true), first, second, alias };
}

test("root alias retargeting cannot read another root under the former provider policy", async () => {
  const f = replacementBrains();
  const realpath = fsPromises.realpath;
  let replaced = false;
  const spy = spyOn(fsPromises, "realpath").mockImplementation((async (...args: Parameters<typeof realpath>) => {
    if (args[0] === f.alias && !replaced) {
      replaced = true; unlinkSync(f.alias); symlinkSync(f.second, f.alias);
    }
    return realpath(...args);
  }) as typeof realpath);
  restore.push(() => spy.mockRestore());
  const orientation = await f.read();
  expect(replaced, "ROOT_REPLACEMENT_PROBE_ACTUALLY_RETARGETED_ALIAS").toBe(true);
  expect(conversationOrientation(orientation), "REPLACED_ROOT_MUST_USE_ITS_OWN_PROVIDER_POLICY").not.toContain("WITHHELD_REPLACEMENT_IDENTITY");
  expect(orientation.knowledge).toEqual([]);
});

test("temporary root substitution cannot enumerate replacement names under the held root's policy", async () => {
  const f = replacementBrains(true);
  const open = fsPromises.opendir; let replaced = false; let enumeratedAt = "";
  const spy = spyOn(fsPromises, "opendir").mockImplementation((async (...args: Parameters<typeof open>) => {
    replaced = true; enumeratedAt = String(args[0]);
    renameSync(f.first, join(root, "former")); renameSync(f.second, f.first);
    try { return await open(...args); }
    finally { renameSync(f.first, f.second); renameSync(join(root, "former"), f.first); }
  }) as typeof open);
  restore.push(() => spy.mockRestore());
  const orientation = await f.read();
  expect(replaced, "ROOT_REPLACEMENT_PROBE_ACTUALLY_REPLACED_DIRECTORY").toBe(true);
  expect(enumeratedAt, "MAP_ENUMERATES_THE_POLICY_HELD_ROOT_DESCRIPTOR").toMatch(/^\/proc\/self\/fd\/\d+\/\.$/u);
  const encoded = conversationOrientation(orientation);
  expect(encoded, "HELD_ROOT_ENUMERATION_PRESERVES_ORIGINAL_MAP").toContain("Odysseus's routes to Ithaca.");
  expect(encoded, "REPLACEMENT_DIRECTORY_NAMES_ARE_CONFIDENTIAL").not.toContain("WITHHELD_REPLACEMENT");
});

test("replacing the canonical directory during collection withholds every repository source", async () => {
  const f = replacementBrains(true);
  const read = walker.readAnchoredSnapshot;
  let replaced = false;
  const spy = spyOn(walker, "readAnchoredSnapshot").mockImplementation((...args: Parameters<typeof read>) => {
    const snapshot = read(...args);
    if (!replaced && args[2] === "AGENTS.md") {
      replaced = true; renameSync(f.first, join(root, "former")); renameSync(f.second, f.first);
    }
    return snapshot;
  });
  restore.push(() => spy.mockRestore());
  const orientation = await f.read();
  expect(replaced, "ROOT_REPLACEMENT_PROBE_ACTUALLY_REPLACED_DIRECTORY").toBe(true);
  expect(conversationOrientation(orientation), "REPLACED_ROOT_MUST_USE_ITS_OWN_PROVIDER_POLICY").not.toContain("WITHHELD_REPLACEMENT_IDENTITY");
  expect(orientation.knowledge).toEqual([]);
  expect(orientation.guidance.every(entry => entry.source === "configured systemPromptAppend")).toBe(true);
});

test("a temporary canonical-root replacement cannot substitute content between identity checks", async () => {
  const f = replacementBrains(true);
  const read = walker.readAnchoredSnapshot;
  let replaced = false;
  const spy = spyOn(walker, "readAnchoredSnapshot").mockImplementation((...args: Parameters<typeof read>) => {
    if (replaced || args[2] !== "me/identity.md") return read(...args);
    replaced = true;
    renameSync(f.first, join(root, "former")); renameSync(f.second, f.first);
    try { return read(...args); }
    finally { renameSync(f.first, f.second); renameSync(join(root, "former"), f.first); }
  });
  restore.push(() => spy.mockRestore());
  const orientation = await f.read();
  expect(replaced, "ROOT_REPLACEMENT_PROBE_ACTUALLY_REPLACED_DIRECTORY").toBe(true);
  const encoded = conversationOrientation(orientation);
  expect(encoded, "HELD_ROOT_PREVENTS_TRANSIENT_SUBSTITUTION").not.toContain("WITHHELD_REPLACEMENT_IDENTITY");
  expect(encoded).toContain("Odysseus commands the raft.");
});
