import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureApp } from "./helpers/native-app-fixture";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability";
import { makeFakeBackend } from "./helpers/fake-backend";

// Real createApp wiring, databases and password verification; the explicit
// offline storage fixture does not claim native filesystem qualification.
test("createApp isolates login and passkey option buckets (#1364)", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-app-state-"));
  const password = "Odysseus returns to Ithaca";
  const config = resolveServerConfig({
    AUTH_MODE: "password", HOST: "127.0.0.1", BRAIN_PATH: root,
    DB_PATH: ":memory:", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password),
    COOKIE_SECRET: "odysseus-fixture-secret-0123456789abcdef",
    TRUST_PROXY: "1", BRAIN_UI_PRICING_DISCOVERY: "0",
  });
  const apps: Awaited<ReturnType<typeof createFixtureApp>>[] = [];
  try {
    for (let index = 0; index < 2; index++) apps.push(await createFixtureApp({
      config, registry: createStaticBackendRegistry([makeFakeBackend({ id: "fixture" })]),
      observability: createRecordingObservability(),
    }));
    const request = (index: number, path: string, body: object) => apps[index].fetch(new Request(
      `http://localhost/api/auth/${path}`, { method: "POST", headers: {
        "content-type": "application/json", origin: "http://localhost", host: "localhost",
        "x-forwarded-for": "10.136.4.2",
      }, body: JSON.stringify(body) },
    ));
    for (let count = 0; count < 5; count++) {
      expect((await request(0, "login", { password: "wrong" })).status).toBe(401);
    }
    expect((await request(0, "login", { password })).status).toBe(429);
    expect((await request(1, "login", { password })).status).toBe(200);
    for (let count = 0; count < 10; count++) {
      expect((await request(0, "passkey/login-options", {})).status).toBe(200);
    }
    expect((await request(0, "passkey/login-options", {})).status).toBe(429);
    expect((await request(1, "passkey/login-options", {})).status).toBe(200);
  } finally {
    for (const app of apps.reverse()) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
