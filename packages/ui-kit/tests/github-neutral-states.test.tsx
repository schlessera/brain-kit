/**
 * The GitHub kit's neutral states for what a host could not verify (#4154),
 * as markup: a preview comment with no verified poster, and a target with no
 * verified kind. What only a browser can answer (the 320px layout, both
 * themes, the clamp's expand control, the a11y gate) is the W4 stories' in
 * `stories/github/GitHubWrite.stories.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ghost, telemachus } from "../fixtures/github.js";
import { COMMENT_MAX_CHARS, GitHubComment } from "../src/github/GitHubComment.js";
import { GitHubRef } from "../src/github/GitHubRef.js";

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

const ISSUE_URL = "https://github.com/ithaca/hall/issues/388";

describe("a preview with no verified poster", () => {
  test("names the host's GitHub account, never @ghost or any login, and loads no avatar", () => {
    const doc = draw(<GitHubComment body="Filed #401 for the key log." preview />);
    const article = doc.querySelector("article")!;
    expect(article.getAttribute("aria-label"), "KIT_HOST_ACCOUNT_NAME").toBe("Comment not posted by the host's GitHub account");
    expect(doc.body.textContent, "KIT_HOST_ACCOUNT_SHOWN").toContain("The host's GitHub account");
    expect(doc.body.textContent, "KIT_HOST_ACCOUNT_NOT_GHOST").not.toContain("ghost");
    expect(doc.body.textContent).not.toContain("@");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("[data-avatar-state='ghost']"), "not the deleted account's dashed avatar").toBeNull();
    expect(doc.body.textContent, "still not posted").toContain("Not posted");
    expect(doc.querySelector("a"), "a preview has no link").toBeNull();
  });

  test("a verified poster and a deleted posted author keep their meanings", () => {
    expect(draw(<GitHubComment author={telemachus} body="x" preview />).querySelector("article")!.getAttribute("aria-label")).toBe("Comment not posted by @telemachus");
    const posted = draw(<GitHubComment author={ghost} body="x" />);
    expect(posted.querySelector("article")!.getAttribute("aria-label"), "KIT_GHOST_IS_DELETED").toBe("Comment by @ghost");
    expect(posted.body.textContent).toContain("account deleted");
  });

  test("a preview renders its whole draft; a posted comment keeps its bound", () => {
    const body = `${"a".repeat(COMMENT_MAX_CHARS)}THE-END`;
    const preview = draw(<GitHubComment body={body} preview />);
    expect(preview.body.textContent, "KIT_PREVIEW_EXACT_BODY").toContain("THE-END");
    expect(preview.body.textContent).not.toContain("Truncated");
    const posted = draw(<GitHubComment author={telemachus} body={body} />);
    expect(posted.body.textContent, "the posted bound is unchanged").not.toContain("THE-END");
    expect(posted.body.textContent).toContain("Truncated");
  });
});

describe("a target with no verified kind", () => {
  test("reads repository #number, claims neither kind and has no link, whatever URL it is handed", () => {
    for (const element of [
      <GitHubRef kind={null} repo="ithaca/hall" number={388} />,
      <GitHubRef kind={null} repo="ithaca/hall" number={388} htmlUrl={ISSUE_URL} />,
    ]) {
      const doc = draw(element);
      expect(doc.querySelector("[data-github-ref]")!.textContent, "KIT_UNKNOWN_KIND_TEXT").toBe("ithaca/hall #388");
      expect(doc.querySelector("a"), "KIT_UNKNOWN_KIND_NO_LINK").toBeNull();
    }
  });

  test("as the compact target row it shows no state chip and no link", () => {
    const doc = draw(<GitHubRef kind={null} repo="ithaca/hall" number={388} title="Suitors keep draining the wine store" state="open" htmlUrl={ISSUE_URL} />);
    expect(doc.body.textContent).not.toMatch(/Issue|PR|Open/);
    expect(doc.querySelector("a"), "KIT_UNKNOWN_KIND_ROW_NO_LINK").toBeNull();
    expect(doc.body.textContent).toContain("Suitors keep draining the wine store");
  });

  test("a verified kind keeps its word and its link", () => {
    const issue = draw(<GitHubRef kind="issue" repo="ithaca/hall" number={388} htmlUrl={ISSUE_URL} />);
    expect(issue.querySelector("[data-github-ref]")!.textContent).toBe("Issue · ithaca/hall #388");
    expect(issue.querySelector("a")!.getAttribute("href")).toBe(ISSUE_URL);
    expect(draw(<GitHubRef kind="pr" repo="ithaca/hall" number={412} />).querySelector("[data-github-ref]")!.textContent).toBe("PR · ithaca/hall #412");
  });
});
