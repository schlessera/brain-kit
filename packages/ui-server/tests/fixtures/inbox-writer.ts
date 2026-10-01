import { Database } from "bun:sqlite";
import { createInboxStore } from "../../src/inbox/store.js";

// Each worker owns a real SQLite connection. The parent releases both writers
// only after they have opened it; no network, provider, or subprocess is involved.
const worker = globalThis as unknown as {
  postMessage(value: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
let db: Database;
let input: {
  path: string;
  operation: "dedup" | "resolution";
  ordinal: number;
  now: number;
};
worker.onmessage = (event) => {
  if (event.data.kind === "init") {
    input = event.data;
    db = new Database(input.path);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    worker.postMessage({ kind: "ready" });
    return;
  }
  try {
    const store = createInboxStore(db, { now: () => input.now });
    if (input.operation === "dedup") {
      const result = store.ingest({
        threadId: `thread-${input.ordinal}`,
        itemId: `item-${input.ordinal}`,
        dedupKey: "same-arrival",
        stagingId: "staging",
        source: "share",
        stakes: 2,
        expiresAt: input.now + 100_000,
      });
      worker.postMessage({ kind: "result", won: result.created });
    } else {
      store.commit([
        {
          kind: "resolution",
          id: `resolution-${input.ordinal}`,
          itemId: "action",
          optionId: "accept",
          principalId: "principal",
        },
      ]);
      worker.postMessage({ kind: "result", won: true });
    }
  } catch (error) {
    worker.postMessage({ kind: "result", won: false, error: String(error) });
  } finally {
    db.close();
  }
};
