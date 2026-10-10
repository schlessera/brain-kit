import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark, type BrandMarkProps } from "../src/primitives/BrandMark.js";

const ASSETS = join(import.meta.dir, "..", "assets", "brand");

/** The viewBox and path data of a committed master, in document order. */
function master(file: string) {
  const svg = readFileSync(join(ASSETS, file), "utf8");
  return {
    viewBox: /<svg[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1],
    paths: [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]),
  };
}

function rendered(props: BrandMarkProps) {
  const html = renderToStaticMarkup(<BrandMark {...props} />);
  return {
    html,
    viewBox: /<svg[^>]*\sviewBox="([^"]+)"/.exec(html)?.[1],
    paths: [...html.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]),
    parts: [...html.matchAll(/<path\b[^>]*\sdata-part="([^"]+)"/g)].map((m) => m[1]),
  };
}

describe("BrandMark geometry is the committed master artwork", () => {
  const cases: { props: BrandMarkProps; masters: string[]; parts: string[] }[] = [
    { props: { size: 32 }, masters: ["mark-on-dark.svg", "mark-on-paper.svg"], parts: ["ink", "accent"] },
    { props: { size: 24 }, masters: ["mark-on-dark.svg", "mark-on-paper.svg"], parts: ["ink", "accent"] },
    { props: { size: 23 }, masters: ["mark-small-on-dark.svg", "mark-small-on-paper.svg"], parts: ["ink", "accent"] },
    { props: { size: 16 }, masters: ["mark-small-on-dark.svg", "mark-small-on-paper.svg"], parts: ["ink", "accent"] },
    { props: { variant: "lockup", size: 20 }, masters: ["lockup-on-dark.svg", "lockup-on-paper.svg"], parts: ["ink", "accent", "wordmark"] },
    { props: { variant: "lockup", size: 64 }, masters: ["lockup-on-dark.svg", "lockup-on-paper.svg"], parts: ["ink", "accent", "wordmark"] },
  ];
  for (const { props, masters, parts } of cases) {
    for (const file of masters) {
      test(`${JSON.stringify(props)} draws ${file}`, () => {
        const want = master(file);
        const got = rendered(props);
        // Non-empty first, so an empty match on either side cannot pass.
        expect(want.paths.length, `${file} has paths`).toBe(parts.length);
        expect(got.parts).toEqual(parts);
        expect(got.viewBox).toBe(want.viewBox);
        expect(got.paths).toEqual(want.paths);
      });
    }
  }
});

describe("BrandMark naming", () => {
  test("without a label it is decorative", () => {
    for (const variant of ["mark", "lockup"] as const) {
      const { html } = rendered({ variant });
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("role=");
      expect(html).not.toContain("aria-label");
    }
  });

  test("with a label it is an image with that name", () => {
    for (const variant of ["mark", "lockup"] as const) {
      const { html } = rendered({ variant, label: "brain-kit" });
      expect(html).toMatch(/<svg[^>]*\srole="img"/);
      expect(html).toMatch(/<svg[^>]*\saria-label="brain-kit"/);
      expect(html).not.toContain("aria-hidden");
    }
  });
});
