import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startInferenceRelay, startProviderRelay } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createEffectiveSafety } from "../src/governance/effective-safety";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { occurrence } from "../src/governance/occurrence";
import { queryGovernanceEvents } from "../src/governance/events";
import { connectedSafetySession } from "./helpers/connected-safety";
import * as heldWriter from "./fixtures/held-publication-writer";

function exchange(socketPath: string, path: string, method = "GET", headers: Record<string, string> = {}, body = "") {
  return new Promise<number>((resolve, reject) => {
    const child = request({ socketPath, path, method, headers }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject);
    });
    child.once("error", reject); child.end(body);
  });
}

for (const kind of ["inference", "provider"] as const) {
  for (const mode of ["healthy", "shared loss", "independent pending", "revocation", "cancellation"] as const) {
    test(`${kind} joins its own completed egress recording before admission: ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "odysseus-relay-settlement-")), db = createUiDb(join(root, "ui.db"));
      connectedSafetySession(db, "ithaca", "voyage");
      const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), controller = new AbortController();
      const channel = writer.channel(heldWriter, {}); await channel.ready;
      expect(await channel.call<number>("level")).toBe(2);
      const entered = new Int32Array(new SharedArrayBuffer(4)), release = new Int32Array(new SharedArrayBuffer(4));
      const otherEntered = new Int32Array(new SharedArrayBuffer(4)), otherRelease = new Int32Array(new SharedArrayBuffer(4));
      const binding = (db.query("SELECT id FROM safety_collections WHERE turn_id='voyage'").get() as { id: string }).id;
      const submitted = Promise.withResolvers<void>();
      let held: Promise<unknown> | undefined, otherHeld: Promise<unknown> | undefined, pending: Promise<unknown> | undefined, authority = true, upstream = 0;
      const safety = createEffectiveSafety(db, { turnId: "voyage", sessionId: () => "ithaca", policyHash: null, writes,
        authority: () => ({ current: authority, epoch: authority ? "0" : "1" }) });
      const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (request.method === "POST") { upstream++; await request.arrayBuffer(); return Response.json({ candidates: [] }); }
        return new Response("Ithaca");
      } });
      const proxy = await prepareTurnEgress({ controller, policy: resolveGovernancePolicy({ schema_version: 1 }),
        turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive",
        bridge: { admissionSafety: safety, emit() {}, requestPermission: async () => ({ behavior: "deny" }) } as unknown as BackendBridge,
        governanceDb: db, governanceWrites: writes, record(event) {
          // Hold the real FULL transaction just before terminal exposure storage,
          // after the worker has received its HTTP body, as in the native failure.
          if (event.kind === "taint_exposure" && !held) {
            held = channel.call("hold", entered, release);
            const result = writes.record(event).then(value => {
              if (mode === "independent pending") {
                // This separate ingestion stays held after the proxy's own
                // exposure has committed. It is outside proxy.settled().
                otherHeld = channel.call("hold", otherEntered, otherRelease);
                pending = writes.firstTaint({ turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: "governed",
                  kind: "taint", payload: { source: "web_fetch", tool: "WebFetch", detail: null,
                    occurrence: occurrence(binding, "tool_web_input", "other-input", "open") } });
              }
              return value;
            });
            submitted.resolve(); return result;
          }
          return writes.record(event);
        } });
      const path = kind === "inference" ? "/v1/messages" : "/v1beta/models/gemini-2.5-flash:generateContent";
      // The relay's admission of its own operation, observed: when it starts, and when it answers.
      const admission = { entered: Promise.withResolvers<void>(), answered: false };
      const observed = <Operation extends { admit(): Promise<boolean> }>(operation: Operation): Operation => ({ ...operation, admit() {
        admission.entered.resolve();
        return operation.admit().finally(() => { admission.answered = true; });
      } });
      const egress = { ...proxy, inference: (...args: Parameters<typeof proxy.inference>) => observed(proxy.inference(...args)),
        relayed: (...args: Parameters<typeof proxy.relayed>) => observed(proxy.relayed(...args)) };
      const relay = kind === "inference"
        ? startInferenceRelay({ upstream: origin.url.origin, routes: [path], credentials: { "x-api-key": "odysseus-host-key" }, egress })
        : startProviderRelay({ egress, credential: name => name === "GEMINI_API_KEY" ? "odysseus-host-key" : undefined,
          origins: new Map([["GEMINI_API_KEY", [origin.url.origin]]]) });
      let dispatch: Promise<number> | undefined;
      try {
        expect(await exchange(proxy.socketPath, origin.url.href)).toBe(200);
        await submitted.promise;
        const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
        expect(Atomics.load(entered, 0)).toBe(1);
        expect(safety.read().recordingAvailable).toBe(false);
        const body = JSON.stringify({ contents: [{ parts: [{ text: "Rank the harbours of Ithaca." }] }] });
        const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
          ...(kind === "provider" ? { "x-brain-provider": "gemini", "x-brain-provider-key": "GEMINI_API_KEY", "x-brain-provider-origin": origin.url.origin } : {}) };
        let completed = false;
        dispatch = exchange(relay.socketPath, path, "POST", headers, body).then(status => { completed = true; return status; });
        // The relay has received the request and asked to admit it. Its own
        // recording is held in the worker; everything else admission awaits is
        // in memory, so one macrotask runs whatever does not wait for the hold.
        await admission.entered.promise;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(admission.answered, "RELAY_WAITS_FOR_OWN_EGRESS_RECORDING").toBe(false);
        expect(completed, "RELAY_WAITS_FOR_OWN_EGRESS_RECORDING").toBe(false);
        expect(upstream).toBe(0);
        if (mode === "shared loss") pending = writes.safetyFail("other-turn");
        else if (mode === "revocation") authority = false;
        else if (mode === "cancellation") controller.abort();
        if (mode === "cancellation") {
          const status = await Promise.race([dispatch, Bun.sleep(1000).then(() => { throw new Error("Relay cancellation waited for SQLite"); })]);
          expect(status).toBe(499);
        }
        Atomics.store(release, 0, 1); Atomics.notify(release, 0);
        await held;
        const status = await dispatch;
        expect(status, "SETTLED_HEALTHY_RELAY_CONTINUES_WITHOUT_RETRY").toBe(mode === "healthy" ? 200 : mode === "cancellation" ? 499 : 403);
        expect(upstream, "ADVERSE_RELAY_RUNS_NOTHING").toBe(mode === "healthy" ? 1 : 0);
        if (mode === "independent pending") expect(safety.read().recordingAvailable).toBe(false);
        Atomics.store(otherRelease, 0, 1); Atomics.notify(otherRelease, 0);
        await otherHeld; await pending; await proxy.settled();
        expect(writes.safety("voyage", "ithaca").restriction).toBe("restricted");
        expect(queryGovernanceEvents(db, { kinds: ["taint_exposure"], limit: 10 }).map(row => row.payload),
          "RELAY_SETTLEMENT_PRESERVES_EXPOSURE").toMatchObject([{ state: "finalized" }]);
      } finally {
        Atomics.store(release, 0, 1); Atomics.notify(release, 0); controller.abort();
        Atomics.store(otherRelease, 0, 1); Atomics.notify(otherRelease, 0);
        await relay.stop(); proxy.stop(); await Promise.allSettled([held, otherHeld, pending, dispatch]);
        await proxy.settled(); origin.stop(true); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
