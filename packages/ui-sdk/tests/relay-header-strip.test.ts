/**
 * Both host relays strip the same headers a worker may not choose (#4763):
 * one shared request list and one shared response list, which the provider
 * relay extends with its own routing headers. Each wire row crosses a real
 * relay socket to a loopback upstream; a name `fetch` will not carry with an
 * arbitrary value is a unit row asserting membership of the shared set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { PROVIDER_RELAY_FAMILY_HEADER, PROVIDER_RELAY_KEY_HEADER, PROVIDER_RELAY_ORIGIN_HEADER } from "@schlessera/brain-common/internal/provider-relay";
import { ANTHROPIC_INFERENCE_ROUTES, startInferenceRelay } from "../src/server/inference-relay.js";
import { startProviderRelay } from "../src/server/provider-relay.js";
import { RELAY_REQUEST_STRIPPED, RELAY_RESPONSE_STRIPPED } from "../src/server/relay-response.js";

const MARKER = "odysseus-worker-chose-this";
/** Request names sent with the marker over the wire. */
const REQUEST_WIRE_ROWS = ["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "proxy-authorization",
  "proxy-connection", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "accept-encoding"];
/** Names a client cannot set to an arbitrary value through `fetch`: asserted as members only. */
const REQUEST_UNIT_ROWS = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade"];
const RESPONSE_WIRE_ROWS = ["content-encoding", "set-cookie"];
const RESPONSE_UNIT_ROWS = ["connection", "keep-alive", "transfer-encoding", "content-length"];

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<Record<string, string>> = [];
let answerHeader: string | undefined;
beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    seen.push(Object.fromEntries(request.headers));
    await request.arrayBuffer();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (answerHeader) headers[answerHeader] = MARKER;
    return new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { headers });
  } });
});
afterAll(() => upstream.stop(true));

function send(socketPath: string, path: string, headers: Record<string, string>):
  Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [], prompt: "Ithaca" }));
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, method: "POST", path,
      headers: { "content-type": "application/json", ...headers, "content-length": String(body.byteLength) } }, incoming => {
      incoming.resume();
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }))
        .on("aborted", () => reject(new Error("response socket closed mid-body"))).on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** One request through the inference relay. Its own credential uses a name outside every row. */
async function throughInference(headers: Record<string, string>) {
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ANTHROPIC_INFERENCE_ROUTES,
    credentials: { "x-odysseus-host-credential": "odysseus-host-held" } });
  seen.length = 0;
  try {
    const response = await send(relay.socketPath, "/v1/messages", headers);
    expect(response.status).toBe(200);
    return { upstream: [...seen], response };
  } finally { relay.stop(); }
}

/**
 * One request through the provider relay. The family is chosen so that the
 * relay's own key placement never writes the row's name: a placement would
 * overwrite the marker and hide a missing strip.
 */
async function throughProvider(headers: Record<string, string>, row?: string) {
  const openai = row === "x-api-key";
  const key = openai ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const relay = startProviderRelay({ credential: name => (name === key ? "odysseus-host-key" : undefined),
    origins: new Map([[key, [upstream.url.origin]]]) });
  seen.length = 0;
  try {
    const response = await send(relay.socketPath, openai ? "/v1/images/generations" : "/v1/messages", {
      [PROVIDER_RELAY_FAMILY_HEADER]: openai ? "openai" : "anthropic", [PROVIDER_RELAY_KEY_HEADER]: key,
      [PROVIDER_RELAY_ORIGIN_HEADER]: upstream.url.origin, ...headers });
    expect(response.status).toBe(200);
    return { upstream: [...seen], response };
  } finally { await relay.stop(); }
}

const relays = [["inference relay", throughInference], ["provider relay", throughProvider]] as const;

describe("shared relay strip lists", () => {
  test.each(REQUEST_UNIT_ROWS)("request unit row: %s is in the shared request list", name => {
    expect(RELAY_REQUEST_STRIPPED.has(name), "REQUEST_STRIP_MEMBER").toBe(true);
  });
  test.each(RESPONSE_UNIT_ROWS)("response unit row: %s is in the shared response list", name => {
    expect(RELAY_RESPONSE_STRIPPED.has(name), "RESPONSE_STRIP_MEMBER").toBe(true);
  });
  test("the rows cover each shared list exactly", () => {
    expect([...RELAY_REQUEST_STRIPPED].sort()).toEqual([...REQUEST_WIRE_ROWS, ...REQUEST_UNIT_ROWS].sort());
    expect([...RELAY_RESPONSE_STRIPPED].sort()).toEqual([...RESPONSE_WIRE_ROWS, ...RESPONSE_UNIT_ROWS].sort());
  });

  for (const [label, through] of relays) {
    describe(label, () => {
      test.each(REQUEST_WIRE_ROWS)("request wire row: a worker's %s never reaches the upstream", async name => {
        const { upstream } = await through({ [name]: MARKER }, name);
        expect(upstream).toHaveLength(1);
        expect(Object.entries(upstream[0]!).filter(([, value]) => value.includes(MARKER)), "REQUEST_MARKER_STRIPPED").toEqual([]);
      });
      test.each(RESPONSE_WIRE_ROWS)("response wire row: an upstream's %s never reaches the worker", async name => {
        answerHeader = name;
        try {
          const { response } = await through({});
          expect(Object.entries(response.headers).filter(([, value]) => String(value).includes(MARKER)), "RESPONSE_MARKER_STRIPPED").toEqual([]);
        } finally { answerHeader = undefined; }
      });
    });
  }

  test.each([PROVIDER_RELAY_FAMILY_HEADER, PROVIDER_RELAY_KEY_HEADER, PROVIDER_RELAY_ORIGIN_HEADER])(
    "provider routing row: %s never reaches the upstream", async name => {
      const { upstream } = await throughProvider({});
      expect(upstream).toHaveLength(1);
      expect(upstream[0]![name], "ROUTING_HEADER_STRIPPED").toBeUndefined();
    });
});
