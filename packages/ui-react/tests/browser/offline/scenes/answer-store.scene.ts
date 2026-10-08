/**
 * A scene for the page-level primitives' self-test (#1016): today's IndexedDB
 * answer store (#910) on a page that counts its launches and records each
 * `pagehide` it saw, so a test can tell a reload from a termination.
 */
import { createIndexedDbAnswerStorage } from "../../../../src/lib/answer-delivery/storage.js";
import type { QueuedAnswer } from "../../../../src/lib/answer-delivery/types.js";
import { defineScene } from "../define-scene.ts";

const store = createIndexedDbAnswerStorage("odysseus-scene-answers");
const launches = Number(localStorage.getItem("launches") ?? 0) + 1;
localStorage.setItem("launches", String(launches));
addEventListener("pagehide", () => {
  const seen = JSON.parse(localStorage.getItem("pagehides") ?? "[]") as number[];
  localStorage.setItem("pagehides", JSON.stringify([...seen, launches]));
});

const answer = (submissionId: string) =>
  ({
    v: 1,
    submissionId,
    principalKey: "odysseus",
    requestId: `ask-${submissionId}`,
    sessionId: "odysseus-ithaca",
    turnId: null,
    submittedAt: Date.UTC(2026, 6, 12, 9, 41),
    sent: false,
    payload: { kind: "ask_user", answer: "Sail west" },
  }) as unknown as QueuedAnswer;

let writing = 0;

defineScene({
  launches: () => launches,
  pagehides: () => JSON.parse(localStorage.getItem("pagehides") ?? "[]") as number[],
  /** Resolves once the answer has committed. */
  save: (id: string) => store.put(answer(id)),
  /** Starts writing answers back to back and returns at once: an operation in flight. */
  keepSaving: (prefix: string) => {
    void (async () => {
      for (;;) await store.put(answer(`${prefix}-${++writing}`));
    })();
    return null;
  },
  saved: async () => ((await store.load()) as Array<{ submissionId: string }>).map((a) => a.submissionId).sort(),
});
