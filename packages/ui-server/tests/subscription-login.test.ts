/**
 * The re-login procedure of docs/hosting/README.md ("Claude subscription
 * login"), rehearsed keyless on a headless host (#254), and the rule that a
 * rejected subscription token never falls back to an API key.
 *
 * The real app boots on the Agent SDK's bundled Claude Code, with no display
 * and no browser. The model is a loopback stub that answers 401 to every
 * bearer, as Anthropic answers a revoked or expired token. Every credential
 * is fake, and nothing leaves the machine: model discovery is off, and the
 * CLI's base URL is the stub.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubscriptionStatus } from "../src/agent/subscription";
import { createApp, type BrainUiApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { resolveAmbientPrincipal } from "../src/db/principals";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";

// Obviously fake: the shape Claude Code accepts, the bytes of no real token.
const FIRST_TOKEN = `sk-ant-oat01-${"a".repeat(95)}AA`;
const ROTATED_TOKEN = `sk-ant-oat01-${"b".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;

const seen: Array<{ xApiKey: string | null; authorization: string | null }> = [];
const scratch: string[] = [];
const savedEnv = { ...process.env };
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.startsWith("/v1/")) {
        seen.push({ xApiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
      }
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: "OAuth access token is invalid." } },
        { status: 401 }
      );
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  seen.length = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A headless host: no display, no browser, the stub as Anthropic, fake keys only. */
function headlessHost(): { brainPath: string; dbPath: string } {
  const dir = tempDir("relogin-host-");
  const brainPath = join(dir, "brain");
  mkdirSync(brainPath);
  mkdirSync(join(dir, "home", ".claude"), { recursive: true });
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "BROWSER", "CLAUDE_CODE_PATH", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    HOME: join(dir, "home"),
    CLAUDE_CONFIG_DIR: join(dir, "home", ".claude"),
    BRAIN_PATH: brainPath,
    DB_PATH: join(dir, "ui.db"),
    AGENT_BACKEND: "claude",
    BRAIN_UI_MODEL_DISCOVERY: "0",
    BRAIN_UI_PRICING_DISCOVERY: "0",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    // In the server's environment, where a fallback would find it.
    ANTHROPIC_API_KEY: API_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  });
  return { brainPath, dbPath: join(dir, "ui.db") };
}

/** Step 2 of the procedure: the token and today's date go in the secret store, then a redeploy. */
async function deploy(token: string, mintedAt: string): Promise<BrainUiApp> {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  process.env.BRAIN_UI_CLAUDE_TOKEN_MINTED_AT = mintedAt;
  return await createApp({ config: resolveServerConfig(process.env) });
}

/** Send one turn and return every frame the client got. */
async function sendTurn(app: BrainUiApp): Promise<Array<Record<string, unknown>>> {
  const sent: string[] = [];
  const ws = { send: (data: string) => sent.push(data), close: () => {}, readyState: 1 } as unknown as WSContext;
  const principal = resolveAmbientPrincipal(app.db, "none", "No authentication", "No authentication");
  const handlers = createWsHandlers(app.wsHost, principal);
  handlers.onOpen(undefined as never, ws);
  handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Reply with ok." }) } as MessageEvent, ws);
  const deadline = Date.now() + 60_000;
  const frames = () => sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  while (!frames().some((frame) => frame.type === "result" || frame.type === "error")) {
    if (Date.now() > deadline) throw new Error("the turn did not end");
    await Bun.sleep(20);
  }
  while (app.isTurnActive() && Date.now() < deadline) await Bun.sleep(20);
  return frames();
}

/** Step 3: confirm on /api/status. */
async function subscriptionStatus(app: BrainUiApp): Promise<SubscriptionStatus> {
  const res = await app.fetch(new Request("http://localhost/api/status"));
  return ((await res.json()) as { subscription: SubscriptionStatus }).subscription;
}

describe("the re-login procedure, headless and keyless", () => {
  test("rotating the token and its date is a redeploy, and the server then runs on the new one", async () => {
    headlessHost();

    const first = await deploy(FIRST_TOKEN, "2025-10-01");
    try {
      await sendTurn(first);
      const status = await subscriptionStatus(first);
      expect(status.mintedAt).toBe("2025-10-01T00:00:00.000Z");
      expect(status.expiresAt).toBe("2026-10-01T00:00:00.000Z");
      // The stub refused the token: the operator is told to log in again.
      expect(status.lastAuthFailure).toMatchObject({ errorClass: "authentication_failed", action: "relogin" });
    } finally {
      first.close();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((request) => request.authorization))).toEqual(new Set([`Bearer ${FIRST_TOKEN}`]));

    seen.length = 0;
    const rotated = await deploy(ROTATED_TOKEN, "2026-09-23");
    try {
      await sendTurn(rotated);
      expect((await subscriptionStatus(rotated)).mintedAt).toBe("2026-09-23T00:00:00.000Z");
    } finally {
      rotated.close();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((request) => request.authorization))).toEqual(new Set([`Bearer ${ROTATED_TOKEN}`]));
  }, 120_000);
});

describe("a rejected subscription token", () => {
  test("ends the turn with authentication_failed, and nothing retries with the API key", async () => {
    headlessHost();
    const app = await deploy(FIRST_TOKEN, "2026-09-01");
    try {
      await sendTurn(app);
      const failure = (await subscriptionStatus(app)).lastAuthFailure;
      expect(failure).toMatchObject({ errorClass: "authentication_failed", source: "turn", action: "relogin" });
      // The run itself is recorded as failed with that class. (The client's
      // terminal frame for it is #191's.)
      const root = app.wsHost.activity!.store.getSpan(`${failure!.runId}:turn`)!;
      expect(root.attrs["brain.failure_class"]).toBe("authentication_failed");
      expect(root.outcome).toBe("error");
    } finally {
      await app.close();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((request) => request.xApiKey !== null)).toEqual([]);
    expect(seen.every((request) => request.authorization === `Bearer ${FIRST_TOKEN}`)).toBe(true);
  }, 120_000);
});
