import type { InboxActionItem, InboxQueueItem, InboxThread, ResolutionEffect } from "../src/protocol.js";

export const operation = { toolName: "Write", input: { path: "notes/ithaca.md", content: "Odysseus returns." }, targetPath: "notes/ithaca.md" };
export const effects: ResolutionEffect[] = [
  { kind: "enqueue", payload: { instruction: "File the return to Ithaca.", operation } },
  { kind: "cancel_blocked" },
  { kind: "snooze" },
  { kind: "dismiss", reason: "wrong_call" },
  { kind: "write_policy", policy: { slug: "ithaca-notes", content: "A deferred proposal." } },
  { kind: "open_session", seed: { prompt: "Discuss the journey." } },
];
export const thread: InboxThread = {
  id: "ithaca", trustClass: "untrusted", source: "share", status: "open", stateMd: "A return journey awaits review.",
  stakes: 2, createdAt: 1000, lastSeenAt: 2000,
};
export const queueItem: InboxQueueItem = {
  id: "work-1", threadId: thread.id, dedupKey: "share-ithaca", createdAt: 1000, updatedAt: 2000,
  expiresAt: 100000, version: 1, queue: "queue", type: "execute", status: "blocked",
  attempts: 1, maxAttempts: 3, blockedByItemId: "action-1", runId: "run-1", payload: { instruction: "File the journey.", operation },
};
export const actionItem: InboxActionItem = {
  id: "action-1", threadId: thread.id, dedupKey: "decision-ithaca", createdAt: 1000, updatedAt: 2000,
  expiresAt: 100000, version: 1, queue: "actions", type: "approve", status: "pending",
  payload: { title: "File the journey?", detail: "Write the return note in notes/ithaca.md." },
  options: effects.map((effect) => ({ id: effect.kind, label: effect.kind, effect })),
};
