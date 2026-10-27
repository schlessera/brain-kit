import { commands } from "vitest/browser";
import { expect, test } from "vitest";
import { armEvaluationAudio } from "../../src/voice/evaluation-audio.js";
import { createConversationPlayback } from "../../src/voice/conversation-pcm.js";
import { compareScheduledSamples } from "../../../../experiments/voice-tail/sample-integrity.js";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const secondContext of [false, true]) test(`diagnostic compares every nonrepeating 48k sample and silence edge; second context ${secondContext}`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator.mediaDevices, "getUserMedia");
  let microphoneCalls = 0;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: () => { microphoneCalls++; throw new Error("No microphone in output proof"); } });
  let synthetic: AudioContext | undefined;
  let recording: Awaited<ReturnType<typeof armEvaluationAudio>> | undefined;
  const playback = createConversationPlayback(() => {}, () => {});
  try {
    if (secondContext) {
      synthetic = new AudioContext({ sampleRate: 48000 });
      const source = synthetic.createBufferSource(); source.buffer = synthetic.createBuffer(1, 128, 48000); source.loop = true;
      const url = URL.createObjectURL(new Blob([
        "registerProcessor('odysseus-synthetic-input', class extends AudioWorkletProcessor { process() { return true; } });",
      ], { type: "text/javascript" }));
      try { await synthetic.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const input = new AudioWorkletNode(synthetic, "odysseus-synthetic-input", { numberOfInputs: 1, numberOfOutputs: 0 });
      source.connect(input); source.start(); await synthetic.resume();
    }
    recording = await armEvaluationAudio(await commands.conversationDiagnosticIdentity());
    expect(recording.context.sampleRate).toBe(48000);
    let seed = 0x4f647973;
    const expected = Float32Array.from({ length: 720037 }, () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed & 65535) - 32768) / 32768;
    });
    // A scheduled 100 ms zero prefix gives later source starts a known future
    // render frame. These zeros are included in the whole-capture comparison.
    const prefix = new Uint8Array(4800 * 2);
    playback.enqueue("odysseus-zero-prefix", prefix, { encoding: "pcm16", channels: 1, sampleRate: 48000 });
    for (let from = 0; from < expected.length; from += 16000) {
      const chunk = expected.subarray(from, Math.min(from + 16000, expected.length));
      const bytes = new Uint8Array(chunk.length * 2); const view = new DataView(bytes.buffer);
      chunk.forEach((x, i) => view.setInt16(i * 2, x * 32768, true));
      playback.enqueue("odysseus-nonrepeating", bytes, { encoding: "pcm16", channels: 1, sampleRate: 48000 });
    }
    // Provider format validation stays at 24k; this graph-only proof deliberately
    // has no provider output and may never claim a complete paired recording.
    playback.quiet(true);
    await wait(15600); playback.dispose();
    const result = await recording.finish();
    const mix = new Float32Array((await result.mix.arrayBuffer()).slice(44));
    const schedules = result.metadata.events.filter((e): e is { kind: string; outputId: string; start: number; frames: number } => "kind" in e && e.kind === "playback-scheduled");
    const start = Math.round(schedules.find(e => e.outputId === "odysseus-nonrepeating")!.start * 48000) - result.metadata.mix.firstFrame!;
    const comparison = compareScheduledSamples(mix, expected, start);
    console.log("Nonrepeating output graph proof", JSON.stringify({ secondContext, firstFrame: result.metadata.mix.firstFrame, start, comparison, scheduledFrameFractions: schedules.map(e => e.start * 48000 - Math.round(e.start * 48000)), issues: result.metadata.issues, gaps: result.metadata.events.filter(e => "kind" in e && e.kind === "render-gap") }));
    expect(comparison.mismatches, JSON.stringify(comparison)).toBe(0);
    expect(comparison.startupSamples).toBeGreaterThanOrEqual(4800);
    expect(comparison.finishSamples).toBeGreaterThan(4800);
    expect(result.metadata.mix.capturedSamples).toBe(mix.length);
    expect(result.metadata.mix.observedSampleOffset).toBe(mix.length);
    expect(result.metadata.complete).toBe(false);
    expect(result.metadata.issues).toContain("no-provider-output");
    expect(result.metadata.issues.filter(x => x !== "no-provider-output" && x !== "render-frame-or-sequence-gap" && x !== "finish-frame-gap")).toEqual([]);
    expect(microphoneCalls).toBe(0);
  } finally {
    playback.dispose();
    if (recording && !recording.finished) await recording.finish();
    await synthetic?.close();
    if (descriptor) Object.defineProperty(navigator.mediaDevices, "getUserMedia", descriptor); else Reflect.deleteProperty(navigator.mediaDevices, "getUserMedia");
  }
}, 25000);
