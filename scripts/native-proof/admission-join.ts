/** Offline measurement of both inference fences with real FULL audit writes. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { startInferenceRelay, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { openSqliteWriter } from "../../packages/ui-server/src/db/write-worker.js";
import { createGovernanceWrites } from "../../packages/ui-server/src/governance/event-writes.js";
import { prepareTurnEgress } from "../../packages/ui-server/src/brain/turn-egress.js";
import { request } from "node:http";

export async function measureAdmissionJoin(directory: string, samples = 5) {
  const root = mkdtempSync(join(directory, "admission-join-")), db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  const rows: { hold: "drained" | "removed"; delayMs: number; sample: number; queuedCommits: number; admitMs: number; credentialToDispatchMs: number; fences: number }[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { await req.arrayBuffer(); return new Response("Ithaca"); } });
  try {
    for (const hold of ["drained", "removed"] as const) for (const delayMs of [10, 50, 500]) for (let sample = 0; sample < samples; sample++) {
      const controller = new AbortController(), records: EgressRecord[] = [];
      let fences = 0;
      const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), controller,
        turnId: `voyage-${hold}-${delayMs}-${sample}`, sessionId: () => null, model: () => "odysseus", origin: "interactive", profile: "governed",
        bridge: { emit() {}, requestPermission: async () => ({ behavior: "deny" }) } as unknown as BackendBridge,
        record(event) { if (event.kind === "egress_connection") records.push(event.payload); return writes.record(event); } });
      const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
        inference(...args) { const operation = proxy.inference(...args); return { ...operation, async admit() { fences++; return operation.admit(); } }; },
      } });
      try {
        // Twenty prior completed inference audit rows queue twenty separate
        // FULL commits. No fake writer latency or durability setting is used.
        for (let i = 0; i < 20; i++) proxy.inference("POST", new URL("/v1/messages", origin.url), controller.signal).finish("completed");
        const resultAt = performance.now();
        if (hold === "drained") await proxy.settled();
        await Bun.sleep(Math.max(0, delayMs - (performance.now() - resultAt)));
        const status = await new Promise<number>((resolve, reject) => {
          const outgoing = request({ socketPath: relay.socketPath, path: "/v1/messages", method: "POST" }, response => {
            response.resume(); response.on("error", reject); response.on("end", () => resolve(response.statusCode!));
          }); outgoing.on("error", reject); outgoing.end('{"model":"odysseus","messages":[]}');
        });
        await proxy.settled();
        const measured = records.at(-1)!;
        if (status !== 200 || fences !== 2 || measured.admitMs === undefined || measured.dispatchMs === undefined || measured.credentialMs === undefined) throw Error("Admission join measurement missing a successful request, two fences or marks");
        rows.push({ hold, delayMs, sample, queuedCommits: 20, admitMs: measured.admitMs, credentialToDispatchMs: measured.dispatchMs - measured.credentialMs, fences });
      } finally { relay.stop(); controller.abort(); proxy.stop(); await proxy.settled(); }
    }
    return { coverage: "real FULL writer and Unix relay; synthetic twenty-record queue; no native worker or runtime assembly claim", rows };
  } finally { origin.stop(true); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw Error("Usage: admission-join.ts <private-existing-output-directory>");
  console.log(JSON.stringify(await measureAdmissionJoin(directory), null, 2));
}
