import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAnthropicModels } from "../packages/ui-backend-claude/src/model-discovery";
import { defineProfiles, getProfile, listProfiles } from "../packages/ui-backend-claude/src/profiles";
import { createClaudeSdkTurn } from "../packages/ui-backend-claude/src/sdk-options";
import { createBrainUiRoot, type BrainUiRoot } from "../packages/ui-react/src/root";

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

test("discovered Haiku 5.5 retains its ID through client persistence and production SDK options", async () => {
  const previous = process.env.ANTHROPIC_API_KEY, oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const brain = mkdtempSync(join(tmpdir(), "haiku-selection-"));
  const stored = new Map<string, string>();
  const storage: Storage = {
    get length() { return stored.size; }, clear: () => stored.clear(), key: index => [...stored.keys()][index] ?? null,
    getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); }, removeItem: key => { stored.delete(key); },
  };
  try {
    process.env.ANTHROPIC_API_KEY = "offline-fixture";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Fixture metadata, not a claim of live account entitlement. Explicit empty
    // effort support must override the known-model fallback.
    const rows = [
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
      { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 1_000_000, capabilities: { effort: null } },
      { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
    ];
    const calls: string[] = [];
    const discovered = await discoverAnthropicModels({ fetchImpl: (async input => {
      const url = String(input); calls.push(url);
      return Response.json(url.includes("/v1/models?") ? { data: rows, has_more: false } : { id: "claude-haiku-4-5" });
    }) as typeof fetch });
    const profiles = defineProfiles(discovered.models), providers = listProfiles(profiles);
    expect(providers).toHaveLength(3);
    expect(providers[1]).toEqual({ id: "claude-haiku-5-5", label: "Claude Haiku 5.5", vendor: "anthropic", contextWindow: 1_000_000, source: "discovered" });
    expect(providers[0]?.id).toBe("claude-haiku-4-5"); expect(calls).toHaveLength(2);
    const createRoot = () => { const root = createBrainUiRoot({ storage, storagePrefix: "haiku-fixture", request: async () => Response.json({ providers }) }); roots.push(root); return root; };
    const client = createRoot(); await client.stores.provider.getState().loadProviders();
    expect(client.stores.provider.getState().selectedId).toBe("claude-haiku-4-5");
    client.stores.provider.getState().setSelected("claude-haiku-5-5");
    expect([...stored.values()]).toContain("claude-haiku-5-5");
    const restored = createRoot(); await restored.stores.provider.getState().loadProviders();
    expect(restored.stores.provider.getState().selectedId).toBe("claude-haiku-5-5");
    const profile = getProfile(profiles, restored.stores.provider.getState().selectedId)!;
    expect(profile).toBeDefined();
    const turn = createClaudeSdkTurn({ backend: { brainPath: brain },
      req: { prompt: "Tell Odysseus about Ithaca.", signal: new AbortController().signal, thinkingLevel: "max",
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No tools in this control." }) } },
      profile, abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log: () => {},
    });
    expect(turn.options.model).toBe("claude-haiku-5-5"); expect(turn.options.permissionMode).toBe("default");
    expect(turn.options.effort).toBeUndefined(); expect(turn.subscriptionOnly).toBe(true);
    expect(turn.options.env?.ANTHROPIC_API_KEY).toBe("");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    if (oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
    rmSync(brain, { recursive: true, force: true });
  }
});

test("declared Haiku 5.5 uses verified effort support while unknown context stays unknown", () => {
  const [profile] = defineProfiles([{ id: "haiku", label: "Claude Haiku 5.5", model: "claude-haiku-5-5" }]);
  expect(listProfiles([profile!])).toEqual([{ id: "haiku", label: "Claude Haiku 5.5", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] }]);
  expect(profile?.contextWindow).toBeUndefined(); expect(profile?.supportedThinkingLevels).toBeUndefined();
});
