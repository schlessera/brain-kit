/**
 * A relayed Gemini completion carries a local video through the host's
 * provider relay (#2738): the Files upload start, the bytes, the poll, the
 * generation and the delete all go to the relay socket, never the network, and
 * none carries a key. A cancelled request still deletes its uploaded file
 * through the relay. (Until #2738 the relay carried no Files lifecycle and a
 * relayed video was refused with `capability=video`.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiCompletions } from "../src/providers/completions/gemini.js";

const NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "BRAIN_WITHHELD_KEYS", "BRAIN_PROVIDER_RELAY_SOCKET", "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI"] as const;
const SOCKET = "/run/brain-egress/providers.sock";
const ORIGIN = "https://generativelanguage.googleapis.com";
const TOKEN = "6f1c2a8e-0d4b-4c51-9a7e-2b3c4d5e6f70";
const saved = new Map<string, PropertyDescriptor | undefined>();
const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
interface Sent { method: string; url: string; unix: unknown; headers: Record<string, string> }
let sent: Sent[];
let directory: string;
/** The step at which the fake relay holds the request until it is aborted. */
let hangAt: string;

beforeEach(() => {
  for (const name of NAMES) { saved.set(name, Object.getOwnPropertyDescriptor(process.env, name)); delete process.env[name]; }
  process.env.BRAIN_WITHHELD_KEYS = "GEMINI_API_KEY";
  process.env.BRAIN_PROVIDER_RELAY_SOCKET = SOCKET;
  sent = []; hangAt = "";
  directory = mkdtempSync(join(tmpdir(), "brain-relay-video-"));
  writeFileSync(join(directory, "troy.mp4"), "fictional-video-bytes");
  // The relay as the worker sees it: answers to the socket, with the upload URL rewritten to a relay token.
  Object.defineProperty(globalThis, "fetch", { ...savedFetch, value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    sent.push({ method: request.method, url: `${url.pathname}${url.search}`, unix: (init as { unix?: unknown } | undefined)?.unix,
      headers: Object.fromEntries(request.headers) });
    const step = url.pathname === "/upload/v1beta/files" ? url.search ? "upload" : "start"
      : url.pathname.endsWith(":generateContent") ? "generate" : request.method === "DELETE" ? "delete" : "poll";
    if (step === hangAt) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) { reject(new Error("no request deadline")); return; }
        if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const file = { name: "files/troy-1", uri: `${ORIGIN}/v1beta/files/troy-1`, mimeType: "video/mp4", state: "ACTIVE" };
    if (step === "start") return Response.json({}, { headers: { "x-goog-upload-url": `${ORIGIN}/upload/v1beta/files?brain_upload=${TOKEN}` } });
    if (step === "upload") return Response.json({ file: { ...file, state: "PROCESSING" } }, { headers: { "x-goog-upload-status": "final" } });
    if (step === "poll") return Response.json(file);
    if (step === "delete") return Response.json({});
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "00:10 The fleet leaves Troy." }] } }] });
  } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "fetch", savedFetch);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(process.env, name, descriptor); else delete process.env[name];
  }
  rmSync(directory, { recursive: true, force: true });
});

const video = () => ({ kind: "video" as const, path: join(directory, "troy.mp4"), mimeType: "video/mp4" });

test("a relayed local video runs its whole Files lifecycle through the relay socket, with no key", async () => {
  const answer = await geminiCompletions().complete({ prompt: "What happens first?", parts: [video()] });
  expect(answer, "RELAYED_VIDEO_COMPLETES").toContain("The fleet leaves Troy");
  expect(sent.map(request => `${request.method} ${request.url}`), "RELAYED_VIDEO_LIFECYCLE").toEqual([
    "POST /upload/v1beta/files",
    `POST /upload/v1beta/files?brain_upload=${TOKEN}`,
    "GET /v1beta/files/troy-1",
    "POST /v1beta/models/gemini-3-flash-preview:generateContent",
    "DELETE /v1beta/files/troy-1",
  ]);
  expect(sent.every(request => request.unix === SOCKET), "EVERY_STEP_THROUGH_RELAY_SOCKET").toBe(true);
  expect(sent.every(request => request.headers["x-brain-provider"] === "gemini" && request.headers["x-brain-provider-origin"] === ORIGIN)).toBe(true);
  expect(sent.filter(request => request.headers["x-goog-api-key"] || request.headers.authorization), "WORKER_SENDS_NO_KEY").toEqual([]);
});

test("a cancelled relayed video still deletes its uploaded file through the relay", async () => {
  hangAt = "poll";
  const controller = new AbortController();
  const pending = geminiCompletions().complete({ prompt: "What happens first?", parts: [video()], signal: controller.signal });
  for (let tries = 0; !sent.some(request => request.method === "GET") && tries < 2000; tries++) await Bun.sleep(5);
  controller.abort(new Error("Odysseus cancelled the watch"));
  const failure = await pending.then(() => "", (error: Error) => error.message);
  expect(failure).toContain("Odysseus cancelled the watch");
  const deletes = sent.filter(request => request.method === "DELETE");
  expect(deletes.map(request => request.url), "CANCELLED_VIDEO_DELETES_OWNED_FILE").toEqual(["/v1beta/files/troy-1"]);
  expect(deletes[0]!.unix, "CANCELLED_CLEANUP_THROUGH_RELAY").toBe(SOCKET);
  expect(sent.some(request => request.url.endsWith(":generateContent")), "CANCELLED_BEFORE_GENERATION").toBe(false);
});
