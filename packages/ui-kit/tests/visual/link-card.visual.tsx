/**
 * The link card makes no request on the reader's behalf (#43, spec test 19).
 *
 * Rendering it, revealing the full address, and clicking everything that is
 * not the Open anchor must reach the network for nothing: no favicon, no
 * preview image, no title, no prefetch, no navigation. The requests are read
 * from Playwright (`request-log.ts`), not from inside the page, because an
 * in-page spy misses an `<img>` or a navigation and Resource Timing misses a
 * request that failed, which is what every `.example` request does.
 *
 * The last test clicks Open and asserts the log DOES see the destination, so
 * the harness is shown able to observe the thing the first test says never
 * happens.
 *
 * The log has one measured blind spot: Chromium routes a request for a
 * `/favicon.ico` path so that Playwright reports no `request` event for it
 * (an `<img>` pointing at one was mutated into the card and the log stayed
 * empty, while the same `<img>` at `/preview.png` was logged). So the card is
 * also asserted to contain nothing that can load anything, which is the
 * direct statement of "no favicon, no preview image".
 *
 * It lives in the visual project because that is the runner with a real
 * browser; it takes no screenshot.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";

import "../../src/styles.css";
import { LinkPreviewCard, type LinkPreviewCardProps } from "../../src/blocks/LinkPreviewCard.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    startRequestLog: () => Promise<void>;
    requestLog: () => Promise<string[]>;
  }
}

const HOST = "ithaca-harbour.example";
const URL_ = `https://${HOST}/tides/2026/week-39`;

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount(props: LinkPreviewCardProps): HTMLElement {
  host = document.createElement("div");
  host.style.width = "320px";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(LinkPreviewCard, props)));
  return host;
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

/** Lets anything the render scheduled (an image load, a prefetch) start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/** Anything in the card that could load a resource by being rendered. */
function loaders(el: HTMLElement): string[] {
  const found = [...el.querySelectorAll("img, picture, source, video, audio, iframe, object, embed, link, script, [srcset]")].map(
    (node) => node.outerHTML.slice(0, 80)
  );
  for (const node of el.querySelectorAll<HTMLElement>("*")) {
    const bg = getComputedStyle(node).backgroundImage;
    if (bg.includes("url(")) found.push(`background ${bg.slice(0, 80)}`);
  }
  return found;
}

/** Requests that left the test page's own origin. */
async function outbound(): Promise<string[]> {
  const log = await commands.requestLog();
  return log.filter((url) => !url.startsWith(location.origin) && !url.startsWith("data:"));
}

describe("LinkPreviewCard link mode: the network", () => {
  test("rendering, revealing and clicking everything but Open requests nothing", async () => {
    await commands.startRequestLog();
    const el = mount({
      url: URL_,
      title: "Harbour tide tables, week 39",
      description: "High water before dawn all week.",
      onCopy: () => undefined,
    });
    await settle();

    await userEvent.click(el.querySelector<HTMLElement>("[data-link-host]")!);
    await userEvent.click(el.querySelector<HTMLElement>("[data-link-attribution]")!);
    await userEvent.click(el.querySelector("button")!);
    await userEvent.click(el.querySelector<HTMLElement>("[data-link-full]")!);
    await settle();


    expect(el.querySelector("[data-link-full]")!.textContent).toBe(URL_);
    expect(loaders(el)).toEqual([]);
    expect(await outbound()).toEqual([]);
    expect(location.href).not.toContain(HOST);
  });

  test("a withheld card requests nothing either", async () => {
    await commands.startRequestLog();
    const el = mount({ url: `https://odysseus:nobody@${HOST}/roster`, title: "Crew roster", expanded: true });
    await settle();
    expect(el.querySelector("[data-link-card]")!.getAttribute("data-link-card")).toBe("withheld");
    expect(loaders(el)).toEqual([]);
    expect(await outbound()).toEqual([]);
  });

  test("the harness sees a request when there is one: activating Open reaches the destination", async () => {
    await commands.startRequestLog();
    const el = mount({ url: URL_, title: "Harbour tide tables, week 39" });
    await userEvent.click(el.querySelector("a")!);
    await settle();
    const seen = await outbound();
    expect(seen.some((url) => url.includes(HOST))).toBe(true);
  });
});
