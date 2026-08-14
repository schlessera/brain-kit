import { describe, expect, test } from "bun:test";

import { buildHtmlDocument } from "../src/render/template";

describe("buildHtmlDocument remote-asset handling", () => {
  test("replaces remote images with a visible placeholder", () => {
    const html = buildHtmlDocument({
      content: "![a chart](https://example.com/chart.png)",
      contentType: "markdown",
    });
    // The renderer denies the page all network access, so a remote <img>
    // would render as a broken-image box; the placeholder is honest instead.
    expect(html).not.toContain("https://example.com/chart.png");
    expect(html).toContain("remote-image");
    expect(html).toContain("[a chart — not embedded]");
  });

  test("keeps inlined data: images", () => {
    const dataUri =
      "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    const html = buildHtmlDocument({
      content: `![inline](${dataUri})`,
      contentType: "markdown",
    });
    expect(html).toContain(dataUri);
    expect(html).not.toContain("not embedded");
  });

  test("applies to raw html content too", () => {
    const html = buildHtmlDocument({
      content: '<p><img src="http://169.254.169.254/latest/meta-data/" alt=""></p>',
      contentType: "html",
    });
    expect(html).not.toContain("169.254.169.254");
    expect(html).toContain("[remote image — not embedded]");
  });

  test("passes a pre-rendered mermaid figure through markdown intact", () => {
    // The client inlines mermaid fences as a single-line <div class="mermaid-figure">
    // (the page runs no JS, so the SVG must arrive pre-rendered). marked must
    // emit that block verbatim, not wrap or escape it.
    const svg = '<svg aria-roledescription="flowchart-v2" viewBox="0 0 100 50"><g class="root"></g></svg>';
    const html = buildHtmlDocument({
      content: `before\n\n<div class="mermaid-figure">${svg}</div>\n\nafter`,
      contentType: "markdown",
    });
    expect(html).toContain(`<div class="mermaid-figure">${svg}</div>`);
    expect(html).toContain(".mermaid-figure svg");
  });
});
