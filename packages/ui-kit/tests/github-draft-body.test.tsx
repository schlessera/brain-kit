/**
 * A not-posted draft's body is never cut (#4197): what the user approves is
 * what the host posts, up to 65,536 characters, so the read bodies'
 * 20,000-character bound does not apply to it. As markup; the 320px layout,
 * both themes and the clamp's expand control in a browser are the W1 long
 * draft stories' in `stories/github/GitHubWrite.stories.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { telemachus } from "../fixtures/github.js";
import { GitHubIssue } from "../src/github/GitHubIssue.js";
import { GitHubPullRequest } from "../src/github/GitHubPullRequest.js";
import { BODY_MAX_CHARS } from "../src/github/object-parts.js";

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

/** Past the read bound, and well inside the write limit. */
const LONG = `${"The tally of the wine store, night by night. ".repeat(Math.ceil((BODY_MAX_CHARS + 5_000) / 45))}THE-LAST-LINE`;

const pr = (p: { preview?: boolean }) => (
  <GitHubPullRequest state="open" repo="ithaca/hall" number={412} title="Sign the cellar key log" author={telemachus} headRef="key-log" baseRef="main" reviews={null} checks={null} body={LONG} {...p} />
);

describe("a draft body", () => {
  test("is longer than the read bound in this test", () => {
    expect(Array.from(LONG).length).toBeGreaterThan(BODY_MAX_CHARS + 1_000);
  });

  test("the W1 issue preview renders all of it, with no Truncated note", () => {
    const doc = draw(<GitHubIssue state="open" repo="ithaca/hall" title="Cellar key log is not signed after dusk" body={LONG} posting={{ status: "preview" }} />);
    expect(doc.body.textContent, "W1_PREVIEW_WHOLE_BODY").toContain("THE-LAST-LINE");
    expect(doc.body.textContent, "W1_PREVIEW_NO_TRUNCATED_NOTE").not.toContain("Truncated");
  });

  test("a pull request preview renders all of it, with no Truncated note", () => {
    const doc = draw(pr({ preview: true }));
    expect(doc.body.textContent, "PR_PREVIEW_WHOLE_BODY").toContain("THE-LAST-LINE");
    expect(doc.body.textContent, "PR_PREVIEW_NO_TRUNCATED_NOTE").not.toContain("Truncated");
    expect(doc.body.textContent, "a draft is not on GitHub").not.toContain("rest is on GitHub");
  });
});

describe("a read body keeps its bound", () => {
  test("an issue as read is cut at the bound and says so", () => {
    const doc = draw(<GitHubIssue state="open" repo="ithaca/hall" number={388} title="Suitors keep draining the wine store" author={telemachus} body={LONG} />);
    expect(doc.body.textContent, "ISSUE_READ_BOUND").not.toContain("THE-LAST-LINE");
    expect(doc.body.textContent, "ISSUE_READ_TRUNCATED_NOTE").toContain("Truncated");
  });

  test("a pull request as read is cut at the bound and says so", () => {
    const doc = draw(pr({}));
    expect(doc.body.textContent, "PR_READ_BOUND").not.toContain("THE-LAST-LINE");
    expect(doc.body.textContent, "PR_READ_TRUNCATED_NOTE").toContain("Truncated");
  });
});
