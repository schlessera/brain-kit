/** Data source and omission proof; provider-frame proof is in live-history-adapters. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("source read cap, escaped paths and executable frontmatter do not reach the provider seed", async () => {
  const f = fixture();
  f.write("AGENTS.md", "# Personal Rules\n" + "🦉".repeat(20000));
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: "../outside.md", currentFocus: "context/watch.md" } } }));
  f.write("context/watch.md", "---js\nthrow Error('ORIENTATION_MUST_NOT_EXECUTE_FRONTMATTER')\n---\nHOST_ONLY_EXECUTABLE\n");
  const orientation = await f.read();
  expect(orientation.knowledge).toEqual([]);
  expect(orientation.unavailable).toContain("AGENTS.md: missing, unreadable or too large");
  expect(conversationOrientation(orientation)).not.toContain("HOST_ONLY");
});

test("a source symlink escaping the brain is omitted", async () => {
  const f = fixture();
  symlinkSync(join(root, ".."), join(root, "me", "outside"));
  f.write("brain.config.json", JSON.stringify({ taxonomy: { canonical: { identity: "me/outside/identity.md", currentFocus: "" } } }));
  expect((await f.read()).knowledge).toEqual([]);
});

test("provider rules and invalid governance withhold new repository sources", async () => {
  const f = fixture(); mkdirSync(join(root, "context", "policies"));
  f.write("CLAUDE.md", "# Personal Rules\nHOST_ONLY_WITHHELD\n");
  f.write("me/identity.md", "HOST_ONLY_WITHHELD_IDENTITY\n");
  const valid = "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\n";
  for (const policy of [valid, "---\nschema_version: invalid\n---\n"]) {
    f.write("context/policies/governance.md", policy);
    if (policy === valid) {
      const checked = governancePolicyReaderFor(root).load();
      expect(checked.errors).toEqual([]); expect(checked.policy.providers).toHaveLength(1);
    }
    const orientation = await f.read();
    expect(orientation.knowledge).toEqual([]);
    expect(conversationOrientation(orientation), "REPOSITORY_POLICY_WITHHOLDS_NEW_STARTUP_CONTENT").not.toContain("HOST_ONLY");
  }
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

function replacementBrains(canonical = false) {
  const f = fixture();
  const first = join(root, "first"), second = join(root, "second"), alias = join(root, "current");
  for (const directory of [first, second]) {
    mkdirSync(join(directory, "me"), { recursive: true });
    mkdirSync(join(directory, "context", "policies"), { recursive: true });
    writeFileSync(join(directory, "AGENTS.md"), "## Personal Rules\nKeep replies brief.\n");
  }
  writeFileSync(join(first, "me", "identity.md"), "Odysseus commands the raft.\n");
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
