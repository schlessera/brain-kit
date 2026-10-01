/**
 * Audiences that receive subprocess environment variables.
 *
 * @internal First-party implementation; no compatibility guarantee.
 */
export type SubprocessEnvAudience = "cron" | "agent" | "brainCli";

const NONE = Object.freeze([]) as readonly SubprocessEnvAudience[];
const PER_CALL = Object.freeze([]) as readonly SubprocessEnvAudience[];
const AGENT = Object.freeze(["agent"]) as readonly SubprocessEnvAudience[];
const CRON = Object.freeze(["cron"]) as readonly SubprocessEnvAudience[];
const AGENT_AND_BRAIN_CLI = Object.freeze([
  "agent",
  "brainCli",
]) as readonly SubprocessEnvAudience[];
const ALL = Object.freeze([
  "cron",
  "agent",
  "brainCli",
]) as readonly SubprocessEnvAudience[];

const SUBPROCESS_ENV_EXTRA_NAME = "BRAIN_UI_SUBPROCESS_ENV_EXTRA";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment variables known to the UI server and its agent backends,
 * classified by the subprocess audiences that need them.
 *
 * An empty audience list means the name is never admitted statically: most
 * are server-only, while conditional capabilities are admitted explicitly for
 * the spawn that needs them. Variables absent from this descriptor likewise
 * reach a child only through an explicit per-call addition.
 *
 * @internal First-party implementation; no compatibility guarantee.
 */
export const SUBPROCESS_ENV = Object.freeze({
  // Process plumbing and paths.
  PATH: ALL,
  BRAIN_PATH: ALL,
  BRAIN_ROOT: ALL,
  // Generic runtime configuration, not server material: bun picks its
  // .env.<mode> file from it in every child process.
  NODE_ENV: ALL,
  TZ: ALL,
  HOME: AGENT_AND_BRAIN_CLI,
  XDG_BIN_HOME: ALL,
  CLAUDE_CONFIG_DIR: AGENT_AND_BRAIN_CLI,
  PI_CODING_AGENT_DIR: AGENT,
  XDG_CONFIG_HOME: AGENT,
  DB_PATH: CRON,
  NO_COLOR: AGENT_AND_BRAIN_CLI,
  BRAIN_RERANK_MODE: ALL,
  BRAIN_CHROME_NO_SANDBOX: AGENT_AND_BRAIN_CLI,
  BRAIN_UI_CHROME_NO_SANDBOX: AGENT_AND_BRAIN_CLI,

  // Credentials and capability keys used by subprocesses.
  // `brain sync` runs the configured agent runner below the brain CLI too.
  CLAUDE_CODE_OAUTH_TOKEN: ALL,
  ANTHROPIC_API_KEY: AGENT_AND_BRAIN_CLI,
  ANTHROPIC_AUTH_TOKEN: AGENT,
  OPENROUTER_API_KEY: AGENT,
  GITHUB_TOKEN: ALL,
  BRAIN_UI_SYNC_GITHUB_TOKEN: ALL,
  GEMINI_API_KEY: ALL,
  TYPESAFE_API_KEY: ALL,
  OPENAI_API_KEY: ALL,
  OPENAI_BASE_URL: ALL,
  GEMINI_BASE_URL: ALL,
  SCRAPE_CHROME_URL: ALL,
  CHROME_CDP_URL: ALL,
  SCRAPE_CHROME_PATH: ALL,
  SCRAPE_CHROME_NO_SANDBOX: ALL,
  SCRAPE_USER_AGENT: ALL,
  SCRAPE_RESPECT_ROBOTS: ALL,
  // Admitted per spawn only when the matching web-search provider is enabled.
  EXA_API_KEY: PER_CALL,
  BRAVE_API_KEY: PER_CALL,
  JINA_API_KEY: PER_CALL,
  PERPLEXITY_API_KEY: PER_CALL,
  TAVILY_API_KEY: PER_CALL,
  FIRECRAWL_API_KEY: PER_CALL,
  KAGI_API_KEY: PER_CALL,

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
  BRAIN_UI_SUBPROCESS_ENV_EXTRA: NONE,
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
  BRAIN_UI_CLAUDE_TOKEN_MINTED_AT: NONE,
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
  BRAIN_GEO_CONFIG_JSON: NONE,
  NOMINATIM_PUBLIC_SERVICE_ELIGIBLE: NONE,
  NOMINATIM_URL: NONE,
  NOMINATIM_USER_AGENT: NONE,
}) satisfies Readonly<Record<string, readonly SubprocessEnvAudience[]>>;

/**
 * Parse the operator escape hatch into valid, unique environment names.
 *
 * Empty and malformed comma-separated entries are ignored. The escape-hatch
 * variable cannot admit itself.
 *
 * @internal First-party implementation; no compatibility guarantee.
 */
export function parseSubprocessEnvExtra(value: string | undefined): string[] {
  if (!value) return [];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(
      (name) =>
        ENV_NAME.test(name) && name !== SUBPROCESS_ENV_EXTRA_NAME
    );
  return [...new Set(names)];
}

/**
 * Build a fresh allowlisted environment for one subprocess audience.
 *
 * Descriptor entries must include the requested audience. Names that cannot
 * be declared statically (for example profile-selected credential variables)
 * may be admitted explicitly for one spawn. Unknown variables never pass
 * through implicitly, and the escape-hatch control variable is always held
 * back from the child.
 *
 * @internal First-party implementation; no compatibility guarantee.
 */
export function filterSubprocessEnv(
  env: Readonly<Record<string, string | undefined>>,
  audience: SubprocessEnvAudience,
  extraNames: readonly string[] = []
): Record<string, string | undefined> {
  const extras = new Set(
    extraNames.filter(
      (name) => ENV_NAME.test(name) && name !== SUBPROCESS_ENV_EXTRA_NAME
    )
  );
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      if (name === SUBPROCESS_ENV_EXTRA_NAME) return false;
      if (extras.has(name)) return true;
      if (!Object.prototype.hasOwnProperty.call(SUBPROCESS_ENV, name)) return false;
      return SUBPROCESS_ENV[name as keyof typeof SUBPROCESS_ENV].includes(audience);
    })
  );
}
