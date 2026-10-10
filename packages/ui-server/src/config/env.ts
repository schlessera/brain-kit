import type { InboxBudgetConfig } from "../inbox/budget.js";
import { type AskUserFormLimits } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resolveAskUserFormLimits } from "@schlessera/brain-ui-sdk/internal/client";
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

import { join, resolve } from "path";
import { isThinkingLevel, type ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";

import { CRON_CONTROL_ENV_NAMES } from "../cron/emit.js";

import { SEVERITIES, type Severity } from "../observability/types.js";
import { envFlag, type DynamicEnvReadSpec } from "./env-core.js";
import {
  type ConfirmPatternSource,
  type ExecWrapperConfig,
  geoConfigSchema,
  type GeoConfigInput,
} from "@schlessera/brain-ui-sdk/server";
import { validateExecWrapper, WEB_SEARCH_PROVIDERS } from "@schlessera/brain-ui-sdk/internal";
import {
  filterSubprocessEnv,
  parseSubprocessEnvExtra,
  type SubprocessEnvAudience,
} from "@schlessera/brain-ui-sdk/internal";

// --- descriptor -------------------------------------------------------------

/**
 * The model the built-in Claude profile is pinned to when
 * `BRAIN_UI_CLAUDE_DEFAULT_MODEL` is unset. Written once: the descriptor
 * documents it and the resolver applies it, and they used to be two literals.
 */
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

function parseDefaultThinkingLevel(raw: string | undefined): ThinkingLevel {
  const value = raw?.trim() || "medium";
  if (!isThinkingLevel(value)) throw new Error("BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL is not a thinking level.");
  return value;
}

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
  { name: "BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY", required: false, default: "5", description: "Admission cap for non-subscription autonomous spend, including active reservations. Invalid values fail startup." },
  { name: "BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY", required: false, default: "0", description: "Daily model-bearing autonomous operation cap. Zero pauses admission until explicitly configured. Invalid values fail startup." },
  { name: "BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD", required: false, default: "0", description: "Bounded daily emergency spend reserve for explicitly eligible server-selected work. Invalid values fail startup." },
  { name: "BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS", required: false, default: "0", description: "Bounded daily emergency autonomous operation reserve. Invalid values fail startup." },
  { name: "BRAIN_UI_AUTONOMOUS_TIMEZONE", required: false, default: "UTC", description: "IANA timezone for autonomous admission days; each reservation keeps its admission day. Invalid values fail startup." },
  { name: "BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN", required: false, default: "0.01", description: "Positive pessimistic rate for unpriced autonomous API tokens; missing usage retains the reservation. Invalid values fail startup." },
  { name: "BRAIN_UI_ASK_USER_FORM_MAX_DEPTH", required: false, default: "3", description: "Conditional form maximum depth (roots count as one). Invalid values fail startup." },
  { name: "BRAIN_UI_ASK_USER_FORM_MAX_NODES", required: false, default: "12", description: "Conditional form maximum node count. Invalid values fail startup." },
  { name: "BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS", required: false, default: "8", description: "Conditional form maximum options per choice or scale node. Invalid values fail startup." },

  {
    name: "BRAIN_UI_EXEC_KILLER",
    description:
      "Absolute path to an authorised helper that cancels a wrapped process " +
      "group, invoked as `<killer> <pgid> <TERM|KILL|INT>`. Needed only when " +
      "the wrapper changes uid: signalling then fails with EPERM however the " +
      "group is arranged, and an aborted request would keep running.",
    default: "(none — signal the group directly)",
    required: false,
  },
  {
    name: "BRAIN_UI_EXEC_WRAPPER",
    description:
      "Absolute path to an executable every agent and brain-CLI subprocess is " +
      "launched through, as `<wrapper> <program> <args…>`. Lets a host run " +
      "those children as another user without this package knowing how. It is " +
      "an argv[0], never a command line: no shell parses it. Unset, spawns are " +
      "exactly what they were.",
    default: "(none — spawn the program directly)",
    required: false,
  },
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
    name: "BRAIN_UI_CRON_HYGIENE",
    description:
      "Whether the generated crontab schedules the weekly `hygiene` job " +
      "(Mondays 06:00), which runs `brain hygiene reconcile` through the cron " +
      "wrapper: it refreshes the content-hygiene log's backlog and last-run " +
      "date and edits no content. Set to a false token (0, false, off, no) to " +
      "leave the job out.",
    default: "on",
    required: false,
  },
  {
    name: "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
    description:
      "Comma-separated environment variable names to admit to every child " +
      "audience when an operator integration needs a variable outside the " +
      "shipped allowlist. Names are trimmed; malformed entries are ignored; " +
      "the control variable itself is never forwarded.",
    default: "(empty)",
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
    description:
      "SQLite file for the UI's own database (sessions, passkeys, settings). " +
      "The server factory defaults to ./brain-ui.db; brain-ui-cron defaults " +
      "to the container path /data/db/brain-ui.db.",
    default: "./brain-ui.db (server); /data/db/brain-ui.db (brain-ui-cron)",
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
    name: "BRAIN_UI_INBOX_POKE_TOKEN_FILE",
    description:
      "Absolute runtime token-file path for the protected internal inbox poke. " +
      "Provision a private directory under /run for this app instance. The server " +
      "atomically writes a new 0600 boot token; unset disables poke authorization. " +
      "Does not enable autonomous dispatch.",
    default: "(unset; poke unavailable)",
    required: false,
  },
  {
    name: "BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS",
    description:
      "Comma-separated HTTPS origins (at most 16) of the model connection scheduled work would use. " +
      "Operators review this audience with every schedule; unset refuses schedule proposals " +
      "(unsupported_capability). Does not enable dispatch.",
    default: "(unset; schedule proposals refused)",
    required: false,
  },
  {
    name: "MAX_AUTONOMOUS_RUNS",
    description: "Maximum in-flight autonomous operations. Interactive sessions retain their separate capacity; this does not enable dispatch.",
    default: "2",
    required: false,
  },
  {
    name: "BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS",
    description: "Continuous same-target interactive wait before an autonomous holder checkpoints and yields. Positive integer below 30000.",
    default: "20000",
    required: false,
  },
  {
    name: "BRAIN_UI_CONFIRM_BASH",
    description:
      "JSON array of regex sources, or {\"pattern\", \"effect\"} objects whose " +
      "effect (what the command does, in words) is shown on the card; a Bash " +
      "command matching any of them raises a confirmation card before it runs. " +
      "Unset uses the shipped defaults " +
      "(brain archive, rm -r, git push --force, git reset --hard, git clean -f, " +
      "git checkout -- ). An empty array [] disables the confirmation. A nonempty " +
      "list with no compilable regex fails backend initialization; repair it or " +
      "explicitly use []. Mixed lists report invalid entries and keep valid ones. Not a " +
      "security boundary — an agent with Bash can reach the same effect another " +
      "way; it stops a destructive command you did not intend, not one that is " +
      "trying to get past you.",
    default: "the shipped pattern set",
    required: false,
  },
  {
    name: "BRAIN_UI_WS_MAX_CONNECTIONS",
    description: "Maximum number of WebSocket connections accepted by one server process.",
    default: "32",
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
    name: "TYPESAFE_API_KEY",
    description:
      "TypeSafe AI key for the classification pass that draws markdown the model typed as kit blocks (D42). Absent = pass disabled; the answer renders as markdown either way.",
    default: null,
    required: false,
  },
  {
    name: "CLAUDE_CODE_PATH",
    description:
      "Path to a Claude Code binary to run instead of the Agent SDK's built-in one. Unset runs the built-in binary, the version the lockfile pins.",
    default: null,
    required: false,
  },
  {
    name: "BRAIN_UI_CLAUDE_DEFAULT_MODEL",
    description: "Model the built-in default Claude profile is pinned to.",
    default: DEFAULT_CLAUDE_MODEL,
    required: false,
  },
  {
    name: "BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL",
    description: "Default Claude reasoning effort (off, minimal, low, medium, high, xhigh, max). Unsupported levels resolve to a supported choice.",
    default: "medium",
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
      "Subscription token from `claude setup-token`: authenticates every Claude " +
      "profile without its own credential, and model discovery. The Claude " +
      "backend consumes it; this package reads only whether it is set, for " +
      "/api/status. Minted off the host and rotated by redeploy (docs/hosting, " +
      '"Claude subscription login").',
    default: null,
    required: false,
  },
  {
    name: "BRAIN_UI_CLAUDE_TOKEN_MINTED_AT",
    description:
      "The date CLAUDE_CODE_OAUTH_TOKEN was minted (ISO 8601, e.g. 2026-09-23), " +
      "set next to the token in the same redeploy. The server counts the " +
      "token's one-year lifetime from it and warns 30 days before expiry. " +
      "An unparseable date refuses boot. Server-only.",
    default: "no expiry warning (one WARN at boot says so)",
    required: false,
  },
  {
    name: "ANTHROPIC_API_KEY",
    description:
      "Never used by a Claude profile without its own credential: those run " +
      "on the subscription, with this cleared before Claude Code starts. The " +
      "Claude backend uses it for model discovery only when no " +
      "CLAUDE_CODE_OAUTH_TOKEN is set.",
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
      'Speech provider: "deepgram", "webspeech" (opt-in only — Chromium streams audio to Google), or the id supplied through createApp({ speechProvider }). An explicit name must match a supplied value. Unset prefers that value, otherwise auto-detects deepgram when its key is present.',
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
  {
    name: "BRAIN_UI_COASTLINE",
    description:
      '"0"/"off"/"false" stops the server fetching map geometry. Maps then draw ' +
      "their graticule, pins and scale bar with no coastline, which is still an " +
      "accurate locator.",
    default: "enabled",
    required: false,
  },
  {
    name: "OVERPASS_URL",
    description: "Overpass endpoint the map geometry is fetched from.",
    default: "https://overpass-api.de/api/interpreter",
    required: false,
  },
  {
    name: "OVERPASS_USER_AGENT",
    description: "Identifying User-Agent for Overpass (usage-policy requirement).",
    default: "brain-kit-ui/1.0",
    required: false,
  },
  {
    name: "COASTLINE_CACHE_DIR",
    description: "Directory holding fetched map geometry. Cached forever; coastlines do not move.",
    default: "$BRAIN_PATH/.brain-ui/geo",
    required: false,
  },
  {
    name: "BRAIN_GEO_CONFIG_JSON",
    description: "Canonical geo configuration as JSON. Overrides legacy Overpass service settings; BRAIN_UI_COASTLINE=false still prevents requests. Relative response-cache paths resolve from BRAIN_PATH. Invalid JSON/configuration refuses startup.",
    default: null,
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
  confirmBashPatterns: ConfirmPatternSource[] | null;
  /** `CLAUDE_CODE_PATH`; null runs the Agent SDK's built-in binary. */
  claudeCodePath: string | null;
  defaultModel: string;
  defaultThinkingLevel?: ThinkingLevel;
  /** Raw BRAIN_UI_CLAUDE_PROFILES JSON, parsed at boot and again by the registry. */
  profilesJson: string | null;
  /**
   * Raw BRAIN_UI_PI_PROFILES JSON, parsed at boot and again by the registry.
   * When set, the pi backend runs alongside the Claude backend and these
   * profiles join the picker.
   */
  piProfilesJson: string | null;
  modelDiscovery: boolean;
  modelTtlMs: number;
}

/**
 * Map geometry. Fetched on demand and cached permanently, because a coastline
 * does not move and the cache is the whole reason a free shared service can be
 * used politely: one request per place, ever.
 */
export interface CoastlineConfig {
  /** BRAIN_UI_COASTLINE is not falsy (0/false/off/no, case-insensitive). */
  enabled: boolean;
  /** OVERPASS_URL with the public default applied. */
  url: string;
  /** OVERPASS_USER_AGENT with the default applied. */
  userAgent: string;
  /** Resolved geometry cache directory. */
  cacheDir: string;
  /** Optional canonical service/response-cache settings; legacy privacy switch still wins. */
  geo?: GeoConfigInput;
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
  askUserFormLimits?: AskUserFormLimits;
  brainPath: string;
  dbPath: string;
  /** Internal poke provisioning; optional for existing explicit configurations. */
  inbox?: { pokeTokenFile: string | null; budget?: InboxBudgetConfig; maxAutonomousRuns?: number; yieldAfterMs?: number };
  /**
   * Scheduled tasks (BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS): the reviewed model
   * audience. Null or absent refuses schedule proposals.
   */
  schedules?: { inferenceOrigins: string[] | null };
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
  /** Maximum WebSocket connections accepted by one server process. */
  wsMaxConnections: number;
  auth: AuthConfig;
  webauthn: WebAuthnConfig;
  agent: AgentConfig;
  /** The classification pass (D42): enabled only with a key. */
  classification: { apiKey: string | null };
  voice: VoiceConfig;
  coastline: CoastlineConfig;
  /** Model-pricing service (BRAIN_UI_PRICING_*); inline like wsRate. */
  pricing: { enabled: boolean; ttlMs: number };
  /** The Claude subscription token, as far as the server needs to know it (#254). */
  subscription: SubscriptionConfig;
  /**
   * The exec wrapper and its cancellation helper (BRAIN_UI_EXEC_WRAPPER,
   * BRAIN_UI_EXEC_KILLER) that every brain CLI and repository-script spawn
   * goes through. `resolveServerConfig()` always sets it. Optional only so
   * that configurations built before it existed keep their wrapper: when it is
   * absent, `createApp()` resolves it from the process environment at the
   * edge rather than spawning unwrapped.
   */
  exec?: ExecWrapperConfig;
}

export interface SubscriptionConfig {
  /** CLAUDE_CODE_OAUTH_TOKEN is set. The token itself never enters the config. */
  tokenSet: boolean;
  /** BRAIN_UI_CLAUDE_TOKEN_MINTED_AT as written; validated at boot. */
  mintedAt: string | null;
}

// --- resolver ----------------------------------------------------------------

type EnvRecord = Record<string, string | undefined>;

/** Configuration resolved specifically for the standalone cron bin. */
export interface CronConfig {
  /** Brain repository inspected by the crontab emitter. */
  brainPath: string;
  /** The deployment database; unlike createApp(), the bin defaults to the container path. */
  dbPath: string;
  /** Allowlisted brain CLI environment used only to discover module cron entries. */
  moduleDiscoveryEnv: EnvRecord;
  /** Allowlisted environment for the scheduled child, before the span sink is added. */
  childEnv: EnvRecord;
  /** Valid operator-added names, also used when emitting /etc/environment. */
  subprocessEnvExtraNames: string[];
  /** Whether the crontab schedules the weekly `hygiene` job (BRAIN_UI_CRON_HYGIENE). */
  hygiene: boolean;
  /**
   * Control configuration the cron RUNNER itself reads — the exec wrapper and
   * its cancellation helper. Kept apart from `childEnv` on purpose: that one
   * is filtered to the cron audience and is what a scheduled job receives,
   * while these are read before anything is spawned and are not forwarded.
   * Emitting them is what stops the privilege boundary at the crontab.
   */
  controlEnv: EnvRecord;
  /** The exec wrapper resolved from `controlEnv`'s source, once, at the bin's edge. */
  exec: ExecWrapperConfig;
}

function scheduleInferenceOrigins(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const origins = list(raw);
  for (const origin of origins) {
    let url: URL | null = null;
    try { url = new URL(origin); } catch { /* reported below */ }
    if (!url || url.protocol !== "https:" || url.origin !== origin || Buffer.byteLength(origin) > 256)
      throw new Error("BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS must list normalized HTTPS origins.");
  }
  if (origins.length > 16 || new Set(origins).size !== origins.length)
    throw new Error("BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS must list at most 16 distinct origins.");
  return origins;
}

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
 * direction to fail is "more confirmation", not less. Regex validation belongs
 * to backend initialization: a nonempty all-invalid regex list is rejected.
 */
function parseConfirmBash(raw: string | undefined): ConfirmPatternSource[] | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    // Bare sources, or `{ pattern, effect }` — the effect is what the approval
    // card says (#112). Anything else is dropped; a list that had entries and
    // kept none falls back to the defaults, because only a literal `[]` means
    // "no confirmation".
    const kept = parsed.flatMap((entry): ConfirmPatternSource[] => {
      if (typeof entry === "string") return [entry];
      if (entry && typeof entry === "object" && typeof entry.pattern === "string") {
        return [
          typeof entry.effect === "string"
            ? { pattern: entry.pattern, effect: entry.effect }
            : entry.pattern,
        ];
      }
      return [];
    });
    return parsed.length > 0 && kept.length === 0 ? null : kept;
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

function autonomousBudgetConfig(env: EnvRecord): InboxBudgetConfig {
  const number = (name: string, fallback: number, integer = false, positive = false): number => {
    const raw = env[name], value = raw === undefined ? fallback : Number(raw);
    if (raw !== undefined && raw.trim() === "" || !Number.isFinite(value) || value < 0 ||
      positive && value === 0 || integer && !Number.isSafeInteger(value) || !Number.isSafeInteger(Math.ceil(value * 1_000_000)))
      throw new Error(`${name} is not a valid autonomous budget value.`);
    return value;
  };
  const timeZone = env.BRAIN_UI_AUTONOMOUS_TIMEZONE ?? "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); }
  catch { throw new Error("BRAIN_UI_AUTONOMOUS_TIMEZONE is not a valid IANA timezone."); }
  return {
    spendUsd: number("BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY", 5),
    turns: number("BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY", 0, true),
    emergencySpendUsd: number("BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD", 0),
    emergencyTurns: number("BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS", 0, true),
    timeZone,
    unpricedUsdPerToken: number("BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN", 0.01, false, true),
  };
}

function autonomousPositiveInteger(env: EnvRecord, name: string, fallback: number, upper = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name], value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === "" || !Number.isSafeInteger(value) || value < 1 || value >= upper)
    throw new Error(`${name} must be a positive integer below ${upper}.`);
  return value;
}

/**
 * Resolve an environment into a {@link ServerConfig}. Defaults to the real
 * process environment; tests pass their own record instead of mutating it.
 */
export function resolveServerConfig(env: EnvRecord = process.env): ServerConfig {
  const { brainPath, enabled: pricingEnabled, ttlMs: pricingTtlMs } =
    resolveStandalonePricingConfig(env);

  let geo: GeoConfigInput | undefined;
  if (env.BRAIN_GEO_CONFIG_JSON !== undefined) {
    try {
      geo = geoConfigSchema.parse(JSON.parse(env.BRAIN_GEO_CONFIG_JSON));
      if (geo.cacheDir !== undefined) geo.cacheDir = resolve(brainPath, geo.cacheDir);
    } catch {
      throw new Error("BRAIN_GEO_CONFIG_JSON must contain valid canonical geo JSON.");
    }
  }

  const rawAuthMode = env.AUTH_MODE?.trim().toLowerCase() || null;
  const validMode = AUTH_MODES.find((mode) => mode === rawAuthMode) ?? null;

  const modelDiscovery = envFlag(env.BRAIN_UI_MODEL_DISCOVERY, env.NODE_ENV !== "test");

  const rawTtl = Number(env.BRAIN_UI_MODEL_TTL_HOURS);
  const ttlHours = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 24;

  return {
    brainPath,
    askUserFormLimits: resolveAskUserFormLimits(Object.fromEntries([
      ["maxDepth", env.BRAIN_UI_ASK_USER_FORM_MAX_DEPTH],
      ["maxNodes", env.BRAIN_UI_ASK_USER_FORM_MAX_NODES],
      ["maxOptions", env.BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS],
    ].filter((entry) => entry[1] !== undefined).map(([name, value]) => [name, Number(value)]))),
    dbPath: env.DB_PATH || join(process.cwd(), "brain-ui.db"),
    inbox: {
      pokeTokenFile: env.BRAIN_UI_INBOX_POKE_TOKEN_FILE || null, budget: autonomousBudgetConfig(env),
      maxAutonomousRuns: autonomousPositiveInteger(env, "MAX_AUTONOMOUS_RUNS", 2),
      yieldAfterMs: autonomousPositiveInteger(env, "BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS", 20_000, 30_000),
    },
    schedules: { inferenceOrigins: scheduleInferenceOrigins(env.BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS) },
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
      claudeCodePath: env.CLAUDE_CODE_PATH || null,
      defaultModel: env.BRAIN_UI_CLAUDE_DEFAULT_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
      defaultThinkingLevel: parseDefaultThinkingLevel(env.BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL),
      profilesJson: env.BRAIN_UI_CLAUDE_PROFILES?.trim() || null,
      piProfilesJson: env.BRAIN_UI_PI_PROFILES?.trim() || null,
      modelDiscovery,
      modelTtlMs: ttlHours * 60 * 60 * 1000,
    },
    classification: { apiKey: env.TYPESAFE_API_KEY?.trim() || null },
    logLevel: parseSeverity(env.BRAIN_UI_LOG_LEVEL),
    wsMaxConnections: positiveNumber(env.BRAIN_UI_WS_MAX_CONNECTIONS, 32),
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
    coastline: {
      enabled: envFlag(env.BRAIN_UI_COASTLINE, true),
      url: env.OVERPASS_URL || "https://overpass-api.de/api/interpreter",
      userAgent: env.OVERPASS_USER_AGENT || "brain-kit-ui/1.0",
      cacheDir: env.COASTLINE_CACHE_DIR || join(brainPath, ".brain-ui", "geo"),
      ...(geo === undefined ? {} : { geo }),
    },
    pricing: {
      enabled: pricingEnabled,
      ttlMs: pricingTtlMs,
    },
    subscription: {
      tokenSet: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim()),
      mintedAt: env.BRAIN_UI_CLAUDE_TOKEN_MINTED_AT?.trim() || null,
    },
    exec: execConfig(env),
  };
}

/**
 * Resolve the standalone cron bin's paths and allowlisted scheduled-job
 * environment. The escape hatch is parsed here, at this package's sole env
 * chokepoint, and its control variable is held back from the child.
 */
export function resolveCronConfig(
  env: EnvRecord = process.env,
  admittedNames: readonly string[] = []
): CronConfig {
  const subprocessEnvExtraNames = parseSubprocessEnvExtra(
    [env.BRAIN_UI_SUBPROCESS_ENV_EXTRA, ...admittedNames].join(",")
  );
  return {
    brainPath: env.BRAIN_PATH || "/data/brain",
    dbPath: env.DB_PATH || "/data/db/brain-ui.db",
    moduleDiscoveryEnv: filterPackageSubprocessEnv(
      env,
      "brainCli",
      subprocessEnvExtraNames
    ),
    childEnv: filterPackageSubprocessEnv(
      env,
      "cron",
      subprocessEnvExtraNames
    ),
    subprocessEnvExtraNames,
    hygiene: envFlag(env.BRAIN_UI_CRON_HYGIENE, true),
    controlEnv: Object.fromEntries(
      CRON_CONTROL_ENV_NAMES.filter((name) => env[name]).map((name) => [name, env[name]])
    ),
    exec: execConfig(env),
  };
}

/**
 * Build a package-owned child environment from an environment value.
 */
function filterPackageSubprocessEnv(
  env: EnvRecord,
  audience: SubprocessEnvAudience,
  extraNames: readonly string[] = [],
  extra: Record<string, string> = {}
): EnvRecord {
  const operatorNames = parseSubprocessEnvExtra(
    env.BRAIN_UI_SUBPROCESS_ENV_EXTRA
  );
  return {
    ...filterSubprocessEnv(env, audience, [...operatorNames, ...extraNames]),
    ...extra,
  };
}

/**
 * The allowlisted parent environment for a spawned subprocess, plus explicit
 * overrides. The agent default preserves this exported helper's historical
 * no-argument use; every ui-server spawn names its actual audience.
 */
/**
 * The exec wrapper and its cancellation helper, or empty when the host
 * configured neither.
 *
 * Resolved once at an edge into {@link ServerConfig.exec} or
 * {@link CronConfig.exec} and threaded to every spawn (#1363). There is no
 * `process.env` default: a spawn site that resolved the wrapper from the
 * ambient environment would ignore the wrapper an app was configured with.
 */
export function execConfig(env: EnvRecord): ExecWrapperConfig {
  return {
    wrapper: validateExecWrapper(env.BRAIN_UI_EXEC_WRAPPER),
    killer: validateExecWrapper(env.BRAIN_UI_EXEC_KILLER),
  };
}

/**
 * {@link execConfig} of the process environment, for the two edges that must
 * still read it: `createApp()` given a configuration without `exec`, and a
 * `createBrainClient()` an embedder builds without one. Each resolves it once.
 * An absent field must keep the ambient wrapper, never mean "unwrapped".
 */
export function ambientExecConfig(): ExecWrapperConfig {
  return execConfig(process.env);
}

export function subprocessEnv(
  audience: SubprocessEnvAudience = "agent",
  extra: Record<string, string> = {},
  extraNames: readonly string[] = []
): EnvRecord {
  return filterPackageSubprocessEnv(process.env, audience, extraNames, extra);
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

/** @internal Documentation-generator metadata; not a package entry-point API. */
export const DYNAMIC_ENV_READS: readonly DynamicEnvReadSpec[] = [
  {
    source: "web-search provider catalog (`WEB_SEARCH_PROVIDERS`)",
    description:
      "Presence checks for catalog-declared API-key names when reporting " +
      "web-search provider availability. Credentials are not returned over " +
      "the API, logged or copied into web-search.json.",
  },
  {
    source: "filtered environment snapshot (`subprocessEnv`)",
    description:
      "At call time, filters by the requested SDK agent, brainCli or cron " +
      "audience (agent when omitted), admitting valid operator names from " +
      "BRAIN_UI_SUBPROCESS_ENV_EXTRA and explicit per-spawn extraNames. " +
      "Explicit extra overrides merge last; the control variable is excluded " +
      "from the filtered snapshot. Internal transport does not make every " +
      "inherited variable supported server configuration.",
  },
];
