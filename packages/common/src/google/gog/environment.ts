/**
 * The environment every gog process gets (plan §8, "Invocation discipline"):
 * an allow-list built from host-supplied values, never inherited.
 *
 * `GOG_HOME` and `HOME` both name the gog home, so gog reads no ambient
 * configuration and its default output directory is the home the host
 * chose. The keyring is the encrypted file keyring. `GOG_ACCESS_TOKEN`, every
 * other `GOG_*` name, `XDG_*` and anything else in the host's own environment
 * never reach gog: nothing here reads the host environment at all.
 */

/** What the host supplies. Validating the home itself (owner, mode, placement) is the host's job. */
export interface GogEnvironmentConfig {
  /** The gog home: config, keyring and state. Absolute. */
  home: string;
  /** The file keyring's password. */
  keyringPassword: string;
  /** IANA zone gog renders dates in; the codecs convert to UTC either way. Default `UTC`. */
  timezone?: string;
}

/** Exactly these names, and no other, reach a gog process. */
export const GOG_ENVIRONMENT_NAMES = Object.freeze([
  "GOG_HOME", "HOME", "GOG_KEYRING_BACKEND", "GOG_KEYRING_PASSWORD", "GOG_TIMEZONE", "PATH", "LANG",
] as const);
export type GogEnvironmentName = typeof GOG_ENVIRONMENT_NAMES[number];
export type GogEnvironment = Readonly<Record<GogEnvironmentName, string>>;

/** gog is a static binary; it needs no tool from PATH. */
export const GOG_PATH = "/usr/bin:/bin";
export const GOG_LANG = "C.UTF-8";

const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;

export type GogEnvironmentResult = { ok: true; environment: GogEnvironment } | { ok: false; reason: "home" | "keyring_password" | "timezone" };

/** The allow-listed environment, or the field that cannot be one. */
export function gogEnvironment(config: GogEnvironmentConfig): GogEnvironmentResult {
  const { home, keyringPassword, timezone = "UTC" } = config;
  if (typeof home !== "string" || !home.startsWith("/") || CONTROL.test(home) || home.includes("\0")) return { ok: false, reason: "home" };
  if (typeof keyringPassword !== "string" || keyringPassword.length === 0 || /[\0\r\n]/.test(keyringPassword)) {
    return { ok: false, reason: "keyring_password" };
  }
  if (typeof timezone !== "string" || timezone.length > 64 || !TIMEZONE.test(timezone)) return { ok: false, reason: "timezone" };
  const environment: GogEnvironment = Object.freeze({
    GOG_HOME: home,
    HOME: home,
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: keyringPassword,
    GOG_TIMEZONE: timezone,
    PATH: GOG_PATH,
    LANG: GOG_LANG,
  });
  return { ok: true, environment };
}
