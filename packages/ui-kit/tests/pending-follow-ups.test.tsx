/**
 * `PendingFollowUps`'s markup and vocabulary (D52 §3, #1002), rendered on the
 * server with no document at all. Geometry, focus, the popover, the sheet and
 * real input are `tests/visual/pending-follow-ups.visual.tsx`'s, in Chromium.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { longFollowUp, pendingFollowUps } from "../fixtures/follow-ups.js";
import { ComposerRow } from "../src/chrome/ComposerRow.js";
import { PendingFollowUps, followUpLabel } from "../src/chrome/PendingFollowUps.js";

const render = (node: React.ReactElement) => renderToStaticMarkup(<ComposerRow right={node} />);
const names = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&#x27;/g, "'"));

describe("PendingFollowUps", () => {
  test("renders on a server, with no document, whatever it holds", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(() => render(<PendingFollowUps followUps={[]} announcement="Follow-up queued" announcementKey={1} />)).not.toThrow();
    expect(() => render(<PendingFollowUps followUps={pendingFollowUps} />)).not.toThrow();
  });

  test("none draws nothing in the half", () => {
    expect(render(<PendingFollowUps followUps={[]} />)).toContain('data-row-half="right"></div>');
  });

  test("one or two draw a pill each, oldest first, named with their place and state", () => {
    const html = render(<PendingFollowUps followUps={pendingFollowUps.slice(0, 2)} />);
    expect(names(html)).toEqual([
      "Pending follow-ups",
      "Pending follow-up 1 of 2: Winds from Aeolus. Not yet received by the agent.",
      "Pending follow-up 2 of 2: Count the timber again once…. Not yet received by the agent.",
    ]);
    expect(html.match(/>pending</g)).toHaveLength(2);
    // The full text is in the markup, as each pill's description, hidden.
    expect(html).toContain(pendingFollowUps[1]!.text.replace(/'/g, "&#x27;"));
    expect(html.match(/aria-describedby="/g)).toHaveLength(2);
    expect(html.match(/data-follow-up-text="" hidden=""/g)).toHaveLength(2);
  });

  test("three or more draw the oldest pill and a summary of the rest", () => {
    const html = render(<PendingFollowUps followUps={[...pendingFollowUps, longFollowUp]} />);
    expect(names(html)).toEqual([
      "Pending follow-ups",
      "Pending follow-up 1 of 6: Winds from Aeolus. Not yet received by the agent.",
      "5 pending follow-ups. Open list.",
    ]);
    expect(html).toContain("+5 pending");
  });

  test("with the keyboard up, one summary counts them all", () => {
    expect(names(render(<PendingFollowUps followUps={pendingFollowUps.slice(0, 2)} keyboardOpen />))).toEqual([
      "Pending follow-ups",
      "2 pending follow-ups. Open list.",
    ]);
    const one = render(<PendingFollowUps followUps={pendingFollowUps.slice(0, 1)} keyboardOpen />);
    expect(names(one)[1]).toBe("1 pending follow-up. Open list.");
    expect(one).toContain(">1 pending<");
  });

  test("a label is the start of the prompt until a model supplies one", () => {
    expect(followUpLabel("Add two more jars of water to the raft list.")).toBe("Add two more jars of…");
    expect(followUpLabel("  Steer   home  ")).toBe("Steer home");
    expect(followUpLabel("")).toBe("Follow-up");
  });
});
