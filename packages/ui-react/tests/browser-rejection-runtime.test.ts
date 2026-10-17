import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chromium } from "playwright";
import { expectRejectedValue } from "./fixtures/expect-rejected-value.js";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Browser rejection runtime proof requires real Chrome");

// Test-only view of pinned Playwright's collocated protocol boundary. Observe
// actual messages; never manufacture, delay or replace a protocol delivery.
type Message = {
  method?: string;
  params?: { type?: string; guid?: string; initializer?: { url?: string }; response?: { guid: string } };
};
type Dispatcher = { onmessage(message: Message): unknown };
type Connection = {
  toImpl(connection: Connection): Dispatcher;
  dispatch(message: Message): unknown;
  _objects: Map<string, unknown>;
};

test.skipIf(!executablePath)("a browser rejection preserves creation before a later response reference", async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let finishStream: (() => void) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/probe") return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("Ithaca"));
      finishStream = () => controller.close();
    } }), { headers: { "content-type": "text/plain" } });
    return new Response("<!doctype html><title>Odysseus</title>", { headers: { "content-type": "text/html" } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const connection = (chromium as unknown as { _connection: Connection })._connection;
  const dispatcher = connection.toImpl(connection);
  const enqueueDescriptor = Object.getOwnPropertyDescriptor(dispatcher, "onmessage");
  const dispatchDescriptor = Object.getOwnPropertyDescriptor(connection, "dispatch");
  const enqueue = dispatcher.onmessage;
  const dispatch = connection.dispatch;
  const trace: Array<{ phase: string; method?: string; bound?: boolean }> = [];
  let responseGuid: string | undefined;
  let resume!: () => void;
  const creationQueued = new Promise<void>(resolve => { resume = resolve; });
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let passed = false;
  try {
    Object.defineProperty(dispatcher, "onmessage", { configurable: true, writable: true, value: function (this: Dispatcher, message: Message) {
      if (message.method === "__create__" && message.params?.type === "Response" && message.params.initializer?.url === `${origin}/probe`) {
        responseGuid = message.params.guid;
        // Put the awaiting continuation before the unmodified creation enqueue.
        // Closing the real HTTP stream there generates requestFinished on a later
        // native tick. A nested promise matcher lets it overtake this batch.
        setImmediate(resume);
      }
      if (responseGuid && (message.params?.guid === responseGuid || message.params?.response?.guid === responseGuid)) {
        trace.push({ phase: "enqueue", method: message.method });
      }
      return enqueue.call(this, message);
    } });
    Object.defineProperty(connection, "dispatch", { configurable: true, writable: true, value: function (this: Connection, message: Message) {
      if (responseGuid && (message.params?.guid === responseGuid || message.params?.response?.guid === responseGuid)) {
        trace.push({ phase: "deliver", method: message.method, bound: connection._objects.has(responseGuid) });
      }
      return dispatch.call(this, message);
    } });
    context = await browser.newContext();
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on("response", () => {}); // Subscribe to real response lifecycle events.
    await page.goto(origin);
    const finished = page.waitForEvent("requestfinished", { predicate: request => request.url() === `${origin}/probe` });
    await page.evaluate(() => {
      Object.assign(window, { __pendingResponse: fetch("/probe").then(response => response.text()) });
    });
    await creationQueued;
    expect(responseGuid, "an actual Response creation was queued").toBeDefined();
    expect(connection._objects.has(responseGuid!), "creation has not yet reached the client").toBe(false);
    const failure = new Error("the fixture deliberately stops before upload");
    await expectRejectedValue((async () => {
      finishStream!();
      finishStream = undefined;
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
      throw failure;
    })(), failure);
    expect(await page.evaluate(() => (window as unknown as { __pendingResponse: Promise<string> }).__pendingResponse)).toBe("Ithaca");
    await finished; // Browser-side fetch completion can precede driver event delivery.
    expect(trace.filter(event => event.phase === "enqueue").map(event => event.method)).toEqual(["__create__", "response", "requestFinished"]);
    expect(trace.filter(event => event.phase === "deliver").map(event => event.method)).toEqual(["__create__", "response", "requestFinished"]);
    expect(trace.filter(event => event.phase === "deliver" && event.method !== "__create__").every(event => event.bound)).toBe(true);
    passed = true;
  } finally {
    if (!passed) console.error("BROWSER_REJECTION_PROTOCOL", JSON.stringify(trace));
    try {
      finishStream?.();
      await context?.close();
    } finally {
      if (enqueueDescriptor) Object.defineProperty(dispatcher, "onmessage", enqueueDescriptor);
      else Reflect.deleteProperty(dispatcher, "onmessage");
      if (dispatchDescriptor) Object.defineProperty(connection, "dispatch", dispatchDescriptor);
      else Reflect.deleteProperty(connection, "dispatch");
      try { await browser.close(); }
      finally { server.stop(true); }
    }
  }
}, 30_000);
