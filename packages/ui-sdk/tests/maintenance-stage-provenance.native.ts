/** Observe only the existing disposable manager's stage and reader authority. */
import { fstatSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import { runMaintenanceWorker } from "../src/server/maintenance-worker.js";
import { probeWorkerHost, verifiedWorkerIdentity } from "../src/server/worker-launcher.js";
import type { NativeStage } from "../src/server/native-brain-manager-protocol.js";

export async function captureMaintenanceStage(brain: string) {
  if (process.getuid?.() !== 21001 || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper")
    throw Error("MAINTENANCE_STAGE_PROVENANCE_REQUIRES_DISPOSABLE_IDENTITY_FIXTURE");
  const probe = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
  if (!probe.ok) throw Error(`MAINTENANCE_STAGE_REAL_IDENTITY_PROBE_REFUSED: ${probe.requirement}`);
  const client = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
  let stage: NativeStage | undefined;
  const manager = { ...client, async prepareStage(...args: Parameters<typeof client.prepareStage>) {
    stage = await client.prepareStage(...args); return stage;
  } };
  const view = await prepareNativeWorkerStartupView(brain, manager);
  let outputs: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
  const attempt = <T>(read: () => T): { value: T } | { error: string } => {
    try { return { value: read() }; } catch (error) { return { error: (error as NodeJS.ErrnoException).code ?? String(error) }; }
  };
  const metadata = (info: ReturnType<typeof lstatSync>) => ({ uid: Number(info.uid), gid: Number(info.gid),
    mode: (Number(info.mode) & 0o7777).toString(8), dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() });
  try {
    outputs = await prepareNativeWorkerOutput(brain, { startupView: view });
    if (!stage) throw Error("MAINTENANCE_STAGE_RECEIPT_MISSING");
    const held = stage, source = outputs.output.source, fd = Number(/^\/proc\/\d+\/fd\/(\d+)\/merged$/.exec(source)?.[1]);
    if (!Number.isSafeInteger(fd)) throw Error("MAINTENANCE_STAGE_DESCRIPTOR_MISSING");
    const identity = verifiedWorkerIdentity(brain);
    if (!identity) throw Error("MAINTENANCE_STAGE_QUALIFIED_IDENTITY_MISSING");
    const row = {
      kind: "maintenance-stage-provenance", server: { pid: process.pid, uid: process.getuid(), gid: process.getgid?.(), groups: process.getgroups?.() },
      qualifiedWorker: identity, stage: held, descriptor: fd, source,
      descriptorRoot: metadata(fstatSync(fd)), merged: attempt(() => metadata(lstatSync(source))),
      descriptorTarget: attempt(() => readlinkSync(`/proc/${process.pid}/fd/${fd}`)),
      keeper: { status: attempt(() => readFileSync(`/proc/${held.namespacePid}/status`, "utf8").split("\n").filter(line => /^(Uid|Gid|Groups|NSpid):/.test(line))),
        start: attempt(() => readFileSync(`/proc/${held.namespacePid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]),
        mountNamespace: attempt(() => readlinkSync(`/proc/${held.namespacePid}/ns/mnt`)) },
      directEnumeration: attempt(() => readdirSync(source)),
    };
    console.log(JSON.stringify(row));
    console.log(JSON.stringify({ kind: "maintenance-stage-authorized-reader",
      stat: await client.statStage(held.id, "brain.config.ts", identity.workerUid),
      members: (await client.listStage(held.id, "", identity.workerUid)).map(item => ({ path: item.path, mode: item.mode, kind: item.kind })),
    }));
    let result: unknown;
    try {
      result = await runMaintenanceWorker({ brainPath: brain, startupView: outputs.view,
        output: { ...outputs.output, target: "/tmp/brain-maintenance-output" },
        command: ["/bin/sh", "-c", 'printf "qualified" > "$BRAIN_ROOT/.brain-maintenance-probe"'],
        env: { PATH: "/usr/bin:/bin" }, credentials: false, timeoutMs: 5000 });
    } catch (error) { result = { error: String(error), code: (error as NodeJS.ErrnoException).code }; }
    console.log(JSON.stringify({ kind: "maintenance-stage-launch", result }));
    return { row, result };
  } finally { try { await outputs?.cleanup(); } finally { await view.cleanup(); } }
}
