import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THINKING_LEVELS } from "@schlessera/brain-ui-sdk/protocol";

import { backendModule } from "../src/module";

describe("pi backend module descriptor", () => {
  const roster = (thinkingLevel: string) =>
    JSON.stringify([{ id: "gpt", label: "Test", vendor: "openai-codex", model: "gpt-test", thinkingLevel }]);

  test("profileSchema refuses a thinking level the protocol does not define", () => {
    const parsed = backendModule.profileSchema.parse(roster("ultra"), { occupiedProfiles: [] });
    expect(parsed.ok, "PI_ROSTER_REFUSES_UNKNOWN_LEVEL").toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([{
        code: "invalid_entry",
        profileId: "gpt",
        // Generated on the tree before the protocol's list replaced the descriptor's copy (#4734).
        message: 'BRAIN_UI_PI_PROFILES entry "gpt" has invalid thinkingLevel "ultra" (expected one of off, minimal, low, medium, high, xhigh, max).',
      }]);
    }
  });

  test.each([...THINKING_LEVELS])("profileSchema accepts the protocol thinking level %s", level => {
    expect(backendModule.profileSchema.parse(roster(level), { occupiedProfiles: [] }).ok).toBe(true);
  });

  test("a thinking override that is not a protocol level keeps the configured level", async () => {
    const brain = mkdtempSync(join(tmpdir(), "pi-module-"));
    try {
      const parsed = backendModule.profileSchema.parse(JSON.stringify([
        // A catalog reasoning model: only those list a thinking level.
        { id: "gpt", label: "Sol", vendor: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "xhigh" },
        { id: "gpt-low", label: "Luna", vendor: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "xhigh" },
      ]), { occupiedProfiles: [] });
      if (!parsed.ok) throw new Error(parsed.errors[0]?.message);
      const resolved = await backendModule.resolveFromEnv({ brainPath: brain, config: {}, profiles: parsed.profiles, confirmBashPatterns: null,
        settings: { getThinkingOverrides: () => ({ gpt: "ultra", "gpt-low": "low" }) } });
      if (!resolved.ok) throw resolved.error;
      const listed = await resolved.value.backend.listProfiles();
      expect(Object.fromEntries(listed.map(profile => [profile.id, profile.thinkingLevel])), "PI_OVERRIDE_KEEPS_ONLY_PROTOCOL_LEVELS")
        .toEqual({ gpt: "xhigh", "gpt-low": "low" });
    } finally { rmSync(brain, { recursive: true, force: true }); }
  });

  test("profileSchema returns typed reserved, collision, and thinking failures", () => {
    const profile = (id: string, thinkingLevel?: string) =>
      JSON.stringify([
        {
          id,
          label: "Test",
          vendor: "openai-codex",
          model: "gpt-test",
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
      ]);

    const reserved = backendModule.profileSchema.parse(profile("claude-new"), {
      occupiedProfiles: [],
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.errors[0]?.code).toBe("reserved_id");

    const collision = backendModule.profileSchema.parse(profile("shared"), {
      occupiedProfiles: [{ id: "shared", source: "BRAIN_UI_CLAUDE_PROFILES" }],
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.errors[0]?.code).toBe("duplicate_id");

    const thinking = backendModule.profileSchema.parse(profile("gpt", "ultra"), {
      occupiedProfiles: [],
    });
    expect(thinking.ok).toBe(false);
    if (!thinking.ok) expect(thinking.errors[0]?.code).toBe("invalid_entry");
  });

  test("profileSchema leniently extracts ids from an inactive Claude roster", () => {
    const piProfile = JSON.stringify([
      {
        id: "shared",
        label: "Shared (OpenAI)",
        vendor: "openai-codex",
        model: "gpt-test",
      },
    ]);
    for (const raw of ["not json", JSON.stringify([{}])]) {
      expect(
        backendModule.profileSchema.parse(piProfile, {
          occupiedProfiles: [],
          inactiveRosters: [{ backendId: "claude", raw }],
        }).ok
      ).toBe(true);
    }

    const collision = backendModule.profileSchema.parse(piProfile, {
      occupiedProfiles: [],
      inactiveRosters: [
        {
          backendId: "claude",
          raw: JSON.stringify([{ id: "shared", label: "Shared (Anthropic)" }]),
        },
      ],
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.errors[0]?.message).toContain(
        'collides with a BRAIN_UI_CLAUDE_PROFILES entry'
      );
    }
  });
});
