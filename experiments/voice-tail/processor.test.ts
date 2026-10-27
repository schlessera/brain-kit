/** Keyless processor protocol proof; real graph proof lives in the browser suite. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const code = readFileSync(new URL("../../packages/ui-react/src/voice/evaluation-audio.ts", import.meta.url), "utf8").match(/const processor = `([\s\S]*?)`;/)![1]!;
function setup() {
  const messages: any[] = [];
  let Processor: any;
  let frame = 0, frameReads = 0, timeReads = 0;
  const scope = { Float32Array, sampleRate: 48000,
    get currentFrame() { frameReads++; return frame; },
    get currentTime() { timeReads++; return frame / 48000; },
    AudioWorkletProcessor: class { port = { postMessage: (message: any) => messages.push(message), onmessage: undefined }; },
    registerProcessor: (_name: string, type: any) => { Processor = type; },
  };
  runInNewContext(code, scope);
  const processor = new Processor();
  return { processor, messages, step(at: number, input = Float32Array.from({ length: 128 }, (_, i) => (at + i + 1) / 8388608)) {
    frame = at; frameReads = 0; timeReads = 0;
    const output = new Float32Array(128);
    const alive = processor.process([[input]], [[output]]);
    return { output, alive, input, frameReads, timeReads };
  } };
}
test("tap snapshots each browser clock once and retains observed repeat/jump with independent sample offsets", () => {
  const { step, messages } = setup();
  for (const frame of [0, 128, 128, 384]) {
    const result = step(frame);
    expect(result.frameReads).toBe(1); expect(result.timeReads).toBe(1);
    expect(result.output.every(x => x === 0)).toBe(true);
    expect(messages.at(-1).samples).toEqual(result.input);
  }
  expect(messages.map(x => x.frame)).toEqual([0, 128, 128, 384]);
  expect(messages.map(x => x.time)).toEqual([0, 128/48000, 128/48000, 384/48000]);
  expect(messages.map(x => x.sampleOffset)).toEqual([0, 128, 256, 384]);
  expect(messages.map(x => x.sequence)).toEqual([0, 1, 2, 3]);
});
test("tap finish acknowledgement retains terminal observed clock and cumulative samples", () => {
  const { processor, step, messages } = setup();
  step(0); step(128); // The handler observes the browser clock, never substitutes a counter.
  processor.port.onmessage({ data: "finish" });
  expect(messages.at(-1)).toMatchObject({ done: true, sequence: 2, frame: 128, time: 128/48000, sampleOffset: 256 });
  expect(step(256).alive).toBe(false);
});
test("tap render and byte caps terminate without posting another sample block", () => {
  for (const cap of ["render", "bytes"]) {
    const { processor, step, messages } = setup();
    step(0);
    if (cap === "bytes") processor.bytes = 24_000_000;
    const result = step(cap === "render" ? 48000 * 120 : 128);
    expect(result.alive).toBe(false);
    expect(messages.at(-1)).toMatchObject({ cap: true, sequence: 1, sampleOffset: 128 });
    expect(result.output.every(x => x === 0)).toBe(true);
    expect(messages.filter(x => x.samples).length).toBe(1);
  }
});
