/** Offline crash points around the actual concrete SQLite commands. */
import { createUiDb } from "../../src/db/client.js";
import { InboxStore } from "../../src/inbox/store.js";
import { escalateInbox } from "../../src/inbox/escalate.js";
import type { InboxEscalationInput } from "../../src/inbox/escalate.js";
import { createInboxResolver } from "../../src/inbox/resolve.js";
import { createInboxCleanup } from "../../src/inbox/cleanup.js";

const [mode, path, fixture, brainRoot, readyFile, gateFile] = process.argv.slice(2);
const input = await Bun.file(fixture!).json() as InboxEscalationInput;
const db = createUiDb(path!);
const original = InboxStore.prototype.commit;
InboxStore.prototype.commit = function(mutations) {
  if (mode === "cleanup" && mutations.some(m => m.kind === "transition" && m.to === "done")) process.exit(73);
  original.call(this, mutations);
  if (mode === "checkpoint" && mutations.some(m => m.kind === "checkpoint")) process.exit(71);
  if (mode === "follow-up" && mutations.some(m => m.kind === "item" && m.item.type === "execute")) process.exit(72);
};
if (mode === "checkpoint" || mode === "commit") {
  escalateInbox(db, input);
  process.exit(74); // committed checkpoint/Action/block, before acknowledgement
} else if (mode === "follow-up") {
  createInboxResolver(db, { now: () => input.now!, allowedOperations: () => input.allowedOperations })
    .resolve(input.escalation.principalId, { type: "inbox_resolve", itemId: input.action.id, optionId: "approve" });
} else if (mode === "cleanup") {
  await createInboxCleanup(db, brainRoot!, { now: () => input.now! }).sweep();
} else if (mode === "race") {
  await Bun.write(readyFile!, "ready");
  while (!await Bun.file(gateFile!).exists()) await Bun.sleep(2);
  const receipt = createInboxResolver(db, { now: () => input.now!, allowedOperations: () => input.allowedOperations })
    .resolve(input.escalation.principalId, { type: "inbox_resolve", itemId: input.action.id, optionId: "approve" });
  console.log(JSON.stringify(receipt));
  db.close();
  process.exit(0);
}
throw new Error("The intended crash point was not reached");
