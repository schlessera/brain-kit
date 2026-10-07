/**
 * Boot-time backend validation.
 *
 * F1 made both agent backends optional peers behind a lazy require — which
 * moved "the package is not installed" from import time to the first agent
 * turn: `createApp()` succeeded and /api/health reported healthy on a
 * deployment that could never run a turn. `assertBackendResolvable` restores
 * the boot-time guarantee and runs descriptor-owned profile validation before
 * health can report ready; backend construction remains lazy.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertBackendResolvable,
  createStaticBackendRegistry,
  loadBackendModule,
} from "../src/agent/backend";
import { createApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";

const agent = (backend: string | null) =>
  resolveServerConfig(backend === null ? {} : { AGENT_BACKEND: backend }).agent;

/** A resolver simulating "this package is not installed". */
const absent = (specifier: string) => {
  throw new Error(`Cannot find module '${specifier}'`);
};

describe("assertBackendResolvable", () => {
  test("passes when the selected backend's package resolves", () => {
    // The workspace links backend-claude, so the real resolver finds it.
    expect(() => assertBackendResolvable(agent(null))).not.toThrow();
    expect(() => assertBackendResolvable(agent("claude"))).not.toThrow();
  });

  test("a missing Claude package refuses with the install hint", () => {
    expect(() => assertBackendResolvable(agent(null), absent)).toThrow(
      'AGENT_BACKEND=claude but "@schlessera/brain-backend-claude" is not installed'
    );
  });

  test("a missing pi package refuses with the install hint", () => {
    expect(() => assertBackendResolvable(agent("pi"), absent)).toThrow(
      'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed'
    );
  });

  test("BRAIN_UI_PI_PROFILES with a missing pi package refuses at boot", () => {
    const withPiProfiles = resolveServerConfig({
      BRAIN_UI_PI_PROFILES: JSON.stringify([
        { id: "gpt-sol", label: "Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
      ]),
    }).agent;
    // Only the pi specifier is absent — the claude (primary) one resolves.
    const claudeOnly = (specifier: string) => {
      if (specifier.includes("backend-pi")) absent(specifier);
    };
    expect(() => assertBackendResolvable(withPiProfiles, claudeOnly)).toThrow(
      'BRAIN_UI_PI_PROFILES is set but "@schlessera/brain-backend-pi" is not installed'
    );
    // With everything resolvable, the opt-in passes.
    expect(() => assertBackendResolvable(withPiProfiles)).not.toThrow();
  });

  test("a malformed BRAIN_UI_PI_PROFILES refuses at boot, not on first request", () => {
    const malformed = resolveServerConfig({
      BRAIN_UI_PI_PROFILES: "not json",
    }).agent;
    expect(() => assertBackendResolvable(malformed)).toThrow(
      "BRAIN_UI_PI_PROFILES is not valid JSON"
    );
  });

  test("pi primary boots without Claude installed when the inactive roster is empty", () => {
    const resolved: string[] = [];
    const piOnly = (specifier: string) => {
      resolved.push(specifier);
      if (specifier.includes("backend-claude")) absent(specifier);
    };
    const config = resolveServerConfig({
      AGENT_BACKEND: "pi",
      BRAIN_UI_CLAUDE_PROFILES: "[]",
    }).agent;

    expect(() => assertBackendResolvable(config, piOnly)).not.toThrow();
    expect(resolved).toEqual(["@schlessera/brain-backend-pi"]);
  });

  test("pi primary boots without Claude installed for a non-colliding inactive roster", () => {
    const piOnly = (specifier: string) => {
      if (specifier.includes("backend-claude")) absent(specifier);
    };
    const config = resolveServerConfig({
      AGENT_BACKEND: "pi",
      BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
        { id: "anthropic-custom", label: "Anthropic Custom" },
      ]),
      BRAIN_UI_PI_PROFILES: JSON.stringify([
        { id: "gpt-test", label: "GPT Test", vendor: "openai-codex", model: "gpt-test" },
      ]),
    }).agent;

    expect(() => assertBackendResolvable(config, piOnly)).not.toThrow();
  });

  test("pi primary ignores malformed data in the inactive Claude roster", () => {
    for (const inactiveRoster of ["not json", JSON.stringify([{}])]) {
      const config = resolveServerConfig({
        AGENT_BACKEND: "pi",
        BRAIN_UI_CLAUDE_PROFILES: inactiveRoster,
        BRAIN_UI_PI_PROFILES: JSON.stringify([
          {
            id: "gpt-test",
            label: "GPT Test",
            vendor: "openai-codex",
            model: "gpt-test",
          },
        ]),
      }).agent;

      expect(() => assertBackendResolvable(config)).not.toThrow();
    }
  });

  test("an unrecognized AGENT_BACKEND refuses without touching the resolver", () => {
    const touched: string[] = [];
    expect(() =>
      assertBackendResolvable(agent("gemini"), (specifier) => {
        touched.push(specifier);
      })
    ).toThrow('AGENT_BACKEND="gemini" does not match any configured backend');
    expect(touched).toEqual([]);
  });

  test("AGENT_BACKEND accepts only the two fixed first-party ids", () => {
    for (const value of [
      "@scope/custom-backend",
      "file:./backend.ts",
      "https://example.invalid/backend.js",
      "gemini",
    ]) {
      expect(() => assertBackendResolvable(agent(value))).toThrow(
        `AGENT_BACKEND="${value.toLowerCase()}" does not match any configured backend`
      );
    }
    expect(() => assertBackendResolvable(agent("claude"))).not.toThrow();
    expect(() => assertBackendResolvable(agent("pi"))).not.toThrow();
  });
});

describe("loadBackendModule", () => {
  test("the installed workspace backend loads through the real importer", async () => {
    const claude = (await loadBackendModule("claude")) as Record<string, unknown>;
    expect(typeof claude.createClaudeBackend).toBe("function");
    expect(typeof claude.backendModule).toBe("object");
  });

  test("an absent package maps to the install hint (Bun-shaped resolve error)", async () => {
    // Bun's ResolveMessage is NOT an Error instance; it carries the failing
    // specifier as a property.
    const bunResolveError = {
      name: "ResolveMessage",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@schlessera/brain-backend-pi",
      message: "Cannot find module '@schlessera/brain-backend-pi' from '/srv/app/index.js'",
    };
    await expect(
      loadBackendModule("pi", () => Promise.reject(bunResolveError))
    ).rejects.toThrow(
      'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed'
    );
  });

  test("an absent package maps to the install hint (Node-shaped resolve error)", async () => {
    // Node puts the failing specifier in the message, not on a property.
    const nodeResolveError = Object.assign(
      new Error(
        "Cannot find package '@schlessera/brain-backend-claude' imported from " +
          "/srv/app/node_modules/@schlessera/brain-ui-server/dist/agent/backend.js"
      ),
      { code: "ERR_MODULE_NOT_FOUND" }
    );
    await expect(
      loadBackendModule("claude", () => Promise.reject(nodeResolveError))
    ).rejects.toThrow(
      'AGENT_BACKEND=claude but "@schlessera/brain-backend-claude" is not installed'
    );
  });

  test("a backend missing its own transitive dep does NOT read as 'not installed'", async () => {
    // Same error code, different failing specifier: the backend IS installed,
    // its install is broken. "Not installed" would send the operator to
    // reinstall the wrong package; the real error is the diagnostic.
    const transitiveMiss = Object.assign(
      new Error(
        "Cannot find package '@anthropic-ai/claude-agent-sdk' imported from " +
          "/srv/app/node_modules/@schlessera/brain-backend-claude/dist/index.js"
      ),
      { code: "ERR_MODULE_NOT_FOUND" }
    );
    await expect(
      loadBackendModule("claude", () => Promise.reject(transitiveMiss))
    ).rejects.toThrow("Cannot find package '@anthropic-ai/claude-agent-sdk'");
  });

  test("an installed-but-throwing module surfaces its real error", async () => {
    // A real import of a real (broken) module, not a simulated rejection: the
    // whole point of dropping the blanket catch is that this class of failure
    // stops masquerading as "not installed".
    const dir = mkdtempSync(join(tmpdir(), "brain-ui-broken-backend-"));
    const file = join(dir, "index.mjs");
    writeFileSync(file, 'throw new Error("backend exploded at import time");\n');
    try {
      const rejection = loadBackendModule("pi", () => import(pathToFileURL(file).href));
      await expect(rejection).rejects.toThrow("backend exploded at import time");
      await expect(rejection).rejects.not.toThrow("is not installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-resolution failure (e.g. ERR_REQUIRE_ESM) is rethrown untouched", async () => {
    const requireEsm = Object.assign(new Error("require() of ES Module not supported"), {
      code: "ERR_REQUIRE_ESM",
    });
    await expect(
      loadBackendModule("pi", () => Promise.reject(requireEsm))
    ).rejects.toThrow("require() of ES Module not supported");
  });
});

describe("createApp boot validation", () => {
  const baseEnv = {
    HOST: "127.0.0.1",
    AUTH_MODE: "none",
    DB_PATH: ":memory:",
    // These boot tests do not exercise pricing; custom env records do not
    // inherit the runner's NODE_ENV=test default that disables discovery.
    BRAIN_UI_PRICING_DISCOVERY: "0",
  } as const;

  test("an unrecognized AGENT_BACKEND refuses to boot", async () => {
    await expect(createApp({ config: resolveServerConfig({ ...baseEnv, AGENT_BACKEND: "gemini" }) })).rejects.toThrow('AGENT_BACKEND="gemini" does not match any configured backend');
  });

  test("a pi profile missing required fields refuses to boot", async () => {
    await expect(createApp({
        config: resolveServerConfig({
          ...baseEnv,
          BRAIN_UI_PI_PROFILES: JSON.stringify([{}]),
        }),
      })).rejects.toThrow("Each BRAIN_UI_PI_PROFILES entry needs a non-empty string id.");
  });

  test("a reserved pi profile id refuses to boot", async () => {
    await expect(createApp({
        config: resolveServerConfig({
          ...baseEnv,
          BRAIN_UI_PI_PROFILES: JSON.stringify([
            {
              id: "claude-shadow",
              label: "Shadow",
              vendor: "openai-codex",
              model: "gpt-test",
            },
          ]),
        }),
      })).rejects.toThrow('BRAIN_UI_PI_PROFILES id "claude-shadow" is reserved for the Claude roster');
  });

  test("an invalid pi thinking level refuses to boot", async () => {
    await expect(createApp({
        config: resolveServerConfig({
          ...baseEnv,
          BRAIN_UI_PI_PROFILES: JSON.stringify([
            {
              id: "gpt-test",
              label: "GPT Test",
              vendor: "openai-codex",
              model: "gpt-test",
              thinkingLevel: "ultra",
            },
          ]),
        }),
      })).rejects.toThrow('BRAIN_UI_PI_PROFILES entry "gpt-test" has invalid thinkingLevel "ultra"');
  });

  test("pi-primary still rejects ids declared in the inactive Claude roster", async () => {
    await expect(createApp({
        config: resolveServerConfig({
          ...baseEnv,
          AGENT_BACKEND: "pi",
          BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
            { id: "shared", label: "Shared (Anthropic)" },
          ]),
          BRAIN_UI_PI_PROFILES: JSON.stringify([
            {
              id: "shared",
              label: "Shared (OpenAI)",
              vendor: "openai-codex",
              model: "gpt-test",
            },
          ]),
        }),
      })).rejects.toThrow('BRAIN_UI_PI_PROFILES id "shared" collides with a BRAIN_UI_CLAUDE_PROFILES entry.');
  });

  test("an injected registry skips the resolvability check", async () => {
    // The embedder took ownership of backend wiring — AGENT_BACKEND is then
    // irrelevant and must not be able to block boot.
    const app = await createApp({
      config: resolveServerConfig({ ...baseEnv, AGENT_BACKEND: "gemini" }),
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.agent.backend).toBe("gemini");
    await app.close();
  });

  test('dbPath: "" is honored (SQLite anonymous temporary database)', async () => {
    // A truthiness check here once made the empty override fall through to
    // the resolved config — exactly the coercion class the injection refactor
    // was meant to end. "" is a valid SQLite database name.
    const app = await createApp({
      config: resolveServerConfig({ ...baseEnv, DB_PATH: "/tmp/should-not-open.db" }),
      dbPath: "",
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.dbPath).toBe("");
    expect(app.db.filename).toBe("");
    await app.close();
    expect(existsSync("/tmp/should-not-open.db")).toBe(false);
  });

  test("app.config.dbPath reports the database actually opened", async () => {
    // The option must fold into the returned config — an embedder inspecting
    // "the configuration this instance runs on" gets one answer, not two.
    const override = `/tmp/brain-ui-boot-config-${process.pid}.db`;
    const app = await createApp({
      config: resolveServerConfig(baseEnv), // DB_PATH=:memory:
      dbPath: override,
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.dbPath).toBe(override);
    expect(app.db.filename).toBe(override);
    await app.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(override + suffix, { force: true });
    }
  });
});

describe("BrainUiApp handle", () => {
  test("exposes the resolved authMode so the shell need not re-derive it", async () => {
    const app = await createApp({
      config: resolveServerConfig({ HOST: "127.0.0.1", AUTH_MODE: "none", DB_PATH: ":memory:", BRAIN_UI_PRICING_DISCOVERY: "0" }),
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.authMode).toBe("none");
    await app.close();
  });
});
