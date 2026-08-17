import { describe, expect, test } from "bun:test";

import { buildHtmlDocument } from "../src/template";

describe("buildHtmlDocument", () => {
  test("parses markdown and inlines the stylesheet", () => {
    const html = buildHtmlDocument({ content: "# Hello\n\nBody.", contentType: "markdown" });
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<style>");
    // Self-contained: nothing to fetch.
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });

  test("passes HTML through untouched", () => {
    const html = buildHtmlDocument({
      content: '<div class="card">raw</div>',
      contentType: "html",
    });
    expect(html).toContain('<div class="card">raw</div>');
    expect(html).not.toContain("<p>");
  });

  test("renders GFM tables", () => {
    const html = buildHtmlDocument({
      content: "| a | b |\n|---|---|\n| 1 | 2 |",
      contentType: "markdown",
    });
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
  });

  test("escapes the title", () => {
    const html = buildHtmlDocument({
      content: "x",
      contentType: "markdown",
      title: '<script>alert("x")</script>',
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<title><script>");
  });

  test("defaults the title", () => {
    expect(buildHtmlDocument({ content: "x", contentType: "markdown" })).toContain(
      "<title>Shared from Brain</title>"
    );
  });

  describe("remote images", () => {
    test("become a placeholder carrying the alt text", () => {
      const html = buildHtmlDocument({
        content: "![Matterhorn](https://example.com/m.jpg)",
        contentType: "markdown",
      });
      expect(html).toContain('<span class="remote-image">[Matterhorn — not embedded]</span>');
      expect(html).not.toContain("example.com/m.jpg");
    });

    test("fall back to a generic label with no alt text", () => {
      const html = buildHtmlDocument({
        content: '<img src="https://example.com/m.jpg">',
        contentType: "html",
      });
      expect(html).toContain("[remote image — not embedded]");
    });

    test("data: URIs survive", () => {
      const src = "data:image/png;base64,iVBORw0KGgo=";
      const html = buildHtmlDocument({ content: `<img src="${src}">`, contentType: "html" });
      expect(html).toContain(src);
      // `.remote-image` also names a CSS rule in the stylesheet, so assert on
      // the placeholder markup rather than the class name alone.
      expect(html).not.toContain("not embedded");
    });

    test("allowHosts keeps matching hosts, case-insensitively", () => {
      const html = buildHtmlDocument({
        content: '<img src="https://Upload.Wikimedia.org/a.jpg"><img src="https://other.test/b.jpg">',
        contentType: "html",
        allowHosts: ["upload.wikimedia.org"],
      });
      expect(html).toContain("Upload.Wikimedia.org/a.jpg");
      expect(html).toContain("[remote image — not embedded]");
      expect(html).not.toContain("other.test/b.jpg");
    });

    test("a malformed src is placeholdered, not passed through", () => {
      const html = buildHtmlDocument({
        content: '<img src="::not a url::">',
        contentType: "html",
        allowHosts: ["example.com"],
      });
      expect(html).toContain("remote-image");
    });

    test("an empty alt falls back to the generic label", () => {
      const html = buildHtmlDocument({
        content: '<p><img src="http://169.254.169.254/latest/meta-data/" alt=""></p>',
        contentType: "html",
      });
      expect(html).not.toContain("169.254.169.254");
      expect(html).toContain("[remote image — not embedded]");
    });

    test("alt text is escaped into the placeholder", () => {
      const html = buildHtmlDocument({
        content: '<img alt="<b>x</b>" src="https://example.com/m.jpg">',
        contentType: "html",
      });
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>x</b>");
    });
  });

  test("passes a pre-rendered mermaid figure through markdown intact", () => {
    // The client inlines mermaid fences as a single-line <div class="mermaid-figure">
    // (the page runs no JS, so the SVG must arrive pre-rendered). marked must
    // emit that block verbatim, not wrap or escape it.
    const svg =
      '<svg aria-roledescription="flowchart-v2" viewBox="0 0 100 50"><g class="root"></g></svg>';
    const html = buildHtmlDocument({
      content: `before\n\n<div class="mermaid-figure">${svg}</div>\n\nafter`,
      contentType: "markdown",
    });
    expect(html).toContain(`<div class="mermaid-figure">${svg}</div>`);
    expect(html).toContain(".mermaid-figure svg");
  });

  test("print rules avoid splitting blocks across pages", () => {
    const html = buildHtmlDocument({ content: "x", contentType: "markdown" });
    expect(html).toContain("@media print");
    expect(html).toContain("break-inside: avoid");
  });
});
