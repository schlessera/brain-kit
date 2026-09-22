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
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";

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
