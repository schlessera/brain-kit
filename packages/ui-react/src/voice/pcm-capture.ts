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
  /**
   * Graceful end of input: the worklet posts the samples it holds short of a
   * full block, `receive` gets them after every block posted before them,
   * and then this resolves. Capture keeps running; the caller stops it.
   * Resolves at once when nothing is capturing, and when `stop()` runs first.
   */
  flush(): Promise<void>;
  /** Idempotent hard stop: worklet, source, tracks and AudioContext. */
  stop(): void;
}

/** Samples the worklet gathers before it posts a block. */
export const PCM_CAPTURE_BLOCK = 4096;

/**
 * The capture worklet, as the AudioWorkletGlobalScope evaluates it. It posts
 * each full block as a bare Float32Array, which is all live conversation ever
 * receives. Only a "flush" request makes it post `{ flushed }`, the partial
 * block it holds, which also acknowledges the request.
 */
const PCM_CAPTURE_WORKLET = `class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(${PCM_CAPTURE_BLOCK}); this.used = 0;
    this.port.onmessage = ({ data }) => {
      if (data !== "flush") return;
      this.port.postMessage({ flushed: this.samples.slice(0, this.used) }); this.used = 0;
    };
  }
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
  const flushes: Array<() => void> = [];
  const settleFlushes = () => { for (const settle of flushes.splice(0)) settle(); };
  const stop = () => {
    stopped = true;
    settleFlushes();
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
      const url = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET], { type: "text/javascript" }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (stopped) { stop(); return; }
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "brain-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
      const resample = createPcmResampler(context.sampleRate, rate);
      const deliver = (block: Float32Array) => {
        let energy = 0;
        for (const value of block) energy += value * value;
        receive(resample(block), block.length ? Math.sqrt(energy / block.length) : 0);
      };
      node.port.onmessage = ({ data }: MessageEvent<Float32Array | { flushed: Float32Array }>) => {
        if (stopped) return;
        if (data instanceof Float32Array) { deliver(data); return; }
        if (!(data?.flushed instanceof Float32Array)) return;
        if (data.flushed.length) deliver(data.flushed);
        settleFlushes();
      };
      source.connect(node);
      await context.resume();
      if (stopped) { stop(); return; }
      opened();
    } catch (error) { stop(); throw error; }
  })();
  const flush = () => {
    if (stopped || !node) return Promise.resolve();
    const port = node.port;
    return new Promise<void>((resolve) => {
      flushes.push(resolve);
      // The worklet answers after every block it already posted.
      port.postMessage("flush");
    });
  };
  return { ready, flush, stop };
}

/** Little-endian bytes of PCM16 samples, independent of platform endianness. */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return bytes;
}
