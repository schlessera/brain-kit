import type { ConversationAudioFormat, ConversationPlayback } from "@schlessera/brain-ui-sdk/protocol";
import { openPcmMicrophone, pcm16Bytes } from "./pcm-capture.js";

/**
 * A 0–1 meter reading from a block's RMS amplitude. Display only: it never
 * gates capture, endpointing or playback evidence.
 */
function meterLevel(rms: number) {
  return Math.max(0, Math.min(1, rms / 0.25));
}

/** Concrete browser PCM transport. No recorder codec or independent speech service. */
export function openConversationMicrophone(rate: number, receive: (pcm: Uint8Array, speaking: boolean, level: number) => void, opened: () => void, interrupted: () => void) {
  return openPcmMicrophone(rate, (pcm, rms) => receive(pcm16Bytes(pcm), rms > 0.015, meterLevel(rms)), opened, interrupted);
}

/** One queue owns all local output, including chunks waiting for a quiet boundary. */
export function createConversationPlayback(report: (outputId: string, state: ConversationPlayback) => void, changed: () => void) {
  let context: AudioContext | undefined;
  let generation = 0;
  let availableAt = 0;
  let blocked = true;
  const waiting: { outputId: string; bytes: Uint8Array; format: ConversationAudioFormat }[] = [];
  // `levels` holds one meter reading per 10 ms window from `start`.
  const live = new Map<AudioBufferSourceNode, { outputId: string; audible: [number, number][]; start: number; step: number; levels: number[] }>();
  let boundary: ReturnType<typeof setTimeout> | undefined;
  // PCM magnitude cannot prove physical audibility. Only digital silence is
  // excluded: every nonzero sample conservatively protects a 10 ms window.
  // Times belong to the AudioContext clock, not arrival or wall-clock time.
  const playingIds = () => context?.state === "running" ? [...new Set([...live.values()]
    .filter(({ audible }) => audible.some(([start, end]) => context!.currentTime >= start && context!.currentTime < end))
    .map(({ outputId }) => outputId))] : [];
  function scheduleBoundary() {
    clearTimeout(boundary);
    if (context?.state !== "running") return;
    const now = context.currentTime;
    const next = Math.min(...[...live.values()].flatMap(({ audible }) => audible.flat()).filter(time => time > now));
    if (Number.isFinite(next)) boundary = setTimeout(() => { changed(); scheduleBoundary(); }, Math.ceil((next - now) * 1000) + 5);
  }
  const discarded = new Set<string>();
  const touched = new Set<string>();
  function pump() {
    if (blocked) return;
    while (waiting.length) {
      const chunk = waiting.shift()!;
      if (discarded.has(chunk.outputId)) continue;
      if (!context) {
        context = new AudioContext();
        context.onstatechange = () => { changed(); scheduleBoundary(); };
      }
      if (Math.max(0, availableAt - context.currentTime) + chunk.bytes.byteLength / (2 * chunk.format.sampleRate) > 80) throw new Error("Speech playback queue is full.");
      void context.resume();
      const buffer = context.createBuffer(1, chunk.bytes.byteLength / 2, chunk.format.sampleRate);
      const samples = buffer.getChannelData(0);
      const view = new DataView(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      availableAt = Math.max(context.currentTime, availableAt);
      const audible: [number, number][] = [];
      const levels: number[] = [];
      const window = Math.max(1, Math.round(chunk.format.sampleRate / 100));
      for (let offset = 0; offset < samples.length; offset += window) {
        const end = Math.min(offset + window, samples.length);
        let energy = 0;
        for (let i = offset; i < end; i++) energy += samples[i]! * samples[i]!;
        levels.push(meterLevel(Math.sqrt(energy / (end - offset))));
        if (!samples.subarray(offset, end).some(sample => sample !== 0)) continue;
        const startTime = availableAt + offset / chunk.format.sampleRate;
        const endTime = availableAt + end / chunk.format.sampleRate;
        const previous = audible.at(-1);
        if (previous && previous[1] === startTime) previous[1] = endTime;
        else audible.push([startTime, endTime]);
      }
      live.set(source, { outputId: chunk.outputId, audible, start: availableAt, step: window / chunk.format.sampleRate, levels });
      touched.add(chunk.outputId);
      const own = generation;
      source.onended = () => {
        source.disconnect();
        live.delete(source);
        if (own !== generation) return;
        // The service has no output-done signal. This describes the chunks
        // actually drained, never completion of provider generation or work.
        if (![...live.values()].some(item => item.outputId === chunk.outputId) && !waiting.some((x) => x.outputId === chunk.outputId)) report(chunk.outputId, "played");
        changed(); scheduleBoundary();
      };
      source.start(availableAt);
      availableAt += buffer.duration;
    }
    changed(); scheduleBoundary();
  }
  function flush(retire: boolean) {
    generation++;
    clearTimeout(boundary);
    const ids = new Set([...live.values()].map(item => item.outputId).concat(waiting.map((chunk) => chunk.outputId)));
    waiting.length = 0;
    for (const source of live.keys()) { source.onended = null; source.stop(); source.disconnect(); }
    live.clear();
    availableAt = 0;
    for (const id of ids) { if (retire) discarded.add(id); report(id, touched.has(id) ? "unknown" : "discarded"); }
    changed();
  }
  return {
    enqueue(outputId: string, bytes: Uint8Array, format: ConversationAudioFormat) {
      if (discarded.has(outputId)) return;
      if (waiting.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0) + bytes.byteLength > 4_000_000) throw new Error("Speech playback queue is full.");
      waiting.push({ outputId, bytes, format });
      pump();
    },
    quiet(value: boolean) { blocked = !value; pump(); },
    pending: () => waiting.length > 0 || live.size > 0,
    playing: () => playingIds().length > 0,
    playingIds,
    /** The reading of whatever sounds now, for the meter only. */
    level() {
      if (context?.state !== "running") return 0;
      const now = context.currentTime;
      for (const item of live.values()) {
        const at = Math.floor((now - item.start) / item.step);
        if (at >= 0 && at < item.levels.length) return item.levels[at]!;
      }
      return 0;
    },
    // A local floor/tone flush cannot retire an epoch-wide provider identity.
    // Only cancellation/teardown rejects later chunks with the same identity.
    flush() { flush(false); },
    cut() { flush(true); },
    dispose() {
      this.cut();
      blocked = true;
      if (context) { context.onstatechange = null; if (context.state !== "closed") void context.close(); }
    },
  };
}
