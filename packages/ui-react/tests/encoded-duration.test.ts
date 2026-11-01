import { expect, test } from "bun:test";
import { createEncodedDurationMeter } from "../src/voice/encoded-duration.js";
const el = (id: number[], data: number[]) => [...id, 0x80 + data.length, ...data];
const prefix = [0x18,0x53,0x80,0x67,0xff, ...el([0x16,0x54,0xae,0x6b], el([0xae], [...el([0xd7],[1]), ...el([0x86],Array.from(new TextEncoder().encode("A_OPUS")))])),0x1f,0x43,0xb6,0x75,0xff];
const block = (packet: number[], flags = 0) => el([0xa3],[0x81,0,0,flags,...packet]);
test("complete Opus packets count identically at every split boundary", () => {
  const bytes = new Uint8Array([...prefix,...block([0x98,0])]);
  for (let split = 0; split <= bytes.length; split++) {
    const meter = createEncodedDurationMeter("audio/webm;codecs=opus");
    expect(meter.push(bytes.slice(0,split))).not.toBeNull();
    expect(meter.push(bytes.slice(split))).toBe(960);
  }
  const meter = createEncodedDurationMeter("audio/webm;codecs=opus");
  for (const byte of bytes.slice(0,-1)) expect(meter.push(new Uint8Array([byte]))).toBe(0);
  expect(meter.push(bytes.slice(-1))).toBe(960);
});
test("SILK, hybrid and CELT frames and packet counts use 48 kHz samples", () => {
  for (let config=0; config<32; config++) for (let code=0; code<4; code++) {
    const frame = config<12 ? [480,960,1920,2880][config%4]! : config<16 ? [480,960][config%2]! : [120,240,480,960][config%4]!;
    const count=code===0?1:2;
    expect(createEncodedDurationMeter("audio/webm;codecs=opus").push(new Uint8Array([...prefix,...block(code===0?[(config<<3)|code,0]:code===1?[(config<<3)|code,0,0]:code===2?[(config<<3)|code,1,0,0]:[(config<<3)|code,2,0,0])]))).toBe(frame*count);
  }
});
test("unsupported forms permanently refuse, with bounded carry for malicious lengths", () => {
  for (const bytes of [[...prefix,...block([0x98],6)],[...prefix,...block([0x9b,0])],[...prefix,0xa3,0],[...prefix,0xa3,0x10,0xff,0xff,0xff]]) {
    const meter=createEncodedDurationMeter("audio/webm;codecs=opus");
    expect(meter.push(new Uint8Array(bytes))).toBeNull();
    expect(meter.push(new Uint8Array(prefix))).toBeNull();
  }
  expect(createEncodedDurationMeter("audio/mp4").push(new Uint8Array(prefix))).toBeNull();
  const wrong=new Uint8Array(prefix); wrong[wrong.indexOf(65)]=66;
  expect(createEncodedDurationMeter("audio/webm;codecs=opus").push(wrong)).toBeNull();
});
