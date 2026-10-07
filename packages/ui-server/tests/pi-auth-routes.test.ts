import { describe, expect, test } from "bun:test";
import { createPiAuthRoutes, type PiLoginFlowView } from "../src/routes/pi-auth";
import { resolveServerConfig } from "../src/config/env";

const PROFILES = JSON.stringify([
  { id: "gpt-sol", label: "GPT-5.6 Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
]);

const agentFor = (env: Record<string, string> = {}) =>
  resolveServerConfig({ NODE_ENV: "test", ...env }).agent;

/** Scripted stand-in for the lazily-loaded pi module. */
function makeFakeModule() {
  const flow: PiLoginFlowView = {
    id: "flow-1",
    providerId: "openai-codex",
    status: "pending",
    userCode: "ABCD-1234",
    verificationUri: "https://auth.openai.com/codex/device",
    startedAt: Date.now(),
  };
  const calls: string[] = [];
  const module = {
    backendModule: {
      id: "pi",
      settingsHooks: {},
      profileSchema: {
        source: "BRAIN_UI_PI_PROFILES",
        parse(raw: string | null) {
          return { ok: true, profiles: raw ? JSON.parse(raw) : [] } as const;
        },
      },
      resolveFromEnv() {
        throw new Error("not used by route tests");
      },
    },
    createPiAuth: () => ({
      async status(providerIds: string[]) {
        calls.push(`status:${providerIds.join(",")}`);
        return providerIds.map((providerId) => ({
          providerId,
          name: "OpenAI (ChatGPT Plus/Pro)",
          configured: false,
          oauth: true,
        }));
      },
      async startLogin(providerId: string) {
        calls.push(`start:${providerId}`);
        return { ...flow, providerId };
      },
      getFlow(id: string) {
        calls.push(`get:${id}`);
        return id === flow.id ? { ...flow } : null;
      },
      cancelFlow(id: string) {
        calls.push(`cancel:${id}`);
      },
      async logout(providerId: string) {
        calls.push(`logout:${providerId}`);
      },
    }),
  };
  return { module, calls, importer: async () => module };
}

describe("pi-auth routes", () => {
  test("providers is empty (not an error) when pi is not configured", async () => {
    const { importer } = makeFakeModule();
    const routes = createPiAuthRoutes({ agent: agentFor(), importer });
    const res = await routes.request("/pi-auth/providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  test("providers reports the configured roster's vendors", async () => {
    const { importer, calls } = makeFakeModule();
    const routes = createPiAuthRoutes({
      agent: agentFor({ BRAIN_UI_PI_PROFILES: PROFILES }),
      importer,
    });
    const res = await routes.request("/pi-auth/providers");
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].providerId).toBe("openai-codex");
    expect(calls).toContain("status:openai-codex");
  });

  test("login starts a flow for a configured vendor and returns the code", async () => {
    const { importer } = makeFakeModule();
    const routes = createPiAuthRoutes({
      agent: agentFor({ BRAIN_UI_PI_PROFILES: PROFILES }),
      importer,
    });
    const res = await routes.request("/pi-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flow.providerId).toBe("openai-codex");
    expect(body.flow.userCode).toBe("ABCD-1234");
  });

  test("login rejects unknown providers and unconfigured deployments", async () => {
    const { importer } = makeFakeModule();
    const unconfigured = createPiAuthRoutes({ agent: agentFor(), importer });
    expect(
      (
        await unconfigured.request("/pi-auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "openai-codex" }),
        })
      ).status
    ).toBe(409);

    const configured = createPiAuthRoutes({
      agent: agentFor({ BRAIN_UI_PI_PROFILES: PROFILES }),
      importer,
    });
    expect(
      (
        await configured.request("/pi-auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "anthropic" }),
        })
      ).status
    ).toBe(400);
  });

  test("flow poll returns the flow or 404; delete cancels", async () => {
    const { importer, calls } = makeFakeModule();
    const routes = createPiAuthRoutes({
      agent: agentFor({ BRAIN_UI_PI_PROFILES: PROFILES }),
      importer,
    });
    const found = await routes.request("/pi-auth/login/flow-1");
    expect(found.status).toBe(200);
    expect((await found.json()).flow.id).toBe("flow-1");

    expect((await routes.request("/pi-auth/login/other")).status).toBe(404);

    const cancelled = await routes.request("/pi-auth/login/flow-1", {
      method: "DELETE",
    });
    expect(cancelled.status).toBe(200);
    expect(calls).toContain("cancel:flow-1");
  });

  test("logout validates the provider and delegates", async () => {
    const { importer, calls } = makeFakeModule();
    const routes = createPiAuthRoutes({
      agent: agentFor({ BRAIN_UI_PI_PROFILES: PROFILES }),
      importer,
    });
    expect(
      (
        await routes.request("/pi-auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "nope" }),
        })
      ).status
    ).toBe(400);

    const ok = await routes.request("/pi-auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex" }),
    });
    expect(ok.status).toBe(200);
    expect(calls).toContain("logout:openai-codex");
  });
});
