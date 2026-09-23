/**
 * The core CLI's Claude runner — what `brain sync` runs under cron — never
 * bills an API key (#253, docs/decisions/claude-code-runtime.md).
 *
 * Runs the REAL Claude Code binary the lockfile installs (the Agent SDK's
 * bundled one, put on PATH as `claude`) against a loopback HTTP server set as
 * `ANTHROPIC_BASE_URL`. Every credential is bogus and nothing leaves the
 * machine: the server records the auth headers of each `/v1/messages`
 * request and answers 400, which the CLI does not retry.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claudeRunner } from "../src/providers/agents/cli-runners";
import { ClaudeSubscriptionError } from "../src/providers/agents/claude-subscription";

const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;
const AUTH_TOKEN = `sk-ant-bearer-${"b".repeat(60)}`;
const HELPER_KEY = `sk-ant-api03-${"h".repeat(95)}AA`;
const STORED_KEY = `sk-ant-api03-${"s".repeat(95)}AA`;

/** The binary the Agent SDK would spawn on this platform, from the workspace install. */
function bundledClaude(): string {
  const libc = process.platform === "linux" ? ["", "-musl"] : [""];
  for (const suffix of libc) {
    try {
      return Bun.resolveSync(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/claude`,
        join(import.meta.dir, "../../ui-backend-claude")
      );
    } catch {
      // try the next libc
    }
  }
  throw new Error("the Agent SDK's bundled Claude Code binary is not installed");
}

interface Seen {
  xApiKey: string | null;
  authorization: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let binDir: string;
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
  binDir = mkdtempSync(join(tmpdir(), "runner-bin-"));
  symlinkSync(bundledClaude(), join(binDir, "claude"));
});

afterAll(() => {
  server.stop(true);
  rmSync(binDir, { recursive: true, force: true });
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

/** A fresh HOME, config dir and repo, with the given credentials in process.env. */
function arrange(setup: { oauth?: string; helper?: string; storedKey?: boolean }): string {
  const home = tempDir("runner-home-");
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  const repo = tempDir("runner-repo-");
  if (setup.helper) {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: setup.helper }));
  }
  if (setup.storedKey) {
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ primaryApiKey: STORED_KEY }));
  }
  Object.assign(process.env, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  if (setup.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = setup.oauth;
  return repo;
}

const MODES = {
  run: (repo: string) => claudeRunner().run("Reply with the single word ok.", { cwd: repo }),
  runStreaming: (repo: string) =>
    claudeRunner().runStreaming!("Reply with the single word ok.", { cwd: repo, onEvent: () => {} }),
};

const LIVE = 90_000;

for (const [mode, invoke] of Object.entries(MODES)) {
  describe(`claudeRunner().${mode}`, () => {
    test("OAuth, an API key and a bearer token all present: only the OAuth bearer is sent", async () => {
      const repo = arrange({ oauth: OAUTH });
      // The loopback answers 400, so the run itself fails; what matters is what was sent.
      await invoke(repo).catch(() => {});

      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen) {
        expect(request.authorization).toBe(`Bearer ${OAUTH}`);
        expect(request.xApiKey).toBeNull();
      }
    }, LIVE);

    test("no subscription token: nothing is sent and the run is refused", async () => {
      const repo = arrange({});
      await expect(invoke(repo)).rejects.toBeInstanceOf(ClaudeSubscriptionError);
      expect(seen).toEqual([]);
    }, LIVE);

    test("a project apiKeyHelper never runs, and with no subscription nothing is sent", async () => {
      const marker = join(tempDir("runner-marker-"), "helper-ran");
      const repo = arrange({ helper: `touch ${marker}; echo ${HELPER_KEY}` });
      await expect(invoke(repo)).rejects.toBeInstanceOf(ClaudeSubscriptionError);
      expect(seen).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    }, LIVE);

    test("a DELAYED apiKeyHelper beside an OAuth token never runs and never supplies the key", async () => {
      const marker = join(tempDir("runner-marker-"), "helper-ran");
      const repo = arrange({ oauth: OAUTH, helper: `sleep 2; touch ${marker}; echo ${HELPER_KEY}` });
      await invoke(repo).catch(() => {});

      for (const request of seen) {
        expect(request.xApiKey).toBeNull();
        expect(request.authorization).toBe(`Bearer ${OAUTH}`);
      }
      expect(existsSync(marker)).toBe(false);
    }, LIVE);

    test("a stored Console key is refused before the prompt is written, even beside an OAuth token", async () => {
      const repo = arrange({ oauth: OAUTH, storedKey: true });
      await expect(invoke(repo)).rejects.toBeInstanceOf(ClaudeSubscriptionError);
      expect(seen).toEqual([]);
    }, LIVE);
  });
}
