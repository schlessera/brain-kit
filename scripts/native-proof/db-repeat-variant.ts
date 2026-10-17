/** One DB-qualification-only observation of already held and validated facts. */
import { createHash } from "node:crypto";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function dbRepeatStageVariant(source: string) {
  const before = '    if (String(info.dev) !== stage.rootDevice || String(info.ino) !== stage.rootInode) throw Error("Native stage mounted-root identity differs from its receipt");';
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw Error("DB repeat stage fixture anchor changed");
  const after = `${before}
    const fixtureDbSlot = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("brain-kit.fixture.db-repeat-stage"));
    if (fixtureDbSlot) {
      const fixtureReceipts = fixtureDbSlot.value?.receipts;
      if (fixtureDbSlot.writable !== false || fixtureDbSlot.enumerable !== false || fixtureDbSlot.configurable !== true
        || !Array.isArray(fixtureReceipts) || fixtureReceipts.length >= 128) throw Error("DB_REPEAT_STAGE_OBSERVER_OWNER_CHANGED");
      const fixtureHash = (value: string) => createHash("sha256").update(value).digest("hex");
      fixtureReceipts.push({ checkpointKey: fixtureHash(native.checkpoint.id), stageKey: fixtureHash(stage.id),
        checkpointPhysical: fixtureHash(JSON.stringify({ fsid: native.checkpoint.fsid, uuid: native.checkpoint.uuid,
          rootId: native.checkpoint.rootId, transaction: native.checkpoint.transaction })),
        stagePhysical: fixtureHash(JSON.stringify({ dev: String(info.dev), ino: String(info.ino) })),
        namespacePid: stage.namespacePid, namespaceStart: stage.namespaceStart });
    }`;
  const output = source.replace(before, after);
  return { source: output, substitution: { before, after }, hashes: { original: hash(source), variant: hash(output) } };
}
