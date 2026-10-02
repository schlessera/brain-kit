import { describe, expect, test } from "bun:test";
import { resolveEnv as claudeEnv } from "../packages/ui-backend-claude/src/config/env.js";
import { resolveEnv as piEnv } from "../packages/ui-backend-pi/src/config/env.js";

describe.each([["claude", claudeEnv], ["pi", piEnv]] as const)("%s reverse geocoding eligibility", (_name, resolve) => {
  test("defaults, empty values and typos never infer public-service eligibility", () => {
    for (const value of [undefined, "", "banana", "0", "false", "off", "no"]) {
      expect(resolve({ NOMINATIM_PUBLIC_SERVICE_ELIGIBLE: value }).nominatimPublicServiceEligible).toBe(false);
    }
    expect(resolve({}).reverseGeocodeEnabled).toBe(true);
  });
  test("only deliberate recognized tokens enable eligibility", () => {
    for (const value of ["1", "true", "on", "yes", " TRUE "]) {
      expect(resolve({ NOMINATIM_PUBLIC_SERVICE_ELIGIBLE: value }).nominatimPublicServiceEligible).toBe(true);
    }
  });
});
