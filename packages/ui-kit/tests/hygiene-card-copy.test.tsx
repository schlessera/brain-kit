import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HygieneCard, type HygieneCardProps } from "../src/decisions/HygieneCard.js";

const base: HygieneCardProps = {
  title: "A link points to a note that does not exist", severity: "MUST FIX", category: "broken link",
  path: "journeys/return-to-ithaca.md", provenance: "hygiene", priority: "urgency unknown",
  commit: { label: "Apply fix", onClick: () => {} },
};
const states = ["applying", "stale", "refused", "check_failed", "still_detected", "unknown", "fixed", "undone"] as const;

test("omitting caller copy keeps every file default (#2837)", () => {
  const shown = Object.fromEntries(states.map(state => [state, renderToStaticMarkup(<HygieneCard {...base} state={state} reason="the file is locked" code="link-unresolved" />)]));
  expect(shown.applying, "HYGIENE_CARD_FILE_DEFAULT_APPLYING").toContain("Applying… checking the file first");
  expect(shown.stale, "HYGIENE_CARD_FILE_DEFAULT_STALE").toContain("This file changed since the finding was shown. Nothing was written.");
  expect(shown.refused, "HYGIENE_CARD_FILE_DEFAULT_REFUSED").toContain("Couldn&#x27;t write journeys/return-to-ithaca.md: the file is locked. Nothing was changed.");
  expect(shown.check_failed, "HYGIENE_CARD_FILE_DEFAULT_CHECK_FAILED").toContain("The change was written, but the check still fails: link-unresolved.");
  expect(shown.unknown).toContain("Didn&#x27;t hear back. Checking again won&#x27;t apply the change twice.");
  expect(shown.still_detected).toContain("Still detected — nothing changed");
  expect(shown.fixed, "HYGIENE_CARD_FILE_DEFAULT_FIXED").toContain("Fixed · re-checked · Finding no longer detected in journeys/return-to-ithaca.md");
  expect(shown.undone).toContain("Change undone. Review a new preview before applying again.");
});

test("caller copy replaces only the states it names, as inert text", () => {
  const hostile = "[x](http://e.test)<b>y</b>";
  const html = renderToStaticMarkup(<HygieneCard {...base} state="check_failed" stateText={{ check_failed: `The removal didn't finish: ${hostile}` }} />);
  expect(html, "HYGIENE_CARD_CALLER_COPY").toContain("The removal didn&#x27;t finish: [x](http://e.test)&lt;b&gt;y&lt;/b&gt;");
  expect(html).not.toContain("<b>y</b>");
  expect(html).not.toContain("The change was written");
  const fixed = renderToStaticMarkup(<HygieneCard {...base} state="fixed" stateText={{ fixed: "Worktree removed" }} />);
  expect(fixed, "HYGIENE_CARD_CALLER_FIXED").toContain("Worktree removed");
  expect(fixed).not.toContain("journeys/return-to-ithaca.md");
  // A state the caller does not name keeps its default.
  expect(renderToStaticMarkup(<HygieneCard {...base} state="stale" stateText={{ fixed: "Worktree removed" }} />)).toContain("This file changed since the finding was shown.");
});

test("the busy label is caller copy too, with the file default kept", () => {
  expect(renderToStaticMarkup(<HygieneCard {...base} state="applying" />), "HYGIENE_CARD_FILE_DEFAULT_BUSY").toContain("Applying… checking the file first");
  const html = renderToStaticMarkup(<HygieneCard {...base} state="applying" stateText={{ applying: "Removing… checking the worktree first" }} busyLabel="Removing… checking the worktree first" />);
  expect(html, "HYGIENE_CARD_CALLER_BUSY").not.toContain("checking the file first");
});
