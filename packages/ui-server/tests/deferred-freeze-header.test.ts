import { expect, test } from "bun:test";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { fixture, send } from "./helpers/deferred-freeze-fixture";

test("received upstream headers are charged before waiting for the result gate", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const boundary = Promise.withResolvers<boolean>(), checkpoint = f.native.manager.checkpoint;
  let upstream = 0, charged = false;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstream++; return new Response("Ithaca", { headers: { "x-odysseus": "Ithaca" } });
  } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    ...f.proxy, inference(...args) {
      const operation = f.proxy.inference(...args);
      return { ...operation,
        charge(bytes) { if (upstream && bytes > 0) charged = true; return operation.charge(bytes); },
        responseReady() { boundary.resolve(charged); return operation.responseReady(); },
      };
    },
  } });
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const observed = f.result(), response = send(relay.socketPath); void response.catch(() => {});
    await entered.promise;
    expect(await boundary.promise, "UPSTREAM_HEADERS_ARE_CHARGED_BEFORE_THE_OBSERVATION_WAIT").toBe(true);
    release.resolve(); await observed;
    expect((await response).status).toBe(200); expect(upstream).toBe(1);
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});
