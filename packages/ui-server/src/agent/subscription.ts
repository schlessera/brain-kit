/**
 * The Claude subscription token, as the operator needs to see it (#254,
 * docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * The token is minted off the host with `claude setup-token` and lives in the
 * host's secret store; rotating it is a redeploy. It is opaque, so its expiry
 * cannot be read from it: the operator records the mint date next to it, and
 * the measured `setup-token` lifetime (one year) gives the expiry. The server
 * warns before that date, says when the token last worked, and turns every
 * auth failure into an instruction.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import {
  SUBSCRIPTION_RELOGIN_PROCEDURE,
  type BackendModelSourceState,
  type SubscriptionAuthAction,
} from "@schlessera/brain-ui-sdk/server";

import type { RuntimeStatus } from "../activity/runtime-status.js";
import type { SubscriptionConfig } from "../config/env.js";
import { getSetting, setSetting } from "../db/settings.js";

export const MINTED_AT_ENV = "BRAIN_UI_CLAUDE_TOKEN_MINTED_AT";

const DAY_MS = 24 * 60 * 60 * 1000;
/** `claude setup-token`'s default lifetime, 31536000 s, as measured (#183). */
export const TOKEN_LIFETIME_MS = 365 * DAY_MS;
/** How far ahead of expiry the warning starts. */
export const EXPIRY_WARNING_MS = 30 * DAY_MS;
/** At most one expiry warning per this interval while the server runs. */
const WARNING_INTERVAL_MS = DAY_MS;

/** A calendar date, or a date and time with an explicit zone. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * The mint date as the operator wrote it, or null when unset. Anything that
 * is not a real ISO 8601 date refuses boot — a day that does not exist, a
 * time with no zone, a date in the future — because a date silently ignored
 * or misread would move the expiry warning or switch it off.
 */
export function parseMintedAt(raw: string | null, now: Date = new Date()): Date | null {
  if (raw === null) return null;
  const value = raw.trim();
  const refuse = (why: string): never => {
    throw new Error(
      `${MINTED_AT_ENV} must be the ISO 8601 date the Claude subscription token was minted ` +
        `(for example 2026-09-23); got ${JSON.stringify(raw)}: ${why}. The expiry warning counts from it.`
    );
  };
  const match = ISO_DATE.exec(value);
  if (!match) return refuse("not a date, or a time without a zone");
  const [, year, month, day] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day)
  ) {
    return refuse("that day does not exist");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return refuse("not a valid time");
  // A day of slack for time zones; anything later is a typo.
  if (date.getTime() > now.getTime() + DAY_MS) return refuse("it is in the future");
  return date;
}

/** What `/api/status` says about the subscription. Never the token itself. */
export interface SubscriptionStatus {
  tokenSet: boolean;
  mintedAt: string | null;
  expiresAt: string | null;
  /** When the token last demonstrably worked. */
  lastProvenAt: string | null;
  provenBy: "turn" | "model_discovery" | null;
  /** The latest auth failure, with what to do about it. */
  lastAuthFailure:
    | {
        errorClass: string;
        at: string;
        action: SubscriptionAuthAction;
        source: "turn" | "model_discovery";
        runId?: string;
        message?: string;
        status?: number;
      }
    | null;
}

export interface SubscriptionMonitorOptions {
  config: SubscriptionConfig;
  log: Logger;
  /** The app's database, where turns are recorded. */
  db: Database;
  /** The last auth failure of a turn that ran on the subscription. */
  lastTurnFailure: () => ReturnType<RuntimeStatus["subscriptionAuthFailure"]>;
  /** The Claude backend's model discovery, when it runs. */
  modelSource: () => Promise<{ state(): BackendModelSourceState } | null>;
  now?: () => Date;
  /** Runs `check` every `ms`; returns the cancel. Defaults to an unref'd interval. */
  every?: (check: () => void, ms: number) => () => void;
}

export interface SubscriptionMonitor {
  /** The hourly pass: keeps the last proof, and warns about expiry at most once a day. */
  tick(): void;
  status(): Promise<SubscriptionStatus>;
  close(): void;
}

/** Where the last proof is kept once it is read, so detail retention cannot take it. */
export const LAST_PROVEN_SETTING = "subscription.lastProvenTurnAt";

/**
 * The last successful root turn that ran on the subscription, from the
 * activity store: it survives a restart, unlike anything held in memory. The
 * store prunes span detail after its retention window, so every read also
 * keeps the answer in the settings table, and the later of the two wins.
 */
export function lastSubscriptionTurnAt(db: Database): number | null {
  const row = db
    .query(
      `SELECT MAX(ended_at) AS at FROM activity_spans
       WHERE parent_span_id IS NULL AND kind = 'turn' AND outcome = 'success'
         AND json_extract(attrs, '$."brain.billing_observed"') = 'subscription'`
    )
    .get() as { at: number | null } | null;
  const fromSpans = row?.at ?? null;
  const kept = getSetting<number | null>(db, LAST_PROVEN_SETTING, null);
  if (fromSpans !== null && (kept === null || fromSpans > kept)) {
    setSetting(db, LAST_PROVEN_SETTING, fromSpans);
    return fromSpans;
  }
  return kept;
}

/**
 * Validates the configuration (throwing refuses the boot), logs the boot
 * warnings, and starts the daily expiry check.
 */
export function createSubscriptionMonitor(options: SubscriptionMonitorOptions): SubscriptionMonitor {
  const { config, log } = options;
  const now = options.now ?? (() => new Date());
  const mintedAt = parseMintedAt(config.mintedAt, now());
  const expiresAt = mintedAt ? new Date(mintedAt.getTime() + TOKEN_LIFETIME_MS) : null;
  let lastWarnedAt: number | null = null;

  /** The hourly pass: keep the proof ahead of retention, then the expiry check. */
  function hourly(): void {
    lastSubscriptionTurnAt(options.db);
    checkExpiry();
  }

  function checkExpiry(): void {
    if (!config.tokenSet || !expiresAt) return;
    const at = now().getTime();
    const left = expiresAt.getTime() - at;
    if (left > EXPIRY_WARNING_MS) return;
    if (lastWarnedAt !== null && at - lastWarnedAt < WARNING_INTERVAL_MS) return;
    lastWarnedAt = at;
    const when = expiresAt.toISOString().slice(0, 10);
    log.emit({
      severityText: "WARN",
      body:
        (left <= 0
          ? `The Claude subscription token expired on ${when}. `
          : `The Claude subscription token expires on ${when}, in ${Math.ceil(left / DAY_MS)} days. `) +
        SUBSCRIPTION_RELOGIN_PROCEDURE,
      attributes: { "subscription.expires_at": expiresAt.toISOString(), "auth.action": "relogin" },
    });
  }

  if (config.tokenSet && !mintedAt) {
    log.emit({
      severityText: "WARN",
      body:
        "CLAUDE_CODE_OAUTH_TOKEN is set without its mint date, so the server cannot warn before the token " +
        `expires. Set ${MINTED_AT_ENV} to the date the token was minted.`,
      attributes: { "config.variable": MINTED_AT_ENV },
    });
  }
  checkExpiry();

  const every =
    options.every ??
    ((check: () => void, ms: number) => {
      const timer = setInterval(check, ms);
      // A closed test app must not be kept alive by it.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      return () => clearInterval(timer);
    });
  const cancel = every(hourly, 60 * 60 * 1000);

  return {
    tick: hourly,
    async status() {
      const discovery = await options
        .modelSource()
        .then((source) => source?.state() ?? null)
        .catch(() => null);
      const turnAt = lastSubscriptionTurnAt(options.db);
      const discoveredAt = discovery?.subscriptionProvenAt ?? null;
      const proven =
        turnAt === null && discoveredAt === null
          ? null
          : (turnAt ?? -Infinity) >= (discoveredAt ?? -Infinity)
            ? { at: turnAt!, by: "turn" as const }
            : { at: discoveredAt!, by: "model_discovery" as const };

      const turnFailure = options.lastTurnFailure();
      const refused = discovery?.subscriptionRefused;
      const failures: NonNullable<SubscriptionStatus["lastAuthFailure"]>[] = [];
      if (turnFailure) {
        const { policy: _policy, ...failure } = turnFailure;
        failures.push({ ...failure, source: "turn" });
      }
      if (refused) {
        failures.push({
          errorClass: "authentication_failed",
          at: new Date(refused.at).toISOString(),
          action: "relogin",
          source: "model_discovery",
          status: refused.status,
        });
      }
      failures.sort((a, b) => b.at.localeCompare(a.at));

      return {
        tokenSet: config.tokenSet,
        mintedAt: mintedAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        lastProvenAt: proven ? new Date(proven.at).toISOString() : null,
        provenBy: proven?.by ?? null,
        lastAuthFailure: failures[0] ?? null,
      };
    },
    close() {
      cancel();
    },
  };
}
