/**
 * The boot configuration of a keyless test app (#4838): no auth, a loopback
 * host, the test runner's `NODE_ENV`, and every discovery a vendor would
 * answer turned off explicitly, so an override of `NODE_ENV` cannot turn one
 * back on. A test passes its own brain and database, then whatever it is
 * about as overrides; an override wins, and one set to `undefined` drops the
 * key.
 */
import { resolveServerConfig, type ServerConfig } from "../../src/config/env";

export function testServerConfig(
  paths: { brain: string; db: string },
  overrides: Record<string, string | undefined> = {},
): ServerConfig {
  return resolveServerConfig({
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    BRAIN_UI_MODEL_DISCOVERY: "0",
    BRAIN_UI_PRICING_DISCOVERY: "0",
    BRAIN_UI_COASTLINE: "0",
    BRAIN_PATH: paths.brain,
    DB_PATH: paths.db,
    ...overrides,
  });
}
