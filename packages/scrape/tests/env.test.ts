import { describe, expect, test } from "bun:test";

import { resolveEnv } from "../src/config/env";

describe("config/env resolveEnv", () => {
  test("empty environment yields the documented defaults", () => {
    const env = resolveEnv({});
    expect(env.userAgent).toBe("brain-scrape (+https://github.com/schlessera/brain-kit)");
    expect(env.chromeUrl).toBeUndefined();
    expect(env.chromePath).toBeUndefined();
    expect(env.noSandbox).toBe(false);
    expect(env.respectRobots).toBe(true);
  });

  test("noSandbox: shared truthy token set, off unless recognised", () => {
    for (const v of ["1", "true", "on", "YES"]) {
      expect(resolveEnv({ SCRAPE_CHROME_NO_SANDBOX: v }).noSandbox).toBe(true);
    }
    // Falsy tokens and unrecognised values keep the sandbox on.
    for (const v of ["0", "off", "false", "no", "", "banana"]) {
      expect(resolveEnv({ SCRAPE_CHROME_NO_SANDBOX: v }).noSandbox).toBe(false);
    }
  });

  test("respectRobots: on by default, shared falsy token set disables", () => {
    for (const v of ["0", "off", "false", "no", "OFF", " false "]) {
      expect(resolveEnv({ SCRAPE_RESPECT_ROBOTS: v }).respectRobots).toBe(false);
    }
    // Truthy tokens, empty, and unrecognised values keep enforcement on —
    // the safe direction for a typo is more robots.txt, not less.
    for (const v of ["1", "on", "yes", "", "banana"]) {
      expect(resolveEnv({ SCRAPE_RESPECT_ROBOTS: v }).respectRobots).toBe(true);
    }
  });
});
