/**
 * A Claude turn on a profile with no credential of its own runs on the
 * subscription or not at all (#253, docs/decisions/claude-code-runtime.md).
 *
 * These tests run the REAL Claude Code binary the lockfile installs (the Agent
 * SDK's bundled one) through the production backend, against a loopback HTTP
 * server set as `ANTHROPIC_BASE_URL`. Every credential is bogus and nothing
 * leaves the machine: the server records the auth headers of each
 * `/v1/messages` request and answers 400, which the CLI does not retry. So the
 * assertion is on what the CLI actually SENT, not on what we set — the thing
 * that went wrong is that the CLI prefers an API key over the subscription
 * token, silently, when both are in its environment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";

// Distinct bogus values, so a header names exactly which credential was sent.
const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;
const AUTH_TOKEN = `sk-ant-bearer-${"b".repeat(60)}`;
const HELPER_KEY = `sk-ant-api03-${"h".repeat(95)}AA`;
const STORED_KEY = `sk-ant-api03-${"s".repeat(95)}AA`;
const DECLARED_KEY = `sk-ant-api03-${"d".repeat(95)}AA`;

interface Seen {
  xApiKey: string | null;
  authorization: string | null;
}

let server: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
const scratch: string[] = [];
const savedEnv = { ...process.env };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/v1/messages") {
        seen.push({
          xApiKey: req.headers.get("x-api-key"),
          authorization: req.headers.get("authorization"),
        });
      }
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "loopback" } },
        { status: 400 }
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

interface Setup {
  oauth?: string;
  /** Project settings for the brain repo (the backend loads them). */
  projectSettings?: Record<string, unknown>;
  /** A stored Console key in the CLI's global config. */
  storedKey?: boolean;
}

/** A fresh HOME, config dir and brain repo, and the process env a host would have. */
function arrange(setup: Setup): { brainPath: string; home: string } {
  const home = tempDir("sub-home-");
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  const brainPath = tempDir("sub-brain-");
  if (setup.projectSettings) {
    mkdirSync(join(brainPath, ".claude"), { recursive: true });
    writeFileSync(join(brainPath, ".claude", "settings.json"), JSON.stringify(setup.projectSettings));
  }
  if (setup.storedKey) {
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ primaryApiKey: STORED_KEY }));
  }
  Object.assign(process.env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    DECLARED_KEY_ENV: DECLARED_KEY,
    DECLARED_TOKEN_ENV: AUTH_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  });
  if (setup.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = setup.oauth;
  return { brainPath, home };
}

/** The real query, with every SDK message it produced kept for inspection. */
function observedQuery(observed: SDKMessage[]): typeof query {
  return ((params: Parameters<typeof query>[0]) => {
    const real = query(params);
    return {
      initializationResult: () => real.initializationResult(),
      async *[Symbol.asyncIterator]() {
        for await (const message of real) {
          observed.push(message);
          yield message;
        }
      },
    };
  }) as unknown as typeof query;
}

async function runTurn(
  brainPath: string,
  profileId?: string
): Promise<{ frames: ServerMessage[]; observed: SDKMessage[] }> {
  const frames: ServerMessage[] = [];
  const observed: SDKMessage[] = [];
  const bridge: BackendBridge = {
    emit: (message) => frames.push(message),
    requestPermission: async () => ({ behavior: "deny", message: "test" }),
  };
  const backend = createClaudeBackend({
    brainPath,
    queryFn: observedQuery(observed),
    profiles: defineProfiles([
      { id: "claude", label: "Claude", source: "builtin" },
      { id: "other", label: "Other", model: "claude-sonnet-4-6", source: "declared" },
      { id: "declared-key", label: "Keyed", apiKeyEnv: "DECLARED_KEY_ENV", source: "declared" },
      { id: "declared-token", label: "Bearer", authTokenEnv: "DECLARED_TOKEN_ENV", source: "declared" },
    ]),
    log: () => {},
  });
  await backend.startTurn({
    prompt: "Reply with the single word ok.",
    signal: new AbortController().signal,
    bridge,
    ...(profileId ? { profileId } : {}),
  });
  return { frames, observed };
}

function initApiKeySource(observed: SDKMessage[]): string | undefined {
  const init = observed.find(
    (message) => message.type === "system" && message.subtype === "init"
  ) as { apiKeySource?: string } | undefined;
  return init?.apiKeySource;
}

function authFailure(frames: ServerMessage[]): ServerMessage | undefined {
  return frames.find((frame) => frame.type === "error" && frame.code === "CLAUDE_AUTH");
}

const LIVE = 90_000;

describe("a profile without its own credential bills the subscription", () => {
  test("OAuth, an API key and a bearer token all present: only the OAuth bearer is sent", async () => {
    const { brainPath } = arrange({ oauth: OAUTH });
    const { observed } = await runTurn(brainPath);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${OAUTH}`);
      expect(request.xApiKey).toBeNull();
    }
    expect(initApiKeySource(observed)).toBe("none");
  }, LIVE);

  test("a second credential-free profile is held to the same rule", async () => {
    const { brainPath } = arrange({ oauth: OAUTH });
    const { observed } = await runTurn(brainPath, "other");

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${OAUTH}`);
      expect(request.xApiKey).toBeNull();
    }
    expect(initApiKeySource(observed)).toBe("none");
  }, LIVE);

  test("no subscription token: nothing is sent and the turn is an auth failure", async () => {
    const { brainPath } = arrange({});
    const { frames } = await runTurn(brainPath);

    expect(seen).toEqual([]);
    expect(authFailure(frames)).toBeDefined();
    expect(frames.at(-1)?.type).toBe("error");
  }, LIVE);

  test("an EMPTY subscription token is no token: nothing is sent", async () => {
    const { brainPath } = arrange({ oauth: "" });
    const { frames } = await runTurn(brainPath);

    expect(seen).toEqual([]);
    expect(authFailure(frames)).toBeDefined();
  }, LIVE);

  test("a project apiKeyHelper is switched off: it never runs, and with no subscription nothing is sent", async () => {
    const marker = join(tempDir("sub-marker-"), "helper-ran");
    const { brainPath } = arrange({
      projectSettings: { apiKeyHelper: `touch ${marker}; echo ${HELPER_KEY}` },
    });
    const { frames } = await runTurn(brainPath);

    expect(seen).toEqual([]);
    expect(authFailure(frames)).toBeDefined();
    expect(existsSync(marker)).toBe(false);
  }, LIVE);

  test("a DELAYED apiKeyHelper beside an OAuth token never runs and never supplies the key", async () => {
    // A helper that has not produced its key yet is invisible to the account
    // check, so the only safe helper is one that never runs.
    const marker = join(tempDir("sub-marker-"), "helper-ran");
    const { brainPath } = arrange({
      oauth: OAUTH,
      projectSettings: { apiKeyHelper: `sleep 2; touch ${marker}; echo ${HELPER_KEY}` },
    });
    await runTurn(brainPath);

    for (const request of seen) {
      expect(request.xApiKey).toBeNull();
      expect(request.authorization).toBe(`Bearer ${OAUTH}`);
    }
    expect(existsSync(marker)).toBe(false);
  }, LIVE);

  test("a stored Console key is refused before the prompt is sent, even beside an OAuth token", async () => {
    const { brainPath } = arrange({ oauth: OAUTH, storedKey: true });
    const { frames } = await runTurn(brainPath);

    expect(seen).toEqual([]);
    expect(authFailure(frames)).toBeDefined();
  }, LIVE);
});

describe("a profile that declares its own credential is billed as declared", () => {
  test("apiKeyEnv sends that key as x-api-key", async () => {
    const { brainPath } = arrange({ oauth: OAUTH });
    await runTurn(brainPath, "declared-key");

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request.xApiKey).toBe(DECLARED_KEY);
  }, LIVE);

  test("authTokenEnv sends that token as the bearer", async () => {
    const { brainPath } = arrange({ oauth: OAUTH });
    await runTurn(brainPath, "declared-token");

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${AUTH_TOKEN}`);
      expect(request.xApiKey).toBeNull();
    }
  }, LIVE);
});
