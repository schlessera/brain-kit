import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureApp } from "./helpers/native-app-fixture";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability";
import { makeFakeBackend } from "./helpers/fake-backend";
import { privateMaintenanceTest } from "./helpers/private-maintenance-test";

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

test("two differently configured apps isolate exec wrappers and login/passkey buckets (#2752)", async () => {
  if (await privateMaintenanceTest(import.meta.path, "two differently configured apps isolate exec wrappers and login/passkey buckets (#2752)")) return;
  const root = mkdtempSync(join(tmpdir(), "odysseus-two-apps-"));
  const apps: Awaited<ReturnType<typeof createFixtureApp>>[] = [];
  try {
    const fixtures = await Promise.all([
      { name: "ithaca", password: "Odysseus returns to Ithaca" },
      { name: "pylos", password: "Telemachus sails to Pylos" },
    ].map(async ({ name, password }) => {
      const brainPath = join(root, name);
      const binDir = join(brainPath, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "brain");
      writeFileSync(bin, `#!/usr/bin/env bun\n` +
        `if (process.argv.includes("--version")) console.log("0.43.1");\n` +
        `else console.log(JSON.stringify({ results: [], warnings: [] }));\n`);
      chmodSync(bin, 0o755);
      const wrapper = join(brainPath, `${name}.sh`);
      // Log only searches: boot pruning has its own concurrent maintenance
      // output and must not overwrite this request's wrapper evidence.
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$2" = search ]; then\n` +
        `  printf '%s\\n' "$@" >> "\${BRAIN_WORKER_DATA_ROOT:-${brainPath}}/${name}.log"\nfi\nexec "$@"\n`);
      chmodSync(wrapper, 0o755);
      return { name, password, brainPath, log: join(brainPath, `${name}.log`), config: resolveServerConfig({
        AUTH_MODE: "password", HOST: "127.0.0.1", BRAIN_PATH: brainPath,
        DB_PATH: ":memory:", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password),
        COOKIE_SECRET: `odysseus-${name}-fixture-secret-0123456789abcdef`,
        TRUST_PROXY: "1", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_EXEC_WRAPPER: wrapper,
      }) };
    }));
    // Both real app instances stay alive in this process; only native storage
    // acquisition uses the explicit offline fixture, as in the test above.
    for (const fixture of fixtures) apps.push(await createFixtureApp({
      config: fixture.config, registry: createStaticBackendRegistry([makeFakeBackend({ id: "fixture" })]),
      observability: createRecordingObservability(),
    }));
    const request = (index: number, path: string, body?: object, cookie?: string) => apps[index].fetch(new Request(
      `http://localhost/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: {
        "content-type": "application/json", origin: "http://localhost", host: "localhost",
        "x-forwarded-for": "192.0.2.52", ...(cookie ? { cookie } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    ));
    const cookies: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const login = await request(index, "auth/login", { password: fixture.password });
      expect(login.status, `${fixture.name}: own password authenticates`).toBe(200);
      expect(login.headers.get("set-cookie")).not.toBeNull();
      cookies.push(login.headers.get("set-cookie")!.split(";")[0]);
    }
    expect((await request(1, "brain/search?q=foreign-cookie", undefined, cookies[0])).status,
      "APP_B_REJECTS_APP_A_SESSION").toBe(401);

    for (const index of [0, 1, 0]) {
      const response = await request(index, `brain/search?q=${fixtures[index].name}`, undefined, cookies[index]);
      const body = await response.text();
      expect(response.status, `${fixtures[index].name}: authenticated CLI search: ${body}`).toBe(200);
      expect(JSON.parse(body)).toEqual({ results: [], warnings: [] });
    }
    for (const [index, fixture] of fixtures.entries()) {
      const other = fixtures[1 - index];
      const lines = existsSync(fixture.log) ? readFileSync(fixture.log, "utf8").split("\n") : [];
      expect(lines, `APP_${index === 0 ? "A" : "B"}_USES_OWN_EXEC_WRAPPER`).toContain(fixture.name);
      expect(lines).toContain("search");
      expect(lines).not.toContain(other.name);
      expect(existsSync(join(fixture.brainPath, `${other.name}.log`)), "NO_FOREIGN_EXEC_WRAPPER_LOG").toBe(false);
    }

    for (let count = 0; count < 5; count++) {
      expect((await request(0, "auth/login", { password: "wrong" })).status).toBe(401);
    }
    expect((await request(0, "auth/login", { password: fixtures[0].password })).status,
      "APP_A_LOGIN_BUCKET_EXHAUSTED").toBe(429);
    expect((await request(1, "auth/login", { password: fixtures[1].password })).status,
      "APP_B_LOGIN_BUCKET_UNTOUCHED").toBe(200);
    for (let count = 0; count < 10; count++) {
      expect((await request(0, "auth/passkey/login-options", {})).status).toBe(200);
    }
    expect((await request(0, "auth/passkey/login-options", {})).status,
      "APP_A_PASSKEY_OPTIONS_BUCKET_EXHAUSTED").toBe(429);
    expect((await request(1, "auth/passkey/login-options", {})).status,
      "APP_B_PASSKEY_OPTIONS_BUCKET_UNTOUCHED").toBe(200);
    expect((await request(1, "auth/login", { password: fixtures[0].password })).status,
      "APP_B_REJECTS_APP_A_PASSWORD").toBe(401);
  } finally {
    for (const app of apps.reverse()) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
