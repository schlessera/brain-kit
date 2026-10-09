import { createBrainUiRoot } from "../../../../src/root.js";
import { defineScene } from "../define-scene.ts";
import { installFaultNetwork } from "../fault-network.ts";

const net = installFaultNetwork({ routes: async () => Response.json({ sessions: [] }) });
const root = createBrainUiRoot({ storagePrefix: "odysseus-recording-lock", localCapture: true, request: net.request });
root.stores.connection.getState().setVpnStatus("connected", "odysseus");
root.stores.connection.getState().setWsStatus("connected");

defineScene({
  async begin() {
    await root.localWork!.restoring(); await root.localWork!.snapshotNow();
    const sink = root.recordings!.sink();
    try {
      await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
      await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])]) });
      return { ok: true, owner: (await navigator.locks.query()).held!.find(lock => lock.name === "brain-ui:recording")!.clientId };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  },
  async end() { await root.recordings!.stop("user"); return (await root.recordings!.list("account:odysseus")).map(row => ({ bytes: row.bytes, hash: row.contentHash })); },
  holder: async () => (await navigator.locks.query()).held?.find(lock => lock.name === "brain-ui:recording")?.clientId ?? null,
});
