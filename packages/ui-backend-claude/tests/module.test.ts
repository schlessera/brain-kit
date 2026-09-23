import { describe, expect, test } from "bun:test";

import { backendModule } from "../src/module";

describe("Claude backend module descriptor", () => {
  test("exports only the six descriptor members", () => {
    expect(Object.keys(backendModule).sort()).toEqual([
      "id",
      "modelSource",
      "probeRuntime",
      "profileSchema",
      "resolveFromEnv",
      "settingsHooks",
    ]);
  });

  test("profileSchema returns typed JSON and duplicate-id failures", () => {
    const invalid = backendModule.profileSchema.parse("not json", {
      occupiedProfiles: [],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors[0]?.code).toBe("invalid_json");

    const duplicate = backendModule.profileSchema.parse(
      JSON.stringify([{ id: "claude", label: "Shadow" }]),
      { occupiedProfiles: [] }
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors[0]?.code).toBe("duplicate_id");
  });
});
