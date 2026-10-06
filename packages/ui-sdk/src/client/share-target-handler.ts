import {
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TEXT_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  SHARE_STASH_TTL_MS,
} from "../protocol.js";
import {
  getShareStore,
  pruneStoredShares,
  type ShareStore,
  type StoredShare,
} from "./share-store.js";

/**
 * The service-worker half of the Web Share Target API.
 *
 * A POST share target is a cross-site POST *navigation*: the browser hands the
 * payload to whatever answers the action URL. It must be answered in the
 * service worker, not on the server, for two independent reasons —
 *
 *   1. The session cookie is SameSite=Strict, which is exactly the case a
 *      cross-site POST navigation does not carry. A server route would see an
 *      unauthenticated request with the payload already consumed.
 *   2. Answering locally keeps the payload on the device until the app is
 *      authenticated and online, so a share made offline or logged out is
 *      queued rather than lost.
 *
 * So: stash the payload, redirect to the app with an id, and let the app upload
 * it when it can.
 *
 * SECURITY: this path is reachable by any website. A page that auto-submits a
 * cross-site form to the action URL is indistinguishable from the system share
 * sheet — same method, same encoding, same absent cookie, and `Sec-Fetch-Site`
 * reads `cross-site` for both and is not exposed to a worker anyway. A stashed
 * share is therefore UNTRUSTED input, and whatever consumes it has to let the
 * user see it before anything is written to their knowledge base.
 *
 * Deliberately free of any Workbox dependency — a plain `fetch` listener needs
 * no router, and Workbox never answers a POST of its own accord (see
 * registerShareTarget).
 */

/** Path the manifest's `share_target.action` should point at. */
export const DEFAULT_SHARE_TARGET_PATH = "/share-target";
/** Query parameter carrying the stashed share's id to the app. */
export const SHARE_QUERY_PARAM = "share";
/** Query parameter carrying a failure the app should explain rather than swallow. */
export const SHARE_ERROR_PARAM = "share_error";

/**
 * How long to wait for the stash before giving up on it.
 *
 * `indexedDB.open()` can hang outright on a corrupted or locked backing store —
 * no success event, no error event. Without a bound the response promise never
 * settles, the tab sits blank until the browser kills the worker, and the user
 * gets a network error instead of the explanation this module promises.
 */
const STORE_TIMEOUT_MS = 5_000;

export type ShareTargetError =
  /** `formData()` threw — usually a manifest `accept` listing an extension with no MIME type. */
  | "parse"
  /** The share sheet sent nothing usable. */
  | "empty"
  /** Past the caps the server would refuse anyway. */
  | "too_large"
  /** IndexedDB refused the write, or took too long to accept it. */
  | "store";

export interface ShareTargetOptions {
  /** Must match `share_target.action`. Default `/share-target`. */
  path?: string;
  /** Where the browser lands afterwards. Default `/`. */
  landingPath?: string;
  /** Test hook: answer against a different store. Not an extension point. */
  store?: ShareStore;
}

/**
 * Minimal structural shapes for the two service-worker globals used here. The
 * package compiles against the DOM lib, and pulling in lib.webworker to name
 * `FetchEvent` would conflict with it across every other file.
 */
export interface ShareFetchEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

export interface ShareTargetScope {
  addEventListener(
    type: "fetch",
    listener: (event: ShareFetchEvent) => void
  ): void;
}

const encoder = new TextEncoder();

function nonEmptyString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function utf8Length(value: string | undefined): number {
  return value ? encoder.encode(value).length : 0;
}

function redirect(base: string, url: string, params: Record<string, string>): Response {
  const target = new URL(base, url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  // 303 so the browser follows with a GET: the app boots normally, and a reload
  // of the landing page never re-POSTs the share.
  return Response.redirect(target.toString(), 303);
}

/** Reject rather than hang — see STORE_TIMEOUT_MS. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("share_store_timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** True when this request is a payload being delivered to the share target. */
export function isShareTargetRequest(
  request: Request,
  path: string = DEFAULT_SHARE_TARGET_PATH
): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname === path;
  } catch {
    return false;
  }
}

/**
 * Collect the shared files.
 *
 * Liberal in what it accepts, on two axes. It takes every binary entry rather
 * than only the field the manifest names, because senders disagree about which
 * field a share fills in and some attach files under a name of their own. And
 * it accepts a bare `Blob` as well as a `File`, because not every runtime
 * surfaces a binary part as a `File`.
 *
 * It also NAMES what arrives nameless. `FormData.append(name, blob)` yields an
 * entry whose `name` is empty in some runtimes (observed in Bun), and a file
 * with no name reaches the server as an anonymous blob it has to invent a name
 * for anyway. Naming it here keeps the stash self-describing.
 *
 * Note what is deliberately NOT rescued: a multipart part sent without a
 * `filename` parameter is, per the FormData spec, a *string* entry — verified
 * against the runtime, not assumed. It is indistinguishable from the title or
 * text fields, so treating strings as files would turn every text share into a
 * bogus attachment. Android always sends a filename.
 */
function collectFiles(form: FormData): File[] {
  const files: File[] = [];
  for (const [, value] of form.entries()) {
    const entry: unknown = value;
    if (!(entry instanceof Blob) || entry.size === 0) continue;
    const named =
      entry instanceof File && entry.name
        ? entry
        : new File([entry], `shared-${files.length + 1}`, { type: entry.type });
    files.push(named);
  }
  return files;
}

/**
 * Stash an incoming share and redirect to the app.
 *
 * Never rejects and never hangs: a browser mid-navigation has to land
 * somewhere, so every failure becomes a redirect carrying `share_error`. The
 * user sees an explanation instead of a dead tab.
 */
export async function handleShareTargetRequest(
  request: Request,
  options: ShareTargetOptions = {}
): Promise<Response> {
  const landing = options.landingPath ?? "/";
  const fail = (reason: ShareTargetError) =>
    redirect(landing, request.url, { [SHARE_ERROR_PARAM]: reason });

  // Refuse an obviously oversized body BEFORE `formData()` buffers it whole in
  // the worker. A 400 MB video would otherwise get the worker killed on memory
  // pressure, leaving the navigation on a browser error page with nothing to
  // explain it.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SHARE_MAX_TOTAL_BYTES) {
    return fail("too_large");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("parse");
  }

  const files = collectFiles(form);
  const title = nonEmptyString(form.get("title"));
  const text = nonEmptyString(form.get("text"));
  const url = nonEmptyString(form.get("url"));

  if (!title && !text && !url && files.length === 0) {
    return fail("empty");
  }

  // The same caps the server enforces, applied here too. Without them a share
  // is written to the user's own device first and only refused on upload — the
  // phone pays the storage cost for a payload that was never going to be
  // accepted, and the explanation arrives minutes late.
  if (files.length > SHARE_MAX_FILES) return fail("too_large");
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > SHARE_MAX_FILE_BYTES) return fail("too_large");
    totalBytes += file.size;
  }
  if (totalBytes > SHARE_MAX_TOTAL_BYTES) return fail("too_large");
  if (
    utf8Length(title) > SHARE_MAX_TEXT_BYTES ||
    utf8Length(text) > SHARE_MAX_TEXT_BYTES ||
    utf8Length(url) > SHARE_MAX_TEXT_BYTES
  ) {
    return fail("too_large");
  }

  const record: StoredShare = {
    id: crypto.randomUUID(),
    receivedAt: Date.now(),
    files,
  };
  if (title) record.title = title;
  if (text) record.text = text;
  if (url) record.url = url;

  const store = options.store ?? getShareStore();
  try {
    await withTimeout(store.put(record), STORE_TIMEOUT_MS);
  } catch {
    return fail("store");
  }

  // Bound the stash: a share the app never claims (abandoned behind a login
  // prompt, or an upload that never succeeded) would otherwise sit on the
  // device holding whole files forever. Not awaited — the browser is mid
  // navigation and the redirect must not wait on housekeeping. This can never
  // reach the newest record, so the app prunes on start as well.
  void pruneStoredShares(store, SHARE_STASH_TTL_MS).catch(() => {});

  return redirect(landing, request.url, { [SHARE_QUERY_PARAM]: record.id });
}

