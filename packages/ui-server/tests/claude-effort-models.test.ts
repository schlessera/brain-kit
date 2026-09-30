import { expect, test } from "bun:test";
import { backendModule } from "@schlessera/brain-backend-claude";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createUiDb } from "../src/db/client.js";
import { getThinkingOverrides } from "../src/db/settings.js";
import { createModelRoutes } from "../src/routes/models.js";
import { resolveServerConfig } from "../src/config/env.js";

test("Claude catalog accepts saved effort and applies it through its real module", async () => {
  const db = createUiDb(":memory:");
  try {
    const parsed = backendModule.profileSchema.parse(null, { occupiedProfiles: [] });
    if (!parsed.ok) throw new Error("builtin profile missing");
    const resolved = await backendModule.resolveFromEnv({ brainPath: "/tmp/effort-models-test", config: { defaultThinkingLevel: "high" },
      profiles: parsed.profiles, settings: { getThinkingOverrides: () => getThinkingOverrides(db) }, confirmBashPatterns: null });
    if (!resolved.ok) throw resolved.error;
    const registry = createStaticBackendRegistry([resolved.value.backend], "claude");
    const routes = createModelRoutes({ registry, db });
    const before = await (await routes.request("/models")).json();
    expect(before.models[0]).toMatchObject({ id: "claude", thinkingLevel: "high", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] });
    const response = await routes.request("/models/thinking", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ thinking: { claude: "low" } }) });
    expect(response.status).toBe(200);
    const after = await response.json();
    expect(after.models[0]).toMatchObject({ id: "claude", thinkingLevel: "low", thinkingOverride: "low" });
    expect(getThinkingOverrides(db)).toEqual({ claude: "low" });
    expect(resolveServerConfig({}).agent).toMatchObject({ defaultModel: "claude-opus-5-5", defaultThinkingLevel: "medium" });
    expect(() => resolveServerConfig({ BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL: "invalid" })).toThrow("thinking level");
  } finally { db.close(); }
});
