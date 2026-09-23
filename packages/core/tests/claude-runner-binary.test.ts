/**
 * The Claude runner spawns the binary chat runs, not whatever `claude` is on
 * `PATH` (#213). With no `claude` on `PATH` at all, `brain sync` still runs:
 * on the Agent SDK's built-in binary, the one the chat backend's SDK selects.
 *
 * Keyless: the run goes to a loopback server with bogus credentials only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bundledClaudeCandidates, claudeCommand, prefersMusl } from "../src/providers/agents/claude-binary";
import { claudeRunner } from "../src/providers/agents/cli-runners";

const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const API_KEY = `sk-ant-api03-${"k".repeat(95)}AA`;

let server: ReturnType<typeof Bun.serve>;
const seen: Array<{ xApiKey: string | null; authorization: string | null }> = [];
const scratch: string[] = [];
const savedEnv = { ...process.env };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/v1/messages") {
        seen.push({ xApiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
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

/** What the chat backend's copy of the SDK would spawn with no path configured. */
async function chatBinary(): Promise<string> {
  const sdk = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../../ui-backend-claude"));
  const { query } = (await import(sdk)) as typeof import("@anthropic-ai/claude-agent-sdk");
  let command: string | undefined;
  try {
    query({
      prompt: "",
      options: {
        cwd: tmpdir(),
        spawnClaudeCodeProcess: (spawn) => {
          command = spawn.command;
          throw new Error("captured");
        },
      },
    });
  } catch {
    // the capture
  }
  if (!command) throw new Error("the SDK did not ask to spawn Claude Code");
  return command;
}

describe("the Claude runner's binary", () => {
  test("with no claude on PATH, the runner runs chat's binary and reaches the model", async () => {
    const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
    expect(Bun.which("claude", { PATH: path })).toBeNull();
    const home = tempDir("runner-home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    delete process.env.CLAUDE_CODE_PATH;
    Object.assign(process.env, {
      PATH: path,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      ANTHROPIC_API_KEY: API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });

    const [command, ...rest] = claudeCommand();
    expect(rest).toEqual([]);
    expect(realpathSync(command!)).toBe(realpathSync(await chatBinary()));
    await claudeRunner()
      .run("Reply with the single word ok.", { cwd: tempDir("runner-repo-") })
      .catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ xApiKey: null, authorization: `Bearer ${OAUTH}` });
  });

  test("CLAUDE_CODE_PATH, when set, is the binary, as it is for chat", () => {
    expect(claudeCommand({ CLAUDE_CODE_PATH: "/opt/claude/bin/claude" })).toEqual(["/opt/claude/bin/claude"]);
  });

  test("a JavaScript CLAUDE_CODE_PATH runs through the interpreter the SDK would use", () => {
    expect(claudeCommand({ CLAUDE_CODE_PATH: "/opt/claude/cli.js" })).toEqual(["bun", "/opt/claude/cli.js"]);
  });

  test("without the SDK installed where the runner looks, it runs claude from PATH", () => {
    expect(claudeCommand({}, join(tempDir("no-sdk-"), "index.js"))).toEqual(["claude"]);
  });

  test("tells musl from glibc the way the SDK does", () => {
    expect(prefersMusl("linux", () => ({ header: { glibcVersionRuntime: "2.39" } }))).toBe(false);
    expect(prefersMusl("linux", () => ({ header: {} }))).toBe(true);
    // No report at all keeps glibc first.
    expect(prefersMusl("linux", null)).toBe(false);
    expect(prefersMusl("linux", () => null)).toBe(false);
    expect(prefersMusl("darwin", () => ({ header: {} }))).toBe(false);
  });

  test("looks for the platform packages in the SDK's order", () => {
    const sdk = "@anthropic-ai/claude-agent-sdk";
    expect(bundledClaudeCandidates({ platform: "linux", arch: "x64", preferMusl: false })).toEqual([
      `${sdk}-linux-x64/claude`,
      `${sdk}-linux-x64-musl/claude`,
    ]);
    expect(bundledClaudeCandidates({ platform: "linux", arch: "arm64", preferMusl: true })).toEqual([
      `${sdk}-linux-arm64-musl/claude`,
      `${sdk}-linux-arm64/claude`,
    ]);
    expect(bundledClaudeCandidates({ platform: "android", arch: "arm64", preferMusl: false })).toEqual([
      `${sdk}-linux-arm64-android/claude`,
    ]);
    expect(bundledClaudeCandidates({ platform: "win32", arch: "x64", preferMusl: false })).toEqual([
      `${sdk}-win32-x64/claude.exe`,
    ]);
  });
});
