/**
 * Transport fault primitives and the network spy, browser side (#1016).
 *
 * `installFaultNetwork` replaces the page's transports with fixtures it can
 * break the way the real host and network break them:
 *
 * - `drop()`: every open socket closes with 1006, new sockets never open, and
 *   every request, the connectivity probe (`/api/vpn-check`) included, fails
 *   as a network error does. `recover()` heals all of it; the app reconnects
 *   on its own schedule, exactly as after a real outage.
 * - `expireAuth()`: the probe and every request answer 401, open sockets close
 *   with 1008 (the host's expiry and revocation close:
 *   `SESSION_EXPIRED_CLOSE_CODE`, `packages/ui-server/src/ws/host.ts:38`;
 *   `SESSION_REVOKED_CLOSE_CODE`, `packages/ui-server/src/middleware/auth.ts:66`),
 *   and new sockets fail their handshake, as an upgrade without a session does.
 *
 * Pass `network.request` to `createBrainUiRoot({ request })`. The global
 * `WebSocket` is replaced for the whole page, so the app's socket and any
 * other (a speech provider's) are fixtures too; nothing reaches a server.
 *
 * The spy records every request and every socket frame: requests through
 * `network.request`, and anything that bypasses it through `fetch`,
 * `XMLHttpRequest` or `navigator.sendBeacon`. Bypassing requests still go to
 * the real `fetch` after being recorded; in the pinned runner only the
 * in-container Vite server answers. A test asserting that nothing left the
 * device reads `network.requests` and `network.frames`.
 *
 * Call `restore()` when the test ends (`ctx.onTestFinished`).
 */

export type NetworkState = "online" | "down" | "expired";

export interface RecordedRequest {
  /** `request`: through the root's request function. The rest bypassed it. */
  via: "request" | "fetch" | "xhr" | "beacon";
  method: string;
  url: string;
}

export interface RecordedFrame {
  url: string;
  data: string | ArrayBufferLike | Blob | ArrayBufferView;
  /** Encoded size: a string's UTF-8 length, a Blob's or buffer's byte length. */
  bytes: number;
}

export interface FaultNetworkOptions {
  /** Answers for requests other than the probe while online; unmatched → 404. */
  routes?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
  /** Runs when a socket opens while online, e.g. to deliver the host's hello. */
  onOpen?: (socket: FaultSocket) => void;
}

const PROBE_PATH = "/api/vpn-check";
const encoder = new TextEncoder();

function frameBytes(data: RecordedFrame["data"]): number {
  if (typeof data === "string") return encoder.encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}

/** A WebSocket the fault network opens, closes and records. */
export class FaultSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Frames this socket sent, oldest first. */
  readonly sent: RecordedFrame[] = [];

  constructor(readonly url: string, private readonly net: FaultNetworkInternals) {
    super();
  }

  send(data: RecordedFrame["data"]): void {
    if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
    const frame = { url: this.url, data, bytes: frameBytes(data) };
    this.sent.push(frame);
    this.net.frames.push(frame);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => this.finish(code, reason, true));
  }

  /** The host speaks: one frame, JSON-encoded unless it is already a string. */
  deliver(frame: unknown): void {
    if (this.readyState !== 1) throw new Error("deliver on a socket that is not open");
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.fire("message", new MessageEvent("message", { data }));
  }

  /** Parsed JSON frames of one type this socket sent. */
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .filter((f) => typeof f.data === "string")
      .map((f) => { try { return JSON.parse(f.data as string); } catch { return null; } })
      .filter((f) => f?.type === type);
  }

  /** @internal */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.fire("open", new Event("open"));
  }

  /** @internal The server or the network ends the socket. */
  finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) return;
    const opened = this.readyState !== 0;
    this.readyState = 3;
    if (!opened || !wasClean) this.fire("error", new Event("error"));
    this.fire("close", new CloseEvent("close", { code, reason, wasClean }));
  }

  private fire(type: "open" | "message" | "close" | "error", event: Event) {
    const handler = this[`on${type}`] as ((e: Event) => void) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

interface FaultNetworkInternals {
  frames: RecordedFrame[];
}

export interface FaultNetwork {
  /** Give this to `createBrainUiRoot({ request })`. */
  request: (url: string, init?: RequestInit) => Promise<Response>;
  readonly state: NetworkState;
  /** Every socket constructed while installed, oldest first. */
  readonly sockets: readonly FaultSocket[];
  /** The newest socket whose URL contains `match` (default: any). */
  socket(match?: string): FaultSocket | undefined;
  /** The spy: every request, in order. */
  readonly requests: readonly RecordedRequest[];
  /** The spy: every frame any socket sent, in order. */
  readonly frames: readonly RecordedFrame[];
  /** Transport loss. `announce` also flips `navigator.onLine` and fires `offline`. */
  drop(options?: { announce?: boolean }): void;
  /** Transport back. Fires `online` if the drop was announced. */
  recover(): void;
  /** The session expired or was revoked on the host. */
  expireAuth(): void;
  restore(): void;
}

export function installFaultNetwork(options: FaultNetworkOptions = {}): FaultNetwork {
  let state: NetworkState = "online";
  let announced = false;
  const sockets: FaultSocket[] = [];
  const requests: RecordedRequest[] = [];
  const internals: FaultNetworkInternals = { frames: [] };

  const failure = () => new TypeError("Failed to fetch");
  const unauthorized = () => Response.json({ error: "UNAUTHORIZED", message: "Session expired" }, { status: 401 });

  async function answer(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url, location.href);
    if (state === "down") throw failure();
    if (state === "expired") return unauthorized();
    if (parsed.pathname.endsWith(PROBE_PATH)) return Response.json({ ok: true });
    return (await options.routes?.(parsed, init)) ?? new Response("{}", { status: 404 });
  }

  // The spy: requests that bypass the root's request function.
  const original = {
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    sendBeacon: navigator.sendBeacon,
    onLine: Object.getOwnPropertyDescriptor(navigator, "onLine"),
  };
  globalThis.fetch = function spiedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ via: "fetch", method: method.toUpperCase(), url: new URL(url, location.href).href });
    return original.fetch.call(globalThis, input, init);
  } as typeof fetch;
  const xhrTargets = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function spiedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrTargets.set(this, { method: method.toUpperCase(), url: new URL(String(url), location.href).href });
    return (original.xhrOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function spiedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const target = xhrTargets.get(this);
    if (target) requests.push({ via: "xhr", ...target });
    return original.xhrSend.call(this, body);
  };
  navigator.sendBeacon = function spiedBeacon(url: string | URL, data?: BodyInit | null) {
    requests.push({ via: "beacon", method: "POST", url: new URL(String(url), location.href).href });
    return original.sendBeacon.call(navigator, url, data);
  };

  class InstalledSocket extends FaultSocket {
    constructor(url: string | URL, _protocols?: string | string[]) {
      super(String(url), internals);
      sockets.push(this);
      // A socket opens or fails asynchronously, never inside its constructor.
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (state === "online") {
          this.open();
          if ((this.readyState as number) === 1) options.onOpen?.(this);
        } else {
          // No session or no network: the handshake fails and never opens.
          this.finish(1006, "", false);
        }
      }, 0);
    }
  }
  globalThis.WebSocket = InstalledSocket as unknown as typeof WebSocket;

  function closeOpen(code: number, reason: string, wasClean: boolean) {
    for (const s of sockets) if (s.readyState === 1 || s.readyState === 0) s.finish(code, reason, wasClean);
  }

  return {
    async request(url: string, init: RequestInit = {}) {
      requests.push({ via: "request", method: (init.method ?? "GET").toUpperCase(), url: new URL(url, location.href).href });
      return answer(url, init);
    },
    get state() { return state; },
    sockets,
    socket(match?: string) {
      for (let i = sockets.length - 1; i >= 0; i--) if (!match || sockets[i]!.url.includes(match)) return sockets[i];
      return undefined;
    },
    requests,
    frames: internals.frames,
    drop({ announce = false } = {}) {
      state = "down";
      closeOpen(1006, "", false);
      if (announce) {
        announced = true;
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        window.dispatchEvent(new Event("offline"));
      }
    },
    recover() {
      state = "online";
      if (announced) {
        announced = false;
        if (original.onLine) Object.defineProperty(navigator, "onLine", original.onLine);
        else delete (navigator as { onLine?: boolean }).onLine;
        window.dispatchEvent(new Event("online"));
      }
    },
    expireAuth() {
      state = "expired";
      closeOpen(1008, "Session expired", true);
    },
    restore() {
      // Sockets are left as they are: dispose the root that owns them first.
      globalThis.WebSocket = original.WebSocket;
      globalThis.fetch = original.fetch;
      XMLHttpRequest.prototype.open = original.xhrOpen;
      XMLHttpRequest.prototype.send = original.xhrSend;
      navigator.sendBeacon = original.sendBeacon;
      if (announced) {
        if (original.onLine) Object.defineProperty(navigator, "onLine", original.onLine);
        else delete (navigator as { onLine?: boolean }).onLine;
      }
    },
  };
}
