/**
 * The host's Google credential (#4206; plan
 * [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §10, "Hosted: an enforced boundary"): the transport the host runs gog
 * through, in a home that passed its checks (`./home.ts`), and the
 * availability probe later surfaces read (the host tools, #4207; status,
 * #4209).
 *
 * The home is checked at first use and again on every later use, never at
 * boot. A home that fails a check makes Google answer `unavailable` with the
 * reason, and nothing else on the host changes: the server boots and serves
 * chats as before. Nothing latches. Each call looks at the home as it is
 * now, so a repaired home is seen on the next call.
 *
 * The mask is fixed at boot: the configured home with its symbolic links
 * resolved, laid over every worker view as an exact mask (like the native
 * manager's private paths). A home that later resolves somewhere else is
 * `home_moved` until the server restarts, because no worker view covers the
 * new place. A home inside or holding the brain gets no mask, since a worker
 * view cannot cover part of the brain it binds, and its check refuses it.
 */
import {
  createGogTransport, isGogAccountAlias, type GogBinary, type GogTransport, type GogTransportOptions,
} from "@schlessera/brain-common/internal/google-gog";
import type { GoogleError } from "@schlessera/brain-common/internal/google-operations";
import type { GoogleHostEnv } from "../config/env.js";
import { checkGoogleHome, googleHomeAreas, googleHomeMask, GOOGLE_HOME_REASONS, type GoogleHomeArea, type GoogleHomeLayout } from "./home.js";

/** Why Google is unavailable on this host. */
export const GOOGLE_UNAVAILABLE_REASONS = [
  ...GOOGLE_HOME_REASONS,
  "keyring_password_unset", "keyring_password_invalid", "gog_path_unset", "account_unset", "account_invalid",
  "binary_refused", "transport_incompatible", "not_connected", "account_unverified",
] as const;
export type GoogleUnavailableReason = typeof GOOGLE_UNAVAILABLE_REASONS[number];

/** What later surfaces read. `cause` is the transport's own coded reason, when it gave one. */
export type GoogleAvailabilityStatus =
  | {
    state: "available";
    account: string;
    binary: { kind: "pinned"; version: string; commit: string; sha256: string } | { kind: "fake" };
    /** When the connected check last succeeded (epoch ms). */
    connected_at: number;
  }
  | { state: "unavailable"; reason: GoogleUnavailableReason; detail: string; cause: string | null };

export interface GoogleCredentialOptions {
  env: GoogleHostEnv;
  layout: GoogleHomeLayout;
  /** A test's fake (`createFakeGog().binary`). Never configuration: production always runs the pinned BRAIN_UI_GOG_PATH. */
  binary?: GogBinary;
  hostUid?: number;
  /** How long a successful connected check stands. Default {@link GOOGLE_CONNECTED_TTL_MS}. */
  connectedTtlMs?: number;
  /** Told once each time an account's availability changes, with the detail. */
  report?: (message: string, status: GoogleAvailabilityStatus) => void;
  now?: () => number;
  transport?: Pick<GogTransportOptions, "timeouts" | "retryDelayMs" | "log">;
}

export interface GoogleCredential {
  /** The exact worker masks: the home as resolved at boot, or none. */
  readonly maskPaths: readonly string[];
  /** Configuration and home only, then the account's transport. The pin runs at the transport's first use. */
  transport(account: string | null | undefined): { ok: true; transport: GogTransport } | { ok: false; status: Extract<GoogleAvailabilityStatus, { state: "unavailable" }> };
  /** The full probe: configuration, home, the pinned binary and whether the account is connected. */
  status(account: string | null | undefined): Promise<GoogleAvailabilityStatus>;
}

/** A connected check stands this long; the home and the pin are checked on every call regardless. */
export const GOOGLE_CONNECTED_TTL_MS = 5 * 60_000;

type Unavailable = Extract<GoogleAvailabilityStatus, { state: "unavailable" }>;
const unavailable = (reason: GoogleUnavailableReason, detail: string, cause: string | null = null): Unavailable => ({ state: "unavailable", reason, detail, cause });

/** The connected check's error, as a reason. A refusal from Google itself is not a disconnected account. */
function connectedFailure(error: GoogleError): Unavailable {
  if (error.code === "unavailable" && (error.reason === "auth_required" || error.reason === "config")) {
    return unavailable("not_connected", "The gog home has no usable token for this account. Connect it from the host's shell with `brain google connect --remote`.", error.reason);
  }
  if (error.code === "unavailable" && error.reason === "environment_keyring_password") {
    return unavailable("keyring_password_invalid", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD holds a line break or NUL, which gog cannot take.", error.reason);
  }
  if (error.code === "transport_incompatible") {
    return unavailable("transport_incompatible", "gog answered in a way this host does not read.", error.reason);
  }
  return unavailable("account_unverified", "Google did not confirm the account just now; the next call checks again.", error.reason ?? error.code);
}

export function createGoogleCredential(options: GoogleCredentialOptions): GoogleCredential {
  const { env, layout } = options;
  const now = options.now ?? Date.now;
  const ttl = options.connectedTtlMs ?? GOOGLE_CONNECTED_TTL_MS;
  const masked = googleHomeMask(env.home, layout.brainPath);
  const transports = new Map<string, GogTransport>();
  const connected = new Map<string, number>();
  const inflight = new Map<string, Promise<GoogleAvailabilityStatus>>();
  const reported = new Map<string, string>();

  function report(account: string, status: GoogleAvailabilityStatus): GoogleAvailabilityStatus {
    const key = status.state === "available" ? "available" : `${status.reason}:${status.cause ?? ""}`;
    if (reported.get(account) !== key) {
      reported.set(account, key);
      options.report?.(status.state === "available"
        ? `Google is available for account alias ${account}.`
        : `Google is unavailable on this host (${status.reason}${status.cause ? `: ${status.cause}` : ""}): ${status.detail}`, status);
    }
    return status;
  }

  function transport(account: string | null | undefined): ReturnType<GoogleCredential["transport"]> {
    const refused = (status: Unavailable) => ({ ok: false as const, status });
    if (!env.home) return refused(unavailable("home_unset", "BRAIN_UI_GOOGLE_HOME is not set."));
    const password = env.keyringPassword();
    if (!password) return refused(unavailable("keyring_password_unset", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD is not set."));
    if (!options.binary && !env.gogPath) return refused(unavailable("gog_path_unset", "BRAIN_UI_GOG_PATH is not set."));
    if (!account) return refused(unavailable("account_unset", "The governance policy names no Google account alias."));
    if (!isGogAccountAlias(account)) return refused(unavailable("account_invalid", "The governance policy's Google account is not a gog alias."));
    let areas: GoogleHomeArea[];
    try { areas = googleHomeAreas(layout); }
    catch { return refused(unavailable("home_unresolvable", "A directory BRAIN_UI_GOOGLE_HOME is checked against cannot be resolved.")); }
    const home = checkGoogleHome(env.home, areas, { ...(options.hostUid !== undefined ? { hostUid: options.hostUid } : {}), masked: masked ?? null });
    if (!home.ok) return refused(unavailable(home.reason, home.detail));
    const key = `${account}\0${home.path}`;
    let found = transports.get(key);
    if (!found) {
      found = createGogTransport({
        binary: options.binary ?? { kind: "pinned", path: env.gogPath! },
        account,
        environment: { home: home.path, keyringPassword: password },
        ...options.transport,
      });
      transports.set(key, found);
    }
    return { ok: true, transport: found };
  }

  async function probe(account: string, open: GogTransport): Promise<GoogleAvailabilityStatus> {
    const pin = await open.availability();
    if (!pin.ok) {
      connected.delete(account);
      return pin.error.code === "transport_incompatible"
        ? unavailable("binary_refused", "BRAIN_UI_GOG_PATH is not a gog release this host accepts, or it or its directory is writable by another user.", pin.error.reason)
        : connectedFailure(pin.error);
    }
    const binary = pin.fake ? { kind: "fake" as const } : { kind: "pinned" as const, version: pin.pin.version, commit: pin.pin.commit, sha256: pin.pin.sha256 };
    const since = connected.get(account);
    if (since !== undefined && now() - since < ttl) return { state: "available", account, binary, connected_at: since };
    // The narrowest read the transport has: label ids and names, read-only, one command allowed.
    const labels = await open.execute("gmail.labels.list", {});
    if (!labels.ok) {
      connected.delete(account);
      return connectedFailure(labels.error);
    }
    const at = now();
    connected.set(account, at);
    return { state: "available", account, binary, connected_at: at };
  }

  async function status(account: string | null | undefined): Promise<GoogleAvailabilityStatus> {
    const label = account ?? "";
    const open = transport(account);
    if (!open.ok) {
      connected.delete(label);
      return report(label, open.status);
    }
    const key = account!;
    let running = inflight.get(key);
    if (!running) {
      running = probe(key, open.transport).finally(() => inflight.delete(key));
      inflight.set(key, running);
    }
    return report(key, await running);
  }

  return { maskPaths: masked ? [masked] : [], transport, status };
}
