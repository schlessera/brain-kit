import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiCompletions } from "../src/providers/completions/gemini.js";
import { anthropicCompletions } from "../src/providers/completions/anthropic.js";
import { resolveCompletionProvider } from "../src/lib/registry.js";
import type { ContentPart } from "../src/lib/seams.js";

const savedFetch = globalThis.fetch;
const KEY = "BRAIN_VIDEO_TEST_KEY";
let env: Record<string, string | undefined>;
let directory: string;
let events: string[];
let generated: any;
let failGenerate: boolean;
let failDelete: boolean;
let processing: boolean;
let failedProcessing: boolean;
let hangAt: string;
let deleteSignal: AbortSignal | undefined;
let uploadSignal: AbortSignal | undefined;
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const active = () => ({ name: "files/odysseus", uri: "https://generativelanguage.googleapis.com/v1beta/files/odysseus", mimeType: "video/mp4", state: failedProcessing ? "FAILED" : "ACTIVE" });

beforeEach(() => {
  env = {};
  for (const key of [KEY, "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL"]) {
    env[key] = process.env[key]; delete process.env[key];
  }
  process.env[KEY] = "fictional-video-key";
  directory = mkdtempSync(join(tmpdir(), "brain-video-test-"));
  writeFileSync(join(directory, "odysseus.mp4"), "fictional-video-bytes");
  events = []; generated = null; failGenerate = false; failDelete = false;
  processing = false; failedProcessing = false; hangAt = ""; deleteSignal = undefined; uploadSignal = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let event: string;
    if (url.pathname === "/upload/v1beta/files") event = "upload-start";
    else if (url.pathname === "/upload-bytes") event = "upload-bytes";
    else if (url.pathname.endsWith(":generateContent")) event = "generate";
    else if (url.pathname === "/v1beta/files/odysseus") event = init?.method === "DELETE" ? "delete" : "poll";
    else throw new Error(`Unexpected fake request: ${url.pathname}`);
    events.push(event);
    if (event === "upload-bytes") uploadSignal = init?.signal ?? undefined;
    if (event === hangAt) {
      const signal = init?.signal;
      if (!signal) throw new Error("Request deadline was not attached to transport");
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (event === "upload-start") return json({}, { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload-bytes" });
    if (event === "upload-bytes") return json({ file: { ...active(), state: processing ? "PROCESSING" : active().state } }, { "x-goog-upload-status": "final" });
    if (event === "poll") return json(active());
    if (event === "delete") {
      deleteSignal = init?.signal ?? undefined;
      if (failDelete) return new Response(JSON.stringify({ error: { message: "cleanup refused" } }), { status: 400 });
      return json({});
    }
    generated = JSON.parse(String(init?.body));
    if (failGenerate) return new Response(JSON.stringify({ error: { message: "fictional generation failure" } }), { status: 400 });
    return json({ candidates: [{ content: { role: "model", parts: [{ text: "00:10 Preparations for the voyage." }] } }] });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});
const provider = () => geminiCompletions({ apiKeyEnv: KEY, model: "fictional-gemini-model" });
const local = (): Extract<ContentPart, { kind: "video" }> => ({ kind: "video", path: join(directory, "odysseus.mp4"), mimeType: "video/mp4" });

describe("Gemini video request mapping through the real SDK", () => {
  test("remote URI and clip offsets are exact, prompt remains separate", async () => {
    const answer = await provider().complete({ prompt: "What is visible?", parts: [{ kind: "video", uri: "https://www.youtube.com/watch?v=Odysseus001", mimeType: "video/mp4", clip: { start: 0, end: 120.5 } }] });
    expect(answer).toContain("00:10");
    expect(generated.contents[0].parts).toEqual([
      { fileData: { fileUri: "https://www.youtube.com/watch?v=Odysseus001", mimeType: "video/mp4" }, videoMetadata: { startOffset: "0s", endOffset: "120.5s" } },
      { text: "What is visible?" },
    ]);
    expect(events).toEqual(["generate"]);
  });
  test("a caller's Files API URI is used without deletion or upload", async () => {
    await provider().complete({ prompt: "Watch", parts: [{ kind: "video", uri: active().uri, mimeType: "video/mp4" }] });
    expect(generated.contents[0].parts[0]).toEqual({ fileData: { fileUri: active().uri, mimeType: "video/mp4" } });
    expect(events).toEqual(["generate"]);
  });
  test("a local path is uploaded, polled ACTIVE, generated and deleted", async () => {
    processing = true;
    await provider().complete({ prompt: "Watch", parts: [local()] });
    expect(events).toEqual(["upload-start", "upload-bytes", "poll", "generate", "delete"]);
    expect(generated.contents[0].parts[0]).toEqual({ fileData: { fileUri: active().uri, mimeType: "video/mp4" } });
  });
  test("local bytes use the Files API too", async () => {
    await provider().complete({ prompt: "Watch", parts: [{ kind: "video", data: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" }] });
    expect(events).toEqual(["upload-start", "upload-bytes", "generate", "delete"]);
  });
  test("generation failure still deletes the upload", async () => {
    failGenerate = true;
    await expect(provider().complete({ prompt: "Watch", parts: [local()] })).rejects.toThrow("fictional generation failure");
    expect(events).toEqual(["upload-start", "upload-bytes", "generate", "delete"]);
  });
  test("failed deletion is reported, including when generation also failed", async () => {
    failDelete = true;
    await expect(provider().complete({ prompt: "Watch", parts: [local()] })).rejects.toThrow("cleanup failed for files/odysseus");
    expect(events.at(-1)).toBe("delete");
    failGenerate = true;
    try { await provider().complete({ prompt: "Watch", parts: [local()] }); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect(String((error as AggregateError).errors[0])).toContain("fictional generation failure");
      expect(String((error as AggregateError).errors[1])).toContain("cleanup failed");
    }
  });
  test("FAILED processing deletes without generation", async () => {
    failedProcessing = true;
    await expect(provider().complete({ prompt: "Watch", parts: [local()] })).rejects.toThrow("did not become ACTIVE");
    expect(events).toEqual(["upload-start", "upload-bytes", "delete"]);
  });
  test("deadline during polling deletes with an un-aborted fresh signal", async () => {
    processing = true;
    await expect(provider().complete({ prompt: "Watch", parts: [local()], signal: AbortSignal.timeout(100) })).rejects.toThrow();
    expect(events).toEqual(["upload-start", "upload-bytes", "delete"]);
    expect(deleteSignal).toBeDefined();
    expect(deleteSignal!.aborted).toBe(false);
  });
  test("binary upload transport has the deadline even when SDK drops per-call options", async () => {
    hangAt = "upload-bytes";
    const start = performance.now();
    await expect(provider().complete({ prompt: "Watch", parts: [local()], signal: AbortSignal.timeout(50) })).rejects.toThrow();
    expect(events).toEqual(["upload-start", "upload-bytes"]);
    expect(uploadSignal).toBeDefined();
    expect(uploadSignal!.aborted).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  test("generation deadline still deletes", async () => {
    hangAt = "generate";
    await expect(provider().complete({ prompt: "Watch", parts: [local()], signal: AbortSignal.timeout(100) })).rejects.toThrow();
    expect(events.at(-1)).toBe("delete");
    expect(deleteSignal!.aborted).toBe(false);
  });
  for (const clip of [{ start: -1 }, { end: 0 }, { start: 20, end: 10 }, { start: NaN }]) {
    test(`invalid seam clip is refused before upload ${JSON.stringify(clip)}`, async () => {
      await expect(provider().complete({ prompt: "Watch", parts: [{ ...local(), clip }] })).rejects.toThrow("Invalid video clip");
      expect(events).toEqual([]);
    });
  }
});

describe("capability honesty and no silent fallback", () => {
  test("Gemini true, Anthropic false; direct Anthropic refuses before any HTTP request", async () => {
    expect(provider().capabilities.video).toBe(true);
    const anthropic = anthropicCompletions();
    expect(anthropic.capabilities.video).toBe(false);
    await expect(anthropic.complete({ prompt: "Watch", parts: [local()] })).rejects.toThrow("do not support video");
    expect(events).toEqual([]);
  });
  test("an ordinary completion retains configured fallback, video never uses it", async () => {
    let fallbackCalls = 0;
    const wrapped = resolveCompletionProvider({
      provider: { id: "gemini:fake", capabilities: { vision: true, video: true }, complete: async () => { throw new Error("primary failed"); } },
      fallback: { id: "other:fake", capabilities: { vision: true }, complete: async () => { fallbackCalls++; return "fallback"; } },
    });
    expect(wrapped.capabilities.video).toBe(true);
    await expect(wrapped.complete({ prompt: "Watch", parts: [local()] })).rejects.toThrow("primary failed");
    expect(fallbackCalls).toBe(0);
    expect(await wrapped.complete({ prompt: "ordinary" })).toBe("fallback");
    expect(fallbackCalls).toBe(1);
  });
});
