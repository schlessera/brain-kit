/**
 * Microphone feeding and interruption, browser side (#1016).
 *
 * In Chromium the `ui-react-layout` project's launch flags already make the
 * real `getUserMedia` play the 10-second fixture (`fake-microphone-file.ts`),
 * so a test there needs none of the injection below.
 *
 * - `installWavMicrophone(wav)`: for an engine without Chromium's fake-file
 *   flag (Firefox, WebKit). `getUserMedia` resolves a `MediaStream` decoded
 *   from the WAV through `AudioContext`, looped. Encoded output from it is
 *   comparable only within one browser, never across browsers.
 * - `watchMicrophone()`: records every stream `getUserMedia` hands out, real
 *   or injected, so a test can reach the track the app opened. `interrupt()`
 *   ends every live audio track the way the OS does: the track's state
 *   becomes `ended` and its `ended` event fires (a page's own `stop()` fires
 *   nothing, so the event is dispatched explicitly).
 * - `hidePage()`: the page becomes hidden (`visibilityState`, `hidden`, a
 *   `visibilitychange` event), as when the phone locks or the user switches
 *   away; the returned `show()` brings it back the same way.
 *
 * Each returns something to restore; call it when the test ends.
 */

export interface MicrophoneWatch {
  /** Every stream `getUserMedia` resolved since watching, oldest first. */
  readonly streams: readonly MediaStream[];
  /** End every live audio track, as an OS interruption does. */
  interrupt(): void;
  restore(): void;
}

export function installWavMicrophone(wav: Uint8Array): { restore(): void } {
  const media = navigator.mediaDevices;
  const original = media.getUserMedia;
  const contexts: AudioContext[] = [];
  media.getUserMedia = async function wavMicrophone(constraints?: MediaStreamConstraints) {
    if (!constraints?.audio) return original.call(media, constraints);
    const context = new AudioContext();
    contexts.push(context);
    const buffer = await context.decodeAudioData(wav.slice().buffer);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    source.start();
    // A context created outside a gesture starts suspended, and resumes only
    // where the runner allows autoplay (Chromium: the project's
    // `--autoplay-policy=no-user-gesture-required`).
    await context.resume();
    return destination.stream;
  };
  return {
    restore() {
      media.getUserMedia = original;
      for (const context of contexts) void context.close().catch(() => {});
    },
  };
}

export function watchMicrophone(): MicrophoneWatch {
  const media = navigator.mediaDevices;
  const original = media.getUserMedia;
  const streams: MediaStream[] = [];
  media.getUserMedia = async function watchedGetUserMedia(constraints?: MediaStreamConstraints) {
    const stream = await original.call(media, constraints);
    streams.push(stream);
    return stream;
  };
  return {
    streams,
    interrupt() {
      for (const stream of streams) {
        for (const track of stream.getAudioTracks()) {
          if (track.readyState === "ended") continue;
          track.stop();
          track.dispatchEvent(new Event("ended"));
        }
      }
    },
    restore() {
      media.getUserMedia = original;
    },
  };
}

/**
 * The loudest frequency in `stream` over `ms`, in Hz (resolution about 12 Hz
 * at 48 kHz). Tells the fixture's tone apart from any other source.
 */
export async function dominantFrequency(stream: MediaStream, ms = 600): Promise<number> {
  const context = new AudioContext();
  try {
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    context.createMediaStreamSource(stream).connect(analyser);
    const frame = new Float32Array(analyser.frequencyBinCount);
    const sum = new Float64Array(analyser.frequencyBinCount);
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatFrequencyData(frame);
      for (let i = 0; i < frame.length; i++) sum[i]! += Math.pow(10, frame[i]! / 10);
    }
    let peak = 1;
    for (let i = 2; i < sum.length; i++) if (sum[i]! > sum[peak]!) peak = i;
    return (peak * context.sampleRate) / analyser.fftSize;
  } finally {
    await context.close();
  }
}

export function hidePage(): { show(): void } {
  const doc = document;
  let hidden = true;
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => hidden });
  doc.dispatchEvent(new Event("visibilitychange"));
  return {
    show() {
      if (!hidden) return;
      hidden = false;
      delete (doc as { visibilityState?: unknown }).visibilityState;
      delete (doc as { hidden?: unknown }).hidden;
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  };
}
