/**
 * A rejected subscription token fails `brain sync`'s Claude runner; nothing
 * retries it on the API key the host also holds (#254).
 *
 * Keyless: the model is a loopback stub that answers 401 to every bearer, and
 * both credentials are fake.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeRunner } from "../src/providers/agents/cli-runners";

const OAUTH = `sk-ant-oat01-${"r".repeat(95)}AA`;
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

describe("the Claude runner on a rejected token", () => {
  test("fails, and no request carries the API key", async () => {
    const home = tempDir("rejected-home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    delete process.env.CLAUDE_CODE_PATH;
    Object.assign(process.env, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      ANTHROPIC_API_KEY: API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });

    const outcome = await claudeRunner()
      .run("Reply with the single word ok.", { cwd: tempDir("rejected-repo-") })
      .then(
        (text) => ({ ok: true as const, text }),
        (error: unknown) => ({ ok: false as const, error: String(error) })
      );

    expect(outcome.ok).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((request) => request.xApiKey !== null)).toEqual([]);
    expect(seen.every((request) => request.authorization === `Bearer ${OAUTH}`)).toBe(true);
  }, 60_000);
});
