/** Keyless HTTP fixture for the default XHR transport: real upload progress,
 * a socket drop at forty percent, and provider-shaped local responses. */
/// <reference types="@vitest/browser-playwright" />
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { BrowserCommand } from "vitest/node";
import type { CDPSession } from "playwright";

type Operation = { op: "start"; drop: boolean } | { op: "stats" | "close"; id: string };
const fixtures = new Map<string, { server: Server; cdp: CDPSession; uploads: number; bytes: number; progress: number[] }>();
export const transcriptionHttp: BrowserCommand<[Operation], unknown> = async (ctx, request) => {
  if (request.op === "start") {
    const id = crypto.randomUUID();
    const state = { server: null as unknown as Server, cdp: await ctx.context.newCDPSession(ctx.page), uploads: 0, bytes: 0, progress: [] as number[] };
    let receipt: unknown;
    state.server = createServer((req, res) => {
      res.setHeader("Connection", "close");
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "null");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "content-type,content-sha256");
      res.setHeader("Access-Control-Allow-Methods", "GET,PUT,DELETE,OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const respond = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url?.endsWith("/capabilities")) { respond({ providerId: "deepgram", capabilities: { savedAudio: true } }); return; }
      if (req.method === "GET") { respond(receipt ?? {}, receipt ? 200 : 404); return; }
      if (req.method !== "PUT") { respond({}); return; }
      state.uploads++;
      const length = Number(req.headers["content-length"]);
      const hash = createHash("sha256");
      let read = 0;
      req.on("data", (chunk: Buffer) => {
        hash.update(chunk); read += chunk.byteLength; state.bytes += chunk.byteLength;
        const percent = Math.round(read / length * 100); state.progress.push(percent);
        if (request.drop && percent >= 40) req.socket.destroy();
      });
      req.on("end", () => {
        receipt = { recordingId: req.url!.split("/").at(-2), sha256: hash.digest("hex"), providerId: "deepgram", status: "done", attemptId: id, retryCount: 0, failures: [], text: "Odysseus asks Penelope about the loom order." };
        respond(receipt);
      });
    });
    await new Promise<void>(resolve => state.server.listen(0, "127.0.0.1", resolve));
    await state.cdp.send("Network.enable");
    await state.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 10, downloadThroughput: 10_000_000, uploadThroughput: 250_000 });
    fixtures.set(id, state);
    const address = state.server.address() as { port: number };
    return { id, url: `http://127.0.0.1:${address.port}` };
  }
  const state = fixtures.get(request.id)!;
  if (request.op === "stats") return { uploads: state.uploads, bytes: state.bytes, progress: state.progress };
  await state.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await state.cdp.detach(); state.server.closeAllConnections();
  await new Promise<void>(resolve => state.server.close(() => resolve())); fixtures.delete(request.id);
};
declare module "vitest/browser" { interface BrowserCommands { transcriptionHttp: (request: Operation) => Promise<unknown> } }
