/**
 * The Claude subscription token as the operator sees it (#254): the mint date
 * and the expiry warning, when the token last worked, and every auth failure
 * turned into an instruction, on `/api/status` and in the log.
 *
 * Every token here is fake, and nothing reaches an Anthropic host: turns come
 * from a scripted backend, discovery from a stubbed Models API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeBackend, createModelSource } from "@schlessera/brain-backend-claude";
import {
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  type BackendActivityEvent,
  type BackendBridge,
  type BackendModelSource,
} from "@schlessera/brain-ui-sdk/server";
import { filterSubprocessEnv } from "@schlessera/brain-ui-sdk/internal";

import { createStaticBackendRegistry } from "../src/agent/backend";
import {
  createSubscriptionMonitor,
  LAST_PROVEN_SETTING,
  MINTED_AT_ENV,
  parseMintedAt,
  type SubscriptionStatus,
} from "../src/agent/subscription";
import { createApp, type BrainUiApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import { resolveAmbientPrincipal } from "../src/db/principals";
import { createRecordingObservability, type RecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { makeFakeBackend } from "./helpers/fake-backend";

const FAKE_TOKEN = `sk-ant-oat01-${"f".repeat(95)}AA`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-23T12:00:00Z");

const scratch: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
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

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);
}

function warnings(observability: RecordingObservability, text: string): string[] {
  return observability.logs
    .find({ severity: "WARN" })
    .map((entry) => String(entry.body))
    .filter((body) => body.includes(text));
}

/** A monitor with no turns and no discovery, on a clock the test moves. */
function monitorWith(config: { tokenSet: boolean; mintedAt: string | null }) {
  const observability = createRecordingObservability();
  let clock = NOW.getTime();
  const db = createUiDb(":memory:");
  const scheduled: Array<{ check: () => void; ms: number; cancelled: boolean }> = [];
  const monitor = createSubscriptionMonitor({
    config,
    log: observability.logger("agent"),
    db,
    lastTurnFailure: () => undefined,
    modelSource: async () => null,
    now: () => new Date(clock),
    every: (check, ms) => {
      const entry = { check, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return {
    monitor,
    observability,
    scheduled,
    advance: (ms: number) => {
      clock += ms;
    },
    close: () => {
      monitor.close();
      db.close();
    },
  };
}

describe("the expiry warning", () => {
  test("warns once at boot for a token minted 340 days ago", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: daysBefore(340) });
    expect(warnings(m.observability, "expires on")).toHaveLength(1);
    const [warning] = warnings(m.observability, "expires on");
    // The procedure, and no claim that anything was rejected: nothing was tried.
    expect(warning).toContain("claude setup-token");
    expect(warning).toContain(MINTED_AT_ENV);
    expect(warning).not.toContain("rejected");
    m.close();
  });

  test("says nothing for a token minted 100 days ago", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: daysBefore(100) });
    expect(m.observability.logs.find({ severity: "WARN" })).toEqual([]);
    m.close();
  });

  test("starts exactly 30 days before expiry, to the millisecond", () => {
    const at = (msBeforeWindow: number) =>
      new Date(NOW.getTime() - (365 - 30) * DAY + msBeforeWindow).toISOString();
    const early = monitorWith({ tokenSet: true, mintedAt: at(1) });
    expect(early.observability.logs.find({ severity: "WARN" })).toEqual([]);
    early.close();
    const due = monitorWith({ tokenSet: true, mintedAt: at(0) });
    expect(warnings(due.observability, "in 30 days")).toHaveLength(1);
    due.close();
  });

  test("the running check is the scheduled one, hourly, and closing cancels it", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: daysBefore(340) });
    expect(m.scheduled.map((entry) => entry.ms)).toEqual([60 * 60 * 1000]);
    m.advance(DAY);
    m.scheduled[0]!.check();
    expect(warnings(m.observability, "expires on")).toHaveLength(2);
    m.close();
    expect(m.scheduled[0]!.cancelled).toBe(true);
  });

  test("warns once at boot for a token already past its expiry", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: daysBefore(400) });
    expect(warnings(m.observability, "expired on")).toHaveLength(1);
    m.close();
  });

  test("a running server warns at most once per 24 hours", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: daysBefore(340) });
    for (let hour = 1; hour < 24; hour++) {
      m.advance(60 * 60 * 1000);
      m.monitor.tick();
    }
    expect(warnings(m.observability, "expires on")).toHaveLength(1);
    m.advance(60 * 60 * 1000);
    m.monitor.tick();
    expect(warnings(m.observability, "expires on")).toHaveLength(2);
    m.close();
  });

  test("a database that fails the hourly pass is logged, not thrown into the timer", () => {
    const observability = createRecordingObservability();
    const broken = {
      query: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as ReturnType<typeof createUiDb>;
    const scheduled: Array<() => void> = [];
    const monitor = createSubscriptionMonitor({
      // Inside the warning window: the failing database must not silence it.
      config: { tokenSet: true, mintedAt: daysBefore(340) },
      log: observability.logger("agent"),
      db: broken,
      lastTurnFailure: () => undefined,
      modelSource: async () => null,
      now: () => NOW,
      every: (check) => {
        scheduled.push(check);
        return () => {};
      },
    });
    expect(() => scheduled[0]!()).not.toThrow();
    expect(warnings(observability, "subscription check failed").length).toBeGreaterThanOrEqual(2);
    expect(warnings(observability, "expires on")).toHaveLength(1);
    monitor.close();
  });

  test("a token without a mint date gets the one cannot-warn WARN at boot", () => {
    const m = monitorWith({ tokenSet: true, mintedAt: null });
    const found = warnings(m.observability, "cannot warn before the token expires");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(MINTED_AT_ENV);
    m.advance(2 * DAY);
    m.monitor.tick();
    expect(m.observability.logs.find({ severity: "WARN" })).toHaveLength(1);
    m.close();
  });
});

// --- The app ------------------------------------------------------------------

interface Host {
  brainPath: string;
  dbPath: string;
}

function host(): Host {
  const dir = tempDir("subscription-app-");
  const brainPath = join(dir, "brain");
  mkdirSync(brainPath);
  return { brainPath, dbPath: join(dir, "ui.db") };
}

type Script = (bridge: BackendBridge) => void;

async function boot(
  at: Host,
  env: Record<string, string>,
  script: Script = () => {},
  observability = createRecordingObservability(),
  modelSource: BackendModelSource | null = null
): Promise<{ app: BrainUiApp; observability: RecordingObservability }> {
  const config = resolveServerConfig({
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    BRAIN_PATH: at.brainPath,
    DB_PATH: at.dbPath,
    BRAIN_UI_PRICING_DISCOVERY: "0",
    ...env,
  });
  const backend = makeFakeBackend({
    id: "claude",
    startTurn: async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-1", isNew: true });
      script(bridge);
    },
  });
  const app = await createApp({
    config,
    observability,
    registry: createStaticBackendRegistry([backend], backend.id, { modelSource }),
  });
  return { app, observability };
}

async function turn(app: BrainUiApp): Promise<void> {
  const sent: string[] = [];
  const ws = { send: (data: string) => sent.push(data), close: () => {}, readyState: 1 } as unknown as WSContext;
  // The principal an AUTH_MODE=none app gives every connection.
  const principal = resolveAmbientPrincipal(app.db, "none", "No authentication", "No authentication");
  const handlers = createWsHandlers(app.wsHost, principal);
  handlers.onOpen(undefined as never, ws);
  handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent, ws);
  const deadline = Date.now() + 5000;
  while (!sent.some((frame) => JSON.parse(frame).type === "result")) {
    if (Date.now() > deadline) throw new Error("the turn did not finish");
    await Bun.sleep(5);
  }
  while (app.isTurnActive() && Date.now() < deadline) await Bun.sleep(5);
}

async function status(app: BrainUiApp): Promise<{ raw: string; subscription: SubscriptionStatus }> {
  const res = await app.fetch(new Request("http://localhost/api/status"));
  const raw = await res.text();
  return { raw, subscription: (JSON.parse(raw) as { subscription: SubscriptionStatus }).subscription };
}

const subscriptionRun: Script = (bridge) => {
  bridge.activity?.({
    kind: "runtime_observed",
    runtime: { name: "claude-code", version: "2.1.999" },
    billing: "subscription",
    policy: "subscription",
  });
  bridge.emit({ type: "result", sessionId: "sess-1", outcome: "success", costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
};

function failingRun(errorClass: string): Script {
  return (bridge) => {
    bridge.activity?.({ kind: "auth_failure", errorClass, message: "Refused." } as BackendActivityEvent);
    bridge.emit({ type: "result", sessionId: "sess-1", outcome: "error", costUsd: 0, durationMs: 1, numTurns: 1, isError: true });
  };
}

describe("/api/status's subscription", () => {
  test("has every field, and never the token", async () => {
    const at = host();
    const minted = daysBefore(10);
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [MINTED_AT_ENV]: minted }, subscriptionRun);
    try {
      await turn(app);
      const { raw, subscription } = await status(app);
      expect(raw).not.toContain(FAKE_TOKEN);
      expect(Object.keys(subscription).sort()).toEqual(
        ["expiresAt", "lastAuthFailure", "lastProvenAt", "mintedAt", "provenBy", "tokenSet"].sort()
      );
      expect(subscription.tokenSet).toBe(true);
      expect(subscription.mintedAt).toBe(new Date(minted).toISOString());
      expect(subscription.expiresAt).toBe(new Date(new Date(minted).getTime() + 365 * DAY).toISOString());
      expect(subscription.provenBy).toBe("turn");
      expect(typeof subscription.lastProvenAt).toBe("string");
      expect(subscription.lastAuthFailure).toBeNull();
    } finally {
      await app.close();
    }
  });

  test("the last proof is a successful subscription turn from the store, and survives a new app on the same database", async () => {
    const at = host();
    const first = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, subscriptionRun);
    await turn(first.app);
    const proven = (await status(first.app)).subscription.lastProvenAt;
    await first.app.close();
    expect(proven).not.toBeNull();

    const second = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    try {
      const { subscription } = await status(second.app);
      expect(subscription.lastProvenAt).toBe(proven);
      expect(subscription.provenBy).toBe("turn");
    } finally {
      await second.app.close();
    }
  });

  test("the last proof outlives the span detail, even when nothing read it first", async () => {
    const at = host();
    const first = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, subscriptionRun);
    await turn(first.app);
    const ended = (first.app.db.query("SELECT MAX(ended_at) AS at FROM activity_spans").get() as { at: number }).at;
    // What detail retention does to a digested run after its window, before
    // any status request or hourly pass has looked.
    first.app.db.run("DELETE FROM activity_spans");
    await first.app.close();

    const second = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    try {
      expect((await status(second.app)).subscription.lastProvenAt).toBe(new Date(ended).toISOString());
    } finally {
      await second.app.close();
    }
  });

  test("a proof recorded before this version is kept at boot, before retention can prune it", async () => {
    const at = host();
    const first = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, subscriptionRun);
    await turn(first.app);
    const ended = (first.app.db.query("SELECT MAX(ended_at) AS at FROM activity_spans").get() as { at: number }).at;
    // As an older server leaves it: the span, and nothing kept.
    first.app.db.run("DELETE FROM settings WHERE key = ?", [LAST_PROVEN_SETTING]);
    await first.app.close();

    const second = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    second.app.db.run("DELETE FROM activity_spans");
    try {
      expect((await status(second.app)).subscription.lastProvenAt).toBe(new Date(ended).toISOString());
    } finally {
      await second.app.close();
    }
  });

  test("a turn that ran on an API key proves nothing about the subscription", async () => {
    const at = host();
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, (bridge) => {
      bridge.activity?.({ kind: "runtime_observed", billing: "api", policy: "subscription" });
      bridge.emit({ type: "result", sessionId: "sess-1", outcome: "success", costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
    });
    try {
      await turn(app);
      expect((await status(app)).subscription.lastProvenAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  for (const [errorClass, action] of [
    ["authentication_failed", "relogin"],
    ["oauth_org_not_allowed", "check_account"],
    ["account_on_hold", "check_account"],
    ["billing_error", "check_account"],
    // Refused before sending: a configuration a new token would not fix.
    ["subscription_required", "check_config"],
  ] as const) {
    test(`a turn failing with ${errorClass} says ${action}, on the status and in one WARN`, async () => {
      const at = host();
      const { app, observability } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, failingRun(errorClass));
      try {
        await turn(app);
        const { subscription } = await status(app);
        expect(subscription.lastAuthFailure).toMatchObject({ errorClass, action, source: "turn" });
        const found = warnings(observability, `failed to authenticate (${errorClass})`);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(SUBSCRIPTION_AUTH_INSTRUCTIONS[action]);
        // The instruction says what to do, in words an operator can act on.
        expect(found[0]).toContain(
          { relogin: "claude setup-token", check_account: "claude.ai", check_config: "apiKeyHelper" }[action]
        );
      } finally {
        await app.close();
      }
    });
  }

  test("a date that does not exist, a zoneless time, or a future date is refused, not misread", () => {
    for (const value of ["2026-02-30", "2025-02-29", "2026-09-23T10:00", "2999-01-01"]) {
      expect(() => parseMintedAt(value, NOW)).toThrow(MINTED_AT_ENV);
    }
    expect(parseMintedAt("2024-02-29", NOW)?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseMintedAt(" 2026-09-23 ", NOW)?.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(parseMintedAt("2026-09-23T10:00+02:00", NOW)?.toISOString()).toBe("2026-09-23T08:00:00.000Z");
  });

  test("a failure on a profile with its own credential is not the subscription's", async () => {
    const at = host();
    const { app, observability } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, (bridge) => {
      bridge.activity?.({ kind: "runtime_observed", billing: "api", policy: "api" });
      failingRun("authentication_failed")(bridge);
    });
    try {
      await turn(app);
      const body = (await (await app.fetch(new Request("http://localhost/api/status"))).json()) as {
        subscription: SubscriptionStatus;
        runtime: { lastAuthFailure?: { action?: string; policy?: string } };
      };
      expect(body.subscription.lastAuthFailure).toBeNull();
      expect(body.runtime.lastAuthFailure).toMatchObject({ errorClass: "authentication_failed", policy: "api" });
      expect(body.runtime.lastAuthFailure?.action).toBeUndefined();
      expect(warnings(observability, SUBSCRIPTION_AUTH_INSTRUCTIONS.relogin)).toEqual([]);
      expect(warnings(observability, "Check that profile's credential")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test("a runtime message that quotes the token does not carry it onto the status", async () => {
    const at = host();
    const { app, observability } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, (bridge) => {
      bridge.activity?.({
        kind: "auth_failure",
        errorClass: "authentication_failed",
        message: `401 for Bearer ${FAKE_TOKEN} (token ${FAKE_TOKEN})`,
      } as BackendActivityEvent);
      bridge.emit({ type: "result", sessionId: "sess-1", outcome: "error", costUsd: 0, durationMs: 1, numTurns: 1, isError: true });
    });
    try {
      await turn(app);
      const { raw, subscription } = await status(app);
      expect(subscription.lastAuthFailure?.message).toContain("[redacted]");
      expect(raw).not.toContain(FAKE_TOKEN);
      expect(raw).not.toContain(FAKE_TOKEN.slice(0, 30));
      for (const entry of observability.logs.find({})) expect(JSON.stringify(entry)).not.toContain(FAKE_TOKEN);
    } finally {
      await app.close();
    }
  });

  test("a profile credential of another shape is redacted too", async () => {
    const otherKey = `sk-or-v1-${"0".repeat(64)}`;
    const opaque = "q".repeat(40);
    const at = host();
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, (bridge) => {
      bridge.activity?.({ kind: "runtime_observed", billing: "api", policy: "api" });
      bridge.activity?.({
        kind: "auth_failure",
        errorClass: "authentication_failed",
        message: `Invalid API key: ${otherKey}; x-api-key: abc123; token ${opaque}`,
      } as BackendActivityEvent);
      bridge.emit({ type: "result", sessionId: "sess-1", outcome: "error", costUsd: 0, durationMs: 1, numTurns: 1, isError: true });
    });
    try {
      await turn(app);
      const { raw } = await status(app);
      expect(raw).toContain("Invalid API key");
      // Nor in the run's own record, which the activity views serve.
      const events = JSON.stringify(app.db.query("SELECT * FROM activity_events").all());
      for (const text of [raw, events]) {
        for (const secret of [otherKey, "abc123", opaque]) expect(text).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });

  test("the last proof is the last successful root turn: a later failed one does not move it", async () => {
    const at = host();
    let fail = false;
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, (bridge) => {
      bridge.activity?.({ kind: "runtime_observed", billing: "subscription", policy: "subscription" });
      bridge.emit({ type: "result", sessionId: "sess-1", outcome: fail ? "error" : "success", costUsd: 0, durationMs: 1, numTurns: 1, isError: fail });
    });
    try {
      await turn(app);
      const proven = (await status(app)).subscription.lastProvenAt;
      expect(proven).not.toBeNull();
      await Bun.sleep(5);
      fail = true;
      await turn(app);
      expect((await status(app)).subscription.lastProvenAt).toBe(proven);
    } finally {
      await app.close();
    }
  });

  test("model discovery's proof and refusal reach the route", async () => {
    const state: ReturnType<BackendModelSource["state"]> = { enabled: true, refreshedAt: null, stale: false };
    const source: BackendModelSource = { list: () => [], state: () => state, ensureFresh: async () => {}, refresh: async () => {} };
    const at = host();
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, undefined, undefined, source);
    try {
      state.subscriptionProvenAt = Date.parse("2026-09-20T10:00:00Z");
      expect((await status(app)).subscription).toMatchObject({
        lastProvenAt: "2026-09-20T10:00:00.000Z",
        provenBy: "model_discovery",
      });
      state.subscriptionRefused = { status: 401, at: Date.parse("2026-09-21T10:00:00Z") };
      expect((await status(app)).subscription.lastAuthFailure).toMatchObject({
        action: "relogin",
        source: "model_discovery",
        at: "2026-09-21T10:00:00.000Z",
      });
    } finally {
      await app.close();
    }
  });

  test("only a root turn counts, not a later successful child or cron span", async () => {
    const at = host();
    const { app } = await boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, subscriptionRun);
    try {
      await turn(app);
      const proven = (await status(app)).subscription.lastProvenAt;
      expect(proven).not.toBeNull();
      const later = Date.parse(proven!) + 60_000;
      const attrs = JSON.stringify({ "brain.billing_observed": "subscription" });
      const insert = app.db.prepare(
        `INSERT INTO activity_spans (span_id, run_id, parent_span_id, name, kind, origin, attrs, started_at, ended_at, outcome, writer)
         VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 'success', 'test')`
      );
      insert.run("child", "run-x", "run-x:turn", "turn", "session", attrs, later, later);
      insert.run("job", "run-y", null, "cron", "cron", attrs, later, later);
      expect((await status(app)).subscription.lastProvenAt).toBe(proven);
    } finally {
      await app.close();
    }
  });

  test("an unparseable mint date refuses boot, naming the variable", async () => {
    const at = host();
    await expect(boot(at, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [MINTED_AT_ENV]: "last spring" })).rejects.toThrow(MINTED_AT_ENV);
  });
});

describe("model discovery on the subscription token", () => {
  function discovery(respond: (req: Request) => Response) {
    const observability = createRecordingObservability();
    const logged: string[] = [];
    const source = createModelSource({
      brainPath: tempDir("discovery-brain-"),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
        respond(new Request(input, init))) as typeof fetch,
      log: (level, message) => {
        if (level === "warn") logged.push(message);
      },
    });
    const db = createUiDb(":memory:");
    const monitor = createSubscriptionMonitor({
      config: { tokenSet: true, mintedAt: daysBefore(10) },
      log: observability.logger("agent"),
      db,
      lastTurnFailure: () => undefined,
      modelSource: async () => source,
    });
    return {
      source,
      monitor,
      logged,
      close: () => {
        monitor.close();
        db.close();
      },
    };
  }

  test("a successful call with the OAuth token is a proof", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const seen: Array<string | null> = [];
    const d = discovery((req) => {
      seen.push(req.headers.get("authorization"));
      return Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Opus" }], has_more: false });
    });
    await d.source.refresh();
    const s = await d.monitor.status();
    expect(seen[0]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(s.provenBy).toBe("model_discovery");
    expect(s.lastProvenAt).not.toBeNull();
    d.close();
  });

  for (const [name, respond] of [
    ["a 429", () => new Response("{}", { status: 429 })],
    ["a 404", () => new Response("{}", { status: 404 })],
    ["a 200 with no roster", () => Response.json({ unexpected: true })],
  ] as const) {
    test(`${name} proves nothing`, async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
      const d = discovery(respond);
      await d.source.refresh().catch(() => {});
      expect((await d.monitor.status()).lastProvenAt).toBeNull();
      d.close();
    });
  }

  test("a 401 says relogin, on the status and in one WARN", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
    const d = discovery(() => new Response("{}", { status: 401 }));
    await d.source.refresh().catch(() => {});
    const s = await d.monitor.status();
    expect(s.lastAuthFailure).toMatchObject({
      errorClass: "authentication_failed",
      action: "relogin",
      source: "model_discovery",
      status: 401,
    });
    expect(d.logged.filter((line) => line.includes(SUBSCRIPTION_AUTH_INSTRUCTIONS.relogin))).toHaveLength(1);
    expect(s.lastProvenAt).toBeNull();
    d.close();
  });
});

describe(`${MINTED_AT_ENV}`, () => {
  test("never reaches a turn's environment", async () => {
    process.env[MINTED_AT_ENV] = "2026-09-23";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
    let env: Record<string, string | undefined> | undefined;
    const queryFn = ((params: { options?: { env?: Record<string, string | undefined> } }) => {
      env = params.options?.env;
      return (async function* () {})();
    }) as unknown as NonNullable<Parameters<typeof createClaudeBackend>[0]["queryFn"]>;
    await createClaudeBackend({ brainPath: tempDir("minted-brain-"), queryFn })
      .startTurn({
        prompt: "hi",
        signal: new AbortController().signal,
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) },
      })
      .catch(() => {});
    expect(env).toBeDefined();
    // The same process environment does carry the token the turn needs.
    expect(env!.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(env![MINTED_AT_ENV]).toBeUndefined();
    for (const audience of ["agent", "brainCli", "cron"] as const) {
      expect(filterSubprocessEnv({ [MINTED_AT_ENV]: "2026-09-23" }, audience)[MINTED_AT_ENV]).toBeUndefined();
    }
  });
});
