/** EVALUATION ONLY / DO NOT MERGE. Concrete, removable diagnostic instrumentation.
 * No microphone route, provider startup, credentials or content breadcrumbs.
 */
const MAX_PROVIDER = 5_760_000;
const MAX_MIX = 24_000_000; // float32 mono, up to 120 s at 48 kHz (no requantization)
const MAX_EVENTS = 16_384;
const MAX_MS = 120_000;
type Fields = Record<string, string | number | boolean | null>;
type Block = { sequence: number; frame: number; samples: Float32Array };
let active: Recording | undefined;
let ordinaryContexts = 0;
let arming = false;
const owned = new WeakSet<AudioContext>();

export function evaluationEvent(kind: string, fields: Fields = {}) { active?.event(kind, fields); }
export function evaluationProvider(bytes: Uint8Array, rate: number, outputId: string, wireSequence = -1) { active?.provider(bytes, rate, outputId, wireSequence); }
export function evaluationPlaybackContext() { return active?.context; }
export function evaluationContextOpened(context: AudioContext) { if (!owned.has(context)) ordinaryContexts++; }
export function evaluationContextClosed(context: AudioContext) { if (!owned.has(context)) ordinaryContexts--; }
export function evaluationOwnsContext(context: AudioContext) { return owned.has(context); }
export function evaluationSchedule(bytes: Uint8Array, fields: Fields) {
  const providerByteOffset = active?.providerOffsets.get(bytes);
  evaluationEvent("playback-scheduled", { ...fields, providerByteOffset: providerByteOffset ?? -1 });
}
/** Called only on an AudioBufferSourceNode created by the playback queue. */
export function evaluationConnect(source: AudioBufferSourceNode) {
  if (active && source.context === active.context) source.connect(active.tap);
}

// All render quanta, including silence, are posted immediately. Never batch a
// partial last block. The extra destination branch always emits digital zero.
const processor = `class OutputTap extends AudioWorkletProcessor {
  constructor() { super(); this.sequence=0; this.bytes=0; this.start=null; this.done=false;
    this.port.onmessage=({data})=>{if(data==='finish') {this.port.postMessage({done:true,sequence:this.sequence,frame:currentFrame});this.done=true;}};
  }
  process(inputs, outputs) {
    if(this.done) return false;
    if(this.start===null) this.start=currentFrame;
    const n=outputs[0][0].length;
    if(this.bytes+n*4>24000000 || currentFrame-this.start>=sampleRate*120) {
      this.port.postMessage({cap:true,sequence:this.sequence,frame:currentFrame});this.done=true;return false;
    }
    const samples=new Float32Array(n); if(inputs[0]?.[0]) samples.set(inputs[0][0]);
    this.port.postMessage({sequence:this.sequence++,frame:currentFrame,samples},[samples.buffer]);this.bytes+=n*4;
    return true;
  }
} registerProcessor('brain-evaluation-output-only',OutputTap);`;

function wav(chunks: Uint8Array[], rate: number, float: boolean) {
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const header = new Uint8Array(44); const v = new DataView(header.buffer);
  for (const [at, text] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]] as const) for (let i = 0; i < text.length; i++) header[at + i] = text.charCodeAt(i);
  v.setUint32(4, size + 36, true); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * (float ? 4 : 2), true); v.setUint16(32, float ? 4 : 2, true); v.setUint16(34, float ? 32 : 16, true); v.setUint32(40, size, true);
  return new Blob([header, ...chunks as Uint8Array<ArrayBuffer>[]], { type: "audio/wav" });
}

class Recording {
  readonly started = performance.now();
  readonly utc = new Date().toISOString();
  readonly events: object[] = [];
  readonly providerChunks: Uint8Array[] = [];
  readonly mixChunks: Uint8Array[] = [];
  readonly providerOffsets = new WeakMap<Uint8Array, number>();
  readonly issues = new Set<string>();
  providerBytes = 0; mixBytes = 0; providerRate = 0; providerSequence = 0;
  nextSequence = 0; nextFrame: number | undefined; firstFrame: number | undefined;
  maxDeliveryMs = 0; lastDelivery = performance.now();
  finished = false;
  resolveFinish: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly context: AudioContext, readonly tap: AudioWorkletNode, readonly sourceSha: string) {}
  event(kind: string, fields: Fields = {}) {
    if (this.finished) return;
    if (this.events.length >= MAX_EVENTS) { this.issues.add("metadata-cap"); return; }
    this.events.push({ sequence: this.events.length, kind, wallMs: performance.now() - this.started, contextTime: this.context.currentTime, ...fields });
  }
  provider(bytes: Uint8Array, rate: number, outputId: string, wireSequence: number) {
    if (this.finished) return;
    if (performance.now() - this.started >= MAX_MS || this.providerBytes + bytes.byteLength > MAX_PROVIDER) { this.issues.add("provider-cap"); return; }
    if (!bytes.length || bytes.length > 65_536 || bytes.length % 2 || rate !== 24000 || this.providerRate && this.providerRate !== rate) { this.issues.add("provider-format-rejected"); return; }
    this.providerRate = rate;
    this.event("adapter-output-received", { audioSequence: this.providerSequence++, byteOffset: this.providerBytes, byteLength: bytes.byteLength, sampleRate: rate, outputId, wireSequence });
    this.providerOffsets.set(bytes, this.providerBytes);
    this.providerChunks.push(bytes.slice()); this.providerBytes += bytes.byteLength;
  }
  block(data: Block) {
    if (this.finished) { this.issues.add("post-finish-block"); return; }
    if (data.sequence !== this.nextSequence || this.nextFrame !== undefined && data.frame !== this.nextFrame) { this.issues.add("render-frame-or-sequence-gap"); this.event("render-gap", { expectedSequence: this.nextSequence, sequenceReceived: data.sequence, expectedFrame: this.nextFrame ?? -1, frameReceived: data.frame }); }
    this.firstFrame ??= data.frame;
    this.nextSequence = data.sequence + 1; this.nextFrame = data.frame + data.samples.length;
    const now = performance.now(); const delay = now - this.lastDelivery;
    this.maxDeliveryMs = Math.max(this.maxDeliveryMs, delay);
    if (delay > 250) this.event("callback-delivery-gap", { delayMs: delay, audioSequence: data.sequence });
    this.lastDelivery = now;
    if (this.mixBytes + data.samples.byteLength > MAX_MIX) { this.issues.add("mix-memory-cap"); return; }
    this.mixChunks.push(new Uint8Array(data.samples.buffer)); this.mixBytes += data.samples.byteLength;
  }
  async finish() {
    if (this.finished) throw new Error("Already exported; arm a fresh recording.");
    clearTimeout(this.timer);
    if (!this.providerBytes) this.issues.add("no-provider-output");
    if (!this.mixBytes) this.issues.add("no-mix-blocks");
    this.event("capture-finish-request");
    let acknowledged = false;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { this.issues.add("finish-ack-timeout"); resolve(); }, 2000);
      this.resolveFinish = () => { acknowledged = true; clearTimeout(timeout); resolve(); };
      this.tap.port.postMessage("finish");
    });
    this.event("capture-finished", { acknowledged });
    this.finished = true; if (active === this) active = undefined;
    this.tap.disconnect(); this.tap.port.onmessage = null;
    await this.context.close();
    const provider = wav(this.providerChunks, this.providerRate || 24000, false);
    const mix = wav(this.mixChunks, this.context.sampleRate, true);
    const hash = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, "0")).join("");
    const metadata = { version: "evaluation-only-1", sourceSha: this.sourceSha, utc: this.utc,
      boundary: "Adapter-received PCM before recovery filtering; mix is playback AudioBufferSource graph BEFORE driver/headphone hardware. No microphone audio recorded.",
      providerFinality: "unproven; complete describes capture integrity only",
      complete: acknowledged && this.issues.size === 0, issues: [...this.issues],
      limits: { wallMs: MAX_MS, providerBytes: MAX_PROVIDER, mixBytes: MAX_MIX, metadataEvents: MAX_EVENTS },
      provider: { provenance: "browser-adapter-received-not-raw-provider-wire", encoding: "pcm16le", channels: 1, sampleRate: this.providerRate || 24000, bytes: this.providerBytes, chunks: this.providerSequence, sha256: await hash(provider) },
      mix: { encoding: "float32le", channels: 1, sampleRate: this.context.sampleRate, bytes: this.mixBytes, blocks: this.nextSequence, firstFrame: this.firstFrame, endFrame: this.nextFrame, maxCallbackDeliveryMs: this.maxDeliveryMs, sha256: await hash(mix) }, events: this.events };
    return { provider, mix, metadata };
  }
}

/** Arm from an explicit browser gesture BEFORE entering voice. Setup makes no provider request. */
async function prepareEvaluationAudio(sourceSha: string) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("An exact source commit SHA is required.");
  if (active || ordinaryContexts) throw new Error("Leave voice and dispose existing playback before arming.");
  const context = new AudioContext({ sampleRate: 48000 }); owned.add(context);
  await context.suspend();
  if (context.sampleRate > 48000) { await context.close(); throw new Error("Mix sample rate exceeds bounded capture capacity."); }
  const url = URL.createObjectURL(new Blob([processor], { type: "text/javascript" }));
  try { await context.audioWorklet.addModule(url); } catch (e) { await context.close(); throw e; } finally { URL.revokeObjectURL(url); }
  const tap = new AudioWorkletNode(context, "brain-evaluation-output-only", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
  const recording = new Recording(context, tap, sourceSha);
  let first: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { first = resolve; });
  tap.port.onmessage = ({ data }) => {
    if (data.cap) { recording.issues.add("render-cap"); recording.resolveFinish?.(); return; }
    if (data.done) {
      if (data.sequence !== recording.nextSequence || recording.nextFrame !== undefined && data.frame !== recording.nextFrame) recording.issues.add("finish-frame-gap");
      recording.resolveFinish?.(); return;
    }
    recording.block(data); first?.(); first = undefined;
  };
  tap.onprocessorerror = () => recording.issues.add("processor-error");
  // Keep channel topology stable through silence and source end/disconnect.
  // This is a digital-zero playback source, never an input or microphone route.
  const zero = context.createBufferSource(); zero.buffer = context.createBuffer(1, 128, context.sampleRate); zero.loop = true; zero.connect(tap); zero.start();
  tap.connect(context.destination); // Processor emits zeros, never a second audible copy.
  await context.resume();
  try { await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Output tap did not start")), 2000))]); }
  catch (e) { tap.disconnect(); await context.close(); throw e; }
  active = recording;
  recording.event("capture-armed", { sampleRate: context.sampleRate });
  recording.timer = setTimeout(() => { recording.issues.add("wall-cap"); recording.event("capture-cap-expired"); recording.tap.port.postMessage("finish"); }, MAX_MS);
  return recording;
}

export async function armEvaluationAudio(sourceSha: string) {
  if (arming) throw new Error("Capture setup already in progress");
  arming = true;
  try { return await prepareEvaluationAudio(sourceSha); } finally { arming = false; }
}

// Deliberately unreleased console surface, removable with this entire experiment.
if (typeof window !== "undefined") Object.assign(window, { brainAudioEvaluation: { arm: armEvaluationAudio } });
