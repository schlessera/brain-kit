/**
 * The GitHub family's security claims, in a real browser (#3800).
 *
 * `tests/untrusted-text.test.tsx` proves the markup. This file proves what
 * only a browser can:
 *
 * - an untrusted https link cannot navigate before the full-URL
 *   interstitial, and only its Open action navigates, in a new tab;
 * - non-https links stay inert, out of the tab order;
 * - raw HTML is never parsed, so a handler in it never runs;
 * - remote content images never load; only an explicit brain-origin avatar
 *   prop loads an image, and the request log sees that one (the positive
 *   control that proves the log can see a request at all);
 * - bidi content cannot reorder the chrome beside it;
 * - direct links appear only in their slots, only with a github.com URL,
 *   never from inside untrusted text;
 * - S1 and the interstitial do not animate under reduced motion.
 */
import { createElement, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles.css";
import { UntrustedText } from "../../src/evidence/UntrustedText.js";
import { GitHubComment } from "../../src/github/GitHubComment.js";
import { GitHubCommitRow } from "../../src/github/GitHubCommitRow.js";
import { GitHubDetailSection } from "../../src/github/GitHubDetailSection.js";
import { GitHubIdentity } from "../../src/github/GitHubIdentity.js";
import { GitHubMergeEvent } from "../../src/github/GitHubMergeEvent.js";
import { GitHubRef } from "../../src/github/GitHubRef.js";
import { GitHubPullRequest } from "../../src/github/GitHubPullRequest.js";
import { GitHubIssue } from "../../src/github/GitHubIssue.js";
import { GitHubResultList } from "../../src/github/GitHubResultList.js";
import { GitHubReview } from "../../src/github/GitHubReview.js";
import { hostileBody } from "../../fixtures/github.js";
import { AVATARS } from "../../stories/github/_github.js";
import * as detailStories from "../../stories/github/GitHubDetailSection.stories.js";
import * as untrustedStories from "../../stories/evidence/UntrustedText.stories.js";
import * as resultStories from "../../stories/github/GitHubResultList.stories.js";

type Runnable = { run: (context?: unknown) => Promise<void> };

declare module "vitest/browser" {
  interface BrowserCommands {
    startRequestLog: () => Promise<void>;
    requestLog: (options?: { settle: boolean }) => Promise<string[]>;
    dictationMotion: (motion: "reduce" | "no-preference") => Promise<void>;
  }
}

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount(element: ReactElement, width = 680): HTMLElement {
  host = document.createElement("div");
  host.style.cssText = `width:${width}px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(element));
  return host;
}

afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  await commands.dictationMotion("no-preference");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

function loaders(el: ParentNode): string[] {
  const found = [...el.querySelectorAll("img, picture, source, video, audio, iframe, object, embed, link, script, [srcset]")].map((node) => node.outerHTML.slice(0, 80));
  for (const node of el.querySelectorAll<HTMLElement>("*")) {
    const bg = getComputedStyle(node).backgroundImage;
    if (bg.includes("url(")) found.push(`background ${bg.slice(0, 80)}`);
  }
  return found;
}

async function outbound(): Promise<string[]> {
  const log = await commands.requestLog();
  return log.filter((url) => !url.startsWith(location.origin) && !url.startsWith("data:"));
}

/** Every navigation an anchor click would start, recorded and stopped before it leaves the page. */
function recordNavigation() {
  const seen: { href: string; target: string; rel: string }[] = [];
  const stop = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    seen.push({ href: anchor.href, target: anchor.target, rel: anchor.rel });
    event.preventDefault();
  };
  document.addEventListener("click", stop, true);
  return { seen, stop: () => document.removeEventListener("click", stop, true) };
}

const ASK = "Nobody is draining anything. Proof: [the steward's report](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal).";

describe("UntrustedText: links ask first", () => {
  test("activating an https link opens the interstitial and navigates nowhere", async () => {
    await commands.startRequestLog();
    const nav = recordNavigation();
    try {
      const el = mount(createElement(UntrustedText, { text: ASK, source: "GitHub", author: "@antinous" }));
      expect(el.querySelectorAll("a"), "no anchor in the text").toHaveLength(0);
      const link = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
      link.focus();
      await userEvent.keyboard("{Enter}");
      const dialog = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
      expect(dialog?.open, "the interstitial is open").toBe(true);
      expect(nav.seen, "nothing navigated on activation").toEqual([]);
      expect(dialog.querySelector("[data-untrusted-gate-domain]")!.textContent).toBe("ithaca-steward.example");
      expect(dialog.querySelector("[data-untrusted-gate-emphasis]")!.textContent).toBe("ithaca-steward.example");
      expect(dialog.querySelector("[data-untrusted-gate-address]")!.textContent).toBe("https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal");

      // Focus starts on Stay here: a second Enter closes, it does not open the site.
      expect(document.activeElement?.textContent).toBe("Stay here");
      await userEvent.keyboard("{Enter}");
      expect(document.querySelector("dialog[data-untrusted-gate]"), "Stay here closes").toBeNull();
      expect(nav.seen, "a double Enter navigates nowhere").toEqual([]);
      await expect.poll(() => document.activeElement).toBe(link);

      // Only Open navigates: one new tab, no opener, no referrer.
      await userEvent.click(link);
      await userEvent.click(document.querySelector<HTMLAnchorElement>("a[data-untrusted-open]")!);
      expect(nav.seen).toEqual([{ href: "https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal", target: "_blank", rel: "noopener noreferrer nofollow" }]);
      expect(document.querySelector("dialog[data-untrusted-gate]"), "Open closes the interstitial").toBeNull();
      await expect.poll(() => document.activeElement).toBe(link);
      expect(await outbound(), "nothing left the page").toEqual([]);
    } finally {
      nav.stop();
    }
  });

  test("a draft's link names the draft, not GitHub, as where it was written", async () => {
    for (const element of [
      createElement(GitHubComment, { author: { login: "ithaca-brain", bot: true }, body: "See [the log](https://ithaca.example/log).", preview: true }),
      createElement(GitHubIssue, { state: "open", repo: "ithaca/hall", title: "Key log", body: "See [the log](https://ithaca.example/log).", posting: { status: "preview" } }),
    ]) {
      const el = mount(element);
      await userEvent.click(el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!);
      const dialog = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
      expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Open a link from this draft?");
      expect(dialog.textContent).toContain("This link was written in this draft.");
      expect(dialog.textContent).not.toContain("on GitHub");
      await userEvent.keyboard("{Escape}");
      flushSync(() => root!.unmount());
      host!.remove();
      root = undefined;
      host = undefined;
    }
  });

  test("a link clipped out of a clamped field expands it when it takes focus", async () => {
    const text = `${"The bow has hung unstrung for twenty years. ".repeat(20)}\n\nSee [the armoury notes](https://notes.ithaca.example/a).`;
    const el = mount(createElement(UntrustedText, { text, source: "GitHub", lines: 3, expandLabel: "Show full description" }), 320);
    const field = el.querySelector<HTMLElement>(".bk-ut")!;
    expect(field.classList.contains("bk-ut-clamp"), "the field starts clamped").toBe(true);
    const button = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
    button.focus();
    expect(document.activeElement, "the clipped link takes focus").toBe(button);
    await expect.poll(() => field.classList.contains("bk-ut-clamp"), { timeout: 2000 }).toBe(false);
    const link = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!.getBoundingClientRect();
    expect(link.bottom, "the focused link is inside the field").toBeLessThanOrEqual(field.getBoundingClientRect().bottom + 1);
  });

  test("Escape closes the interstitial and returns focus to the link", async () => {
    const el = mount(createElement(UntrustedText, { text: ASK, source: "GitHub" }));
    const link = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
    await userEvent.click(link);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("dialog[data-untrusted-gate]")).toBeNull();
    await expect.poll(() => document.activeElement).toBe(link);
  });

  test("http, javascript and refused links are inert and take no focus stop", async () => {
    const nav = recordNavigation();
    try {
      const el = mount(
        createElement(UntrustedText, {
          text: "[the cellar sheet](http://cellar.ithaca.example/sheet) [click here](javascript:alert(1)) [bidi](https://ithaca.example/\u202Efdp.exe)",
          source: "GitHub",
        }),
      );
      expect(el.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
      for (const word of ["the cellar sheet", "click here", "bidi"]) {
        const node = [...el.querySelectorAll("bdi")].find((b) => b.textContent === word)!;
        await userEvent.click(node);
      }
      expect(nav.seen).toEqual([]);
      expect(document.querySelector("dialog")).toBeNull();
    } finally {
      nav.stop();
    }
  });
});

describe("nothing loads, nothing runs", () => {
  test("raw HTML is never parsed and remote images never load", async () => {
    const pwned = (window as unknown as { __pwned?: boolean });
    pwned.__pwned = false;
    await commands.startRequestLog();
    const el = mount(
      createElement(UntrustedText, {
        text: `${hostileBody}\n\n<img src="https://tracker.example/pixel.gif" onerror="window.__pwned = true">\n\n<svg onload="window.__pwned = true"></svg>`,
        source: "GitHub",
        author: "@antinous",
      }),
    );
    await settle();
    expect(el.querySelector("details, summary, svg[onload], img"), "no element from the text").toBeNull();
    expect(loaders(el), "nothing in the text can load").toEqual([]);
    expect(pwned.__pwned, "no handler from the text ran").toBe(false);
    expect(await outbound(), "no request left the page").toEqual([]);
  });

  test("only a brain-origin avatar loads an image, and the log sees it", async () => {
    await commands.startRequestLog();
    const el = mount(
      createElement("div", null, [
        createElement(GitHubIdentity, { key: "remote", login: "penelope", avatarSrc: "https://avatars.githubusercontent.com/u/1?v=4" }),
        createElement(GitHubIdentity, { key: "data", login: "argos", avatarSrc: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" }),
        createElement(GitHubIdentity, { key: "relative", login: "antinous", avatarSrc: "//avatars.githubusercontent.com/u/2" }),
        createElement(GitHubIdentity, { key: "proxy", login: "telemachus", avatarSrc: AVATARS.telemachus }),
      ]),
    );
    await expect.poll(() => el.querySelector("[data-avatar-state='loaded']")).not.toBeNull();
    await settle();
    const images = [...el.querySelectorAll("img")].map((img) => new URL(img.src).origin);
    expect(images, "one image, from the page's own origin").toEqual([location.origin]);
    const log = await commands.requestLog();
    expect(log.some((url) => url.includes("_avatars/telemachus.svg")), "positive control: the log sees the proxy request").toBe(true);
    expect(await outbound(), "nothing from GitHub's image hosts").toEqual([]);
  });
});

describe("bidi cannot reorder the chrome", () => {
  test("an RLO in link words or a title leaves the label beside it in place", async () => {
    const el = mount(
      createElement("div", null, [
        createElement(UntrustedText, {
          key: "text",
          text: "\u202Eesrever [\u202Eetis eht](https://ithaca.example/notes) and [\u202Ekool](http://log.example/)",
          source: "GitHub",
          caption: false,
          frame: "none",
        }),
        createElement(GitHubResultList, { key: "list", repo: "ithaca/hall", query: "bow", total: 1, results: [{ kind: "issue", number: 409, state: "open", title: "Bow string frays", facts: ["\u202Ewob", "3 comments"] }] }),
        // One inline run of chrome and untrusted words: the branch name sits mid-sentence.
        createElement(GitHubMergeEvent, { key: "merge", by: { login: "penelope" }, into: "\u202Eniam", sha: "a3f9c21", time: "1 d ago" }),
      ]),
    );
    const words = el.querySelector(".bk-ut-link-words")!.getBoundingClientRect();
    const domain = [...el.querySelectorAll("button[data-untrusted-link] span")].at(-1)!.getBoundingClientRect();
    expect(domain.left, "the domain label stays after the link words").toBeGreaterThanOrEqual(words.right - 1);
    const reason = el.querySelector("[data-untrusted-link-reason]")!.getBoundingClientRect();
    const kool = [...el.querySelectorAll("bdi")].find((b) => b.textContent === "\u202Ekool")!.getBoundingClientRect();
    expect(reason.left, "the reason stays after its words").toBeGreaterThanOrEqual(kool.right - 1);
    const row = el.querySelector("[data-github-result] button")!;
    const fact = [...row.querySelectorAll("[data-untrusted-field]")].find((b) => b.textContent === "\u202Ewob")!.getBoundingClientRect();
    const tail = [...row.querySelectorAll("span")].find((node) => node.textContent === " · 3 comments")!.getBoundingClientRect();
    expect(tail.left, "the next fact stays after a label in a result row").toBeGreaterThanOrEqual(fact.right - 1);
    const merge = el.querySelector("[data-github-merge]")!;
    const branch = [...merge.querySelectorAll("[data-untrusted-field]")].find((b) => b.textContent === "\u202Eniam")!.getBoundingClientRect();
    const sha = [...merge.querySelectorAll("span")].find((node) => node.textContent === " · a3f9c21")!.getBoundingClientRect();
    expect(sha.left, "the sha stays after the branch in the merge sentence").toBeGreaterThanOrEqual(branch.right - 1);
  });
});

describe("direct links: only in their slots, only to github.com", () => {
  const slots = (htmlUrl: string | undefined) =>
    createElement("div", null, [
      createElement(GitHubComment, { key: "c", author: { login: "antinous" }, body: "See [the PR](https://github.com/ithaca/hall/pull/412).", htmlUrl }),
      createElement(GitHubReview, { key: "r", reviewer: { login: "penelope" }, state: "approved", htmlUrl }),
      createElement(GitHubCommitRow, { key: "m", sha: "b81c0d4", subject: "Add tension check", author: { login: "telemachus" }, htmlUrl }),
      createElement(GitHubRef, { key: "f", kind: "pr", repo: "ithaca/hall", number: 412, htmlUrl }),
      createElement(GitHubResultList, { key: "l", repo: "ithaca/hall", query: "bow", total: 40, results: [], searchUrl: htmlUrl }),
    ]);

  test("a github.com URL renders one direct link per slot, and the link in the comment body still asks", async () => {
    const nav = recordNavigation();
    try {
      const el = mount(slots("https://github.com/ithaca/hall/pull/412#issuecomment-1"));
      const links = [...el.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links).toHaveLength(5);
      await userEvent.click(links[0]!);
      expect(nav.seen, "a direct link opens directly, in a new tab").toEqual([{ href: "https://github.com/ithaca/hall/pull/412#issuecomment-1", target: "_blank", rel: "noopener noreferrer" }]);
      expect(document.querySelector("dialog"), "no interstitial for a direct link").toBeNull();
      await userEvent.click(el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!);
      expect(nav.seen, "the body's own github.com link never opens directly").toHaveLength(1);
      expect(document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")?.open).toBe(true);
      await userEvent.keyboard("{Escape}");
    } finally {
      nav.stop();
    }
  });

  test.each([undefined, "https://github.com.evil.example/ithaca/hall/pull/412", "http://github.com/ithaca/hall/pull/412", "javascript:alert(1)", "https://github.com:8443/x"])(
    "%s renders no link in any slot",
    async (htmlUrl) => {
      const el = mount(slots(htmlUrl));
      expect(el.querySelectorAll("a")).toHaveLength(0);
    },
  );
});

describe("reduced motion", () => {
  // The two reduced-motion stories, rendered as written, with the media
  // feature emulated: Storybook itself cannot set it.
  test("the S1 reduced-motion story holds still", async () => {
    await commands.dictationMotion("reduce");
    await (detailStories.LoadingReducedMotion as unknown as Runnable).run();
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const section = document.querySelector("[data-github-detail='loading']")!;
    expect(section, "the story rendered S1").not.toBeNull();
    expect(section.getAnimations({ subtree: true }).filter((a) => a.playState === "running"), "S1 holds still").toEqual([]);
  });

  test("the interstitial reduced-motion story opens without motion", async () => {
    await commands.dictationMotion("reduce");
    await (untrustedStories.InterstitialReducedMotion as unknown as Runnable).run();
    const dialog = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
    expect(dialog?.open, "the story opened the interstitial").toBe(true);
    expect(dialog.getAnimations({ subtree: true }), "the interstitial appears without motion").toEqual([]);
    await userEvent.keyboard("{Escape}");
  });
});

describe("targets", () => {
  /** A control's reachable height: its box, or its `::before` reach for an inline text control. */
  const reach = (control: HTMLElement) => {
    const box = control.getBoundingClientRect();
    const before = getComputedStyle(control, "::before");
    return before.content !== "none" && before.position === "absolute" ? box.height + 2 * Math.abs(parseFloat(before.top)) : box.height;
  };
  /** Every control is 44px tall, or carries `.bk-hit`, the kit's coarse-pointer reach (#4086). */
  const meetsTarget = (el: ParentNode) => {
    for (const control of el.querySelectorAll<HTMLElement>("a, button")) {
      if (control.matches(".bk-ut-link")) continue; // inline link: the WCAG 2.5.8 inline exception, per the design
      if (control.classList.contains("bk-hit")) continue;
      expect(reach(control), `${control.textContent}: 44px target`).toBeGreaterThanOrEqual(44);
    }
  };

  test("every control in the thread, commit and detail components is a 44px target at 320px", async () => {
    await page.viewport(320, 800);
    const el = mount(
      createElement("div", null, [
        createElement(GitHubComment, { key: "c", author: { login: "eurycleia" }, time: "2 d ago", body: "Sinew stretches.", htmlUrl: "https://github.com/ithaca/hall/issues/388#issuecomment-2" }),
        createElement(GitHubCommitRow, { key: "m", sha: "b81c0d4", subject: "Add tension check", message: "Add tension check\n\nBody.", author: { login: "telemachus" }, htmlUrl: "https://github.com/ithaca/hall/commit/b81c0d4" }),
        createElement(GitHubDetailSection, { key: "d", state: "error", errorStatus: 502, noun: "commits", object: "pull request", idleLabel: "Show commits", onRetry: () => {} }),
        createElement(GitHubDetailSection, { key: "i", state: "idle", noun: "files", object: "pull request", idleLabel: "Show files", onLoad: () => {} }),
        createElement(UntrustedText, { key: "u", text: Array(30).fill("The bow has hung unstrung for twenty years.").join(" "), source: "GitHub", lines: 3, expandLabel: "Show full description" }),
      ]),
      288,
    );
    expect(el.querySelector("button.bk-text-btn[aria-expanded='false']"), "the expand control rendered").not.toBeNull();
    meetsTarget(el);
  });

  test("the result list's rows, Show more and links are 44px targets", async () => {
    await page.viewport(320, 900);
    await (resultStories.MixedNarrow as unknown as Runnable).run();
    const list = document.querySelector("[data-github-results]")!;
    await userEvent.click(list.querySelector<HTMLButtonElement>("li button")!);
    meetsTarget(list);
  });

  test("the labels' +n and the interstitial's actions are targets", async () => {
    await page.viewport(320, 800);
    const el = mount(createElement(GitHubPullRequest, { state: "open", repo: "ithaca/hall", number: 412, title: "Restring the bow", author: { login: "telemachus" }, headRef: "a", baseRef: "main", labels: ["bow", "contest", "armoury", "axes"], reviews: null, checks: null, body: "See [the notes](https://notes.ithaca.example/a)." }), 288);
    const more = el.querySelector<HTMLButtonElement>("[data-github-labels] button")!;
    expect(more.classList.contains("bk-hit"), "+n carries the kit's 44px coarse-pointer reach").toBe(true);
    await userEvent.click(el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!);
    meetsTarget(document.querySelector("dialog[data-untrusted-gate]")!);
    await userEvent.keyboard("{Escape}");
  });
});
