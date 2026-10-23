/**
 * Who receives a hosted turn's inference, by the provider policy's names
 * (#2695, maintainer rulings of 2026-10-23).
 *
 * Only the exact origin the turn's host inference relay forwards to names a
 * recipient. A built-in origin names the vendor that runs it. An operator
 * may name a trusted gateway they run with `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS`.
 * Every other origin is unknown, and an unknown recipient is denied every
 * provider folder. That covers a custom base URL, an origin listed only to
 * receive a credential (`BRAIN_UI_CLAUDE_OAUTH_ORIGINS`,
 * `BRAIN_UI_PI_CREDENTIAL_ORIGINS`), aggregators and routers, and hosted
 * clouds such as Bedrock or Vertex. A model label, vendor name or cost route
 * never names one.
 */

/**
 * Origins whose operator is the vendor a policy names. Each is an API the
 * vendor runs itself; a router or a cloud that hosts several vendors' models
 * is deliberately absent.
 */
export const FIRST_PARTY_RECIPIENT_ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  "https://api.anthropic.com": "anthropic",
  "https://api.openai.com": "openai",
  // pi's `openai-codex` provider: ChatGPT's own Codex endpoint.
  "https://chatgpt.com": "openai",
  "https://generativelanguage.googleapis.com": "google",
  "https://api.x.ai": "xai",
  "https://api.mistral.ai": "mistral",
  "https://api.deepseek.com": "deepseek",
  "https://api.groq.com": "groq",
  "https://api.cerebras.ai": "cerebras",
  "https://api.fireworks.ai": "fireworks",
  "https://api.together.ai": "together",
  "https://api.moonshot.ai": "moonshotai",
  "https://api.moonshot.cn": "moonshotai",
  "https://api.kimi.com": "moonshotai",
  "https://api.minimax.io": "minimax",
  "https://api.minimaxi.com": "minimax",
  "https://api.z.ai": "zai",
  "https://open.bigmodel.cn": "zai",
});

const NAME = /^[a-z0-9][a-z0-9._-]*$/u;

/** An exact `http(s)` origin with nothing else, as `URL#origin` writes it. */
function exactOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return value.replace(/\/$/u, "") === url.origin ? url.origin : undefined;
  } catch { return undefined; }
}

/**
 * Parse `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS`: `name=origin[,origin];name=origin`.
 * A malformed entry, or one that names a built-in origin anything but its
 * vendor, refuses the boot with the variable's name.
 */
export function parseProviderRecipientOrigins(value: string | undefined): ReadonlyMap<string, string> {
  const origins = new Map<string, string>();
  const refuse = (detail: string): never => { throw new Error(`BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS ${detail}`); };
  for (const entry of (value ?? "").split(";").map(part => part.trim()).filter(Boolean)) {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at).trim();
    if (at < 1 || !NAME.test(name)) refuse("has an entry without a lowercase policy name");
    const list = entry.slice(at + 1).split(",").map(origin => origin.trim()).filter(Boolean);
    if (!list.length) refuse(`lists no origin for ${name}`);
    for (const raw of list) {
      const origin = exactOrigin(raw) ?? refuse(`lists something other than an exact http(s) origin for ${name}`);
      const builtIn = FIRST_PARTY_RECIPIENT_ORIGINS[origin];
      if (builtIn !== undefined && builtIn !== name) refuse(`names ${origin} ${name}, but it is ${builtIn}'s own origin`);
      const mapped = origins.get(origin);
      if (mapped !== undefined && mapped !== name) refuse(`names ${origin} both ${mapped} and ${name}`);
      origins.set(origin, name);
    }
  }
  return origins;
}

/** The policy name an exact relay origin proves, or undefined for an unknown recipient. */
export function providerRecipient(origin: string | undefined, operator: ReadonlyMap<string, string> = new Map()): string | undefined {
  const exact = origin === undefined ? undefined : exactOrigin(origin);
  if (exact === undefined) return undefined;
  return Object.hasOwn(FIRST_PARTY_RECIPIENT_ORIGINS, exact) ? FIRST_PARTY_RECIPIENT_ORIGINS[exact] : operator.get(exact);
}
