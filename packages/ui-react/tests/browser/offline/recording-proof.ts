/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { resolve } from "node:path";
/** Retain actual native bytes and measurements before assertions, including failures. */
export const recordingProof: BrowserCommand<[string, string, string], void> = async (_ctx, name, base64, measurements) => {
  if (!["starvation", "control", "endurance"].includes(name)) throw new Error("Unknown recording proof");
  const directory = resolve("../../tmp/recording-proof");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [suffix, data] of [["webm", Buffer.from(base64, "base64")], ["json", measurements]] as const) {
    const fd = openSync(resolve(directory, `${name}.${suffix}`), "w", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { recordingProof(name: string, base64: string, measurements: string): Promise<void>; }
}
