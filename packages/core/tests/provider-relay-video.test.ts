/**
 * The provider relay carries fixed POST routes, never the Files upload, poll
 * and delete lifecycle a video needs (#1673): a relayed Gemini completion
 * refuses a video part before any request, naming the provider.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseProviderUnavailable } from "@schlessera/brain-common/internal/provider-unavailable";
import { geminiCompletions } from "../src/providers/completions/gemini.js";

const NAMES = ["GEMINI_API_KEY", "BRAIN_WITHHELD_KEYS", "BRAIN_PROVIDER_RELAY_SOCKET"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
let requests = 0;
beforeEach(() => {
  for (const name of NAMES) saved.set(name, Object.getOwnPropertyDescriptor(process.env, name));
  delete process.env.GEMINI_API_KEY;
  process.env.BRAIN_WITHHELD_KEYS = "GEMINI_API_KEY";
  process.env.BRAIN_PROVIDER_RELAY_SOCKET = "/run/brain-egress/providers.sock";
  requests = 0;
  Object.defineProperty(globalThis, "fetch", { ...savedFetch, value: async () => { requests++; throw new Error("no request expected"); } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "fetch", savedFetch);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(process.env, name, descriptor); else delete process.env[name];
  }
});

test("a relayed Gemini completion refuses video before any request", async () => {
  const provider = geminiCompletions();
  const failure = await provider.complete({ prompt: "Summarise the voyage.",
    parts: [{ kind: "video", mimeType: "video/mp4", data: new Uint8Array([1, 2, 3]) }] }).then(() => "", (error: Error) => error.message);
  expect(parseProviderUnavailable(failure), "RELAYED_VIDEO_REFUSED").toEqual([
    { provider: "gemini", capability: "video", key: "GEMINI_API_KEY", degradedTo: null },
  ]);
  expect(requests).toBe(0);
});
