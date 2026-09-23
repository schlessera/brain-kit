/**
 * `brain`'s Anthropic completions keep working from inside a chat turn once
 * the turn's API key is cleared (#253).
 *
 * A chat turn on a profile without its own credential runs with
 * `ANTHROPIC_API_KEY` emptied, so the CLI cannot bill it
 * (docs/decisions/claude-code-runtime.md). The Bash tool inherits that
 * environment, and so does any `brain` command the model runs through it — so
 * the `anthropic-haiku` completion provider needs its key under another name,
 * named in public configuration. This takes the environment the production
 * backend hands the CLI, then resolves the provider through the public config
 * schema and registry inside it, and completes one request against a mocked
 * fetch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { brainConfigSchema, resolveCompletionProvider } from "@schlessera/brain";
import type { query } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeBackend } from "../packages/ui-backend-claude/src/backend";

const COMPLETIONS_KEY_ENV = "BRAIN_ANTHROPIC_COMPLETIONS_KEY";
const COMPLETIONS_KEY = `sk-ant-api03-${"c".repeat(95)}AA`;

const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});

/** The environment the production backend hands the CLI for one default-profile turn. */
async function chatTurnEnv(): Promise<Record<string, string | undefined>> {
  let captured: Record<string, string | undefined> | undefined;
  const queryFn = ((params: { options?: { env?: Record<string, string | undefined> } }) => {
    captured = params.options?.env;
    return (async function* () {})();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn, log: () => {} });
  await backend.startTurn({
    prompt: "hi",
    signal: new AbortController().signal,
    bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) },
  });
  if (!captured) throw new Error("the backend never built a query");
  return captured;
}

/** Run `fn` with process.env replaced by `env`, as a child of the CLI would see it. */
async function inEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const outer = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, outer);
  }
}

describe("anthropic-haiku completions inside a subscription chat turn", () => {
  test("a key named in public configuration reaches the provider", async () => {
    Object.assign(process.env, {
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"o".repeat(95)}AA`,
      ANTHROPIC_API_KEY: `sk-ant-api03-${"k".repeat(95)}AA`,
      [COMPLETIONS_KEY_ENV]: COMPLETIONS_KEY,
      BRAIN_UI_SUBPROCESS_ENV_EXTRA: COMPLETIONS_KEY_ENV,
    });
    const env = await chatTurnEnv();
    // The premise: the CLI, and so its Bash tool, never sees the ambient key.
    expect(env.ANTHROPIC_API_KEY).toBe("");

    const sent: Array<string | null> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("x-api-key"));
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch;

    const text = await inEnv(env, async () => {
      const config = brainConfigSchema.parse({
        completions: { provider: "anthropic-haiku", apiKeyEnv: COMPLETIONS_KEY_ENV },
      });
      return resolveCompletionProvider(config.completions).complete({ prompt: "say ok" });
    });

    expect(text).toBe("ok");
    expect(sent).toEqual([COMPLETIONS_KEY]);
  });

  test("without that setting the provider finds no key inside the turn", async () => {
    Object.assign(process.env, {
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"o".repeat(95)}AA`,
      ANTHROPIC_API_KEY: `sk-ant-api03-${"k".repeat(95)}AA`,
    });
    const env = await chatTurnEnv();
    globalThis.fetch = (async () => {
      throw new Error("no request should be made");
    }) as unknown as typeof fetch;

    await expect(
      inEnv(env, async () => {
        const config = brainConfigSchema.parse({ completions: { provider: "anthropic-haiku" } });
        return resolveCompletionProvider(config.completions).complete({ prompt: "say ok" });
      })
    ).rejects.toThrow("ANTHROPIC_API_KEY environment variable is required");
  });
});
