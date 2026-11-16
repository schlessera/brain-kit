/**
 * The crashed app instance of case 19 (#3513). It opens the case's database
 * and the served pool, requests the pending changed refresh and is killed by
 * the proof with SIGKILL once its staging root is writable, so no cleanup of
 * its own runs. Arguments: database, manager socket, repository, principal and
 * the case's fixed clock.
 */
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createReferenceSources } from "../../packages/ui-server/src/brain/reference-source.js";
import { createReferenceTransport } from "../../packages/ui-server/src/brain/reference-transport.js";
import { referenceWorktreeDependents } from "../../packages/ui-server/src/brain/reference-worktrees.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";

const [dbPath, socketPath, repository, principalId, clock] = process.argv.slice(2) as [string, string, string, string, string];
const db = createUiDb(dbPath);
const sources = createReferenceSources({ db, pool: createNativeBrainManagerClient({ socketPath, timeoutMs: 20_000 }),
  transport: createReferenceTransport({ brainPath: "/brain-fixture/brain" }), brain: "ithaca", credentials: {}, now: () => Number(clock),
  dependents: rootId => referenceWorktreeDependents(db, rootId) });
console.log("requesting");
const lease = await sources.request({ principalId, repository, revision: "main" });
// Reached only if the proof was too late to kill this instance; the proof then fails on its own assertion.
console.log(`acquired ${lease.rootId}`);
