import { describe, expect, test } from "bun:test";

import { backendModule, PI_THINKING_LEVELS } from "../src/module";

describe("pi backend module descriptor", () => {
  test("owns the complete thinking-level tuple", () => {
    expect(PI_THINKING_LEVELS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
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
