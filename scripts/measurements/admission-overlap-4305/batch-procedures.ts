import { setup as records } from "../../../packages/ui-server/src/brain/governed-turn-writes.ts";
import type { Database } from "bun:sqlite";
export const url = import.meta.url;
export function setup(db: Database) {
  const record = records(db);
  const policy = (id: string) => record.recordPolicy(id as never, "interactive" as never, "governed" as never, null as never, "default" as never, "{}" as never, "[]" as never, 1783814400000 as never);
  const manifest = (id: string) => record.manifestBegin(id as never, "/ithaca" as never, process.pid as never, "1" as never, '{}' as never, 1783814400000 as never);
  return { policy, manifest, batch(id: string) { return db.transaction(() => { policy(id); manifest(id); }).immediate(); } };
}
