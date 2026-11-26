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
 * manager's private paths), but only where a mask is safe for every launcher
 * to lay (`googleWorkerMasks`): an existing directory neither inside nor
 * holding the brain, holding no other area, inside no worker mount but the
 * server's HOME, and below no worker-private root. A home strictly inside
 * the server's HOME, the database directory or another temp area is still
 * masked while its check refuses it. With a separate worker identity, a home
 * behind a directory that identity cannot search gets no mask: no worker can
 * reach it. Boot holds the home open, so a home that later resolves
 * somewhere else is `home_moved`, and one created or replaced after boot
 * `home_created_after_boot`, until the server restarts, because no worker
 * view covers it. A home that overlaps an area is refused for that overlap
 * whether or not boot masked it.
 *
 * `status()` never rejects: an exception anywhere in the probe answers
 * `probe_failed`, with a fixed detail and the step that failed as its cause.
 * A connected check that began before an unavailable answer for its account,
 * from `status()` or from `transport()`, neither answers available nor stands
 * as the cached success.
 */
import {
  createGogTransport, GOG_PIN_TRANSIENT_REFUSALS, isGogAccountAlias, type GogBinary, type GogPinRefusal, type GogTransport, type GogTransportOptions,
} from "@schlessera/brain-common/internal/google-gog";
import type { GoogleError } from "@schlessera/brain-common/internal/google-operations";
import type { GoogleHostEnv } from "../config/env.js";
import { checkGoogleHome, googleHomeAreas, GOOGLE_HOME_REASONS, type GoogleHomeArea, type GoogleHomeLayout, type GoogleWorkerMasks } from "./home.js";

/** Why Google is unavailable on this host. */
export const GOOGLE_UNAVAILABLE_REASONS = [
  ...GOOGLE_HOME_REASONS,
  "keyring_password_unset", "keyring_password_invalid", "gog_path_unset", "account_unset", "account_invalid",
  "binary_refused", "transport_incompatible", "not_connected", "account_unverified", "probe_failed",
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
  /**
   * The masks boot laid in every worker view, the home held open
   * (`googleWorkerMasks(home, layout, { hold: true })`). The caller closes
   * them when it is done with the credential.
   */
  masks: GoogleWorkerMasks;
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
  /** The exact worker masks boot laid: the home as resolved at boot and gog's default directories under the server's HOME, each where safe. */
  readonly maskPaths: readonly string[];
  /**
   * Configuration and home only, then the account's transport. The pin runs at
   * the transport's first use. An unavailable answer here is one for the
   * account, as from `status()`: it drops the cached success and overtakes the
   * check running.
   */
  transport(account: string | null | undefined): { ok: true; transport: GogTransport } | { ok: false; status: Extract<GoogleAvailabilityStatus, { state: "unavailable" }> };
  /** Resolve through the verified alias-list command, rechecking the protected home first. */
  resolveAccount(account: string): Promise<import("@schlessera/brain-common/internal/google-gog").GogResult<string>>;
  /** The full probe: configuration, home, the pinned binary and whether the account is connected. Never rejects. */
  status(account: string | null | undefined): Promise<GoogleAvailabilityStatus>;
}

/** A connected check stands this long; the home and the pin are checked on every call regardless. */
export const GOOGLE_CONNECTED_TTL_MS = 5 * 60_000;

type Unavailable = Extract<GoogleAvailabilityStatus, { state: "unavailable" }>;
const unavailable = (reason: GoogleUnavailableReason, detail: string, cause: string | null = null): Unavailable => ({ state: "unavailable", reason, detail, cause });
/** An exception in one step of the probe. Its text is never kept: it may hold a path or an address. */
const failed = (step: "transport" | "pin" | "connected_check" | "probe"): Unavailable =>
  unavailable("probe_failed", "The Google availability check failed unexpectedly; the next call checks again.", step);

/** The connected check's error, as a reason. A refusal from Google itself is not a disconnected account. */
function connectedFailure(error: GoogleError): Unavailable {
  if (error.code === "unavailable" && (error.reason === "auth_required" || error.reason === "config")) {
    return unavailable("not_connected", "The gog home has no usable token for this account. Connect the account into this home from the host's shell.", error.reason);
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
  const masks = options.masks;
  const transports = new Map<string, GogTransport>();
  const connected = new Map<string, number>();
  const inflight = new Map<string, Promise<GoogleAvailabilityStatus>>();
  const reported = new Map<string, string>();
  // Bumped on every unavailable answer for an account. A connected check that
  // began under an older generation was overtaken by that answer: it neither
  // answers available nor stands as the cached success, and its callers get
  // the answer that overtook it.
  const generations = new Map<string, number>();
  const overtaken = new Map<string, Unavailable>();
  const generation = (account: string) => generations.get(account) ?? 0;

  /** An unavailable answer: no cached success and no outstanding check outlives it. */
  function refusal(account: string, status: Unavailable): Unavailable {
    generations.set(account, generation(account) + 1);
    overtaken.set(account, status);
    connected.delete(account);
    inflight.delete(account);
    return status;
  }

  function report(account: string, status: GoogleAvailabilityStatus): GoogleAvailabilityStatus {
    const key = status.state === "available" ? "available" : `${status.reason}:${status.cause ?? ""}`;
    if (reported.get(account) !== key) {
      reported.set(account, key);
      try {
        options.report?.(status.state === "available"
          ? `Google is available for account alias ${account}.`
          : `Google is unavailable on this host (${status.reason}${status.cause ? `: ${status.cause}` : ""}): ${status.detail}`, status);
      } catch { /* A failing log never changes the answer. */ }
    }
    return status;
  }

  /**
   * The one way to the account's transport, for `status()` and every caller
   * outside it: each unavailable answer it gives, a refusal or an exception,
   * passes through {@link refusal}, so it overtakes any check already running.
   */
  function transport(account: string | null | undefined): ReturnType<GoogleCredential["transport"]> {
    let opened: ReturnType<GoogleCredential["transport"]>;
    try { opened = openTransport(account); }
    catch { opened = { ok: false, status: failed("transport") }; }
    if (!opened.ok) refusal(account ?? "", opened.status);
    return opened;
  }

  /** Only {@link transport} calls it: what it refuses is not yet an answer. */
  function openTransport(account: string | null | undefined): ReturnType<GoogleCredential["transport"]> {
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
    const home = checkGoogleHome(env.home, areas, { ...(options.hostUid !== undefined ? { hostUid: options.hostUid } : {}), mask: masks.home });
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
    const began = generation(account);
    // Overtaken by an unavailable answer since it began: that answer stands.
    const current = () => generation(account) === began;
    let pin: Awaited<ReturnType<GogTransport["availability"]>>;
    try { pin = await open.availability(); }
    catch { return refusal(account, failed("pin")); }
    if (!pin.ok) {
      return refusal(account, pin.error.code !== "transport_incompatible" ? connectedFailure(pin.error)
        // A transient cause says nothing lasting about the binary: it changed while checked, or the check could not finish.
        : GOG_PIN_TRANSIENT_REFUSALS.includes(pin.error.reason as GogPinRefusal)
          ? unavailable("binary_refused", "BRAIN_UI_GOG_PATH could not be checked just now; it is checked again shortly.", pin.error.reason)
          : unavailable("binary_refused", "BRAIN_UI_GOG_PATH is not a gog release this host accepts, or it or its directory is writable by another user.", pin.error.reason));
    }
    const binary = pin.fake ? { kind: "fake" as const } : { kind: "pinned" as const, version: pin.pin.version, commit: pin.pin.commit, sha256: pin.pin.sha256 };
    if (!current()) return overtaken.get(account)!;
    const since = connected.get(account);
    if (since !== undefined && now() - since < ttl) return { state: "available", account, binary, connected_at: since };
    // The narrowest read the transport has: label ids and names, read-only, one command allowed.
    let labels: Awaited<ReturnType<GogTransport["execute"]>>;
    try { labels = await open.execute("gmail.labels.list", {}); }
    catch { return refusal(account, failed("connected_check")); }
    if (!labels.ok) return refusal(account, connectedFailure(labels.error));
    if (!current()) return overtaken.get(account)!;
    const at = now();
    connected.set(account, at);
    return { state: "available", account, binary, connected_at: at };
  }

  async function status(account: string | null | undefined): Promise<GoogleAvailabilityStatus> {
    const opened = transport(account);
    // Already a refusal: `transport` overtook any check running for the account.
    if (!opened.ok) return report(account ?? "", opened.status);
    const key = account!;
    let running = inflight.get(key);
    if (!running) {
      // Anything the probe's own steps did not catch still answers, and drops a cached success.
      const started: Promise<GoogleAvailabilityStatus> = probe(key, opened.transport).catch(() => refusal(key, failed("probe")))
        .finally(() => { if (inflight.get(key) === started) inflight.delete(key); });
      running = started;
      inflight.set(key, running);
    }
    return report(key, await running);
  }

  return { maskPaths: masks.paths, transport, status, resolveAccount: async account => {
    const opened = transport(account);
    if (!opened.ok) return { ok: false, error: { code: "unavailable", reason: opened.status.reason, message: opened.status.detail } };
    return opened.transport.resolveAccount();
  } };
}
