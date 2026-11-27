/**
 * The keyless test app's boot configuration (helpers/test-config.ts, #4838)
 * turns vendor discovery off explicitly: `NODE_ENV: "production"` here stops
 * the test-runner default from masking a missing flag.
 */
import { describe, expect, test } from "bun:test";
import { testServerConfig } from "./helpers/test-config";

const PATHS = { brain: "/tmp/ithaca-brain", db: ":memory:" };

describe("testServerConfig", () => {
  test("discovery stays off, auth is none and the host is loopback even outside the test runner's NODE_ENV", () => {
    const config = testServerConfig(PATHS, { NODE_ENV: "production" });
    expect(config.agent.modelDiscovery).toBe(false);
    expect(config.pricing.enabled).toBe(false);
    expect(config.coastline.enabled).toBe(false);
    expect(config.auth.mode).toBe("none");
    expect(config.host).toBe("127.0.0.1");
    expect(config.brainPath).toBe(PATHS.brain);
    expect(config.dbPath).toBe(PATHS.db);
  });

  test("a caller's override wins over the helper's value", () => {
    expect(testServerConfig(PATHS, { BRAIN_UI_MODEL_DISCOVERY: "1" }).agent.modelDiscovery).toBe(true);
    expect(testServerConfig(PATHS, { HOST: "::1" }).host).toBe("::1");
  });
});
