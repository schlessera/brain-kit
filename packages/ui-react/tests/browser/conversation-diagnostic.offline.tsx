import { commands } from "vitest/browser";
import { afterEach, expect, test } from "vitest";
import { armEvaluationAudio, evaluationEvent, evaluationProvider } from "../../src/voice/evaluation-audio.js";
import { createConversationPlayback } from "../../src/voice/conversation-pcm.js";
const recordings: Awaited<ReturnType<typeof armEvaluationAudio>>[] = [];
const arm = async () => { const recording = await armEvaluationAudio(await commands.conversationDiagnosticIdentity()); recordings.push(recording); return recording; };
afterEach(async () => { for (const recording of recordings.splice(0)) if (!recording.finished) await recording.finish(); });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const format = { encoding: "pcm16", channels: 1, sampleRate: 24000 } as const;
function pcm(values: number[]) { const bytes = new Uint8Array(values.length * 2); const view = new DataView(bytes.buffer); values.forEach((x, i) => view.setInt16(i * 2, Math.round(x * 32767), true)); return bytes; }
function rms(xs: Float32Array) { return Math.sqrt(xs.reduce((sum, x) => sum + x*x, 0) / xs.length); }

test("diagnostic graph: known smooth tail and intentional cut differ; tap adds zero output", async () => {
  const capture = async (cut: boolean) => {
    const recording = await arm();
    const playback = createConversationPlayback(() => {}, () => {});
    const analyser = recording.context.createAnalyser(); recording.tap.connect(analyser); analyser.connect(recording.context.destination);
    const bytes = pcm(Array.from({ length: 12000 }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * i / 24000) * Math.min(1, (12000-i) / 7200)));
    evaluationProvider(bytes, 24000, "odysseus-tail");
    playback.enqueue("odysseus-tail", bytes, format); playback.quiet(true);
    await wait(180);
    const destinationBranch = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(destinationBranch);
    expect(rms(destinationBranch), "tap destination branch must emit exact zero").toBe(0);
    analyser.disconnect();
    if (cut) playback.cut();
    await wait(800);
    playback.dispose();
    const result = await recording.finish();
    const mix = new Float32Array((await result.mix.arrayBuffer()).slice(44));
    expect(result.metadata.complete, JSON.stringify({issues:result.metadata.issues, gaps:result.metadata.events.filter(e => "kind" in e && e.kind === "render-gap")})).toBe(true);
    expect(result.metadata.mix.blocks).toBeGreaterThan(100);
    expect(result.metadata.provider.bytes).toBe(bytes.length);
    expect(result.metadata.boundary).toContain("BEFORE driver/headphone");
    expect(Math.max(...mix)).toBeLessThan(.301); // No double playback at tap.
    const nonzero = [...mix.keys()].filter(i => Math.abs(mix[i]!) > .001);
    const end = nonzero.at(-1)!;
    const before = rms(mix.slice(end - 240, end));
    const after = rms(mix.slice(end + 128, end + 368));
    expect(after).toBe(0);
    const directory = await commands.conversationDiagnosticExport({ label: cut ? "cut" : "smooth", provider: [...new Uint8Array(await result.provider.arrayBuffer())], mix: [...new Uint8Array(await result.mix.arrayBuffer())], metadata: result.metadata });
    console.log("Output-only fixture", cut ? "cut" : "smooth", directory);
    return before;
  };
  const smooth = await capture(false);
  const cut = await capture(true);
  expect(smooth).toBeLessThan(.01);
  expect(cut).toBeGreaterThan(.17);
});

test("diagnostic retains final 37-sample chunk plus post-reply silence; no microphone setup", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator.mediaDevices, "getUserMedia");
  let microphoneCalls = 0;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: () => { microphoneCalls++; throw new Error("No input route allowed"); } });
  try {
    const recording = await arm();
    const playback = createConversationPlayback(() => {}, () => {});
    const chunks = [pcm(Array(2400).fill(.2)), pcm(Array(37).fill(.4)), pcm(Array(4800).fill(0))];
    playback.quiet(true);
    for (const bytes of chunks) { evaluationProvider(bytes, 24000, "odysseus-short"); playback.enqueue("odysseus-short", bytes, format); }
    await wait(700); playback.dispose();
    const result = await recording.finish();
    const mix = new Float32Array((await result.mix.arrayBuffer()).slice(44));
    expect(result.metadata.complete, JSON.stringify({issues:result.metadata.issues, gaps:result.metadata.events.filter(e => "kind" in e && e.kind === "render-gap")})).toBe(true);
    expect(result.metadata.provider.bytes).toBe(chunks.reduce((n, b) => n + b.length, 0));
    const peak = [...mix.keys()].filter(i => mix[i]! > .35);
    expect(peak.length).toBeGreaterThan(60); expect(peak.length).toBeLessThan(85);
    expect(rms(mix.slice(peak.at(-1)! + 100))).toBe(0);
    expect(microphoneCalls).toBe(0);
  } finally {
    if (descriptor) Object.defineProperty(navigator.mediaDevices, "getUserMedia", descriptor); else Reflect.deleteProperty(navigator.mediaDevices, "getUserMedia");
  }
});

test("diagnostic reports callback frame/sequence gaps and rejects wrong format and memory overflow", async () => {
  const recording = await arm();
  recording.block({ sequence: 900000, frame: 0, samples: new Float32Array(128) });
  evaluationProvider(new Uint8Array(3), 24000, "odysseus-invalid");
  evaluationProvider(new Uint8Array(5_760_002), 24000, "odysseus-cap");
  recording.block({ sequence: 900001, frame: 128, samples: new Float32Array(6_000_001) });
  evaluationEvent("resume-action", { ready: false });
  const result = await recording.finish();
  expect(result.metadata.complete).toBe(false);
  expect(result.metadata.issues).toContain("render-frame-or-sequence-gap");
  expect(result.metadata.issues).toContain("provider-format-rejected");
  expect(result.metadata.issues).toContain("provider-cap");
  expect(result.metadata.issues).toContain("mix-memory-cap");
  expect(result.metadata.events.some(e => "kind" in e && e.kind === "resume-action")).toBe(true);
});
