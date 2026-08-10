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

const originals = {
  WebSocket: globalThis.WebSocket,
  MediaRecorder: (globalThis as any).MediaRecorder,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

/** Install just enough of the browser to get `start()` to the socket. */
function stubBrowser(): { sockets: FakeSocket[] } {
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
  (globalThis as any).WebSocket = FakeWebSocket;

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    ondataavailable: unknown = null;
    start() {}
    stop() {}
    state = "recording";
  }
  (globalThis as any).MediaRecorder = FakeMediaRecorder;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
    },
  });

  return { sockets };
}

afterEach(() => {
  (globalThis as any).WebSocket = originals.WebSocket;
  (globalThis as any).MediaRecorder = originals.MediaRecorder;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
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
