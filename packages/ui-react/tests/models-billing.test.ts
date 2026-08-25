/**
 * The billing-override round-trip's pure half: the record PUT after changing
 * one profile. "Auto" must REMOVE the key — a redundant explicit value would
 * pin the profile to today's derived mode and silently stop tracking the
 * credential env. The optimistic-update/rollback half mirrors the hidden
 * toggle and is exercised manually (see the U6 report).
 */
import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@schlessera/brain-ui-sdk/protocol";

import { nextBillingOverrides } from "../src/components/settings/models-tab";

function entry(overrides: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry {
  return { label: overrides.id, hidden: false, ...overrides };
}

const models = [
  entry({ id: "claude", billingMode: "subscription" }),
  entry({ id: "openrouter-glm", billingMode: "api", billingOverride: "api" }),
  entry({ id: "mystery" }),
];

describe("nextBillingOverrides", () => {
  test("setting an override adds its key and keeps the others", () => {
    expect(nextBillingOverrides(models, "claude", "api")).toEqual({
      claude: "api",
      "openrouter-glm": "api",
    });
  });

  test("switching back to auto removes the key instead of storing the resolved mode", () => {
    expect(nextBillingOverrides(models, "openrouter-glm", "auto")).toEqual({});
  });

  test("auto on a profile that never had an override is a no-op record", () => {
    expect(nextBillingOverrides(models, "mystery", "auto")).toEqual({
      "openrouter-glm": "api",
    });
  });

  test("an unclassifiable profile can still be forced", () => {
    expect(nextBillingOverrides(models, "mystery", "subscription")).toEqual({
      "openrouter-glm": "api",
      mystery: "subscription",
    });
  });
});
