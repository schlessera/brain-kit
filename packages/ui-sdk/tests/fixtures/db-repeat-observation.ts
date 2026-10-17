/** Fixed fixture evidence for two published indexes; never grants stage access. */
import { createHash } from "node:crypto";
const key = Symbol.for("brain-kit.fixture.db-repeat-stage");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type PhysicalReceipt = { checkpointKey: string; stageKey: string; checkpointPhysical: string; stagePhysical: string; namespacePid: number; namespaceStart: string };
export function installDbRepeatObservation() {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  if (original && (!("value" in original) || original.value !== undefined || !original.configurable)) throw Error("DB_REPEAT_SLOT_NOT_EMPTY");
  const owner = Object.seal({ receipts: [] as PhysicalReceipt[] });
  Object.defineProperty(globalThis, key, { value: owner, configurable: true, enumerable: false, writable: false });
  const current = () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!descriptor || descriptor.value !== owner || !descriptor.configurable || descriptor.enumerable || descriptor.writable) throw Error("DB_REPEAT_OWNER_CHANGED");
    return owner.receipts;
  };
  let active: 1 | 2 | undefined, firstPublished = false, secondPublished = false;
  const observed: Array<{ ordinal: 1 | 2; checkpointPhysical: string; stagePhysical: string }> = [];
  return {
    begin(ordinal: 1 | 2) {
      current();
      if (active || ordinal === 1 && (firstPublished || observed.length) || ordinal === 2 && (!firstPublished || secondPublished)) throw Error("DB_REPEAT_PUBLICATION_ORDER");
      active = ordinal;
    },
    observe(launch: unknown) {
      if (!active) return;
      if (!launch || typeof launch !== "object" || Array.isArray(launch)) throw Error("DB_REPEAT_NATIVE_INDEX_PAYLOAD_REQUIRED");
      const outer = launch as { command?: unknown; startupView?: { root?: unknown }; maintenance?: { credentials?: unknown; output?: { target?: unknown; storage?: { mount?: unknown; namespacePid?: unknown; namespaceStart?: unknown } } } };
      if (!Array.isArray(outer.command) || outer.command.at(-1) !== "index") return;
      const output = outer.maintenance?.output, storage = output?.storage;
      const checkpoint = typeof outer.startupView?.root === "string" ? /^\/brain-fixture\/\.brain-native\/checkpoints\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(outer.startupView.root)?.[1] : undefined;
      const stage = typeof storage?.mount === "string" ? /^\/brain-fixture\/\.brain-native\/stages\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(storage.mount)?.[1] : undefined;
      if (!checkpoint || !stage || outer.maintenance?.credentials !== false || output?.target !== "/tmp/brain-maintenance-output"
        || !Number.isSafeInteger(storage?.namespacePid) || Number(storage?.namespacePid) <= 0
        || typeof storage?.namespaceStart !== "string" || !/^[1-9][0-9]{0,23}$/.test(storage.namespaceStart)) throw Error("DB_REPEAT_NATIVE_INDEX_PAYLOAD_REQUIRED");
      const matches = current().filter(receipt => receipt.checkpointKey === digest(checkpoint) && receipt.stageKey === digest(stage));
      if (matches.length !== 1) throw Error("DB_REPEAT_PHYSICAL_STAGE_RECEIPT_REQUIRED");
      const receipt = matches[0]!;
      if (receipt.namespacePid !== storage?.namespacePid || receipt.namespaceStart !== storage?.namespaceStart) throw Error("DB_REPEAT_STAGE_OWNER_MISMATCH");
      if (![receipt.checkpointPhysical, receipt.stagePhysical].every(value => /^[0-9a-f]{64}$/.test(value))) throw Error("DB_REPEAT_PHYSICAL_STAGE_RECEIPT_REQUIRED");
      observed.push({ ordinal: active, checkpointPhysical: receipt.checkpointPhysical, stagePhysical: receipt.stagePhysical });
    },
    published(ordinal: 1 | 2, status: number, body: unknown) {
      if (active !== ordinal || status !== 200 || !body || typeof body !== "object" || Array.isArray(body)
        || (body as { success?: unknown }).success !== true || Object.keys(body).length !== 1) throw Error("DB_REPEAT_AUTHENTICATED_INDEX_PUBLICATION_REQUIRED");
      if (observed.filter(receipt => receipt.ordinal === ordinal).length !== 1) throw Error("DB_REPEAT_ACTUAL_INDEX_PAYLOAD_REQUIRED");
      active = undefined;
      if (ordinal === 1) firstPublished = true; else secondPublished = true;
    },
    complete() {
      current();
      if (!firstPublished || !secondPublished || active || observed.length !== 2) throw Error("DB_REPEAT_TWO_PUBLISHED_INDEXES_REQUIRED");
      if (observed[0]!.checkpointPhysical === observed[1]!.checkpointPhysical || observed[0]!.stagePhysical === observed[1]!.stagePhysical) throw Error("DB_REPEAT_DISTINCT_PHYSICAL_IDENTITIES_REQUIRED");
      return observed.map(receipt => ({ ...receipt }));
    },
    restore() {
      try { current(); }
      finally { if (original) Object.defineProperty(globalThis, key, original); else if (!Reflect.deleteProperty(globalThis, key)) throw Error("DB_REPEAT_RESTORE_FAILED"); }
    },
  };
}

/** The second request has one fixed loopback route and follows confirmed publication. */
export async function repeatWarmIndex(observation: ReturnType<typeof installDbRepeatObservation>, port: number, cookie: string) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Error("DB_REPEAT_LOOPBACK_PORT_REQUIRED");
  observation.begin(2);
  const repeated = await fetch(`http://127.0.0.1:${port}/api/brain/index`, { method: "POST",
    headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
  const body: unknown = await repeated.json();
  observation.published(2, repeated.status, body);
  return { status: repeated.status, body, physicalStages: observation.complete() };
}
