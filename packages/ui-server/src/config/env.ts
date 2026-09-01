/**
 * The package's ONLY `process.env` reader.
 *
 * Everything `@schlessera/brain-ui-server` can be configured with is declared
 * here twice: once as a runtime descriptor ({@link ENV_VARS}, the artifact the
 * env-parity gate diffs against the documentation) and once as the resolver
 * ({@link resolveServerConfig}) that turns an environment into a plain,
 * fully-resolved {@link ServerConfig}.
 *
 * `createApp()` resolves the environment ONCE, at the edge; every consumer
 * inside the package receives the resolved object (or a slice of it) and never
 * touches `process.env` itself. Tests vary configuration by passing their own
 * env record to the resolver — no global mutation required.
 */

import { join } from "path";

import type { BillingMode } from "@schlessera/brain-ui-sdk/protocol";

import { SEVERITIES, type Severity } from "../observability/types.js";
import { envFlag } from "./env-core.js";
import { WEB_SEARCH_PROVIDERS } from "@schlessera/brain-ui-sdk/server";

// --- descriptor -------------------------------------------------------------

/**
 * The shared descriptor contract (sync-enforced copy in ./env-core.ts),
 * under the name this package has always exported. This package's entries
 * use the `string` arm of `required` for conditionally-required variables
 * (e.g. "AUTH_MODE=password") and `null` for "no default".
 */
/**
 * One environment variable the server reads.
 *
 * Deliberately LOCAL and narrower than env-core's EnvVarSpec: this is the
 * package's published descriptor shape, and widening it to the shared
 * union would be a breaking change for typed consumers of ENV_VARS.
 */
export interface EnvVarDescriptor {
  /** Variable name as it appears in the environment. */
  name: string;
  /** What it controls. */
  description: string;
  /** Human-readable default applied when unset, or null when there is none. */
  default: string | null;
  required: false | string;
}

/**
 * Every environment variable this package reads. Order groups by concern.
 * The env-parity gate (G4) asserts this list equals the package's env
 * documentation in both directions — add here and to the docs together.
 */
export const ENV_VARS: readonly EnvVarDescriptor[] = [
  // core paths / identity
  {
    name: "BRAIN_PATH",
    description: "Path to the brain repo the server operates on.",
    default: "$HOME/brain",
    required: false,
  },
  {
    name: "HOME",
    description:
      "Fallback anchor for the BRAIN_PATH default and the pi config dir (~/.pi).",
    default: "/root",
    required: false,
  },
  {
    name: "PI_CODING_AGENT_DIR",
    description:
      "pi config dir override — where the web-search settings write the " +
      "pi-web-access extension's web-search.json (same precedence the " +
      "extension itself uses).",
    default: "$XDG_CONFIG_HOME/pi, else $HOME/.pi",
    required: false,
  },
  {
    name: "XDG_CONFIG_HOME",
    description: "Second-precedence anchor for the pi config dir ($XDG_CONFIG_HOME/pi).",
    default: null,
    required: false,
  },
  {
    name: "BRAIN_UI_SKILLS_GITHUB_TOKEN",
    description:
      "GitHub token used when installing skills from a private repository " +
      "(Settings → Skills) — typically read-only Contents on the skill " +
      "repos. Falls back to GITHUB_TOKEN.",
    default: "$GITHUB_TOKEN",
    required: false,
  },
  {
    name: "GITHUB_TOKEN",
    description:
      "Generic GitHub token fallback. Used for skill installs when " +
      "BRAIN_UI_SKILLS_GITHUB_TOKEN is unset; the deployment shell also " +
      "falls back to it (from BRAIN_UI_SYNC_GITHUB_TOKEN) for brain-repo " +
      "git pushes and gh-based jobs.",
    default: null,
    required: false,
  },
  {
    name: "DB_PATH",
    description: "SQLite file for the UI's own database (sessions, passkeys, settings).",
    default: "./brain-ui.db",
    required: false,
  },
  {
    name: "HOST",
    description:
      "Bind host; consulted by the auth validation to decide whether AUTH_MODE=none is loopback-safe.",
    default: "(empty)",
    required: false,
  },
  {
    name: "BRAIN_UI_CONFIRM_BASH",
    description:
      "JSON array of regex sources; a Bash command matching any of them raises " +
      "a confirmation card before it runs. Unset uses the shipped defaults " +
      "(brain archive, rm -r, git push --force, git reset --hard, git clean -f, " +
      "git checkout -- ). An empty array [] disables the confirmation. Not a " +
      "security boundary — an agent with Bash can reach the same effect another " +
      "way; it stops a destructive command you did not intend, not one that is " +
      "trying to get past you.",
    default: "the shipped pattern set",
    required: false,
  },
  {
    name: "BRAIN_UI_WS_RATE",
    description:
      "Sustained inbound WebSocket frames per second per connection. 0 " +
      "disables metering entirely.",
    default: "20",
    required: false,
  },
  {
    name: "BRAIN_UI_WS_BURST",
    description:
      "Inbound WebSocket frames absorbable in one burst before the sustained " +
      "rate applies. Opening the app legitimately fires several at once.",
    default: "60",
    required: false,
  },
  {
    name: "BRAIN_UI_LOG_LEVEL",
    description:
      "Minimum severity the console log consumer emits: TRACE, DEBUG, INFO, " +
      "WARN, ERROR or FATAL. Case-insensitive; an unrecognised value falls " +
      "back to the default rather than silencing the server.",
    default: "INFO",
    required: false,
  },
  {
    name: "SOURCE_COMMIT",
    description: "Git SHA reported by /api/status (baked at image build time).",
    default: "dev",
    required: false,
  },
  {
    name: "ALLOWED_ORIGINS",
    description:
      "Comma-separated cross-origin allowlist for a split client/API topology; empty means same-origin only.",
    default: "(empty)",
    required: false,
  },
  {
    name: "MAX_CONCURRENT_SESSIONS",
    description: "Cap on concurrently RUNNING agent sessions.",
    default: "3",
    required: false,
  },
  {
    name: "BRAIN_UI_TURN_TIMEOUT_MS",
    description:
      "Hard per-turn timeout in ms; the host aborts a turn that runs past it. Raise for agent-heavy research work (e.g. 1800000 for 30 minutes).",
    default: "600000 (10 minutes)",
    required: false,
  },
  // auth
  {
    name: "AUTH_MODE",
    description:
      "Authentication mode: password | tailscale | proxy | none. Unset auto-detects (password when a hash is set, else tailscale).",
    default: "(auto-detect)",
    required: false,
  },
  {
    name: "BRAIN_UI_PASSWORD_HASH",
    description: "Bun.password argon2id hash of the shared password.",
    default: null,
    required: "AUTH_MODE=password",
  },
  {
    name: "COOKIE_SECRET",
    description: "Secret signing the session cookie.",
    default: null,
    required: "AUTH_MODE=password",
  },
  {
    name: "TRUST_PROXY",
    description:
      'Set "1" to trust x-forwarded-for/x-real-ip and the proxy auth header; only safe behind a trusted reverse proxy.',
    default: "0",
    required: "AUTH_MODE=proxy",
  },
  {
    name: "TRUST_PROXY_HOPS",
    description: "How many trusted proxies front the app (x-forwarded-for parse depth).",
    default: "1",
    required: false,
  },
  {
    name: "PROXY_AUTH_HEADER",
    description: "Header a fronting auth proxy sets for AUTH_MODE=proxy.",
    default: "x-forwarded-user",
    required: false,
  },
  {
    name: "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
    description:
      'Set "1" to allow AUTH_MODE=none on a non-loopback host. Every network peer gets full agent access.',
    default: "0",
    required: false,
  },
  {
    name: "BRAIN_UI_ALLOW_PASSWORD",
    description:
      'Set "1" to keep password login enabled after a passkey exists for the RP (break-glass recovery).',
    default: "0",
    required: false,
  },
  // WebAuthn / passkeys
  {
    name: "WEBAUTHN_RP_NAME",
    description: "Relying-party display name shown by authenticators.",
    default: "Brain UI",
    required: false,
  },
  {
    name: "WEBAUTHN_USER_NAME",
    description: "WebAuthn user name shown by authenticators.",
    default: "owner",
    required: false,
  },
  {
    name: "WEBAUTHN_USER_ID",
    description:
      "Stable WebAuthn user handle (wire contract — burned into every resident credential; max 64 bytes; never change it after the first passkey).",
    default: "brain-ui-owner",
    required: false,
  },
  {
    name: "WEBAUTHN_RP_ID",
    description: "Relying-party id override for proxies that rewrite Host.",
    default: "(derived from the request origin)",
    required: false,
  },
  {
    name: "WEBAUTHN_ORIGINS",
    description: "Comma-separated extra origins allowed for WebAuthn ceremonies.",
    default: "(empty)",
    required: false,
  },
  {
    name: "BRAIN_UI_ALLOW_LOOPBACK_ORIGIN",
    description:
      'Set "1" to accept loopback Origins for WebAuthn regardless of Host (dev-only, for the vite proxy).',
    default: "0",
    required: false,
  },
  // agent backend
  {
    name: "AGENT_BACKEND",
    description: 'Primary agent backend: "claude" (default) or "pi".',
    default: "claude",
    required: false,
  },
  {
    name: "CLAUDE_CODE_PATH",
    description: "Path to the Claude Code native binary handed to the Agent SDK.",
    default: "/usr/local/bin/claude",
    required: false,
  },
  {
    name: "BRAIN_UI_CLAUDE_DEFAULT_MODEL",
    description: "Model the built-in default Claude profile is pinned to.",
    default: "claude-sonnet-4-6",
    required: false,
  },
  {
    name: "BRAIN_UI_CLAUDE_PROFILES",
    description:
      "JSON array of extra Anthropic-compatible inference profiles ({id,label,model?,baseUrl?,authTokenEnv?,apiKeyEnv?,modelAliases?}).",
    default: "(none)",
    required: false,
  },
  {
    name: "BRAIN_UI_PI_PROFILES",
    description:
      "JSON array of pi-backend model profiles ({id,label,vendor,model,thinkingLevel?}). " +
      "When set (and AGENT_BACKEND is claude), the pi backend runs ALONGSIDE " +
      "the Claude backend and these profiles join the picker — e.g. OpenAI " +
      'models under a ChatGPT subscription via vendor "openai-codex".',
    default: "(none)",
    required: false,
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    description:
      "Consulted for PRESENCE only, to classify billing: with it set and no " +
      "ANTHROPIC_API_KEY, ambient-credential Claude profiles (the built-in " +
      "default and discovered models) count as subscription-billed. The token " +
      "itself is consumed by the Claude backend / Agent SDK, not this package.",
    default: null,
    required: false,
  },
  {
    name: "ANTHROPIC_API_KEY",
    description:
      "Consulted for PRESENCE only, to classify billing: when set it wins " +
      "over CLAUDE_CODE_OAUTH_TOKEN (mirroring the Agent SDK's credential " +
      "precedence), so ambient-credential profiles count as api-billed.",
    default: null,
    required: false,
  },
  {
    name: "BRAIN_UI_MODEL_DISCOVERY",
    description:
      'Model discovery against the Anthropic Models API; "0"/"off"/"false" disables. Defaults ON, except under a test runner (NODE_ENV=test) where it defaults OFF.',
    default: "on (off under NODE_ENV=test)",
    required: false,
  },
  {
    name: "BRAIN_UI_MODEL_TTL_HOURS",
    description: "How long a model-discovery result stays fresh, in hours.",
    default: "24",
    required: false,
  },
  {
    name: "BRAIN_UI_PRICING_DISCOVERY",
    description:
      'Remote model-pricing refresh (LiteLLM + OpenRouter catalogs); "0"/"off"/"false" disables, and runs then roll up with unknown effective cost. Defaults ON, except under a test runner (NODE_ENV=test) where it defaults OFF.',
    default: "on (off under NODE_ENV=test)",
    required: false,
  },
  {
    name: "BRAIN_UI_PRICING_TTL_HOURS",
    description: "How long a fetched model-pricing table stays fresh, in hours.",
    default: "24",
    required: false,
  },
  {
    name: "NODE_ENV",
    description:
      "Only consulted for test-runner detection: flips the model-discovery and pricing-discovery defaults to off under bun test. Never gates any security behavior.",
    default: "(unset)",
    required: false,
  },
  // voice
  {
    name: "DEEPGRAM_API_KEY",
    description: "Deepgram API key for streaming ASR (short-lived tokens are minted from it).",
    default: null,
    required: "VOICE_PROVIDER=deepgram (or any voice use without VOICE_PROVIDER=webspeech)",
  },
  {
    name: "VOICE_PROVIDER",
    description:
      'Speech provider: "deepgram" or "webspeech" (opt-in only — Chromium streams audio to Google). Unset auto-detects deepgram when its key is present.',
    default: "(auto-detect)",
    required: false,
  },
  {
    name: "VOICE_KEYTERM_LIMIT",
    description: "Maximum custom-vocabulary terms built from the brain database.",
    default: "500",
    required: false,
  },
  {
    name: "VOICE_CACHE_DIR",
    description: "Directory holding the keyterm cache JSON.",
    default: "$BRAIN_PATH/.brain-ui",
    required: false,
  },
] as const;

// --- resolved configuration --------------------------------------------------

export type AuthModeName = "password" | "tailscale" | "proxy" | "none";

export interface AuthConfig {
  /** Validated AUTH_MODE, or null to auto-detect. */
  mode: AuthModeName | null;
  /** The raw AUTH_MODE value when it did not validate (for the boot warning). */
  invalidMode: string | null;
  passwordHash: string | null;
  cookieSecret: string | null;
  trustProxy: boolean;
  trustProxyHops: number;
  /** Lowercased proxy auth header name. */
  proxyAuthHeader: string;
  dangerouslyDisableAuth: boolean;
  allowPassword: boolean;
}

export interface WebAuthnConfig {
  rpName: string;
  userName: string;
  userId: string;
  rpId: string | null;
  origins: string[];
  allowLoopbackOrigin: boolean;
}

export interface AgentConfig {
  /** Trimmed, lowercased AGENT_BACKEND; null when unset (defaults to claude). */
  backend: string | null;
  /**
   * Bash-confirmation regex sources; null means "use the backend's defaults".
   * An empty array is a deliberate opt-out and is passed through as such.
   */
  confirmBashPatterns: string[] | null;
  claudeCodePath: string;
  defaultModel: string;
  /** Raw BRAIN_UI_CLAUDE_PROFILES JSON, parsed lazily by the registry. */
  profilesJson: string | null;
  /**
   * Raw BRAIN_UI_PI_PROFILES JSON, parsed by the registry. When set, the pi
   * backend runs alongside the Claude backend and these profiles join the
   * picker.
   */
  piProfilesJson: string | null;
  modelDiscovery: boolean;
  modelTtlMs: number;
  /**
   * Billing classification for profiles running on AMBIENT credentials (the
   * built-in default and discovered models): "subscription" iff the
   * environment holds a CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY —
   * the same precedence the Agent SDK applies — else "api". Declared profiles
   * carrying their own credential env vars are classified "api" by the
   * registry regardless of this value.
   */
  ambientBilling: BillingMode;
}

export interface VoiceConfig {
  /** Trimmed, lowercased VOICE_PROVIDER; null when unset (auto-detect). */
  provider: string | null;
  deepgramApiKey: string | null;
  keytermLimit: number;
  /** Resolved keyterm cache directory. */
  cacheDir: string;
}

/** Fully-resolved server configuration. Plain data — safe to construct in tests. */
export interface ServerConfig {
  brainPath: string;
  dbPath: string;
  /** Bind host, for the loopback check in auth validation. Empty when unset. */
  host: string;
  sourceCommit: string;
  allowedOrigins: string[];
  maxConcurrentSessions: number;
  /**
   * Per-turn timeout in ms (BRAIN_UI_TURN_TIMEOUT_MS), or null to use the
   * WsHost default (10 minutes). An explicit createApp option still wins.
   */
  turnTimeoutMs: number | null;
  /** Threshold for the console log consumer (BRAIN_UI_LOG_LEVEL). */
  logLevel: Severity;
  /** Inbound WebSocket frame metering, per connection. */
  wsRate: { ratePerSecond: number; burst: number };
  auth: AuthConfig;
  webauthn: WebAuthnConfig;
  agent: AgentConfig;
  voice: VoiceConfig;
  /** Model-pricing service (BRAIN_UI_PRICING_*); inline like wsRate. */
  pricing: { enabled: boolean; ttlMs: number };
}

// --- resolver ----------------------------------------------------------------

type EnvRecord = Record<string, string | undefined>;

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A log threshold, defaulting to INFO.
 *
 * An unrecognised value falls back rather than throwing: a typo in a log level
 * must never be the reason a server refuses to boot, and silently emitting
 * nothing would be worse than emitting too much.
 */
/** A non-negative number, falling back rather than throwing on nonsense. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Parse BRAIN_UI_CONFIRM_BASH into pattern sources.
 *
 * Unset or unparseable → null, meaning the backend's shipped defaults. An
 * explicit `[]` is honoured as "no confirmation": disabling the seatbelt is a
 * choice a deployment is allowed to make, and silently re-enabling it would be
 * worse than obeying. Malformed JSON falls back to the defaults rather than
 * throwing — a typo here must not stop the server booting, and the safe
 * direction to fail is "more confirmation", not less.
 */
function parseConfirmBash(raw: string | undefined): string[] | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return null;
  }
}

function parseSeverity(raw: string | undefined): Severity {
  const upper = raw?.trim().toUpperCase();
  return (SEVERITIES as readonly string[]).includes(upper ?? "")
    ? (upper as Severity)
    : "INFO";
}

const AUTH_MODES: readonly AuthModeName[] = ["password", "tailscale", "proxy", "none"];

/**
 * Ambient billing classification from an environment (presence-only reads).
 * The API key wins over the OAuth token — the Agent SDK's own precedence —
 * and no usable credential at all classifies "api" (nothing
 * subscription-billed can run without the token). Exported for the activity
 * store's standalone default, so the cron wrapper classifies from the same
 * predicate the server config does.
 */
export function resolveAmbientBillingMode(env: EnvRecord = process.env): BillingMode {
  return !env.ANTHROPIC_API_KEY?.trim() && env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
    ? "subscription"
    : "api";
}

/**
 * THE derivation of the pricing config (kill switch, TTL, brain path) —
 * consumed by resolveServerConfig and used directly by the cron wrapper's
 * bare `createActivityStore(db)` path, where no ServerConfig exists. Kept
 * here so process.env reads stay in the one chokepoint the env-access gate
 * allows.
 */
export function resolveStandalonePricingConfig(env: EnvRecord = process.env): {
  brainPath: string;
  enabled: boolean;
  ttlMs: number;
} {
  const ttlHours = Number(env.BRAIN_UI_PRICING_TTL_HOURS);
  return {
    brainPath: env.BRAIN_PATH || join(env.HOME || "/root", "brain"),
    enabled: envFlag(env.BRAIN_UI_PRICING_DISCOVERY, env.NODE_ENV !== "test"),
    ttlMs:
      Number.isFinite(ttlHours) && ttlHours > 0
        ? ttlHours * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000,
  };
}

/**
 * Resolve an environment into a {@link ServerConfig}. Defaults to the real
 * process environment; tests pass their own record instead of mutating it.
 */
export function resolveServerConfig(env: EnvRecord = process.env): ServerConfig {
  const { brainPath, enabled: pricingEnabled, ttlMs: pricingTtlMs } =
    resolveStandalonePricingConfig(env);

  const rawAuthMode = env.AUTH_MODE?.trim().toLowerCase() || null;
  const validMode = AUTH_MODES.find((mode) => mode === rawAuthMode) ?? null;

  const modelDiscovery = envFlag(env.BRAIN_UI_MODEL_DISCOVERY, env.NODE_ENV !== "test");

  const rawTtl = Number(env.BRAIN_UI_MODEL_TTL_HOURS);
  const ttlHours = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 24;

  return {
    brainPath,
    dbPath: env.DB_PATH || join(process.cwd(), "brain-ui.db"),
    host: env.HOST ?? "",
    sourceCommit: env.SOURCE_COMMIT ?? "dev",
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    maxConcurrentSessions: Math.max(1, Number(env.MAX_CONCURRENT_SESSIONS) || 3),
    // Positive integer or null — 0, negatives, and garbage all mean "unset",
    // so a typo degrades to the safe default instead of an instant timeout.
    turnTimeoutMs:
      Number.isFinite(Number(env.BRAIN_UI_TURN_TIMEOUT_MS)) &&
      Number(env.BRAIN_UI_TURN_TIMEOUT_MS) > 0
        ? Math.floor(Number(env.BRAIN_UI_TURN_TIMEOUT_MS))
        : null,
    auth: {
      mode: validMode,
      invalidMode: validMode ? null : rawAuthMode,
      passwordHash: env.BRAIN_UI_PASSWORD_HASH || null,
      cookieSecret: env.COOKIE_SECRET || null,
      trustProxy: envFlag(env.TRUST_PROXY, false),
      trustProxyHops: Math.max(1, Number(env.TRUST_PROXY_HOPS) || 1),
      proxyAuthHeader: (env.PROXY_AUTH_HEADER || "x-forwarded-user").toLowerCase(),
      dangerouslyDisableAuth: envFlag(env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH, false),
      allowPassword: envFlag(env.BRAIN_UI_ALLOW_PASSWORD, false),
    },
    webauthn: {
      rpName: env.WEBAUTHN_RP_NAME || "Brain UI",
      userName: env.WEBAUTHN_USER_NAME || "owner",
      userId: env.WEBAUTHN_USER_ID || "brain-ui-owner",
      rpId: env.WEBAUTHN_RP_ID || null,
      origins: list(env.WEBAUTHN_ORIGINS),
      allowLoopbackOrigin: envFlag(env.BRAIN_UI_ALLOW_LOOPBACK_ORIGIN, false),
    },
    agent: {
      backend: env.AGENT_BACKEND?.trim().toLowerCase() || null,
      confirmBashPatterns: parseConfirmBash(env.BRAIN_UI_CONFIRM_BASH),
      claudeCodePath: env.CLAUDE_CODE_PATH || "/usr/local/bin/claude",
      defaultModel: env.BRAIN_UI_CLAUDE_DEFAULT_MODEL?.trim() || "claude-sonnet-4-6",
      profilesJson: env.BRAIN_UI_CLAUDE_PROFILES?.trim() || null,
      piProfilesJson: env.BRAIN_UI_PI_PROFILES?.trim() || null,
      modelDiscovery,
      modelTtlMs: ttlHours * 60 * 60 * 1000,
      ambientBilling: resolveAmbientBillingMode(env),
    },
    logLevel: parseSeverity(env.BRAIN_UI_LOG_LEVEL),
    wsRate: {
      ratePerSecond: positiveNumber(env.BRAIN_UI_WS_RATE, 20),
      burst: positiveNumber(env.BRAIN_UI_WS_BURST, 60),
    },
    voice: {
      provider: env.VOICE_PROVIDER?.trim().toLowerCase() || null,
      deepgramApiKey: env.DEEPGRAM_API_KEY || null,
      keytermLimit: Number(env.VOICE_KEYTERM_LIMIT || 500),
      cacheDir: env.VOICE_CACHE_DIR || join(brainPath, ".brain-ui"),
    },
    pricing: {
      enabled: pricingEnabled,
      ttlMs: pricingTtlMs,
    },
  };
}

/**
 * The parent environment for spawned subprocesses (brain CLI, whatsup), plus
 * overrides. Child processes legitimately inherit the whole environment
 * (PATH, credentials for the tools they run) — that is process plumbing, not
 * configuration, but it still reads `process.env`, so it lives behind this
 * chokepoint.
 */
export function subprocessEnv(extra: Record<string, string> = {}): EnvRecord {
  return { ...process.env, ...extra };
}

/**
 * The pi config directory, resolved with EXACTLY the precedence pi-web-access
 * uses for its `web-search.json` (PI_CODING_AGENT_DIR, then XDG_CONFIG_HOME/pi,
 * then ~/.pi) — the settings routes write the file the extension reads, so
 * the two resolutions must never diverge.
 */
/**
 * Token for private-repo skill installs, read at call time. Specialized
 * variable first, generic fallback — the deployment-wide pattern is
 * `<specialized>_GITHUB_TOKEN` falling back to `GITHUB_TOKEN`.
 */
export function resolveGitHubToken(env: EnvRecord = process.env): string | undefined {
  return env.BRAIN_UI_SKILLS_GITHUB_TOKEN || env.GITHUB_TOKEN || undefined;
}

export function resolvePiConfigDir(env: EnvRecord = process.env): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pi");
  return join(env.HOME || "/root", ".pi");
}

/**
 * The environment the web-search surface reads: the variables that locate the
 * extension's `web-search.json`, plus each provider's API-key variable.
 *
 * PRESENCE is all anything does with the key values — they are never logged,
 * returned over the API, or copied into the config file. Reading them here
 * keeps the rest of the package taking configuration as a value.
 */
export function resolveWebSearchEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const names = [
    "PI_CODING_AGENT_DIR",
    "XDG_CONFIG_HOME",
    "HOME",
    ...WEB_SEARCH_PROVIDERS.map((p) => p.envVar).filter((n): n is string => Boolean(n)),
  ];
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}
