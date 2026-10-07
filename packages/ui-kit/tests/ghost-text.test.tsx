/**
 * Ghost-text loading (#1116): the glyphs, the role map, the markup of each
 * loading view, the handoff, and the theme tokens. The sweep, layout shift and
 * the handoff's timing in a real browser are the stories' (`States/Placeholder`
 * and each component's `LoadingToReady`), in Chromium.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { StrictMode, act, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { StreamingAnswer } from "../src/conversation/StreamingAnswer.js";
import { ActionCard } from "../src/decisions/ActionCard.js";
import { SearchResultCard } from "../src/evidence/SearchResultCard.js";
import { GhostText, HANDOFF_MS, ghostBlur, ghostString } from "../src/internal/GhostText.js";
import { FileRow } from "../src/rows/FileRow.js";
import { QueueItemRow } from "../src/rows/QueueItemRow.js";
import { Placeholder } from "../src/states/Placeholder.js";
import { LIGHT_TOKENS, PRINT_TOKENS, TOKENS, font } from "../src/tokens.js";
import { contrast, parse } from "./_contrast.js";

const css = readFileSync(join(import.meta.dir, "..", "src", "tokens.css"), "utf8");
const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");

function draw(node: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(node);
  return document as unknown as Document;
}

const ghosts = (doc: Document) => [...doc.querySelectorAll<HTMLElement>(".bk-ghost")];

describe("ghostString", () => {
  test("is exactly n characters, for every n", () => {
    for (let n = 0; n <= 300; n++) expect(ghostString(n, "row-1")).toHaveLength(n);
    for (let n = 0; n <= 300; n++) expect(ghostString(n, "row-1", true)).toHaveLength(n);
  });

  test("is stable per seed, and differs between seeds", () => {
    expect(ghostString(120, "queue:3")).toBe(ghostString(120, "queue:3"));
    expect(ghostString(120, 7)).toBe(ghostString(120, 7));
    expect(ghostString(120, "queue:3")).not.toBe(ghostString(120, "queue:4"));
  });

  test("is words of 2-9 characters, never a lone letter", () => {
    for (let n = 2; n <= 300; n++) {
      for (const seed of ["a", "b", "search:0:snippet", 42]) {
        const words = ghostString(n, seed).split(" ");
        expect(words.length).toBeGreaterThan(0);
        for (const word of words) {
          expect(word.length).toBeGreaterThanOrEqual(2);
          expect(word.length).toBeLessThanOrEqual(9);
          expect(word).toMatch(/^[a-z]+$/);
        }
      }
    }
  });

  test("a path ghost has a path's separators and the same segment lengths", () => {
    const path = ghostString(26, "search:0:path", true);
    expect(path).toContain("/");
    expect(path).toMatch(/\.[a-z]{2,9}$/);
    expect(path.split(/[/.]/).map((w) => w.length)).toEqual(ghostString(26, "search:0:path").split(" ").map((w) => w.length));
  });
});

describe("GhostText", () => {
  test("is aria-hidden, one element per slot, with seeded glyphs", () => {
    const doc = draw(<GhostText role="sans" length={40} seed="x" />);
    const [g, ...rest] = ghosts(doc);
    expect(rest).toHaveLength(0);
    expect(g!.getAttribute("aria-hidden")).toBe("true");
    expect(g!.textContent).toBe(ghostString(40, "x"));
  });

  test("each role maps to its family, size and blur", () => {
    const cases = [
      { role: "sans", size: 13.5, family: font.body, blur: 3.2 },
      { role: "sans", size: 13, family: font.body, blur: 3 },
      { role: "sans", size: 12, family: font.body, blur: 2.6 },
      { role: "sans", size: 11.5, family: font.body, blur: 2.6 },
      { role: "mono", size: 11, family: font.mono, blur: 2.4 },
      { role: "mono", size: 9.5, family: font.mono, blur: 2.2 },
      { role: "title", size: 19, family: font.display, blur: 3.2 },
    ] as const;
    for (const c of cases) {
      expect(ghostBlur(c.role, c.size)).toBe(c.blur);
      const g = ghosts(draw(<GhostText role={c.role} size={c.size} length={10} seed="r" />))[0]!;
      expect(g.getAttribute("data-ghost-role")).toBe(c.role);
      expect(g.style.fontSize).toBe(`${c.size}px`);
      expect(g.style.filter).toBe(`blur(${c.blur}px)`);
      // happy-dom normalises the quotes; compare the first family's name.
      expect(g.style.fontFamily.replace(/["']/g, "")).toStartWith(c.family.split(",")[0]!.replace(/["']/g, ""));
    }
  });

  test("`animate={false}` holds it still", () => {
    expect(ghosts(draw(<GhostText role="mono" length={10} seed="s" animate={false} />))[0]!.hasAttribute("data-still")).toBe(true);
    expect(ghosts(draw(<GhostText role="mono" length={10} seed="s" />))[0]!.hasAttribute("data-still")).toBe(false);
  });
});

describe("the stylesheet", () => {
  test("ghost is a keyframe of its own, beside breathe, and breathe is untouched", () => {
    expect(uncommented.match(/@keyframes\s+ghost\s*\{/g)).toHaveLength(1);
    expect(uncommented).toMatch(/\.bk-ghost-track\s*\{[^}]*animation:\s*ghost 2\.6s ease-in-out infinite;/);
    expect(uncommented).toMatch(/\.bk-ghost-in\s*\{[^}]*animation:\s*ghost-in 600ms ease both;/);
    expect(uncommented).toMatch(/\.bk-ghost-out\s*\{[^}]*animation:\s*ghost-out 600ms ease both;/);
    expect(HANDOFF_MS).toBe(600);
  });

  test("reduced motion stops the sweep, makes the handoff instant and lands the tail", () => {
    const start = uncommented.indexOf("@media (prefers-reduced-motion: reduce)");
    const block = uncommented.slice(start);
    // No sweep and no spectrum: plain blurred text in the base colour.
    expect(block).toMatch(/\.bk-ghost\s*\{\s*animation:\s*none;\s*background-image:\s*none;\s*color:\s*var\(--bk-ghost-base\);/);
    expect(block).toMatch(/\.bk-ghost-in,\s*\.bk-ghost-out,\s*\.bk-ghost-tail\s*\{\s*animation-duration:\s*0s;/);
    // Inside the one reduced-motion block, not a second one.
    expect(uncommented.match(/@media \(prefers-reduced-motion/g)).toHaveLength(1);
  });

  test("print hides every ghost and the print theme paints none", () => {
    expect(uncommented).toMatch(/@media print\s*\{[\s\S]*?\.bk-ghost\s*\{\s*visibility:\s*hidden;/);
    for (const name of ["ghost-base", "ghost-amber", "ghost-purple", "ghost-blue"] as const) {
      expect(PRINT_TOKENS[name]).toBe("transparent");
    }
  });
});

describe("the ghost tokens", () => {
  const names = ["ghost-base", "ghost-amber", "ghost-purple", "ghost-blue"] as const;

  test("exist in both themes", () => {
    expect([TOKENS["ghost-base"], TOKENS["ghost-amber"], TOKENS["ghost-purple"], TOKENS["ghost-blue"]]).toEqual([
      "#3a3d46",
      "#e09f3e",
      "#b197d4",
      "#67b8e3",
    ]);
    expect(LIGHT_TOKENS["ghost-base"]).toBe("#c8bfac");
    for (const name of names) {
      expect(css).toContain(`--bk-${name}: light-dark(${LIGHT_TOKENS[name]}, ${TOKENS[name]});`);
    }
  });

  test("each paper hue contrasts with the paper base within 10% of its dark pair", () => {
    for (const hue of ["ghost-amber", "ghost-purple", "ghost-blue"] as const) {
      const dark = contrast(parse(TOKENS[hue]).rgb, parse(TOKENS["ghost-base"]).rgb);
      const paper = contrast(parse(LIGHT_TOKENS[hue]).rgb, parse(LIGHT_TOKENS["ghost-base"]).rgb);
      expect(Math.abs(paper - dark) / dark).toBeLessThanOrEqual(0.1);
    }
  });
});

describe("Placeholder loading", () => {
  test("draws ghost lines, not bars, in a busy box", () => {
    const doc = draw(<Placeholder variant="loading" lines={3} />);
    const box = doc.body.firstElementChild as HTMLElement;
    expect(box.getAttribute("aria-busy")).toBe("true");
    expect(ghosts(doc)).toHaveLength(3);
    expect(doc.body.innerHTML).not.toContain("breathe");
  });

  test("`ghost` draws one ghost per block, in its role and length", () => {
    const doc = draw(
      <Placeholder
        variant="loading"
        seed="card"
        ghost={[
          { role: "mono", size: 11, length: 22 },
          { role: "sans", size: 13, length: 58 },
          { role: "title", length: 12 },
        ]}
      />,
    );
    const g = ghosts(doc);
    expect(g.map((e) => [e.getAttribute("data-ghost-role"), e.textContent!.length])).toEqual([
      ["mono", 22],
      ["sans", 58],
      ["title", 12],
    ]);
    // Slots are static; one owning band sweeps the whole frame.
    expect(g.map((e) => e.style.animationDelay)).toEqual(["", "", ""]);
  });

  test("each ghost line takes its role's font, not the surrounding one", () => {
    const doc = draw(
      <div style={{ fontSize: 16 }}>
        <Placeholder variant="loading" ghost={[{ role: "sans", size: 12, length: 20 }, { role: "mono", length: 10 }]} />
        <Placeholder variant="loading" lines={1} />
      </div>,
    );
    const lines = ghosts(doc).map((g) => g.parentElement!);
    expect(lines.map((l) => [l.style.fontSize, l.style.lineHeight])).toEqual([
      ["12px", "1.55"],
      ["11px", "1.4"],
      ["12px", "1.55"],
    ]);
  });

  test("empty and error do not change", () => {
    const empty = draw(<Placeholder variant="empty" message="Nothing" />);
    const error = draw(<Placeholder variant="error" message="Broke" />);
    expect(ghosts(empty)).toHaveLength(0);
    expect(ghosts(error)).toHaveLength(0);
    expect(empty.body.textContent).toBe("Nothing");
  });
});

/* ── The handoff, rendered for real ─────────────────────────────────────── */

const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;

beforeAll(() => {
  const win = new Window();
  for (const key of GLOBALS) saved[key] = (globalThis as Record<string, unknown>)[key];
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterAll(() => {
  for (const key of GLOBALS) (globalThis as Record<string, unknown>)[key] = saved[key];
});

/** Mounts `render(flag)` under StrictMode — double renders and double effects
 * included — and returns a way to flip the flag and read the DOM. */
async function mount(render: (loading: boolean, n: number) => ReactElement) {
  let set: (v: boolean) => void = () => {};
  let bump: () => void = () => {};
  function Harness() {
    const [loading, setLoading] = useState(true);
    const [n, setN] = useState(0);
    set = setLoading;
    bump = () => setN((x) => x + 1);
    return render(loading, n);
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  return {
    host,
    land: () => act(async () => set(false)),
    reload: () => act(async () => set(true)),
    /** Lands the next value: a re-render with new data while still ready. */
    next: () => act(async () => bump()),
    settle: () => act(async () => void (await new Promise((r) => setTimeout(r, HANDOFF_MS + 40)))),
    unmount: () => act(async () => root.unmount()),
  };
}

const outgoing = (host: Element) => host.querySelectorAll(".bk-ghost-out").length;
const incoming = (host: Element) => host.querySelectorAll(".bk-ghost-in").length;

describe("Placeholder `arrived`", () => {
  test("flips the opacities: children fade in, the ghost fades out, then goes", async () => {
    const m = await mount((loading) => (
      <Placeholder variant="loading" lines={2} arrived={!loading}>
        <p>Three venues are in the corpus.</p>
      </Placeholder>
    ));
    const box = m.host.firstElementChild!;
    expect(box.getAttribute("aria-busy")).toBe("true");
    expect(m.host.textContent).not.toContain("Three venues");
    expect(ghosts(m.host as unknown as Document)).toHaveLength(2);

    await m.land();
    expect(box.getAttribute("aria-busy")).toBeNull();
    expect(m.host.querySelector(".bk-ghost-in")!.textContent).toBe("Three venues are in the corpus.");
    expect(m.host.querySelector(".bk-ghost-out")!.getAttribute("aria-hidden")).toBe("true");
    expect(m.host.querySelector(".bk-ghost-out")!.querySelectorAll(".bk-ghost")).toHaveLength(2);

    await m.settle();
    expect(outgoing(m.host)).toBe(0);
    expect(incoming(m.host)).toBe(0);
    expect(m.host.querySelectorAll(".bk-ghost")).toHaveLength(0);
    expect(m.host.textContent).toBe("Three venues are in the corpus.");
    await m.unmount();
  });

  test("ending the handoff does not remount the content", async () => {
    let mounts = 0;
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          count {count}
        </button>
      );
    }
    const m = await mount((loading) => (
      <Placeholder variant="loading" arrived={!loading}>
        <Counter />
      </Placeholder>
    ));
    await m.land();
    const before = mounts;
    await act(async () => m.host.querySelector("button")!.click());
    expect(m.host.querySelector("button")!.textContent).toBe("count 1");
    await m.settle();
    expect(m.host.querySelectorAll(".bk-ghost")).toHaveLength(0);
    expect(m.host.querySelector("button")!.textContent).toBe("count 1");
    expect(mounts).toBe(before);
    await m.unmount();
  });

  test("the outgoing ghost sits under the content: first in order, content positioned", async () => {
    const m = await mount((loading) => (
      <Placeholder variant="loading" lines={2} arrived={!loading}>
        <p>landed</p>
      </Placeholder>
    ));
    await m.land();
    const out = m.host.querySelector<HTMLElement>(".bk-ghost-out")!;
    const incoming = m.host.querySelector<HTMLElement>(".bk-ghost-in")!;
    expect(out.compareDocumentPosition(incoming) & 4).toBe(4); // incoming FOLLOWS out
    expect(incoming.style.position).toBe("relative");
    await m.unmount();
  });

  test("content that was never waited for does not fade in", () => {
    const doc = draw(
      <Placeholder variant="loading" arrived>
        <p>cached</p>
      </Placeholder>,
    );
    expect(doc.querySelectorAll(".bk-ghost-in, .bk-ghost-out, .bk-ghost")).toHaveLength(0);
    expect(doc.body.textContent).toBe("cached");
  });
});

describe("the five components", () => {
  const cases: [string, (loading: boolean) => ReactElement, string][] = [
    ["QueueItemRow", (l) => <QueueItemRow view={l ? "loading" : "ready"} state="blocked" subject="index · omens/" />, "index · omens/"],
    ["SearchResultCard", (l) => <SearchResultCard view={l ? "loading" : "ready"} path="knowledge/scylla.md" />, "knowledge/scylla.md"],
    ["FileRow", (l) => <FileRow view={l ? "loading" : "ready"} label="omens" kind="file" />, "omens"],
    ["ActionCard", (l) => <ActionCard state={l ? "loading" : "ready"} title="Sail past the sirens?" body="Wax for the crew." footMeta="run 7f2" />, "Sail past the sirens?"],
  ];

  const clickable: [string, (loading: boolean, onClick: () => void) => ReactElement][] = [
    ["QueueItemRow", (l, onClick) => <QueueItemRow view={l ? "loading" : "ready"} onClick={onClick} />],
    ["SearchResultCard", (l, onClick) => <SearchResultCard view={l ? "loading" : "ready"} onClick={onClick} />],
    ["FileRow", (l, onClick) => <FileRow view={l ? "loading" : "ready"} onClick={onClick} />],
    ["ActionCard", (l, onClick) => <ActionCard state={l ? "loading" : "ready"} onClick={onClick} />],
  ];

  for (const [name, render] of clickable) {
    test(`${name}: nothing to act on while loading — not a control, and a click does nothing`, async () => {
      let clicks = 0;
      const m = await mount((loading) => render(loading, () => (clicks += 1)));
      const root = m.host.firstElementChild as HTMLElement;
      expect(root.getAttribute("role")).toBeNull();
      expect(root.getAttribute("tabindex")).toBeNull();
      await act(async () => root.click());
      expect(clicks).toBe(0);
      await m.land();
      const ready = m.host.firstElementChild as HTMLElement;
      expect(ready.getAttribute("tabindex")).toBe("0");
      await act(async () => ready.click());
      expect(clicks).toBe(1);
      await m.unmount();
    });
  }

  test("a re-fetch that starts mid-handoff sizes from the newest value", async () => {
    const m = await mount((loading, n) => <FileRow view={loading ? "loading" : "ready"} label={n ? "penelope-loom-notes.md" : "old"} kind="file" />);
    await m.land();
    await m.settle();
    await m.reload();
    await m.next();
    await m.land(); // shows the 22-character name; the handoff is still running
    expect(outgoing(m.host)).toBeGreaterThan(0);
    await m.reload();
    expect(ghosts(m.host as unknown as Document)[0]!.textContent).toHaveLength("penelope-loom-notes.md".length);
    await m.unmount();
  });

  test("the outgoing ghost keeps the shape it had while loading", async () => {
    const m = await mount((loading) => <FileRow view={loading ? "loading" : "ready"} label={loading ? undefined : "a-much-longer-name.md"} kind="file" />);
    expect(ghosts(m.host as unknown as Document)[0]!.textContent).toHaveLength(14);
    await m.land();
    expect(m.host.querySelector(".bk-ghost-out .bk-ghost")!.textContent).toHaveLength(14);
    await m.unmount();
  });

  test("slots the caller already passes keep their space while loading, invisibly", () => {
    const doc = draw(
      <ActionCard state="loading" rightChip="untrusted · relayed" rightMeta="3 / 3 attempts" footLink={{ label: "blocks queue item", onClick: () => {} }}>
        <p>evidence</p>
      </ActionCard>,
    );
    const hidden = [...doc.querySelectorAll<HTMLElement>("[style]")].filter((e) => e.style.visibility === "hidden");
    expect(hidden.map((e) => e.textContent)).toEqual(["untrusted · relayed", "3 / 3 attempts", "evidence", "blocks queue item"]);
    // A queue row re-fetched with its note keeps the note's line, as a ghost.
    const queue = draw(<QueueItemRow view="loading" note="held by note-filer" link="waiting on your approval" />);
    const lengths = ghosts(queue).map((g) => g.textContent!.length);
    expect(lengths).toContain("held by note-filer".length);
    expect(lengths).toContain("waiting on your approval".length);
  });

  test("reserved slots are inert, and the hidden foot link does nothing", async () => {
    let followed = 0;
    const m = await mount((loading) => (
      <ActionCard
        state={loading ? "loading" : "ready"}
        rightChip="untrusted · relayed"
        footLink={{ label: "blocks queue item", onClick: () => (followed += 1) }}
      >
        <button type="button" style={{ visibility: "visible" }}>
          Allow
        </button>
      </ActionCard>
    ));
    const reservedSlots = [...m.host.querySelectorAll<HTMLElement>("[inert]")].filter((e) => !e.closest(".bk-ghost-viewport"));
    expect(reservedSlots.length).toBe(3);
    expect(reservedSlots.some((e) => e.querySelector("button")?.textContent === "Allow")).toBe(true);
    const footLink = () => [...m.host.querySelectorAll("button")].find((b) => b.textContent === "blocks queue item")!;
    await act(async () => footLink().click());
    expect(followed).toBe(0);
    await m.land();
    expect([...m.host.querySelectorAll("[inert]")].filter((e) => !e.closest(".bk-ghost-viewport"))).toHaveLength(0);
    await act(async () => footLink().click());
    expect(followed).toBe(1);
    await m.unmount();
  });

  test("re-ranking a loading row keeps its glyphs: the seed is the instance, not the index", async () => {
    const m = await mount((_loading, n) => <SearchResultCard view="loading" index={n} />);
    const before = ghosts(m.host as unknown as Document).map((g) => g.textContent);
    await m.next();
    const after = ghosts(m.host as unknown as Document);
    expect(after.map((g) => g.textContent)).toEqual(before);
    // Rank changes neither the glyphs nor the frame’s sweep phase.
    expect(m.host.querySelector(".bk-ghost-track")!.getAttribute("style")).toBeNull();
    await m.unmount();
  });

  test("the foot dot is reserved only when one is coming", async () => {
    // A card that showed no dot re-fetches without one: the foot text stays put.
    const m = await mount((loading) => <ActionCard state={loading ? "loading" : "ready"} footMeta="run 7f2" />);
    await m.land();
    await m.settle();
    await m.reload();
    expect(m.host.querySelector('[data-ghost-slot="dot"]')).toBeNull();
    await m.unmount();
    // One that the caller says has a dot keeps its slot.
    expect(draw(<ActionCard state="loading" footMeta="run 7f2" footDot="amber" />).querySelector('[data-ghost-slot="dot"]')).not.toBeNull();
  });

  for (const [name, render, text] of cases) {
    test(`${name}: ghosts while loading, hands off on arrival, then is itself`, async () => {
      const m = await mount(render);
      const root = m.host.firstElementChild!;
      expect(root.getAttribute("aria-busy")).toBe("true");
      expect(m.host.querySelectorAll(".bk-ghost").length).toBeGreaterThan(0);
      for (const g of m.host.querySelectorAll(".bk-ghost")) expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(m.host.textContent).not.toContain(text);
      // Never a control while there is nothing to act on.
      expect(m.host.querySelector('[tabindex="0"]')).toBeNull();

      await m.land();
      expect(m.host.firstElementChild!.getAttribute("aria-busy")).toBeNull();
      expect(m.host.textContent).toContain(text);
      expect(outgoing(m.host)).toBeGreaterThan(0);
      expect(incoming(m.host)).toBeGreaterThan(0);

      await m.settle();
      expect(m.host.querySelectorAll(".bk-ghost, .bk-ghost-out, .bk-ghost-in")).toHaveLength(0);

      // A re-fetch ghosts the previous value's length.
      await m.reload();
      const lengths = [...m.host.querySelectorAll(".bk-ghost")].map((g) => g.textContent!.length);
      expect(lengths).toContain(text.length);
      await m.unmount();
    });
  }

  test("data-dependent emphasis waits for the data", () => {
    const queue = draw(<QueueItemRow view="loading" state="blocked" />).body.firstElementChild as HTMLElement;
    // happy-dom drops a var() inside a shorthand, so read the attribute.
    expect(queue.getAttribute("style")).toContain("border:1px solid var(--bk-color-line)");
    expect(queue.getAttribute("style")).toContain("background:var(--bk-color-surface)");
    expect(queue.querySelector('[data-ghost-slot="dot"]')).not.toBeNull();

    // Approval is bold: the plain loading frame pads one pixel more, so the
    // text sits where the 2px border will put it.
    const card = draw(<ActionCard state="loading" kind="approval" />).body.firstElementChild as HTMLElement;
    expect(card.getAttribute("style")).toContain("border:1px solid var(--bk-color-line)");
    expect(card.style.padding).toBe("13px");
    expect(card.querySelector('[data-ghost-slot="icon"]')).not.toBeNull();
    const plain = draw(<ActionCard state="loading" kind="fyi" />).body.firstElementChild as HTMLElement;
    expect(plain.style.padding).toBe("12px");
  });

  test("the frame is final from the first frame", () => {
    // SearchResultCard's teal file icon, and FileRow's real icon when the
    // listing already said which kind.
    const search = draw(<SearchResultCard view="loading" />);
    expect(search.querySelector("svg")).not.toBeNull();
    expect(search.querySelector("[data-ghost-slot]")).toBeNull();
    expect(draw(<FileRow view="loading" kind="folder" />).querySelector("[data-ghost-slot]")).toBeNull();
    expect(draw(<FileRow view="loading" />).querySelector('[data-ghost-slot="icon"]')).not.toBeNull();
  });

  test("list items share the block sweep instead of staggering text slots", () => {
    for (const node of [<QueueItemRow view="loading" index={2} />, <SearchResultCard view="loading" index={2} />]) {
      expect(draw(node).querySelectorAll(".bk-ghost-track")).toHaveLength(1);
      expect(ghosts(draw(node)).every((g) => !g.style.animationDelay)).toBe(true);
    }
  });

  test("the server's hint sizes the ghost", () => {
    const snippet = ghosts(draw(<SearchResultCard view="loading" snippetLength={77} />)).pop()!;
    expect(snippet.textContent).toHaveLength(77);
    const name = ghosts(draw(<FileRow view="loading" label="penelope-loom.md" />))[0]!;
    expect(name.textContent).toHaveLength("penelope-loom.md".length);
  });
});

describe("StreamingAnswer", () => {
  test("before the first token, the answer is `lines` ghost lines, busy", () => {
    const doc = draw(<StreamingAnswer text="" lines={3} />);
    const g = ghosts(doc);
    expect(g).toHaveLength(3);
    expect(g.every((e) => e.getAttribute("data-ghost-role") === "sans" && e.style.fontSize === "13.5px")).toBe(true);
    expect(doc.querySelector('[aria-busy="true"]')).not.toBeNull();
    // The phase line is still the live region.
    expect(doc.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  test("the ghost fades on the first token, behind the text, and the height holds", async () => {
    const m = await mount((waiting) => <StreamingAnswer text={waiting ? "" : "Circe named them"} lines={3} />);
    expect(m.host.querySelectorAll(".bk-ghost")).toHaveLength(3);
    const prose = () => m.host.querySelector<HTMLElement>('[style*="min-height"]')!;
    expect(prose().style.minHeight).toBe("5.10em");
    await m.land();
    expect(prose().style.minHeight).toBe("5.10em");
    const out = m.host.querySelector<HTMLElement>(".bk-ghost-out")!;
    expect(out.style.position).toBe("absolute");
    // The text follows the ghost and is positioned, so it paints over it.
    const text = m.host.querySelector<HTMLElement>(".bk-ghost-tail")!.parentElement!;
    expect(out.compareDocumentPosition(text) & 4).toBe(4);
    expect(text.style.position).toBe("relative");
    // The first chunk fades in over the same handoff, not only its tail.
    expect(text.className).toBe("bk-ghost-in");
    expect(m.host.querySelector('[aria-busy="true"]')).toBeNull();
    await m.settle();
    expect(m.host.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
    await m.unmount();
  });

  test("the newest nine characters settle; the rest are plain text", () => {
    const text = "Circe named them in order";
    const doc = draw(<StreamingAnswer text={text} />);
    const tail = [...doc.querySelectorAll(".bk-ghost-tail")].map((e) => e.textContent).join("");
    expect(tail).toBe(text.slice(-9));
    expect(doc.body.textContent).toContain(text);
    expect(ghosts(doc)).toHaveLength(0);
  });

  test("`bars={false}` draws no ghost", () => {
    expect(ghosts(draw(<StreamingAnswer text="" bars={false} />))).toHaveLength(0);
  });
});


describe("one compositor band per loading frame (#1126)", () => {
  const cases: [string, ReactElement][] = [
    ["FileRow", <FileRow view="loading" />],
    ["QueueItemRow", <QueueItemRow view="loading" note="Waiting for the crew" />],
    ["SearchResultCard", <SearchResultCard view="loading" />],
    ["ActionCard", <ActionCard state="loading" />],
    ["Placeholder", <Placeholder lines={5} />],
    ["StreamingAnswer", <StreamingAnswer text="" />],
  ];
  for (const [name, node] of cases) {
    test(`${name}: exactly one track and three masked windows`, () => {
      const doc = draw(node);
      expect(ghosts(doc).length).toBeGreaterThan(0);
      expect(doc.querySelectorAll(".bk-ghost-track")).toHaveLength(1);
      expect(doc.querySelectorAll(".bk-ghost-window")).toHaveLength(3);
      const track = doc.querySelector(".bk-ghost-track")!;
      expect(track.getAttribute("aria-hidden")).toBe("true");
      expect(track.hasAttribute("inert")).toBe(true);
    });
  }
});
