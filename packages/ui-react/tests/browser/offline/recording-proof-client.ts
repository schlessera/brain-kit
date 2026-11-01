import { commands } from "vitest/browser";
export async function retainRecordingProof(name: string, bytes: ArrayBuffer, measurements: unknown) {
  const parts: string[] = [];
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 8192) parts.push(String.fromCharCode(...view.subarray(i, i + 8192)));
  await commands.recordingProof(name, btoa(parts.join("")), JSON.stringify(measurements));
}
