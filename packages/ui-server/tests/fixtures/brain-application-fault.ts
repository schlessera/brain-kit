import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { contentHash, createBrainApplication } from "../../src/brain/application.js";
const root = process.argv[2]!;
const receipts: unknown[] = [];
const apply = createBrainApplication({ root, principalId: "odysseus", turnId: "fault",
  signal: new AbortController().signal, policy: { available: ["write"], autoAllowed: ["write"], lock: createKeyedLock() },
  isAuthorized: () => true, approve: async () => true, record: result => { receipts.push(result); } });
const result = await apply({ principalId: "odysseus", turnId: "fault", input: { operation: "write",
  path: "notes/raft.md", expectedBaseHash: contentHash(readFileSync(join(root, "notes/raft.md"), "utf8")), content: "Odysseus rows. ".repeat(10_000) } });
console.log(JSON.stringify({ result, receipts }));
