/**
 * With `CLAUDE_CODE_PATH` unset, a turn runs the Agent SDK's built-in Claude
 * Code binary (#213, docs/decisions/claude-code-runtime.md, "The decision").
 *
 * Every turn here goes through the production path: the server's own config
 * resolution, the backend registry, and the Claude backend module, with the
 * process environment a host would have. Nothing is hand-built.
 *
 * Which binary the SDK was told to run is read from an exec wrapper, which the
 * SDK hands the command it chose: the built-in binary exactly when the options
 * carry no `pathToClaudeCodeExecutable`. The last test runs that binary for
 * real against a loopback server with bogus credentials only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendActivityEvent, BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { createBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { fixtureShellQuote } from "../../../scripts/worker-effect-witness";
import { bundledClaudeBinary } from "./helpers/claude-binary";

// Distinct bogus values, so a header names exactly which credential was sent.
const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;
const AUTH_TOKEN = `sk-ant-bearer-${"b".repeat(60)}`;

const savedEnv = { ...process.env };
const scratch: string[] = [];
const seen: Array<{ xApiKey: string | null; authorization: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;
const wrapperCommands: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/fixture-command") {
        wrapperCommands.push(await req.text());
        return new Response(null, { status: 204 });
      }
      if (new URL(req.url).pathname === "/v1/messages") {
        seen.push({ xApiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
      }
      // A 400 is not retried, so the turn ends after the first request.
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
  wrapperCommands.length = 0;
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

/** The environment a host would give the server, with every credential bogus. */
function arrangeHost(extra: Record<string, string> = {}): string {
  const home = tempDir("bundled-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const brainPath = tempDir("bundled-brain-");
  delete process.env.CLAUDE_CODE_PATH;
  delete process.env.BRAIN_UI_EXEC_WRAPPER;
  Object.assign(process.env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    BRAIN_PATH: brainPath,
    AGENT_BACKEND: "claude",
    BRAIN_UI_MODEL_DISCOVERY: "0",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ...extra,
  });
  return brainPath;
}

/** One turn on the default backend, built the way the server builds it. */
async function productionTurn(brainPath: string): Promise<BackendActivityEvent[]> {
  const config = resolveServerConfig(process.env);
  const registry = createBackendRegistry({ brainPath, agent: config.agent });
  const backend = await registry.getDefaultBackend();
  const activity: BackendActivityEvent[] = [];
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async () => ({ behavior: "deny", message: "test" }),
    activity: (event) => activity.push(event),
  };
  await backend.startTurn({ prompt: "Reply with the single word ok.", signal: new AbortController().signal, bridge });
  return activity;
}

/** An exec wrapper that records the command the SDK chose, and runs nothing. */
function recordingWrapper(): { wrapper: string; commands: () => string[] } {
  // /tmp is fresh inside the worker; this fixture executable stays read-only.
  const dir = mkdtempSync("/var/tmp/bundled-wrapper-");
  scratch.push(dir);
  const wrapper = join(dir, "wrapper");
  const report = `await fetch("http://127.0.0.1:${server.port}/fixture-command", {method:"POST", body:process.argv.at(-1)});`;
  writeFileSync(wrapper, `#!/bin/sh\n${fixtureShellQuote(process.execPath)} -e ${fixtureShellQuote(report)} "$1"\nexit 1\n`);
  chmodSync(wrapper, 0o755);
  return {
    wrapper,
    commands: () => [...wrapperCommands],
  };
}

describe("the binary a turn runs", () => {
  test("with CLAUDE_CODE_PATH unset, the SDK is given no path and runs its built-in binary", async () => {
    const { wrapper, commands } = recordingWrapper();
    const brainPath = arrangeHost({ BRAIN_UI_EXEC_WRAPPER: wrapper });
    await productionTurn(brainPath);
    expect(commands()).toEqual([bundledClaudeBinary()]);
    // The backend's only input to the option: nothing is configured, so
    // claude-code-path.test.ts's "absent" case is the one that applies.
    expect(resolveServerConfig(process.env).agent.claudeCodePath).toBeNull();
  });

  test("with CLAUDE_CODE_PATH set, the SDK is given that path unchanged", async () => {
    const { wrapper, commands } = recordingWrapper();
    const hostBinary = join(tempDir("bundled-host-"), "claude");
    const brainPath = arrangeHost({ BRAIN_UI_EXEC_WRAPPER: wrapper, CLAUDE_CODE_PATH: hostBinary });
    await productionTurn(brainPath);
    expect(commands()).toEqual([hostBinary]);
  });

  test("the built-in binary, keyless, sends the subscription token and no API key", async () => {
    const brainPath = arrangeHost();
    const activity = await productionTurn(brainPath);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${OAUTH}`);
      expect(request.xApiKey).toBeNull();
    }
    const report = activity.find((event) => event.kind === "runtime_observed") as Extract<
      BackendActivityEvent,
      { kind: "runtime_observed" }
    >;
    // `credential.apiKeySource` is the CLI's own `init.apiKeySource`.
    expect(report.credential?.apiKeySource).toBe("none");
    expect(report.billing).toBe("subscription");
  });
});
