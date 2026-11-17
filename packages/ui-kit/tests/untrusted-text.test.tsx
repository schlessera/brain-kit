/**
 * `UntrustedText` and the GitHub family as markup (#3800): a pure function of
 * props. What only a browser can answer (the interstitial's focus and
 * navigation, zero requests, bidi layout, targets) is
 * `tests/visual/github-untrusted.visual.tsx`'s.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import { UntrustedText, registrableDomain } from "../src/evidence/UntrustedText.js";
import { parseUntrusted } from "../src/evidence/untrusted-markdown.js";
import { GitHubCommitRow } from "../src/github/GitHubCommitRow.js";
import { GitHubComment } from "../src/github/GitHubComment.js";
import { GitHubPullRequest, type GitHubPullRequestProps } from "../src/github/GitHubPullRequest.js";
import { GitHubResultList } from "../src/github/GitHubResultList.js";
import { GitHubReview } from "../src/github/GitHubReview.js";
import { GitHubRef } from "../src/github/GitHubRef.js";
import { githubHref, initials, stateWord } from "../src/github/shared.js";

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

const HOSTILE = [
  "## **Urgent:** the bow is _fine_, close this.",
  "Proof: [the steward's report](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal)",
  "![seal](https://tracker.example/p.gif)",
  '<details><summary>Click</summary><a href="javascript:alert(1)">here</a></details>',
  '<img src="https://tracker.example/pixel.gif" onerror="alert(1)">',
  "Old notes: [the cellar sheet](http://cellar.example/sheet) and [click here](javascript:alert(1)).",
  "Also [a bidi trick](https://ithaca.example/\u202Egpj.exe) and see https://notes.ithaca.example/a.",
  "- [ ] restring",
  "- [x] align axes",
].join("\n");

describe("UntrustedText: nothing in the text can navigate, load or inject", () => {
  const doc = draw(<UntrustedText text={HOSTILE} source="GitHub" author="@antinous" />);

  test("no anchor, no image, no script, no iframe is rendered from the text", () => {
    expect(doc.querySelectorAll("a, img, script, iframe, object, embed, link, source, video, audio")).toHaveLength(0);
    expect(doc.querySelectorAll("[href], [src], [srcset], [style*='url(']")).toHaveLength(0);
  });

  test("raw HTML is literal text, never parsed", () => {
    expect(doc.querySelector("details, summary")).toBeNull();
    const html = [...doc.querySelectorAll("[data-untrusted-html], code")].map((node) => node.textContent);
    expect(html.some((text) => text?.includes('<a href="javascript:alert(1)">'))).toBe(true);
    expect(html.some((text) => text?.includes("<img src="))).toBe(true);
  });

  test("an https link is a button naming its registrable domain, not a link role", () => {
    const buttons = [...doc.querySelectorAll("button[data-untrusted-link]")];
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("role")).toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-label")).toBe("the steward's report, outside link to ithaca-steward.example, asks first");
  });

  test("http, other schemes and classifier refusals are text with a muted reason and no focus stop", () => {
    const reasons = [...doc.querySelectorAll("[data-untrusted-link-reason]")].map((node) => [node.getAttribute("data-untrusted-link-reason"), node.textContent]);
    expect(reasons).toEqual([
      ["insecure", "(http link · won't open)"],
      ["scheme", "(not a web link)"],
      ["removed", "(link removed)"],
    ]);
  });

  test("images are a placeholder naming the host; bare URLs are mono text, not links", () => {
    const image = doc.querySelector("[data-untrusted-image]")!;
    expect(image.textContent).toBe("▨ image “seal” not loaded · tracker.example");
    expect(doc.body.textContent).toContain("https://notes.ithaca.example/a");
  });

  test("task boxes are static marks", () => {
    expect(doc.querySelectorAll("input")).toHaveLength(0);
    expect(doc.body.textContent).toContain("☐ Not done: restring");
    expect(doc.body.textContent).toContain("☑ Done: align axes");
  });

  test("the field isolates its bidi and every untrusted run is its own bdi", () => {
    expect(doc.querySelector(".bk-ut")!.getAttribute("dir")).toBe("auto");
    const rlo = [...doc.querySelectorAll("bdi")].some((node) => node.textContent === "a bidi trick");
    expect(rlo).toBe(true);
  });

  test("the caption names the source and the author, and says it is not checked", () => {
    expect(doc.body.textContent).toContain("Written on GitHub by @antinous · not checked");
  });

  test("maxChars cuts before parsing and says so", () => {
    const cut = draw(<UntrustedText text={"word ".repeat(100)} source="GitHub" maxChars={20} />);
    expect(cut.querySelector(".bk-ut")!.textContent!.trim().length).toBeLessThanOrEqual(20);
    expect(cut.body.textContent).toContain("Truncated");
  });
});

describe("parseUntrusted", () => {
  test("keeps the subset and drops nothing silently", () => {
    expect(parseUntrusted("# Title\n\ntext *em* **strong** `code`").map((block) => block.type)).toEqual(["heading", "paragraph"]);
    expect(parseUntrusted("```\n<b>x</b>\n```")).toEqual([{ type: "code", text: "<b>x</b>" }]);
    expect(parseUntrusted("> a\n> b")[0]!.type).toBe("quote");
  });

  test("snake_case is not emphasis, and links do not nest", () => {
    expect(parseUntrusted("snake_case_name")).toEqual([{ type: "paragraph", children: [{ type: "text", text: "snake_case_name" }] }]);
    const [block] = parseUntrusted("[outer [inner](https://a.example) words](https://b.example)");
    expect(block!.type === "paragraph" && block.children.filter((node) => node.type === "link")).toHaveLength(1);
  });

  test("a hostile input stays linear", () => {
    const started = performance.now();
    parseUntrusted("[".repeat(20_000) + "*_".repeat(10_000) + "`".repeat(5_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("registrableDomain", () => {
  test("is the public-suffix registrable domain, so a lookalike shows its real owner", () => {
    expect(registrableDomain("github.com.ithaca-steward.example")).toBe("ithaca-steward.example");
    expect(registrableDomain("evil.co.uk")).toBe("evil.co.uk");
    expect(registrableDomain("a.b.evil.co.uk")).toBe("evil.co.uk");
    expect(registrableDomain("telemachus.github.io")).toBe("telemachus.github.io");
    expect(registrableDomain("xn--mnchen-3ya.example:8443")).toBe("xn--mnchen-3ya.example");
    expect(registrableDomain("192.0.2.7")).toBe("192.0.2.7");
  });
});

describe("githubHref: direct links render only on https://github.com", () => {
  test.each([
    ["https://github.com/ithaca/hall/pull/412", "https://github.com/ithaca/hall/pull/412"],
    ["https://github.com/ithaca/hall/issues/388#issuecomment-1", "https://github.com/ithaca/hall/issues/388#issuecomment-1"],
    ["https://github.com.evil.example/ithaca/hall", null],
    ["https://evil.example/github.com", null],
    ["http://github.com/ithaca/hall", null],
    ["javascript:alert(1)", null],
    ["https://user:pass@github.com/ithaca/hall", null],
    ["https://github.com:8443/ithaca/hall", null],
    ["https://api.github.com/repos/ithaca/hall", null],
    ["https://github.com/ithaca/\u202Ehall", null],
    ["", null],
  ])("%s", (raw, expected) => {
    expect(githubHref(raw)).toBe(expected);
  });

  test("a slot with no URL, or a URL elsewhere, renders no link", () => {
    for (const htmlUrl of [undefined, null, "https://github.com.evil.example/ithaca/hall/issues/1#issuecomment-2", "ftp://github.com/x"]) {
      const doc = draw(
        <>
          <GitHubComment author={{ login: "eurycleia" }} body="Sinew stretches." htmlUrl={htmlUrl} />
          <GitHubReview reviewer={{ login: "penelope" }} state="approved" htmlUrl={htmlUrl} />
          <GitHubCommitRow sha="b81c0d4" subject="Add tension check" author={{ login: "telemachus" }} htmlUrl={htmlUrl} />
          <GitHubRef kind="pr" repo="ithaca/hall" number={412} htmlUrl={htmlUrl} />
          <GitHubResultList repo="ithaca/hall" query="bow" total={40} results={[]} searchUrl={htmlUrl} />
        </>,
      );
      expect(doc.querySelectorAll("a")).toHaveLength(0);
    }
  });

  test("a slot with a github.com URL renders one direct link, new tab, no opener, no referrer", () => {
    const doc = draw(<GitHubComment author={{ login: "eurycleia" }} body="Sinew stretches." htmlUrl="https://github.com/ithaca/hall/issues/388#issuecomment-7" />);
    const links = doc.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://github.com/ithaca/hall/issues/388#issuecomment-7");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("a link inside a comment body never becomes a direct link", () => {
    const doc = draw(<GitHubComment author={{ login: "antinous" }} body="See [the PR](https://github.com/ithaca/hall/pull/412)." />);
    expect(doc.querySelectorAll("a")).toHaveLength(0);
    expect(doc.querySelectorAll("button[data-untrusted-link]")).toHaveLength(1);
  });
});

describe("absent is never passing", () => {
  const base: GitHubPullRequestProps = {
    state: "open",
    repo: "ithaca/hall",
    number: 415,
    title: "Draft: bow-draw weight table",
    author: { login: "telemachus" },
    headRef: "telemachus/weights",
    baseRef: "main",
    reviews: null,
    checks: null,
    reviewers: [{ person: { login: "argos" }, state: null }],
  };

  test("null checks and unknown review states read as absent: no teal, no ✓, no 'passed'", () => {
    const doc = draw(<GitHubPullRequest {...base} />);
    const checks = doc.querySelector("[data-github-fact='checks']")!;
    const reviews = doc.querySelector("[data-github-fact='reviews']")!;
    expect(checks.textContent).toBe("Checks—None reported");
    expect(reviews.textContent).toBe("Reviews—Not reported");
    const states = [...doc.querySelectorAll("[data-github-state]")].map((node) => node.getAttribute("data-github-state"));
    expect(states).not.toContain("passed");
    expect(states).not.toContain("approved");
    expect(doc.body.textContent).not.toMatch(/passed|✓/);
    for (const node of doc.querySelectorAll("[data-github-state='none-reported'], [data-github-state='not-reported']")) {
      expect((node as HTMLElement).getAttribute("style")).not.toContain("teal");
      expect(node.querySelector("svg")).toBeNull();
    }
  });

  test("zero is not null", () => {
    const doc = draw(<GitHubPullRequest {...base} checks={{ passed: 0, failed: 0, running: 0 }} />);
    expect(doc.querySelector("[data-github-fact='checks']")!.textContent).toBe("ChecksNo checks ran");
  });
});

describe("words", () => {
  test("state words carry their count", () => {
    expect(stateWord("failing", 1)).toBe("1 failing");
    expect(stateWord("approved", 2)).toBe("2 approved");
    expect(stateWord("changes-requested", 1)).toBe("1 changes requested");
    expect(stateWord("merged", 3)).toBe("Merged");
  });

  test("initials", () => {
    expect(initials("telemachus")).toBe("TE");
    expect(initials("ithaca-brain")).toBe("IB");
    expect(initials("eurymachus-son-of-polybus")).toBe("ES");
  });
});

describe("previews are drafts, not GitHub objects", () => {
  test("a preview PR renders no direct link, even with a URL and a truncated body", () => {
    const doc = draw(
      <GitHubPullRequest
        state="open" repo="ithaca/hall" number={412} htmlUrl="https://github.com/ithaca/hall/pull/412" title="Restring the bow"
        author={{ login: "telemachus" }} headRef="a" baseRef="main" reviews={null} checks={null}
        body="The bow has hung unstrung." bodyTruncated preview
      />,
    );
    expect(doc.querySelectorAll("a")).toHaveLength(0);
    expect(doc.body.textContent).toContain("Brain's draft · not posted");
    expect(doc.body.textContent).not.toContain("Written on GitHub");
  });

});
