/**
 * How `Composer` sizes its field, as the markup it emits (issue #92).
 *
 * The rendered heights — three visual lines make three rows, the cap holds,
 * the field shrinks back — are proven in real Chromium by the stories in
 * `stories/chrome/Composer.stories.tsx`; this file is not that proof. What it
 * pins is the contract those heights come from, which is a pure function of
 * props: `field-sizing: content` exactly when there is text to follow, the
 * newline count still on `rows` as the floor for a browser without it, and a
 * cap that keeps the design's 96px for five rows whatever `maxRows` says.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";

const SOURCE = join(resolve(import.meta.dir, ".."), "src", "chrome", "Composer.tsx");

function field(props: Parameters<typeof Composer>[0]): { style: string; rows: string } {
  const html = renderToStaticMarkup(<Composer {...props} />);
  const tag = html.match(/<textarea[^>]*>/)?.[0];
  if (!tag) throw new Error("no textarea rendered");
  return {
    style: tag.match(/style="([^"]*)"/)?.[1] ?? "",
    rows: tag.match(/rows="([^"]*)"/)?.[1] ?? "",
  };
}

describe("Composer field sizing", () => {
  test("a controlled value with text follows its content", () => {
    const f = field({ value: "a paragraph", onChange: () => {} });
    expect(f.style).toContain("field-sizing:content");
    expect(f.rows).toBe("1");
  });

  test("the newline count stays on rows as the floor", () => {
    const f = field({ value: "one\ntwo\nthree", onChange: () => {} });
    expect(f.rows).toBe("3");
    expect(f.style).toContain("field-sizing:content");
  });

  test("an empty controlled field does not size to its placeholder", () => {
    const f = field({ value: "", onChange: () => {}, state: "streaming" });
    expect(f.style).not.toContain("field-sizing");
    expect(f.rows).toBe("1");
  });

  test("an uncontrolled field is the browser's own", () => {
    const f = field({});
    expect(f.style).not.toContain("field-sizing");
    expect(f.rows).toBe("1");
  });

  test("the cap is the design's 96px for five rows", () => {
    expect(field({ value: "x", onChange: () => {} }).style).toContain("max-height:96px");
  });

  test("maxRows moves the cap and bounds the rows floor at the same pitch", () => {
    const f = field({ value: "1\n2\n3\n4\n5\n6", onChange: () => {}, maxRows: 3 });
    expect(f.style).toContain("max-height:57.6px");
    expect(f.rows).toBe("3");
  });
});

/**
 * The cost of a keystroke, as the acceptance criterion's second option: "the
 * implementation being ref-only".
 *
 * `Composer.stories.tsx` counts React `Profiler` commits, which is the direct
 * measurement — but React's production renderer does not call `onRender` at
 * all, so that count is dark in a `storybook build` preview. This holds the
 * same property over the source, where no renderer is involved: the component
 * sizes itself with no hook that can schedule a second pass. `useId` is the one
 * hook it has, and it returns the same string on every render.
 *
 * A source scan rather than a render count because the property IS structural
 * — the way to break it is to add a hook, and a test that names the hooks is
 * the test that fails when somebody does.
 */
describe("Composer costs one render per keystroke", () => {
  const source = readFileSync(SOURCE, "utf8");

  test("it uses no hook that can schedule a second pass", () => {
    const hooks = [...source.matchAll(/\buse[A-Z][A-Za-z]*/g)].map((m) => m[0]);
    expect([...new Set(hooks)].sort()).toEqual(["useId"]);
  });

  test("it holds no element reference to measure through", () => {
    // `\bref=` rather than `ref=`, which an `href=` in an icon would satisfy.
    expect(source).not.toMatch(/\bref=/);
  });
});
