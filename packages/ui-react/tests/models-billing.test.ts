/**
 * The billing-override round-trip's pure halves: the record PUT after
 * changing one profile, and the request-ordering gate the optimistic commits
 * run through. "Auto" must REMOVE the key — a redundant explicit value would
 * pin the profile to today's derived mode and silently stop tracking the
 * credential env. The React optimistic-update/rollback wiring itself is
 * exercised manually (see the U6 report).
 */
import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@schlessera/brain-ui-sdk/protocol";

import { createRequestGate, nextBillingOverrides } from "../src/components/settings/models-tab";

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

describe("createRequestGate", () => {
  test("a token stays current until a newer request begins", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    expect(first()).toBe(true);
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  test("supersession is permanent — an old token never becomes current again", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    gate.begin();
    const third = gate.begin();
    expect(first()).toBe(false);
    expect(third()).toBe(true);
    expect(first()).toBe(false);
  });

  test("independent gates do not interfere", () => {
    const a = createRequestGate();
    const b = createRequestGate();
    const aToken = a.begin();
    b.begin();
    expect(aToken()).toBe(true);
  });
});
