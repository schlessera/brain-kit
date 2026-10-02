import type { AgentBackend, InboxActionItem, InboxOperation } from "@schlessera/brain-ui-sdk/server";
import { requestToolPermission } from "@schlessera/brain-ui-sdk/server";
import { readFileSync, writeFileSync } from "node:fs";
import { createUiDb } from "../../src/db/client.js";
import { createActivityStore } from "../../src/activity/store.js";
import { runAutonomousTurn } from "../../src/inbox/autonomous-turn.js";
import { escalateInbox } from "../../src/inbox/escalate.js";

const [path, fixture, ready, mode] = process.argv.slice(2);
const input = JSON.parse(readFileSync(fixture!, "utf8")) as { principalId: string; action: InboxActionItem; operation: InboxOperation; stagingId: string };
const db = createUiDb(path!), activity = createActivityStore(db, { writer: "unwind-fixture" });
const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async req => {
  req.bridge.activity!({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
  req.bridge.activity!({ kind: "runtime_observed", billing: "api" });
  let denied = false;
  if (mode === "escalated") {
    const decision = await requestToolPermission(req.bridge, { toolUseId: "write-harbor", toolName: input.operation.toolName, input: input.operation.input }, { noGrantSurface: true });
    denied = decision.behavior === "deny";
  }
  // A genuine partial live Activity receipt, with known spend above the
  // reservation, must survive process death without becoming a free call.
  const root = activity.openRootSpans()[0]!;
  activity.patchSpan(root.spanId, { usage: { inputTokens: 300, costUsd: 3 },
    attrs: { "gen_ai.usage.per_model": { fixture: { inputTokens: 300 } } } });
  writeFileSync(ready!, JSON.stringify({ denied, aborted: req.signal.aborted }));
  await new Promise<void>(() => {});
} };

await runAutonomousTurn({ db, store: activity, backend, checkpoint: escalation => {
  escalateInbox(db, { itemId: "share", expectedVersion: 2, escalation, action: input.action, allowedOperations: [input.operation] });
} }, { turnId: "run", principalId: input.principalId, prompt: "Inspect Odysseus's harbor", billingMode: "api", allowedTools: ["read"], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
db.close();
