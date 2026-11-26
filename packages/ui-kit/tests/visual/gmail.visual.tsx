/**
 * The Gmail components' claims that only a browser can check (#4209).
 *
 * The stories under `stories/google/` assert layout, focus, keyboard and
 * targets in both themes. This file adds what a story cannot set or see:
 *
 * - the on-demand body's loading state holds still under reduced motion,
 *   which Storybook cannot emulate, and is there to hold still;
 * - nothing in a rendered message or result list loads anything: hostile
 *   mail carrying an HTML image, a Markdown remote image, a CSS `url(…)`
 *   and attachment-like URLs, aimed at another origin and at this one,
 *   stays mounted and makes no request at all, on any origin. Every request
 *   the browser context makes is recorded and read without waiting for the
 *   network to go idle; a positive control proves the log sees a request;
 * - a link in a mail body cannot navigate before the interstitial, which
 *   says where the link was written and names no author: no anchor click,
 *   no `window.open`, no navigation and no request for the link's origin.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles.css";
import { contentThreads, hiddenCharsMessage, linkMessage, loomMessages, noBodyMessage } from "../../fixtures/gmail.js";
import { GmailMessage, type GmailContentMessage } from "../../src/google/GmailMessage.js";
import { GmailResultList, type GmailContentThread } from "../../src/google/GmailResultList.js";
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

/**
 * Every request recorded since the log started, read at once: no wait for the
 * network to go idle, because an offending request may never finish and the
 * test must fail on its assertion, not on its timeout (#4209 re-review RF1).
 * Fonts are data URLs (`design-font-setup.ts`), so nothing here is harness
 * traffic; only `data:` URLs are dropped.
 */
async function recordedNow(): Promise<string[]> {
  return (await commands.requestLog()).filter((raw) => !raw.startsWith("data:"));
}


/** Where the hostile mail points: a foreign host, this page's origin, and a URL that starts with this origin's text but is another origin. */
const HOSTILE = "https://cdn.ithaca-steward.example";
const hostileUrls = () => [
  `${HOSTILE}/pixel.png?to=odysseus`,
  `${location.origin}/gmail-hostile/same-origin.png`,
  // Starts with this origin's text; its host is ithaca-steward.example. A string-prefix filter would let it through.
  `${location.origin}@ithaca-steward.example/prefix.png`,
];

/** Mail written to make a renderer fetch: an HTML image, a Markdown image, a CSS `url(…)` and attachment-like URLs, at every untrusted slot. */
function hostileMail(): { message: GmailContentMessage; thread: GmailContentThread } {
  const [foreignUrl, sameUrl, prefixUrl] = hostileUrls() as [string, string, string];
  const body = [
    `<img src="${foreignUrl}" onerror="document.body.dataset.pwned='img'"> <img src="${sameUrl}"> <img src="${prefixUrl}">`,
    "",
    `![the herds](${foreignUrl}) ![the hall](${sameUrl}) ![the gate](${prefixUrl})`,
    "",
    `<div style="background-image:url(${foreignUrl})">styled</div> <style>body { background: url(${sameUrl}) }</style>`,
    "",
    `The invoice is attached: [invoice.pdf](${HOSTILE}/attachments/invoice.pdf) <link rel="stylesheet" href="${HOSTILE}/mail.css"> <iframe src="${HOSTILE}/frame"></iframe>`,
    "",
    "> On Fri, the steward wrote:",
    `> ![quoted](${foreignUrl})`,
  ].join("\n");
  const message: GmailContentMessage = {
    ...hiddenCharsMessage,
    untrusted: {
      ...hiddenCharsMessage.untrusted,
      from: `<img src="${foreignUrl}"> <steward@ithaca-steward.example>`,
      subject: `Invoice ![x](${foreignUrl}) url(${sameUrl})`,
      snippet: `<img src="${sameUrl}">`,
      body,
      attachments: [
        { filename: `${HOSTILE}/attachments/invoice.pdf`, mimeType: "application/pdf", size: 48_213 },
        { filename: null, mimeType: `image/png; url=${foreignUrl}`, size: 2_048 },
      ],
    },
  };
  const thread: GmailContentThread = {
    ...contentThreads[0]!,
    threadId: "19a1c0de0f2b4a99",
    untrusted: { from: message.untrusted.from, to: `<img src="${prefixUrl}">`, cc: `url(${foreignUrl})`, subject: message.untrusted.subject, snippet: body.slice(0, 300) },
  };
  return { message, thread };
}

/** Elements that load something, and any computed background image, in `el`. */
function loaders(el: ParentNode): string[] {
  const found = [...el.querySelectorAll("img, picture, source, video, audio, iframe, object, embed, link, script, style, [srcset], [style*='url(']")].map((node) => node.outerHTML.slice(0, 80));
  for (const node of el.querySelectorAll<HTMLElement>("*")) {
    const bg = getComputedStyle(node).backgroundImage;
    if (bg.includes("url(")) found.push(`background ${bg.slice(0, 80)}`);
  }
  return found;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("reduced motion", () => {
  test("the rest's loading story holds still", async () => {
    await commands.dictationMotion("reduce");
    // The story is a desktop one: its play checks the 680px column, so it runs in a viewport that holds one.
    const before = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(760, 900);
    try {
      await (messageStories.TruncatedLoadingReducedMotion as unknown as Runnable).run();
    } finally {
      await page.viewport(before.width, before.height);
    }
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const section = document.querySelector("[data-gmail-detail='loading']")!;
    expect(section, "the story rendered the loading state").not.toBeNull();
    // What holds still must be there: the ghost lines, drawn.
    const ghosts = [...section.querySelectorAll<HTMLElement>(".bk-ghost")];
    expect(ghosts.length, "the loading state draws its ghost lines").toBeGreaterThanOrEqual(3);
    for (const ghost of ghosts) expect(ghost.getBoundingClientRect().height, "a ghost line has height").toBeGreaterThan(0);
    expect(section.getAnimations({ subtree: true }).filter((a) => a.playState === "running"), "the ghost holds still").toEqual([]);
  });
});

describe("nothing loads", () => {
  test("the request log sees a request: an image this test adds itself", async () => {
    await commands.startRequestLog();
    const control = document.createElement("img");
    control.src = `${location.origin}/gmail-positive-control.png?${crypto.randomUUID()}`;
    document.body.append(control);
    try {
      // Polled without waiting for idle, like every read in this file: the control's own request need not
      // finish, only be issued. A wait for network idle hung past 30 s under CPU load (#4616 browser_determinism).
      // The poll's timeout is a watchdog, sized well above the request's start.
      await expect.poll(recordedNow, { timeout: 15_000, message: "the log records a same-origin image" }).toContain(control.src);
      expect(new URL(control.src).origin, "the control is this page's origin").toBe(location.origin);
    } finally {
      control.remove();
    }
  });

  test("hostile mail in a thread, a message with attachments and a content list requests nothing", async () => {
    const { message, thread } = hostileMail();
    const elements = [
      createElement(GmailThread, { view: "content", messages: [...loomMessages, { ...message, messageId: "19a1a01f10000099" }] }),
      createElement(GmailMessage, { view: "content", message }),
      createElement(GmailMessage, { view: "content", message: { ...message, untrusted: { ...message.untrusted, bodyTruncated: true, bodyLength: null }, detail: { state: "loaded", rest: message.untrusted.body } } }),
      createElement(GmailMessage, { view: "content", message: noBodyMessage }),
      createElement(GmailResultList, { view: "content", threads: [thread, ...contentThreads] }),
    ];
    await commands.startRequestLog();
    // Every card mounted at once and left mounted until the network is idle, so any load has the time to start.
    const roots: Root[] = [];
    const hosts: HTMLElement[] = [];
    try {
      for (const element of elements) {
        const el = document.createElement("div");
        el.style.cssText = "width:320px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
        document.body.append(el);
        const r = createRoot(el);
        flushSync(() => r.render(element));
        roots.push(r);
        hosts.push(el);
      }
      // Open every fold, row and quote, so the hostile text is all on screen.
      for (const button of hosts.flatMap((h) => [...h.querySelectorAll<HTMLButtonElement>("[data-gmail-fold], [data-gmail-quoted-toggle], [data-gmail-row='content'] > button")])) {
        if (button.getAttribute("aria-expanded") !== "true") flushSync(() => button.click());
      }
      for (const h of hosts) expect(loaders(h), "no element or style that loads").toEqual([]);
      const shown = hosts.map((h) => h.textContent ?? "").join("\n");
      expect(shown, "the hostile image tag is on screen, as text").toContain("<img src=");
      expect(shown, "the CSS url() is on screen, as text").toContain("background-image:url(");
      expect(shown, "the attachment-like URL is on screen, as text").toContain(`${HOSTILE}/attachments/invoice.pdf`);
      // Read twice without waiting for idle: rendering mail may make no request at all, on any origin,
      // including this page's own host endpoints, whether or not the request ever completes.
      await settle(500);
      expect(await recordedNow(), "rendering hostile mail made no request, 500 ms after mounting").toEqual([]);
      await settle(1000);
      expect(await recordedNow(), "rendering hostile mail made no request, 1.5 s after mounting").toEqual([]);
      expect(document.body.dataset.pwned, "no handler in the mail ran").toBeUndefined();
    } finally {
      for (const r of roots) flushSync(() => r.unmount());
      for (const h of hosts) h.remove();
    }
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
    // A popup: `window.open`, recorded and refused. The descriptor is restored whole.
    const openDescriptor = Object.getOwnPropertyDescriptor(window, "open");
    const opened: string[] = [];
    Object.defineProperty(window, "open", { configurable: true, writable: true, value: (url?: string | URL) => (opened.push(String(url)), null) });
    // A navigation of this document, by any means the Navigation API sees.
    const navigations: string[] = [];
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    const onNavigate = (event: Event) => {
      const e = event as Event & { destination?: { url: string } };
      navigations.push(e.destination?.url ?? "");
      if (e.cancelable) e.preventDefault();
    };
    navigation?.addEventListener("navigate", onNavigate);
    const linkOrigin = new URL("https://charts.pharos.example/route").origin;
    await commands.startRequestLog();
    document.addEventListener("click", stop, true);
    try {
      const el = mount(createElement(GmailMessage, { view: "content", message: linkMessage }));
      expect(el.querySelectorAll("a"), "no anchor in the message").toHaveLength(0);
      const link = el.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
      link.focus();
      await userEvent.keyboard("{Enter}");
      const dialog = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
      expect(dialog?.open, "the interstitial is open").toBe(true);
      expect(seen, "no anchor click on activation").toEqual([]);
      expect(opened, "no popup on activation").toEqual([]);
      expect(navigations, "no navigation on activation").toEqual([]);
      expect(navigation, "the browser has the Navigation API this test listens on").toBeDefined();
      expect(dialog.textContent).toContain("This link was written in this email.");
      expect(dialog.textContent).not.toContain("wrote this link");
      expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Open a link from Gmail?");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.activeElement).toBe(link);
      expect([seen, opened, navigations], "nothing navigated or opened after closing either").toEqual([[], [], []]);
      // Read without waiting for idle (RF1): a request the link started must fail the assertion, not stall it.
      await settle(500);
      const log = await recordedNow();
      expect(log.filter((raw) => new URL(raw).origin === linkOrigin), "no request, in this page or a new one, for the link's origin").toEqual([]);
      expect(log, "opening and closing the interstitial made no request at all").toEqual([]);
    } finally {
      document.removeEventListener("click", stop, true);
      navigation?.removeEventListener("navigate", onNavigate);
      if (openDescriptor) Object.defineProperty(window, "open", openDescriptor);
      else delete (window as unknown as { open?: unknown }).open;
    }
  });
});
