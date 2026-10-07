/**
 * `TrackerPillList`'s 11 browser acceptance criteria (#1001's approved
 * design), measured in a real Chromium at the three widths the design names,
 * in both themes. The numbers in the test names are the design's.
 *
 * The box is the chat column the list gets at each viewport: 320 and 390 less
 * the chat's two 16px gutters (288 and 358, the derivation is in
 * `receipt-value-budget.visual.tsx`), and the design's ~720px column at 900.
 * The host is painted `surface`, which is what the design states AC 10's
 * contrast against.
 *
 * It lives in the visual project because that is the runner with a layout
 * engine; it takes no screenshot.
 */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles.css";
import { trackerEveryAction, trackerLongHost, trackerLongest, trackerMixed, trackerTwenty } from "../../fixtures/tracker.js";
import {
  TrackerPillList,
  trackerItem,
  trackerTone,
  type TrackerEvent,
} from "../../src/blocks/TrackerPillList.js";
import { contrast, over, parse } from "../_contrast.js";

const WIDTHS = [288, 358, 720] as const;
const THEMES = ["dark", "light"] as const;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(events: readonly TrackerEvent[], width: number, theme: string, expanded?: boolean): HTMLDivElement {
  host = document.createElement("div");
  host.dataset.theme = theme;
  host.style.width = `${width}px`;
  host.style.background = "var(--bk-color-surface)";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<TrackerPillList events={events} expanded={expanded} />));
  return host;
}

/** A 120-character title and a 16-character qualifier, the design's AC 1 inputs. */
const STRESS: TrackerEvent[] = [
  {
    url: "https://github.com/ithaca/pylos-voyage/pull/1234",
    action: "reopened",
    qualifier: "waiting harbour.",
    title: "Telemachus asks Nestor and then Menelaus whether anyone has word of his father, while the suitors eat through the hall..",
  },
  { ...trackerLongest },
  ...trackerMixed,
];

/** Distinct line tops a text node's glyphs sit on. */
function lineCount(el: Element): number {
  const tops = new Set<number>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
  }
  return tops.size;
}

const pills = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>("a[data-tracker-pill]")];

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    describe(`tracker pills at ${width}px, ${theme}`, () => {
      test("1. every pill is at most 36px on one line, in a row of at least 44px", () => {
        expect(STRESS[0]!.title).toHaveLength(120);
        expect(STRESS[0]!.qualifier).toHaveLength(16);
        const el = mount(STRESS, width, theme, true);
        const rows = [...el.querySelectorAll<HTMLElement>("[data-tracker-pill], [data-tracker-withheld] > div")];
        expect(rows.length).toBe(STRESS.length);
        for (const pill of rows) {
          expect(pill.getBoundingClientRect().height).toBeLessThanOrEqual(36);
          expect(pill.parentElement!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
          for (const part of pill.querySelectorAll("[data-tracker-action], [data-tracker-number], [data-tracker-title]")) {
            expect(lineCount(part), part.textContent!).toBe(1);
          }
        }
      });

      test("1. the whole 44px row is the target, and neighbouring targets do not overlap", () => {
        const el = mount(trackerMixed.slice(0, 3), width, theme);
        const anchors = pills(el);
        expect(anchors, "the three target rows are drawn").toHaveLength(3);
        for (const anchor of anchors) {
          const row = anchor.parentElement!.getBoundingClientRect();
          const x = row.left + row.width / 2;
          for (const y of [row.top + 1, row.bottom - 1]) {
            expect(document.elementFromPoint(x, y)?.closest("a"), `${anchor.href} at ${Math.round(x)},${Math.round(y)}`).toBe(anchor);
          }
        }
      });

      test("2. action, type and number are never clipped; the title takes the ellipsis, and the qualifier only after it", () => {
        const el = mount(STRESS, width, theme, true);
        for (const pill of el.querySelectorAll<HTMLElement>("[data-tracker-pill]")) {
          const action = pill.querySelector<HTMLElement>("[data-tracker-action] > span:first-child")!;
          for (const part of [action, ...pill.querySelectorAll<HTMLElement>("[data-tracker-number]")]) {
            expect(part.scrollWidth, part.textContent!).toBeLessThanOrEqual(part.clientWidth);
          }
          const title = pill.querySelector<HTMLElement>("[data-tracker-title]")!;
          const qualifier = pill.querySelector<HTMLElement>("[data-tracker-qualifier]");
          const ellipsed = [...pill.querySelectorAll<HTMLElement>("*")].filter((node) => getComputedStyle(node).textOverflow === "ellipsis");
          expect(ellipsed).toEqual(qualifier ? [qualifier, title] : [title]);
          if (qualifier && qualifier.scrollWidth > qualifier.clientWidth) expect(title.clientWidth).toBe(0);
          // Nothing leaves the pill: the open glyph is the last thing in it.
          const open = pill.querySelector<HTMLElement>("[data-tracker-open]")!.getBoundingClientRect();
          expect(open.right).toBeLessThanOrEqual(pill.getBoundingClientRect().right);
        }
        // The stress title really is cut at every width, so the check above
        // is about a title that overflowed rather than one that fit.
        const title = el.querySelector<HTMLElement>("[data-tracker-title]")!;
        expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
      });

      test("2. a parent that sizes the list to its content still gets one that fits the column", () => {
        // A flex row item has `min-width: auto`, so the list is at least as
        // wide as its min-content: a title that counted towards it would push
        // every pill past the column.
        const el = mount([], width, theme);
        flushSync(() => root!.unmount());
        el.style.display = "flex";
        const item = document.createElement("div");
        item.style.flex = "1";
        el.append(item);
        root = createRoot(item);
        flushSync(() => root!.render(<TrackerPillList events={STRESS} expanded />));
        expect(item.getBoundingClientRect().width).toBe(width);
        const right = el.getBoundingClientRect().right;
        for (const pill of pills(el)) {
          expect(pill.querySelector<HTMLElement>("[data-tracker-open]")!.getBoundingClientRect().right).toBeLessThanOrEqual(right);
        }
      });

      test("3. a run header above every tappable pill names its url's derived host and repository", () => {
        const el = mount(trackerMixed, width, theme);
        const anchors = pills(el);
        expect(anchors.length).toBeGreaterThan(0);
        for (const anchor of anchors) {
          const list = anchor.closest("ul")!;
          const header = document.getElementById(list.getAttribute("aria-labelledby")!)!;
          expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(anchor.getBoundingClientRect().top);
          const item = trackerItem(anchor.href);
          if (!item.ok) throw new Error(`${anchor.href} was refused`);
          expect(header.textContent).toBe(item.github ? `${item.host} · ${item.github.repo}` : item.host);
        }
      });

      test("4. a host longer than the column wraps only after a dot and is never ellipsised", () => {
        const el = mount([trackerLongHost], width, theme);
        const hostEl = el.querySelector<HTMLElement>("[data-tracker-host]")!;
        expect(hostEl.textContent).toBe("issues.records.harbour-master.palace-of-odysseus.ithaca.gov.example");
        const labels = [...hostEl.children] as HTMLElement[];
        for (const label of labels) expect(lineCount(label), label.textContent!).toBe(1);
        labels.slice(0, -1).forEach((label) => expect(label.textContent).toMatch(/\.$/));
        // Whether it has to wrap is the font's call (the CI image's mono is
        // narrower than JetBrains Mono), so it is measured: laid out on one
        // line, the host is wider than the column at 288px with either face.
        const probe = hostEl.cloneNode(true) as HTMLElement;
        probe.style.cssText = "position:absolute;white-space:nowrap;width:max-content";
        hostEl.parentElement!.append(probe);
        const natural = probe.getBoundingClientRect().width;
        probe.remove();
        if (width === 288) expect(natural).toBeGreaterThan(width);
        if (natural > width) expect(lineCount(hostEl)).toBeGreaterThan(1);
        else expect(lineCount(hostEl)).toBe(1);
        for (const node of [hostEl, ...hostEl.querySelectorAll("*")]) {
          expect(getComputedStyle(node).textOverflow).not.toBe("ellipsis");
        }
        expect(hostEl.getBoundingClientRect().right).toBeLessThanOrEqual(el.getBoundingClientRect().right + 1);
      });

      test("5. consecutive same-host events share a header, a change starts one, and DOM order is payload order", () => {
        const el = mount(trackerMixed, width, theme);
        expect([...el.querySelectorAll("[data-tracker-run]")].map((h) => h.textContent)).toEqual([
          "github.com · ithaca/hall",
          "tracker.ogygia-shipyard.example",
        ]);
        const order = [...el.querySelectorAll("li")].map((li) => li.querySelector("[data-tracker-title]")!.textContent);
        expect(order).toEqual(trackerMixed.map((event) => event.title));
      });

      test("6. each action and qualifier draws its tone, and the action word is visible text", () => {
        const el = mount(trackerEveryAction, width, theme, true);
        const probe = document.createElement("span");
        el.append(probe);
        expect(trackerEveryAction.length, "the action fixture is nonempty").toBeGreaterThan(0);
        expect(pills(el), "every action reaches the measured DOM").toHaveLength(trackerEveryAction.length);
        pills(el).forEach((pill, i) => {
          const event = trackerEveryAction[i]!;
          const tone = trackerTone(event.action, event.qualifier);
          expect(pill.dataset.tone).toBe(tone);
          const action = pill.querySelector<HTMLElement>("[data-tracker-action]")!;
          expect(action.textContent).toMatch(new RegExp(`^${event.action}`));
          expect(action.checkVisibility()).toBe(true);
          probe.style.color = `var(--bk-${tone}-ink)`;
          expect(getComputedStyle(action).color).toBe(getComputedStyle(probe).color);
        });
      });

      test("7. a refused url is withheld: not an anchor, not focusable, no open glyph, with its reason", async () => {
        const el = mount([trackerMixed[3]!], width, theme);
        const withheld = el.querySelector<HTMLElement>("[data-tracker-withheld]")!;
        expect(withheld.querySelector("a")).toBeNull();
        expect(withheld.querySelector("[data-tracker-open]")).toBeNull();
        expect(withheld.textContent).toContain("withheld");
        await userEvent.tab();
        expect(el.contains(document.activeElement)).toBe(false);
        expect(el.querySelector("[data-tracker-refusal]")!.textContent).toBe(
          "1 address withheld: the address carries a sign-in name or password."
        );
      });

      test("8. 7 or more events show 5 and Show all N; expanding shows N with focus kept on the control", async () => {
        const el = mount(trackerTwenty, width, theme);
        expect(pills(el)).toHaveLength(5);
        const more = el.querySelector<HTMLButtonElement>("[data-tracker-more]")!;
        expect(more.textContent).toBe("Show all 20 changes");
        expect(more.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await userEvent.click(more);
        expect(pills(el)).toHaveLength(20);
        expect(document.activeElement).toBe(more);
        expect(more.textContent).toBe("Show fewer");
        flushSync(() => root!.unmount());
        host!.remove();
        const six = mount(trackerTwenty.slice(0, 6), width, theme);
        expect(pills(six)).toHaveLength(6);
        expect(six.querySelector("[data-tracker-more]")).toBeNull();
      });

      test("9. accessible names follow the patterns, and the title is reachable only as the description", () => {
        const el = mount(trackerMixed, width, theme);
        const names = pills(el).map((pill) => pill.getAttribute("aria-label"));
        expect(names).toEqual([
          "Open issue ithaca/hall 12 on github.com, opened",
          "Open pull request ithaca/hall 21 on github.com, merged",
          "Open issue ithaca/hall 9 on github.com, closed, not planned",
          "Open tracker.ogygia-shipyard.example, opened",
        ]);
        for (const pill of pills(el)) {
          const title = pill.querySelector("[data-tracker-title]")!.textContent!;
          expect(pill.getAttribute("aria-label")).not.toContain(title);
          expect(document.getElementById(pill.getAttribute("aria-describedby")!)!.textContent).toBe(`Title by the brain: ${title}`);
        }
      });

      test("10. action, number and title text pass 4.5:1 on their chip tint over surface", () => {
        const el = mount(trackerEveryAction, width, theme, true);
        const surface = parse(getComputedStyle(el).backgroundColor).rgb;
        const checked: string[] = [];
        for (const pill of pills(el)) {
          const ground = over(parse(getComputedStyle(pill).backgroundColor), surface);
          for (const part of pill.querySelectorAll<HTMLElement>("[data-tracker-action], [data-tracker-number], [data-tracker-title]")) {
            const ratio = contrast(parse(getComputedStyle(part).color).rgb, ground);
            checked.push(part.textContent!);
            expect(ratio, `${pill.dataset.tone} ${part.textContent}`).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(checked.length).toBeGreaterThan(trackerEveryAction.length * 2);
      });

      test("11. the honesty line is always present", () => {
        for (const events of [trackerMixed, trackerTwenty, [trackerLongHost]]) {
          const el = mount(events, width, theme);
          expect(el.querySelector("[data-tracker-honesty]")!.textContent).toBe("Changes as reported by the brain · tracker not checked");
          flushSync(() => root!.unmount());
          host!.remove();
        }
      });
    });
  }
}

describe("tracker pills below the narrowest supported column", () => {
  // 224px: past what a 320px phone gives the list, and narrow enough that
  // the CI image's narrower mono face overflows too. The widest fixed part,
  // `reopened` with a cut 16-character qualifier and `PR 1234`, no longer
  // fits beside even an empty title, so the qualifier gives way after the
  // title does, and the action, the number and the open glyph stay whole
  // and inside the pill.
  for (const theme of THEMES) {
    test(`the qualifier gives way after the title, and nothing leaves the pill (${theme})`, () => {
      const el = mount([trackerLongest], 224, theme);
      const pill = pills(el)[0]!;
      const title = pill.querySelector<HTMLElement>("[data-tracker-title]")!;
      const qualifier = pill.querySelector<HTMLElement>("[data-tracker-qualifier]")!;
      expect(title.clientWidth).toBe(0);
      expect(qualifier.scrollWidth).toBeGreaterThan(qualifier.clientWidth);
      const box = pill.getBoundingClientRect();
      for (const part of pill.querySelectorAll<HTMLElement>("[data-tracker-action] > span:first-child, [data-tracker-number], [data-tracker-open]")) {
        expect(part.scrollWidth, part.textContent!).toBeLessThanOrEqual(part.clientWidth);
        expect(part.getBoundingClientRect().right, part.textContent!).toBeLessThanOrEqual(box.right);
      }
      expect(box.height).toBeLessThanOrEqual(36);
    });
  }
});
