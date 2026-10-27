import type { ConversationAudioFormat, ConversationPlayback } from "@schlessera/brain-ui-sdk/protocol";

/** Concrete browser PCM transport. No recorder codec or independent speech service. */
export function openConversationMicrophone(rate: number, receive: (pcm: Uint8Array, speaking: boolean) => void, opened: () => void, interrupted: () => void) {
  let stopped = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const stop = () => {
    stopped = true;
    if (node) { node.port.onmessage = null; node.disconnect(); }
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close();
  };
  const ready = (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (stopped) { stop(); return; }
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => { if (!stopped) { stop(); interrupted(); } }, { once: true });
      context = new AudioContext();
      const code = `class Capture extends AudioWorkletProcessor {
        constructor() { super(); this.samples = new Float32Array(4096); this.used = 0; }
        process(inputs) {
          const input = inputs[0]?.[0];
          if (input) for (const sample of input) {
            this.samples[this.used++] = sample;
            if (this.used === this.samples.length) {
              this.port.postMessage(this.samples.slice()); this.used = 0;
            }
          }
          return true;
        }
      } registerProcessor("brain-conversation-capture", Capture);`;
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (stopped) { stop(); return; }
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "brain-conversation-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
      const ratio = context.sampleRate / rate;
      let cursor = 0;
      node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (stopped) return;
        const samples: number[] = [];
        let energy = 0;
        for (const value of data) energy += value * value;
        for (; cursor < data.length; cursor += ratio) {
          const at = Math.floor(cursor);
          const value = data[at]! + ((data[Math.min(at + 1, data.length - 1)] ?? 0) - data[at]!) * (cursor - at);
          samples.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
        }
        cursor -= data.length;
        const bytes = new Uint8Array(samples.length * 2);
        const view = new DataView(bytes.buffer);
        samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
        receive(bytes, Math.sqrt(energy / data.length) > 0.015);
      };
      source.connect(node);
      await context.resume();
      if (stopped) { stop(); return; }
      opened();
    } catch (error) { stop(); throw error; }
  })();
  return { ready, stop };
}

/** One queue owns all local output, including chunks waiting for a quiet boundary. */
export function createConversationPlayback(report: (outputId: string, state: ConversationPlayback) => void, changed: () => void) {
  let context: AudioContext | undefined;
  let generation = 0;
  let availableAt = 0;
  let blocked = true;
  const waiting: { outputId: string; bytes: Uint8Array; format: ConversationAudioFormat }[] = [];
  const live = new Map<AudioBufferSourceNode, { outputId: string; audible: [number, number][] }>();
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
      const window = Math.max(1, Math.round(chunk.format.sampleRate / 100));
      for (let offset = 0; offset < samples.length; offset += window) {
        const end = Math.min(offset + window, samples.length);
        if (!samples.subarray(offset, end).some(sample => sample !== 0)) continue;
        const startTime = availableAt + offset / chunk.format.sampleRate;
        const endTime = availableAt + end / chunk.format.sampleRate;
        const previous = audible.at(-1);
        if (previous && previous[1] === startTime) previous[1] = endTime;
        else audible.push([startTime, endTime]);
      }
      live.set(source, { outputId: chunk.outputId, audible });
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
    cut() {
      generation++;
      clearTimeout(boundary);
      const ids = new Set([...live.values()].map(item => item.outputId).concat(waiting.map((chunk) => chunk.outputId)));
      waiting.length = 0;
      for (const source of live.keys()) { source.onended = null; source.stop(); source.disconnect(); }
      live.clear();
      availableAt = 0;
      for (const id of ids) { discarded.add(id); report(id, touched.has(id) ? "unknown" : "discarded"); }
      changed();
    },
    dispose() {
      this.cut();
      blocked = true;
      if (context) { context.onstatechange = null; if (context.state !== "closed") void context.close(); }
    },
  };
}
