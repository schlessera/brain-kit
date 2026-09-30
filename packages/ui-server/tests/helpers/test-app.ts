/**
 * Per-test-suite `createApp()` wiring. App-level suites share one real app,
 * while this helper owns the ambient environment and disposable filesystem
 * state needed to boot it safely.
 */
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { bundledClaudeBinary } from "./claude-binary";
import {
  createApp,
  type BrainUiApp,
  type CreateAppOptions,
} from "../../src/app";

const BASE_ENV = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "ALLOWED_ORIGINS",
  "WEBAUTHN_ORIGINS",
  "TRUST_PROXY",
  "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
  "HOST",
  "NODE_ENV",
  "DB_PATH",
  "BRAIN_PATH",
  "BRAIN_UI_PRICING_DISCOVERY",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_CODE_PATH",
] as const;

let nextId = 0;

/** Options used to boot an isolated app for one test suite. */
export interface TestAppOptions {
  /**
   * Environment overrides resolved by `createApp()` at boot. `DB_PATH`,
   * `BRAIN_PATH` and `PI_CODING_AGENT_DIR` are always replaced with
   * helper-owned temporary paths, and pricing discovery is always off, so a
   * suite never reaches the network or the developer's real pi config.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Non-config app dependencies or display options needed by the suite. */
  appOptions?: Omit<CreateAppOptions, "config" | "dbPath">;
  /** Runs against the empty brain root before the app boots: a suite that needs a fake `brain` CLI installs it here. */
  prepare?: (brainPath: string) => void;
}

/** A booted app and the lifecycle helpers an app-level test suite uses. */
export interface TestApp {
  /** The real app handle returned by `createApp()`. */
  readonly app: BrainUiApp;
  /** Helper-owned disposable SQLite path. */
  readonly dbPath: string;
  /** Helper-owned disposable brain root. */
  readonly brainPath: string;
  /** Helper-owned disposable pi agent directory. */
  readonly piAgentDir: string;
  /** Issue a request against the booted app at `http://localhost`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Close the app, remove temporary state, and restore the pre-suite env.
   * Awaits the app's close (a scratch prune in flight is killed first)
   * before removing state. Idempotent so callers may also use it in failure
   * cleanup.
   */
  teardown(): Promise<void>;
}

/**
 * Merge base headers into a request, with per-call headers taking precedence.
 * Neither the base headers nor the request initializer is mutated.
 */
export function withHeaders(base: HeadersInit, init: RequestInit = {}): RequestInit {
  const headers = new Headers(base);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return { ...init, headers };
}

/**
 * Boot one real app for a test suite using a disposable database and brain
 * root. Call once from `beforeAll` and call `teardown` from `afterAll`.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const id = nextId++;
  const stem = `brain-ui-test-app-${process.pid}-${id}`;
  const dbPath = join(tmpdir(), `${stem}.db`);
  const brainPath = join(tmpdir(), `${stem}-brain`);
  const piAgentDir = join(tmpdir(), `${stem}-pi`);
  const envKeys = new Set<string>([...BASE_ENV, ...Object.keys(options.env ?? {})]);
  const saved: Record<string, string | undefined> = {};

  for (const key of envKeys) saved[key] = process.env[key];

  const restoreEnv = (): void => {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const removeTemporaryState = (): void => {
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(dbPath + suffix, { force: true });
    }
    rmSync(brainPath, { recursive: true, force: true });
    rmSync(piAgentDir, { recursive: true, force: true });
  };

  mkdirSync(brainPath, { recursive: true });
  mkdirSync(piAgentDir, { recursive: true });
  options.prepare?.(brainPath);
  process.env.AUTH_MODE = "none";
  process.env.HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  delete process.env.BRAIN_UI_PASSWORD_HASH;
  delete process.env.COOKIE_SECRET;
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.TRUST_PROXY;
  delete process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH;
  // Boot probes the binary a turn would spawn (#211): the one the lockfile installs.
  process.env.CLAUDE_CODE_PATH = bundledClaudeBinary();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.DB_PATH = dbPath;
  process.env.BRAIN_PATH = brainPath;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  process.env.BRAIN_UI_PRICING_DISCOVERY = "0";

  let app: BrainUiApp;
  try {
    app = await createApp(options.appOptions);
  } catch (error) {
    removeTemporaryState();
    restoreEnv();
    throw error;
  }

  let tornDown = false;
  return {
    app,
    dbPath,
    brainPath,
    piAgentDir,
    fetch: async (path, init) =>
      app.fetch(new Request(new URL(path, "http://localhost"), init)),
    teardown: async () => {
      if (tornDown) return;
      tornDown = true;
      try {
        await app.close();
      } finally {
        removeTemporaryState();
        restoreEnv();
      }
    },
  };
}
