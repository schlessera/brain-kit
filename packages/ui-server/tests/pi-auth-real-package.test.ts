/**
 * The pi-auth routes against the real workspace `@schlessera/brain-backend-pi`,
 * with no injected importer (#2485). The route tests in pi-auth-routes.test.ts
 * inject a scripted module, so they stayed green while the package stopped
 * exporting `createPiAuth` and every `/api/pi-auth/*` route threw.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAuthRoutes } from "../src/routes/pi-auth";
import { resolveServerConfig } from "../src/config/env";

const PROFILES = JSON.stringify([
  { id: "gpt-sol", label: "GPT-5.6 Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
]);

let agentDir: string;
let previousAgentDir: string | undefined;

beforeAll(() => {
  // Keep pi's auth store away from the developer's real ~/.pi.
  agentDir = mkdtempSync(join(tmpdir(), "pi-auth-real-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("pi-auth routes on the real pi package", () => {
  test("the package root exports every function the route resolves", async () => {
    const mod = (await import("@schlessera/brain-backend-pi")) as Record<string, unknown>;
    expect(typeof mod.createPiAuth).toBe("function");
  });

  test("GET /pi-auth/providers answers with provider status", async () => {
    const agent = resolveServerConfig({
      NODE_ENV: "test",
      BRAIN_UI_PI_PROFILES: PROFILES,
    }).agent;
    const routes = createPiAuthRoutes({ agent });
    const res = await routes.request("/pi-auth/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: { providerId: string; configured: boolean; oauth: boolean }[];
    };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      providerId: "openai-codex",
      configured: false,
      oauth: true,
    });
  });
});
