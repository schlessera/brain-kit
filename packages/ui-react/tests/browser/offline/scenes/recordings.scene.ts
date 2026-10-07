import { createBrainUiRoot } from "../../../../src/root.js";
import { defineScene } from "../define-scene.ts";
import type { RecordingEvent } from "../../../../src/lib/recordings.js";
import { watchMicrophone } from "../fake-microphone.ts";

const mic = watchMicrophone();
const root = createBrainUiRoot({ storagePrefix: "odysseus-recording-scene", localCapture: true });
const store = root.recordings!;
let committed = 0;
let began = 0;
const events: RecordingEvent[] = [];
store.onEvent((event) => { events.push(event); if (event.kind === "committed") committed = event.savedThroughMs; });
defineScene({
  async start() { began = performance.now(); await store.start(); },
  async stop() { await store.stop("user"); },
  boundary: () => ({ committed, elapsed: performance.now() - began }),
  async recover() { return store.recover("unassigned"); },
  async playback(id: string) {
    const audio = await store.playback("unassigned", id);
    try {
      const bytes = await (await fetch(audio.url)).arrayBuffer();
      const context = new AudioContext();
      try { return (await context.decodeAudioData(bytes)).duration; } finally { await context.close(); }
    } finally { audio.revoke(); }
  },
  micCalls: () => mic.streams.length,
  events: () => events,
  async tryStart() { try { await store.start(); return "started"; } catch (error) { return (error as Error).message; } },
});
