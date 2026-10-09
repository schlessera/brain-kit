import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainApi, ApiRequestError } from "../src/lib/api-client.js";
import { createBrainRoutes } from "../../ui-server/src/routes/brain.js";
import type { BrainClient } from "../../ui-server/src/brain/client.js";
import type { KeytermSettings } from "../../ui-server/src/voice/keyterm-builder.js";

const terminal = 'data: {"type":"done","success":true,"text":"Sync café completed"}\n\n';
const progress = 'data: {"type":"progress","text":"Working"}\n\n';
const sseHeaders = { "Content-Type": "text/event-stream; charset=utf-8" };

function byteResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, ++at));
    },
  }), { headers: sseHeaders });
}

function clientFor(response: () => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let base = "/old-api";
  const client = createBrainApi(() => base, async (url, init) => {
    requests.push({ url, init });
    return response();
  });
  base = "/current-api";
  return { client, requests };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Sync fixture did not start");
    await Bun.sleep(10);
  }
}

describe("published sync helper through actual routes", () => {
  test.each([0, 1])("maps nonempty real progress and terminal data for exit %d", async (exit) => {
    const root = mkdtempSync(join(tmpdir(), "api-sync-"));
    const script = join(root, "fixture.ts");
    writeFileSync(script, `console.log("Fixture progress"); process.exit(${exit});`);
    const app = createBrainRoutes({
      brainPath: root,
      brain: { cliCommand: () => [process.execPath, script] } as BrainClient,
      keyterms: { brainPath: root } as KeytermSettings,
      exec: {},
    });
    const records: string[] = [];
    const client = createBrainApi(() => "/api", async (url, init) => {
      const response = await app.request(url.slice(4), init);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      // Observe and return the actual bytes, rather than manufacturing a terminal result.
      const text = await response.text();
      records.push(text);
      return byteResponse(text);
    });
    try {
      const outcome = await client.brainSync().then(result => ({ result }), error => ({ error }));
      expect(outcome).toEqual({ result: { success: exit === 0, message: exit === 0 ? "Sync completed" : "Sync failed (exit 1)" } });
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('"type":"progress","text":"Fixture progress"');
      expect(records[0]).toContain('"type":"done","success":');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("transport loss stays incomplete while the real server drains and reserves the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-sync-reservation-"));
    const started = join(root, "started");
    const release = join(root, "release");
    const script = join(root, "fixture.ts");
    writeFileSync(script, `import {existsSync, writeFileSync} from "node:fs";
      writeFileSync(${JSON.stringify(started)}, "yes"); console.log("Working");
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      process.exit(1);`);
    const app = createBrainRoutes({ brainPath: root,
      brain: { cliCommand: () => [process.execPath, script] } as BrainClient,
      keyterms: { brainPath: root } as KeytermSettings, exec: {} });
    let calls = 0;
    const client = createBrainApi(() => "/api", async (url, init) => {
      calls++;
      const response = await app.request(url.slice(4), init);
      if (!response.ok) return response;
      const reader = response.body!.getReader();
      let reads = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (reads++ === 0) {
            const chunk = await reader.read();
            expect(chunk.value?.length).toBeGreaterThan(0);
            controller.enqueue(chunk.value!);
          } else {
            await reader.cancel();
            reader.releaseLock();
            controller.error(new Error("fixture connection lost"));
          }
        },
      }), { headers: response.headers });
    });
    try {
      await expect(client.brainSync()).rejects.toThrow("incomplete");
      await until(() => existsSync(started));
      const busy = await client.brainSync().catch(error => error);
      expect(busy).toBeInstanceOf(ApiRequestError);
      expect(busy.status).toBe(409);
      expect(calls).toBe(2); // One per explicit call, with no automatic POST retry.
    } finally {
      writeFileSync(release, "go");
      // Drain a retry to observe reservation release before removing the child fixture.
      const deadline = Date.now() + 5_000;
      let response: Response;
      do {
        await Bun.sleep(10);
        response = await app.request("/brain/sync", { method: "POST" });
      } while (response.status === 409 && Date.now() < deadline);
      expect(response.status).toBe(200);
      await response.text();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sync event framing and incomplete outcomes", () => {
  test.each(["\n", "\r\n", "\r"])("reads UTF-8, comments and multiline data with %j one byte at a time", async (newline) => {
    const text = '\uFEFF: keepalive\n\n' + progress + 'id: unused\nevent: message\nretry: 1000\n'
      + 'data: {"type":"done",\n: comment inside event\ndata: "success":true,"text":"Sync café completed"}\n\n';
    const { client, requests } = clientFor(() => byteResponse(text.replaceAll("\n", newline)));
    const outcome = await client.brainSync().then(result => ({ result }), error => ({ error }));
    expect(outcome).toEqual({ result: { success: true, message: "Sync café completed" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/current-api/brain/sync");
    expect(requests[0]?.init?.method).toBe("POST");
  });

  test("terminal false resolves as a completed unsuccessful sync", async () => {
    const { client } = clientFor(() => byteResponse(progress + terminal.replace('true', 'false')));
    await expect(client.brainSync()).resolves.toEqual({ success: false, message: "Sync café completed" });
  });

  test.each([
    ["no terminal", progress],
    ["unterminated event", progress + terminal.trimEnd() + "\n"],
    ["missing success", 'data: {"type":"done","text":"message"}\n\n'],
    ["wrong success type", 'data: {"type":"done","success":"true","text":"message"}\n\n'],
    ["missing text", 'data: {"type":"done","success":true}\n\n'],
    ["wrong text type", 'data: {"type":"done","success":true,"text":3}\n\n'],
    ["malformed JSON", 'data: {"type":"done",\n\n'],
    ["progress masquerading as result", 'data: {"type":"progress","success":true,"text":"working"}\n\n'],
  ])("rejects incomplete sync: %s", async (_, text) => {
    const { client, requests } = clientFor(() => byteResponse(text));
    await expect(client.brainSync()).rejects.toThrow("incomplete");
    expect(requests).toHaveLength(1);
  });

  test("rejects a missing body", async () => {
    const { client } = clientFor(() => new Response(null, { headers: sseHeaders }));
    await expect(client.brainSync()).rejects.toThrow("incomplete");
  });

  test("rejects a non-SSE success response", async () => {
    const { client } = clientFor(() => new Response('{"success":true,"message":"invented"}', { headers: { "Content-Type": "application/json" } }));
    await expect(client.brainSync()).rejects.toThrow("incomplete");
  });

  test("a complete terminal resolves without waiting for EOF and releases its reader", async () => {
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(terminal));
        closeTimer = setTimeout(() => controller.close(), 1_000);
      },
      cancel() { cancelled = true; clearTimeout(closeTimer); },
    }), { headers: sseHeaders });
    const { client } = clientFor(() => response);
    await expect(client.brainSync()).resolves.toEqual({ success: true, message: "Sync café completed" });
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });

  test("request failure rejects as incomplete without retry", async () => {
    const { client, requests } = clientFor(() => { throw new Error("fixture offline"); });
    await expect(client.brainSync()).rejects.toThrow("incomplete");
    expect(requests).toHaveLength(1);
  });

  test.each([403, 409, 500])("preserves non-2xx ApiRequestError %d", async (status) => {
    const { client } = clientFor(() => new Response('{"error":"fixture denied","errors":[{"path":"sync","message":"blocked"}]}', { status, headers: { "Content-Type": "application/json" } }));
    const error = await client.brainSync().catch(error => error);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status, message: "fixture denied", errors: [{ path: "sync", message: "blocked" }] });
  });
});
