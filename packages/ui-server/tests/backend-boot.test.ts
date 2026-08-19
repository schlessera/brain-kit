/**
 * Boot-time backend validation.
 *
 * F1 made both agent backends optional peers behind a lazy require — which
 * moved "the package is not installed" from import time to the first agent
 * turn: `createApp()` succeeded and /api/health reported healthy on a
 * deployment that could never run a turn. `assertBackendResolvable` restores
 * the boot-time guarantee (resolution only — the Agent SDK still loads
 * lazily), and `createApp()` calls it next to the auth assertions.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { assertBackendResolvable, createStaticBackendRegistry } from "../src/agent/backend";
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

  test("an unrecognized AGENT_BACKEND refuses without touching the resolver", () => {
    const touched: string[] = [];
    expect(() =>
      assertBackendResolvable(agent("gemini"), (specifier) => {
        touched.push(specifier);
      })
    ).toThrow('AGENT_BACKEND="gemini" does not match any configured backend');
    expect(touched).toEqual([]);
  });
});

describe("createApp boot validation", () => {
  const baseEnv = {
    HOST: "127.0.0.1",
    AUTH_MODE: "none",
    DB_PATH: ":memory:",
  } as const;

  test("an unrecognized AGENT_BACKEND refuses to boot", () => {
    expect(() =>
      createApp({ config: resolveServerConfig({ ...baseEnv, AGENT_BACKEND: "gemini" }) })
    ).toThrow('AGENT_BACKEND="gemini" does not match any configured backend');
  });

  test("an injected registry skips the resolvability check", () => {
    // The embedder took ownership of backend wiring — AGENT_BACKEND is then
    // irrelevant and must not be able to block boot.
    const app = createApp({
      config: resolveServerConfig({ ...baseEnv, AGENT_BACKEND: "gemini" }),
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.agent.backend).toBe("gemini");
    app.close();
  });

  test('dbPath: "" is honored (SQLite anonymous temporary database)', () => {
    // A truthiness check here once made the empty override fall through to
    // the resolved config — exactly the coercion class the injection refactor
    // was meant to end. "" is a valid SQLite database name.
    const app = createApp({
      config: resolveServerConfig({ ...baseEnv, DB_PATH: "/tmp/should-not-open.db" }),
      dbPath: "",
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.dbPath).toBe("");
    app.close();
    expect(existsSync("/tmp/should-not-open.db")).toBe(false);
  });

  test("app.config.dbPath reports the database actually opened", () => {
    // The option must fold into the returned config — an embedder inspecting
    // "the configuration this instance runs on" gets one answer, not two.
    const override = `/tmp/brain-ui-boot-config-${process.pid}.db`;
    const app = createApp({
      config: resolveServerConfig(baseEnv), // DB_PATH=:memory:
      dbPath: override,
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.config.dbPath).toBe(override);
    app.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(override + suffix, { force: true });
    }
  });
});

describe("BrainUiApp handle", () => {
  test("exposes the resolved authMode so the shell need not re-derive it", () => {
    const app = createApp({
      config: resolveServerConfig({ HOST: "127.0.0.1", AUTH_MODE: "none", DB_PATH: ":memory:" }),
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    expect(app.authMode).toBe("none");
    app.close();
  });
});
