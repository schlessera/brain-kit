import { describe, test, expect, afterEach } from "bun:test";
import { DeepgramClient } from "../src/voice/asr-deepgram";

/**
 * The browser cannot set an Authorization header on a WebSocket, so Deepgram
 * credentials ride the sec-websocket-protocol header — and the scheme word has
 * to match the credential type. The server mints a short-lived
 * `/v1/auth/grant` access token, which Deepgram only accepts as `bearer`;
 * sending it as `token` (the raw-API-key scheme) fails the handshake with no
 * 101 and a 1002 close, which surfaced as a mic sheet that opened and
 * immediately closed again.
 */

interface FakeSocket {
  url: string;
  protocols: string[] | undefined;
  readyState: number;
  send: (data: unknown) => void;
  close: () => void;
  onopen: (() => void) | null;
  onmessage: ((evt: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

const GLOBALS = ["WebSocket", "MediaRecorder", "navigator"] as const;
let originals: Array<readonly [string, PropertyDescriptor | undefined]> = [];

/** Install just enough of the browser to get `start()` to the socket. */
function stubBrowser(): { sockets: FakeSocket[] } {
  originals = GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const sockets: FakeSocket[] = [];

  class FakeWebSocket implements FakeSocket {
    static OPEN = 1;
    url: string;
    protocols: string[] | undefined;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((evt: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string, protocols?: string[]) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this);
    }
    send() {}
    close() {}
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    ondataavailable: unknown = null;
    start() {}
    stop() {}
    state = "recording";
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: FakeMediaRecorder });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
    },
  });

  return { sockets };
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals = [];
});

describe("DeepgramClient handshake", () => {
  test("presents the minted token with the `bearer` scheme, not `token`", async () => {
    const { sockets } = stubBrowser();
    const client = new DeepgramClient({
      url: "wss://api.deepgram.com/v1/listen?model=nova-3",
      token: "minted-grant-token",
      onEvent: () => {},
    });

    await client.start();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.protocols).toEqual(["bearer", "minted-grant-token"]);
    // `token` is the raw-API-key scheme — the server never hands one out.
    expect(sockets[0]!.protocols?.[0]).not.toBe("token");
  });

  test("connects to the server-supplied URL verbatim", async () => {
    const { sockets } = stubBrowser();
    const url =
      "wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=Brainform";
    const client = new DeepgramClient({ url, token: "t", onEvent: () => {} });

    await client.start();

    expect(sockets[0]!.url).toBe(url);
  });
});
