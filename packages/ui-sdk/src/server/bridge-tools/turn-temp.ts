import { TURN_TEMP_INPUT_SCHEMA, type TurnTempInput } from "../../tool-contracts/index.js";
import type { BackendActivityEvent } from "../backend.js";
import { purgeTurnTemp, turnTempUsage, type TurnTempAccess } from "../worker-turn-temp.js";

/** At most this many paths of each list go into the governance record. */
const RECORD_PATHS = 50;

export type TurnTempPurgeRecord = Extract<BackendActivityEvent, { kind: "turn_temp_purge" }>;

/**
 * The `turn_temp` tool (#1703): `usage` reports what fills the worker's turn
 * temp, `purge` removes named paths or everything. It reaches turn temp only
 * through the server's held descriptor (`TurnTempAccess`), so it needs no
 * approval: it cannot name anything outside the worker's own `/tmp`. Each
 * purge is reported through `record` as a governance event.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export function handleTurnTemp(input: TurnTempInput, access: TurnTempAccess | undefined,
  record?: (event: TurnTempPurgeRecord) => void): object {
  const parsed = TURN_TEMP_INPUT_SCHEMA.parse(input);
  if (!access) throw new Error("This turn has no turn temp the server can reach, so turn_temp cannot be used in it.");
  if (parsed.action === "usage") {
    if (parsed.paths?.length || parsed.all || parsed.force) throw new Error("action=usage takes no paths, all or force.");
    return turnTempUsage(access);
  }
  const all = parsed.all === true;
  const paths = parsed.paths ?? [];
  if (all === Boolean(paths.length)) throw new Error("action=purge needs either paths or all: true, not both.");
  if (all && parsed.force) throw new Error("force applies to named paths only; all: true always keeps the files the answer links.");
  const result = purgeTurnTemp(access, { paths, all, force: parsed.force === true });
  const linked = result.skipped.filter(skip => skip.reason === "linked").map(skip => skip.path);
  try {
    record?.({ kind: "turn_temp_purge", truncated: result.truncated, all, force: parsed.force === true, paths: all ? [] : paths.slice(0, RECORD_PATHS),
      removedEntries: result.removed.length, freedBytes: result.freedBytes, skippedLinked: linked.slice(0, RECORD_PATHS),
      skippedOther: result.skipped.length - linked.length, usedBytes: result.space.usedBytes, limitBytes: result.space.limitBytes });
  } catch { /* Observability must not fail the observed step. */ }
  return { truncated: result.truncated, removedCount: result.removed.length, removed: result.removed.slice(0, RECORD_PATHS),
    skippedCount: result.skipped.length, skipped: result.skipped.slice(0, RECORD_PATHS),
    freedBytes: result.freedBytes, ...result.space, ...(linked.length ? { note: "Files your answer links were kept: they are copied into persistent scratch at turn end. Pass force: true with their paths to remove them anyway." } : {}) };
}
