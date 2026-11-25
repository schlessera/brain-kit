/**
 * The Gmail components' claims that only a browser can check (#4209).
 *
 * The stories under `stories/google/` assert layout, focus, keyboard and
 * targets in both themes. This file adds what a story cannot set or see:
 *
 * - the on-demand body's loading state holds still under reduced motion,
 *   which Storybook cannot emulate;
 * - nothing in a rendered message or result list loads anything: no image,
 *   frame or font request leaves the page, and the attachment rows fetch
 *   nothing;
 * - a link in a mail body cannot navigate before the interstitial, which
 *   says where the link was written and names no author.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";

import "../../src/styles.css";
import { contentThreads, hiddenCharsMessage, linkMessage, loomMessages, noBodyMessage } from "../../fixtures/gmail.js";
import { GmailMessage } from "../../src/google/GmailMessage.js";
import { GmailResultList } from "../../src/google/GmailResultList.js";
import { GmailThread } from "../../src/google/GmailThread.js";
import * as messageStories from "../../stories/google/GmailMessage.stories.js";

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

function mount(element: ReturnType<typeof createElement>, width = 680): HTMLElement {
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

async function outbound(): Promise<string[]> {
  const log = await commands.requestLog({ settle: true });
  return log.filter((url) => !url.startsWith(location.origin) && !url.startsWith("data:"));
}

describe("reduced motion", () => {
  test("the rest's loading story holds still", async () => {
    await commands.dictationMotion("reduce");
    await (messageStories.TruncatedLoadingReducedMotion as unknown as Runnable).run();
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const section = document.querySelector("[data-gmail-detail='loading']")!;
    expect(section, "the story rendered the loading state").not.toBeNull();
    expect(section.getAnimations({ subtree: true }).filter((a) => a.playState === "running"), "the ghost holds still").toEqual([]);
  });
});

describe("nothing loads", () => {
  test("a thread, a message with attachments and a content list request nothing", async () => {
    await commands.startRequestLog();
    for (const element of [
      createElement(GmailThread, { view: "content", messages: loomMessages }),
      createElement(GmailMessage, { view: "content", message: hiddenCharsMessage }),
      createElement(GmailMessage, { view: "content", message: noBodyMessage }),
      createElement(GmailResultList, { view: "content", threads: contentThreads }),
    ]) {
      const el = mount(element, 320);
      expect(el.querySelectorAll("img, picture, source, video, audio, iframe, object, embed, link, script, [srcset]"), "no element that loads").toHaveLength(0);
      flushSync(() => root!.unmount());
      host!.remove();
      root = undefined;
      host = undefined;
    }
    expect(await outbound(), "nothing left the page").toEqual([]);
  });
});

describe("links in a body ask first", () => {
  test("activating the link opens the interstitial and navigates nowhere", async () => {
    const seen: string[] = [];
    const stop = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      seen.push(anchor.href);
      event.preventDefault();
    };
    document.addEventListener("click", stop, true);
    try {
      const el = mount(createElement(GmailMessage, { view: "content", message: linkMessage }));
      expect(el.querySelectorAll("a"), "no anchor in the message").toHaveLength(0);
      const link = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
      link.focus();
      await userEvent.keyboard("{Enter}");
      const dialog = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
      expect(dialog?.open, "the interstitial is open").toBe(true);
      expect(seen, "nothing navigated on activation").toEqual([]);
      expect(dialog.textContent).toContain("This link was written in this email.");
      expect(dialog.textContent).not.toContain("wrote this link");
      expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Open a link from Gmail?");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.activeElement).toBe(link);
    } finally {
      document.removeEventListener("click", stop, true);
    }
  });
});
