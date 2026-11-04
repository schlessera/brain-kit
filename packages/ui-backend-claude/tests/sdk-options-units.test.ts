/**
 * Direct tests for the units #2519 extracted from `assembleClaudeSdkTurn`.
 * What they compose into is pinned byte-for-byte by sdk-options-snapshot.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assemblePromptContext, computeToolRoster, turnChildEnvironment } from "../src/sdk-options.js";

const handler = async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); };
const request = (extra: Record<string, unknown> = {}) => ({
  prompt: "Which way to Ithaca?", signal: new AbortController().signal,
  bridge: { emit: () => {}, askUser: handler, askUserList: handler, requestMask: handler, getLocation: handler, queryActivity: handler },
  ...extra,
}) as never;

describe("computeToolRoster", () => {
  test("an interactive turn binds its bridge handlers and auto-allows them after the deployment's tools", () => {
    const roster = computeToolRoster(request(), ["Read", "Bash"]);
    expect(roster.allowed).toEqual(["Read", "Bash", "mcp__brain-ui__ask_user", "mcp__brain-ui__ask_user_list",
      "mcp__brain-ui__get_current_location", "mcp__brain-ui__request_image_mask", "mcp__brain-ui__query_activity",
      "mcp__brain-ui__turn_temp", "mcp__brain-ui__show_block"]);
    expect(roster.askUser).toBe(handler);
    expect(roster.hosted).toBe(false);
    expect(roster.turnTempTool).toBe(true);
  });

  test("a turn with no grant surface withholds the handlers that need eyes", () => {
    const roster = computeToolRoster(request({ noGrantSurface: true }), []);
    expect(roster.requestMask).toBeUndefined();
    expect(roster.askUserList).toBeUndefined();
    expect(roster.askUser).toBe(handler);
    expect(roster.allowed).not.toContain("mcp__brain-ui__request_image_mask");
  });

  test("a hosted turn migrates legacy writers and keeps native writers beside the server's", () => {
    const roster = computeToolRoster(request({ applicationAuthority: "server" }), ["Write", "mcp__brain__brain_add"]);
    expect(roster.hosted).toBe(true);
    expect(roster.allowed.slice(0, 3)).toEqual(["Write", "mcp__brain-ui__write_file", "mcp__brain-ui__brain_add"]);
  });

  test("an autonomous roster is exactly the server's", () => {
    const roster = computeToolRoster(request({ autonomous: { origin: "autonomous", allowedTools: ["Read"] } }), ["Read"]);
    expect(roster.allowed).toEqual(["Read"]);
    expect(roster.turnTempTool).toBe(false);
  });
});

describe("turnChildEnvironment", () => {
  const profile = { requiredEnvKeys: ["ODYSSEUS_KEY"], buildEnv: () => ({}), billing: "subscription" } as never;

  test("an ordinary turn runs with its resolved environment unchanged", () => {
    const turnEnvironment = { ODYSSEUS_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "fixture", HOME: "/home/penelope" };
    const env = turnChildEnvironment({ profile, turnEnvironment }, undefined);
    expect(env.childEnv).toBe(turnEnvironment);
    expect(env.inferenceEnv).toBeUndefined();
    expect(env.providerKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  test("a relayed turn keeps the profile's credential on the host and points inference at the relay", () => {
    const env = turnChildEnvironment({ profile, turnEnvironment: { ODYSSEUS_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "fixture", HOME: "/home/penelope" },
      hostInference: { proxyDir: "/run/relay", baseUrl: "http://localhost" } }, undefined);
    expect(env.childEnv.ODYSSEUS_KEY).toBeUndefined();
    expect(env.childEnv.HOME).toBe("/home/penelope");
    expect(env.childEnv.ANTHROPIC_BASE_URL).toBe("http://localhost");
    expect(env.inferenceEnv?.ANTHROPIC_UNIX_SOCKET).toEndWith("/inference.sock");
    // The relay's placeholder replaces the token, so the note names no kept provider key.
    expect(env.childEnv.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("fixture");
    expect(env.providerKeys).toEqual([]);
  });
});

describe("assemblePromptContext", () => {
  test("an interactive turn snapshots a fixed append and carries live facts on the user message", () => {
    const brain = mkdtempSync(join(tmpdir(), "odysseus-prompt-context-"));
    try {
      const req = request({ sessionId: undefined });
      const narrow = computeToolRoster(request({ noGrantSurface: true }), []);
      const wide = computeToolRoster(req, []);
      const sandbox = { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } as never;
      const a = assemblePromptContext({ brainPath: brain }, req, narrow, sandbox, "SANDBOX NOTE");
      const b = assemblePromptContext({ brainPath: brain }, req, wide, sandbox, "SANDBOX NOTE");
      // The append is the same whatever the roster: it must not move the cached prefix.
      expect(a.append).toBe(b.append);
      expect(a.append).not.toContain("SANDBOX NOTE");
      expect(a.owned?.text).toContain("SANDBOX NOTE");
      expect(a.context).toBeDefined();
    } finally { rmSync(brain, { recursive: true, force: true }); }
  });

  test("an autonomous turn has no prompt context and appends its brief to the sandbox note", () => {
    const brain = mkdtempSync(join(tmpdir(), "odysseus-prompt-context-"));
    try {
      const req = request({ autonomous: { origin: "autonomous", allowedTools: [], systemPromptAppend: "Tally the herds." } });
      const prompt = assemblePromptContext({ brainPath: brain }, req, computeToolRoster(req, []), { brain } as never, "SANDBOX NOTE");
      expect(prompt.context).toBeUndefined();
      expect(prompt.owned).toBeUndefined();
      expect(prompt.append).toBe("Tally the herds.\n\nSANDBOX NOTE");
    } finally { rmSync(brain, { recursive: true, force: true }); }
  });
});
