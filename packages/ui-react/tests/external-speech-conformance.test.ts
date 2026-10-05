import { describe, expect, test } from "bun:test";
import { runAsrClientContract, type AsrClientContractProbe } from "@schlessera/brain-ui-sdk/testing";
import type { AsrClientOptions, AsrEvent, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { ExternalSpeechClient } from "./fixtures/external-speech-client";

const session: VoiceSessionResponse = {
  providerId: "fixture-speech", url: "ws://speech.example.test", params: { language: "en" }, expiresAt: 1000,
  capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
};

function create(options: AsrClientOptions): AsrClientContractProbe & { sent: Array<string | Blob>; tailSizes: number[] } {
  const descriptors = new Map(["navigator", "WebSocket", "MediaRecorder"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const track = { readyState: "live", stop() { this.readyState = "ended"; } };
  let acquired = false;
  const sockets: FakeSocket[] = [];
  const sent: Array<string | Blob> = [];
  const tailSizes: number[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) { expect(url).toBe(options.session.url); sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(data: string | Blob) { sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class FakeRecorder {
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        const tail = new Blob(["nonempty captured audio tail"]);
        tailSizes.push(tail.size);
        this.ondataavailable?.({ data: tail });
        this.onstop?.();
      });
    }
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { async getUserMedia() { acquired = true; return { getTracks: () => [track] }; } } } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  return {
    client: new ExternalSpeechClient(options),
    captureActive: () => acquired && track.readyState === "live",
    connectionActive: () => sockets[0]?.readyState === 1,
    sent, tailSizes,
    deliver: (event: AsrEvent) => { sockets[0]!.onmessage?.({ data: JSON.stringify(event) }); },
    fail: () => { sockets[0]!.onerror?.(); },
    finishDrain: (event) => {
      // This fixture can observe real audio/flush ordering. It does not
      // manufacture a successful drain when the client never requested one.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]).toBeInstanceOf(Blob);
      expect((sent[0] as Blob).size).toBeGreaterThan(0);
      expect(sent[1]).toBe(JSON.stringify({ type: "finish" }));
      sockets[0]!.onmessage?.({ data: JSON.stringify(event) });
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "drained" }) });
    },
    dispose() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

runAsrClientContract({ name: "external browser adapter with scripted capture and socket", session, create }, { describe, test, expect });

test("the external adapter consumes its supplied session URL and discards the recorder tail on hard stop", async () => {
  const events: AsrEvent[] = [];
  const probe = create({ session, onEvent: (event) => events.push(event), onError: (error) => { throw error; } });
  try {
    await probe.client.start();
    const client = probe.client as ExternalSpeechClient;
    expect(client.options.session).toEqual(session);
    await probe.deliver({ type: "final", text: "At the harbor", endsTurn: false });
    expect(events).toHaveLength(1);
    probe.client.stop();
    await Promise.resolve();
    expect(probe.tailSizes).toHaveLength(1);
    expect(probe.tailSizes[0]).toBeGreaterThan(0);
    expect(probe.sent).toHaveLength(0);
    expect(probe.captureActive()).toBe(false);
    expect(events).toEqual([{ type: "final", text: "At the harbor", endsTurn: false }]);
  } finally { probe.client.stop(); await probe.dispose(); }
});
