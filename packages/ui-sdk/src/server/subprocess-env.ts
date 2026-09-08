/**
 * Audiences that receive subprocess environment variables.
 *
 * @experimental
 */
export type SubprocessEnvAudience = "cron" | "agent" | "brainCli";

const NONE = Object.freeze([]) as readonly SubprocessEnvAudience[];
const AGENT = Object.freeze(["agent"]) as readonly SubprocessEnvAudience[];
const CRON = Object.freeze(["cron"]) as readonly SubprocessEnvAudience[];
const AGENT_AND_CRON = Object.freeze([
  "agent",
  "cron",
]) as readonly SubprocessEnvAudience[];
const AGENT_AND_BRAIN_CLI = Object.freeze([
  "agent",
  "brainCli",
]) as readonly SubprocessEnvAudience[];
const ALL = Object.freeze([
  "cron",
  "agent",
  "brainCli",
]) as readonly SubprocessEnvAudience[];

/**
 * Environment variables known to the UI server and its agent backends,
 * classified by the subprocess audiences that need them.
 *
 * An empty audience list marks server-only material. The 0.32 denylist filter
 * strips only those entries; variables absent from this descriptor pass
 * through until the per-audience allowlist lands.
 *
 * @experimental
 */
export const SUBPROCESS_ENV = Object.freeze({
  // Process plumbing and paths.
  PATH: ALL,
  BRAIN_PATH: ALL,
  // Generic runtime configuration, not server material: bun picks its
  // .env.<mode> file from it in every child process.
  NODE_ENV: ALL,
  TZ: ALL,
  HOME: AGENT_AND_BRAIN_CLI,
  PI_CODING_AGENT_DIR: AGENT,
  XDG_CONFIG_HOME: AGENT,
  DB_PATH: CRON,
  NO_COLOR: AGENT_AND_BRAIN_CLI,

  // Credentials and capability keys used by subprocesses.
  CLAUDE_CODE_OAUTH_TOKEN: AGENT_AND_CRON,
  ANTHROPIC_API_KEY: AGENT,
  ANTHROPIC_AUTH_TOKEN: AGENT,
  OPENROUTER_API_KEY: AGENT,
  GITHUB_TOKEN: ALL,
  BRAIN_UI_SYNC_GITHUB_TOKEN: ALL,
  GEMINI_API_KEY: ALL,
  OPENAI_API_KEY: ALL,
  EXA_API_KEY: AGENT,
  BRAVE_API_KEY: AGENT,
  JINA_API_KEY: AGENT,
  PERPLEXITY_API_KEY: AGENT,
  TAVILY_API_KEY: AGENT,
  FIRECRAWL_API_KEY: AGENT,
  KAGI_API_KEY: AGENT,

  // Claude profile overrides built by the backend.
  ANTHROPIC_BASE_URL: AGENT,
  ANTHROPIC_DEFAULT_OPUS_MODEL: AGENT,
  ANTHROPIC_DEFAULT_SONNET_MODEL: AGENT,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: AGENT,
  CLAUDE_CODE_SUBAGENT_MODEL: AGENT,

  // Cron pricing configuration.
  BRAIN_UI_PRICING_DISCOVERY: CRON,
  BRAIN_UI_PRICING_TTL_HOURS: CRON,

  // Server process configuration: intentionally absent from child processes.
  BRAIN_UI_SKILLS_GITHUB_TOKEN: NONE,
  HOST: NONE,
  BRAIN_UI_CONFIRM_BASH: NONE,
  BRAIN_UI_WS_MAX_CONNECTIONS: NONE,
  BRAIN_UI_WS_RATE: NONE,
  BRAIN_UI_WS_BURST: NONE,
  BRAIN_UI_LOG_LEVEL: NONE,
  SOURCE_COMMIT: NONE,
  ALLOWED_ORIGINS: NONE,
  MAX_CONCURRENT_SESSIONS: NONE,
  BRAIN_UI_TURN_TIMEOUT_MS: NONE,
  AUTH_MODE: NONE,
  BRAIN_UI_PASSWORD_HASH: NONE,
  COOKIE_SECRET: NONE,
  TRUST_PROXY: NONE,
  TRUST_PROXY_HOPS: NONE,
  PROXY_AUTH_HEADER: NONE,
  BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: NONE,
  BRAIN_UI_ALLOW_PASSWORD: NONE,
  WEBAUTHN_RP_NAME: NONE,
  WEBAUTHN_USER_NAME: NONE,
  WEBAUTHN_USER_ID: NONE,
  WEBAUTHN_RP_ID: NONE,
  WEBAUTHN_ORIGINS: NONE,
  BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: NONE,
  AGENT_BACKEND: NONE,
  CLAUDE_CODE_PATH: NONE,
  BRAIN_UI_CLAUDE_DEFAULT_MODEL: NONE,
  BRAIN_UI_CLAUDE_PROFILES: NONE,
  BRAIN_UI_PI_PROFILES: NONE,
  BRAIN_UI_MODEL_DISCOVERY: NONE,
  BRAIN_UI_MODEL_TTL_HOURS: NONE,
  DEEPGRAM_API_KEY: NONE,
  VOICE_PROVIDER: NONE,
  VOICE_KEYTERM_LIMIT: NONE,
  VOICE_CACHE_DIR: NONE,
  BRAIN_UI_REVERSE_GEOCODE: NONE,
  NOMINATIM_URL: NONE,
  NOMINATIM_USER_AGENT: NONE,
}) satisfies Readonly<Record<string, readonly SubprocessEnvAudience[]>>;

/**
 * Strip descriptor entries that have no subprocess audience.
 *
 * Unknown variables deliberately pass through: this is the 0.32 denylist
 * step, not the later audience allowlist.
 *
 * @experimental
 */
export function filterSubprocessEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      if (!Object.prototype.hasOwnProperty.call(SUBPROCESS_ENV, name)) return true;
      return SUBPROCESS_ENV[name as keyof typeof SUBPROCESS_ENV].length > 0;
    })
  );
}
