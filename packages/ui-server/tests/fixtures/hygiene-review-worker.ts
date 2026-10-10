/** Parent kills this process after the real repair, before recording outcome. */
import { createUiDb } from "../../src/db/client.js";
import { createBrainClient } from "../../src/brain/client.js";
import { createHygieneReview } from "../../src/inbox/hygiene-review.js";
import { InboxStore } from "../../src/inbox/store.js";
const [root, principalId, itemId, ready] = process.argv.slice(2);
const db = createUiDb(`${root}/ui.sqlite`);
const review = createHygieneReview(db, { brain: createBrainClient({ brainPath: root!, exec: {} }) });
const original = InboxStore.prototype.commit;
InboxStore.prototype.commit = function(mutations) {
  if (mutations.some(m => m.kind === "hygiene_update" && m.hygiene.outcome?.status === "fixed")) {
    // This method is synchronous: signal then hold before the receipt transaction.
    require("node:fs").writeFileSync(ready!, "written");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  original.call(this, mutations);
};
await review.resolver.resolveAsync(principalId!, { type: "inbox_resolve", itemId: itemId!, optionId: "link-text" });
throw new Error("Crash point was not reached");
