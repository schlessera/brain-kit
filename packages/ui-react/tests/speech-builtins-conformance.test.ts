import { describe, expect, test } from "bun:test";
import { runAsrClientContract, type AsrClientContractHarness } from "@schlessera/brain-ui-sdk/testing";
import type { AsrEvent, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { DeepgramClient } from "../src/voice/asr-deepgram";
import { WebSpeechClient } from "../src/voice/asr-webspeech";

function session(id: string, endpointing: boolean): VoiceSessionResponse {
  return { providerId: id, url: "wss://speech.example.test", token: "fixture-grant", expiresAt: 1000, capabilities: { streaming: true, interimResults: true, keyterms: endpointing, endpointing } };
}

function replaceGlobals(values: Record<string, unknown>): () => void {
  const originals = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, value });
  return () => { for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); } };
}

const webspeech: AsrClientContractHarness = {
  name: "WebSpeechClient with scripted recognizer", session: session("webspeech", false),
  create(options) {
    const recognitions: FakeRecognition[] = [];
    class FakeRecognition {
      active = false;
      flushing = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() { recognitions.push(this); }
      start() { this.active = true; }
      abort() { this.active = false; }
      stop() { this.active = false; this.flushing = true; }
    }
    const dispose = replaceGlobals({ window: { SpeechRecognition: FakeRecognition } });
    const deliver = (event: AsrEvent) => recognitions[0]!.onresult?.({ resultIndex: 0, results: [{ isFinal: event.type === "final", 0: { transcript: event.text } }] });
    return {
      client: new WebSpeechClient(options), captureActive: () => recognitions[0]?.active ?? false,
      deliver, fail: () => { recognitions[0]!.onerror?.({ error: "fixture-recognition-failure" }); },
      finishDrain(event) { expect(recognitions[0]!.flushing).toBe(true); deliver(event); recognitions[0]!.onend?.(); }, dispose,
    };
  },
};

const deepgram: AsrClientContractHarness = {
  name: "DeepgramClient with scripted microphone and socket", session: session("deepgram", true),
  create(options) {
    const track = { active: false, stop() { this.active = false; } };
    const sockets: FakeSocket[] = [];
    const sent: unknown[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this); }
      send(data: unknown) { sent.push(data); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    class FakeRecorder {
      static isTypeSupported() { return true; }
      state = "inactive";
      ondataavailable: unknown = null;
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; }
    }
    const dispose = replaceGlobals({ WebSocket: FakeSocket, MediaRecorder: FakeRecorder, navigator: { mediaDevices: { async getUserMedia() { track.active = true; return { getTracks: () => [track] }; } } } });
    const deliver = (event: AsrEvent) => sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "Results", is_final: event.type === "final", speech_final: event.type === "final" && event.endsTurn, channel: { alternatives: [{ transcript: event.text }] } }) });
    return {
      client: new DeepgramClient({ url: options.session.url, token: options.session.token!, onEvent: options.onEvent, onError: options.onError }),
      captureActive: () => track.active, deliver, fail: () => { sockets[0]!.onerror?.(); },
      finishDrain(event) {
        expect(sent).toEqual([JSON.stringify({ type: "Finalize" }), JSON.stringify({ type: "CloseStream" })]);
        deliver(event);
        sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "Metadata" }) });
      }, dispose,
    };
  },
};

runAsrClientContract(webspeech, { describe, test, expect });
runAsrClientContract(deepgram, { describe, test, expect });
