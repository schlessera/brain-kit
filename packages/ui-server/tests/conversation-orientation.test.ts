/** Data source and omission proof; provider-frame proof is in live-history-adapters. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversationOrientation } from "../src/voice/conversation-orientation";
import { governancePolicyReaderFor } from "../src/brain/governance-policy";
import { conversationOrientation, projectConversationGuidance } from "@schlessera/brain-ui-sdk/internal";
import { BRAIN_UI_SYSTEM_PROMPT_APPEND } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import type { WsHost } from "../src/ws/host";

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
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
  f.write("CLAUDE.md", "@AGENTS.md\n# Capture policy\nAsk before capturing an emerging preference.\n<!-- brain:generated:module-travel -->\nHOST_ONLY_MODULE_TOOLS\n<!-- /brain:generated:module-travel -->\n");
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
  expect(orientation.unavailable).toContain("configured append: no selected interaction sections");
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
