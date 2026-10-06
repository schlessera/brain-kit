/**
 * `SessionStrip`'s vocabulary and markup (D52 §3–4, #949), as pure functions of
 * props. Geometry, focus, the sheet and real input are
 * `tests/visual/session-strip.visual.tsx`'s, in Chromium.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

import { WORKING_NOW, ogygiaClock, workingByState, workingSessions } from "../fixtures/sessions.js";
import { ComposerRow } from "../src/chrome/ComposerRow.js";
import {
  SessionStrip,
  WORKING_STATES,
  describeWorkingSession,
  workingAge,
  type WorkingSession,
} from "../src/chrome/SessionStrip.js";

const open = (s: Omit<WorkingSession, "onOpen">): WorkingSession => ({ ...s, onOpen: () => {} });
const say = (s: Omit<WorkingSession, "onOpen">) => describeWorkingSession(open(s), WORKING_NOW, ogygiaClock);

function draw(sessions: Omit<WorkingSession, "onOpen">[], keyboardOpen = false): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(
    <ComposerRow left={<SessionStrip sessions={sessions.map(open)} now={WORKING_NOW} formatClock={ogygiaClock} keyboardOpen={keyboardOpen} />} />,
  );
  return document as unknown as Document;
}

describe("the state vocabulary", () => {
  test("the fixture covers every state once, in display order", () => {
    expect(workingSessions.map((s) => s.state)).toEqual([...WORKING_STATES]);
  });

  test("each state prints D52's word, second line and tone", () => {
    const rows = workingSessions.map((s) => {
      const v = say(s);
      return [s.state, v.word, v.detail ?? null, v.tone];
    });
    expect(rows).toEqual([
      ["needs-you", "needs you", "approval", "red"],
      ["failed", "interrupted", "ended 06:12", "red"],
      ["unconfirmed", "unconfirmed", "didn't hear back", "amber"],
      ["running", "running · 2m", null, "amber"],
      ["queued", "queued · busy", "3 turns ahead of this one", "red"],
      ["unknown", "unknown", "host can't confirm the latest turn", "neutral"],
      ["cant-check", "can't check", "host unreachable", "neutral"],
      ["done", "done · 4m", "finished 06:36", "teal"],
      ["cancelled", "cancelled", "ended 06:02", "neutral"],
    ]);
  });

  test("a queue without a note is amber `queued`; the note is what makes it busy", () => {
    const v = say({ ...workingByState.queued, queueNote: undefined });
    expect([v.word, v.detail, v.tone]).toEqual(["queued", undefined, "amber"]);
  });

  test("an unknown timestamp prints no age and no clock time", () => {
    const running = say({ ...workingByState.running, startedAt: null });
    const done = say({ ...workingByState.done, endedAt: null });
    const failed = say({ ...workingByState.failed, endedAt: undefined });
    expect([running.word, running.detail]).toEqual(["running", undefined]);
    expect([done.word, done.detail]).toEqual(["done", undefined]);
    expect([failed.word, failed.detail]).toEqual(["interrupted", undefined]);
    for (const v of [running, done, failed]) expect(v.name).not.toMatch(/\d/);
  });

  test("the outcome word belongs to its state, or falls back to the state's own", () => {
    expect(say({ ...workingByState.failed, outcome: "timed out" }).word).toBe("timed out");
    expect(say({ ...workingByState.failed, outcome: "denied" }).word).toBe("failed");
    expect(say({ ...workingByState.cancelled, outcome: "denied" }).word).toBe("denied");
    expect(say({ ...workingByState.cancelled, outcome: "interrupted" }).word).toBe("cancelled");
  });

  test("ages are compact and never negative", () => {
    expect([0, 59_999, 60_000, 59 * 60_000, 3_600_000, 25 * 3_600_000, -5_000].map(workingAge)).toEqual([
      "<1m", "<1m", "1m", "59m", "1h", "1d", "<1m",
    ]);
  });

  test("the accessible name is `{label}, {state}{, second line}. Open session.`", () => {
    expect(say(workingByState.queued).name).toBe("Ship's log summary, queued, busy, 3 turns ahead of this one. Open session.");
    expect(say(workingByState.running).name).toBe("Raft timber tally, running, 2m. Open session.");
  });
});

describe("the strip's markup", () => {
  const items = (doc: Document) => [...doc.querySelectorAll('[data-session-strip] [data-pill][role="button"], [data-strip-summary]')];

  test("no sessions draws nothing at all", () => {
    const doc = draw([]);
    expect(doc.querySelector("[data-composer-row]")).not.toBeNull();
    expect(doc.querySelector('[data-row-half="left"]')!.childElementCount).toBe(0);
  });

  test("one and two sessions draw one pill each", () => {
    expect(items(draw([workingByState.done]))).toHaveLength(1);
    expect(items(draw([workingByState.done, workingByState.running]))).toHaveLength(2);
  });

  test("three, the boundary, already draws a pill and a summary", () => {
    const drawn = items(draw([workingByState.done, workingByState.running, workingByState.queued]));
    expect(drawn.map((el) => el.getAttribute("data-strip-summary"))).toEqual([null, "overflow"]);
  });

  test("three or more draw the most urgent pill and a summary of the rest, never a third pill", () => {
    const doc = draw([workingByState.done, workingByState.running, workingByState["needs-you"], workingByState.cancelled]);
    const drawn = items(doc);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]!.getAttribute("aria-label")).toBe("Raft lashing plan, needs you, approval. Open session.");
    expect(drawn[1]!.getAttribute("aria-label")).toBe("3 more working sessions: 1 running, 1 done, 1 cancelled. Open list.");
    expect(doc.querySelectorAll("[data-session]")).toHaveLength(1);
  });

  test("the strip is one tab stop", () => {
    for (const n of [1, 2, 5]) {
      const doc = draw(workingSessions.slice(0, n));
      expect(doc.querySelectorAll('[data-session-strip] [tabindex="0"]')).toHaveLength(1);
    }
  });

  test("keyboard open collapses any count to one summary", () => {
    for (const n of [1, 4]) {
      const drawn = items(draw(workingSessions.slice(0, n), true));
      expect(drawn).toHaveLength(1);
      expect(drawn[0]!.getAttribute("data-strip-summary")).toBe("keyboard");
    }
    expect(items(draw([workingByState.running], true))[0]!.getAttribute("aria-label")).toBe("1 working session: 1 running. Open list.");
  });

  test("nothing in the strip animates or draws progress", () => {
    const html = renderToStaticMarkup(<SessionStrip sessions={workingSessions.map(open)} now={WORKING_NOW} />);
    expect(html).not.toMatch(/animation|transition|progress|breathe/i);
  });
});
