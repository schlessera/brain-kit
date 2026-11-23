import { request } from "node:http";
import { safeStartupTiming } from "../../src/server/startup-timing.js";
import { startInferenceRelay } from "../../src/server/inference-relay.js";

const events: string[] = [];
const reject = async (name: string) => { events.push(name); throw Error(`Ithaca asynchronous diagnostic unavailable: ${name}`); };
if (process.argv[2] === "startup") {
  const timing = safeStartupTiming({ start: () => () => reject("completion"),
    worker: () => reject("worker"), missing: () => reject("missing"), received: () => reject("received") })!;
  timing.start("worker_launch")(); timing.worker("resources", 31); timing.missing("first_enqueue"); timing.received();
  safeStartupTiming({ start: () => () => ({ then(_resolve: unknown, fail: (error: Error) => void) { events.push("thenable"); fail(Error("Ithaca thenable diagnostic unavailable")); } }),
    worker() {}, missing() {}, received() {} })!.start("worker_launch")();
  safeStartupTiming({ start: () => () => {}, worker() {}, missing() {},
    received() { events.push("pending"); return new Promise(() => {}); } })!.received();
  await new Promise<void>(resolve => setImmediate(resolve));
  console.log(JSON.stringify(events));
} else if (process.argv[2] === "relay") {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { events.push("upstream"); return new Response("Ithaca model response"); } });
  let receipts = 0;
  const relay = startInferenceRelay({ upstream: `http://127.0.0.1:${upstream.port}`, routes: ["/v1/messages"],
    received() { if (++receipts === 1) return reject("receipt"); events.push("pending receipt"); return new Promise(() => {}); },
    observe: event => reject(event.outcome), credentials: async () => { events.push("credentials"); return { "x-api-key": "ithaca-fixture" }; } });
  const send = (method: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: relay.socketPath, method, path: "/v1/messages" }, response => {
      let body = "";
      response.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => resolve({ status: response.statusCode!, body })).on("error", reject);
    });
    req.on("error", reject); req.end();
  });
  try {
    const responses = [await send("POST"), await send("POST"), await send("GET")];
    await new Promise<void>(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ responses, events }));
  } finally { relay.stop(); await upstream.stop(true); }
} else throw Error("Unknown Ithaca diagnostic fixture mode");
