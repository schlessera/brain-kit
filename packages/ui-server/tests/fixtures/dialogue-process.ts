/** Separate-process recovery witness. No provider, microphone or task execution. */
import { createUiDb } from "../../src/db/client.js";
import { openSqliteWriter } from "../../src/db/write-worker.js";
import * as writes from "../../src/ws/session-catalog-writes.js";
import { readDialogue } from "../../src/ws/dialogue-storage.js";
const [mode, path] = process.argv.slice(2);
if (!path) throw Error("database required");
const db = createUiDb(path),
  writer = openSqliteWriter(db),
  channel = writer.channel({ url: writes.url, setup: writes.setup }, {});
try {
  if (mode === "write") {
    await channel.call("dialogueOpen", {
      conversationId: "ithaca",
      principalId: "odysseus",
      providerId: "gpt-live",
      epoch: 1,
      sessionId: "voyage",
    });
    await channel.call("dialogueAppend", {
      ownerId: "ithaca",
      principalId: "odysseus",
      generation: 1,
      identity: "first",
      evidence: {
        kind: "voice",
        providerId: "gpt-live",
        conversationId: "ithaca",
        epoch: 1,
        event: {
          kind: "unassigned_input_fragment",
          sequence: 0,
          text: "The mast is ready.",
          sessionInterval: { startMs: 0, endMs: 500 },
        },
      },
    });
    console.log("written");
  } else
    console.log(
      JSON.stringify(readDialogue(db, "odysseus", { sessionId: "voyage" }))
    );
} finally {
  await channel.close();
  await writer.close();
  db.close();
}
