/**
 * A writer in a process of its own, as the cron runner and a restarted server
 * are (#2836): an empty module cache over the same UI database and brain.
 *
 * - `acquire` holds a shared writer, prints its folder plan as one JSON line,
 *   and releases once its stdin closes.
 * - `record <folders-json>` records a type translation under the brain's
 *   current policy hash, as admission does, then exits.
 */
import { createUiDb } from "../../src/db/client.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
import { createGovernancePolicyReader } from "../../src/brain/governance-policy.js";

const [dbPath, brain, action, folders] = process.argv.slice(2);
if (!dbPath || !brain || !(action === "acquire" || (action === "record" && folders))) throw Error("unknown gate process case");
const db = createUiDb(dbPath), gate = createWriterGate(db, brain, { pollMs: 10 });
try {
  if (action === "record") gate.rememberTypeFolders(createGovernancePolicyReader(brain).load().hash, JSON.parse(folders!) as string[]);
  else {
    const hold = await gate.acquire("shared", "cron:odysseus-ledger");
    try {
      console.log(JSON.stringify(hold.folderPaths));
      await new Response(Bun.stdin.stream()).text();
    } finally { hold.release(); }
  }
} finally { db.close(); }
