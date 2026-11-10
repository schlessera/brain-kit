import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startInferenceRelay, startProviderRelay } from "@schlessera/brain-ui-sdk/internal";
import { historyHost } from "./fixtures/provider-history-host";
import { fixtureBrain } from "./fixtures/provider-history-brain";
import { makeFakeBackend } from "../packages/ui-server/tests/helpers/fake-backend";
import { makeBridge } from "../packages/ui-server/src/ws/bridge";
import { prepareTurnEgress } from "../packages/ui-server/src/brain/turn-egress";
import { revokePrincipal } from "../packages/ui-server/src/db/principals";
import type { RunningTurn } from "../packages/ui-server/src/ws/turns";

for (const backendId of ["pi", "claude"] as const) for (const kind of ["inference", "provider"] as const) {
  test(`${backendId} provider-history host gives its relay live owner authority and observes revocation: ${kind}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-history-authority-"));
    const brain = fixtureBrain(root, "voyage"), f = historyHost(brain, makeFakeBackend({ id: backendId }));
    const controller = new AbortController();
    const authorization = f.host.coordinator.openAuthorization({ principalId: f.principalId, valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
    const turn = { turnId: "voyage", requestId: "voyage-request", principalId: f.principalId, authorization, sessionId: null,
      startedAt: Date.now(), abortController: controller, queue: [] } as unknown as RunningTurn;
    let requests = 0;
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ content: [] }); } });
    let proxy: Awaited<ReturnType<typeof prepareTurnEgress>> | undefined;
    let relay: ReturnType<typeof startInferenceRelay> | ReturnType<typeof startProviderRelay> | undefined;
    try {
      const bridge = await makeBridge(f.host, turn, { backendId, promptText: "Odysseus reads the harbour notice." });
      bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
      await f.host.catalog.settled?.();
      proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), bridge, controller, turnId: turn.turnId,
        sessionId: () => turn.sessionId, model: () => null, profile: "strict", origin: "interactive" });
      relay = kind === "inference"
        ? startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: { "x-api-key": "odysseus-offline-only-key" }, egress: proxy })
        : startProviderRelay({ origins: new Map([["ODYSSEUS_RELAY_KEY", [origin.url.origin]]]), credential: () => "odysseus-offline-only-key", egress: proxy });
      const send = () => new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ model: "odysseus", messages: [] });
        const outgoing = request({ socketPath: relay!.socketPath, path: "/v1/messages", method: "POST", headers: {
          "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "x-brain-provider": "anthropic",
          "x-brain-provider-key": "ODYSSEUS_RELAY_KEY", "x-brain-provider-origin": origin.url.origin,
        } }, incoming => { incoming.resume(); incoming.on("error", reject); incoming.on("end", () => resolve(incoming.statusCode!)); });
        outgoing.on("error", reject); outgoing.end(body);
      });
      expect(await send(), "PROVIDER_HISTORY_FIXTURE_HAS_LIVE_HOST_AUTHORITY").toBe(200);
      expect(requests, "AUTHORIZED_HISTORY_REQUEST_DISPATCHES_ONCE").toBe(1);
      expect(revokePrincipal(f.db, f.principalId, Date.now())).toEqual([f.principalId]);
      expect(authorization.valid, "COORDINATOR_FIELDS_ALONE_DO_NOT_GRANT_AUTHORITY").toBe(true);
      expect(await send(), "REVOKED_HISTORY_OWNER_NEVER_DISPATCHES").toBe(403);
      expect(requests, "REVOCATION_CANNOT_RETRY_OR_REACH_THE_PROVIDER").toBe(1);
    } finally {
      controller.abort(); await relay?.stop(); proxy?.stop(); await proxy?.settled(); origin.stop(true);
      authorization.release(); await f.close(); rmSync(root, { recursive: true, force: true });
    }
  });
}
