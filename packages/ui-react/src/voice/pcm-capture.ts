/**
 * Browser microphone → mono PCM16 LE at a requested rate, through an
 * AudioWorklet. Shared by live conversation and Gemini dictation (#3708); it
 * holds no state of either. The AudioContext runs at the hardware rate
 * (never assumed to be the target rate) and every block is resampled here.
 */

/**
 * Streaming linear resampler, Float32 at `from` Hz → Int16 at `to` Hz. The
 * fractional position carries across blocks. Byte-for-byte the algorithm live
 * conversation has always used (its PCM witness tests depend on that): the
 * last output position of a block interpolates toward that block's own last
 * sample rather than the next block's first.
 */
export function createPcmResampler(from: number, to: number): (block: Float32Array) => Int16Array {
  if (!(from > 0) || !(to > 0)) throw new Error("PCM resampler rates must be positive.");
  const step = from / to;
  let cursor = 0;
  return (block) => {
    const out: number[] = [];
    for (; cursor < block.length; cursor += step) {
      const at = Math.floor(cursor);
      const value = block[at]! + ((block[Math.min(at + 1, block.length - 1)] ?? 0) - block[at]!) * (cursor - at);
      out.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
    }
    cursor -= block.length;
    return Int16Array.from(out);
  };
}

export interface PcmMicrophone {
  /** Resolves once audio flows; rejects when the microphone or worklet cannot open. */
  ready: Promise<void>;
  /** Idempotent hard stop: worklet, source, tracks and AudioContext. */
  stop(): void;
}

/**
 * Open the microphone and deliver resampled PCM16 LE blocks with their RMS
 * level. `interrupted` reports a track the browser ended (device unplugged,
 * permission revoked) after capture opened.
 */
export function openPcmMicrophone(
  rate: number,
  receive: (pcm: Int16Array, rms: number) => void,
  opened: () => void,
  interrupted: () => void,
): PcmMicrophone {
  let stopped = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const stop = () => {
    stopped = true;
    if (node) { node.port.onmessage = null; node.disconnect(); node = undefined; }
    source?.disconnect(); source = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close().catch(() => {});
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
      } registerProcessor("brain-pcm-capture", Capture);`;
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (stopped) { stop(); return; }
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "brain-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
      const resample = createPcmResampler(context.sampleRate, rate);
      node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (stopped) return;
        let energy = 0;
        for (const value of data) energy += value * value;
        receive(resample(data), data.length ? Math.sqrt(energy / data.length) : 0);
      };
      source.connect(node);
      await context.resume();
      if (stopped) { stop(); return; }
      opened();
    } catch (error) { stop(); throw error; }
  })();
  return { ready, stop };
}

/** Little-endian bytes of PCM16 samples, independent of platform endianness. */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return bytes;
}
