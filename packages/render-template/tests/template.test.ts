import { describe, expect, test } from "bun:test";

import { buildHtmlDocument, DEFAULT_TITLE, documentTitle, isFullDocument } from "../src/template";
import { STYLES } from "../src/styles";
import { lintDocument } from "../src/lint";

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

  describe("a complete HTML document (#530)", () => {
    const DOC = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Their title</title><style>h1 { color: red; }</style></head>
<body data-accent="teal"><h1>Hi</h1></body></html>`;

    test("is recognised after a BOM, whitespace and comments, and a fragment is not", () => {
      expect(isFullDocument(DOC)).toBe(true);
      expect(isFullDocument("\uFEFF \n<!-- made by hand -->\n<HTML><body>x</body></HTML>")).toBe(true);
      expect(isFullDocument('<div class="doc-card">x</div>')).toBe(false);
      expect(isFullDocument("<header>x</header>")).toBe(false);
    });

    test("is not nested: one <html>, one <head>, one <body>", () => {
      const html = buildHtmlDocument({ content: DOC, contentType: "html" });
      expect(html.match(/<html\b/gi)).toHaveLength(1);
      expect(html.match(/<head\b/gi)).toHaveLength(1);
      expect(html.match(/<body\b/gi)).toHaveLength(1);
      expect(html).toStartWith("<!doctype html>");
    });

    test("gets the shell's stylesheet before its own, so its own rules win", () => {
      const html = buildHtmlDocument({ content: DOC, contentType: "html" });
      const shell = html.indexOf("@layer brain-document");
      const own = html.indexOf("h1 { color: red; }");
      expect(shell).toBeGreaterThan(-1);
      expect(own).toBeGreaterThan(shell);
      // First child of <head>: nothing of the author's precedes it.
      expect(html).toContain("<head><style>\n@layer brain-document {\n  @page { size: A4;");
    });

    test("keeps its own title, and a caller's title only fills a missing one", () => {
      const kept = buildHtmlDocument({ content: DOC, contentType: "html", title: "Caller" });
      expect(kept.match(/<title>/g)).toHaveLength(1);
      expect(kept).toContain("<title>Their title</title>");
      const filled = buildHtmlDocument({
        content: "<!doctype html><html><head></head><body>x</body></html>",
        contentType: "html",
        title: "Caller & co",
      });
      expect(filled).toContain("<title>Caller &amp; co</title>");
    });

    test("with no <head>, gets one; with no <html>, the style goes after the doctype", () => {
      const noHead = buildHtmlDocument({ content: "<!doctype html><html><body><header>x</header></body></html>", contentType: "html" });
      expect(noHead).toStartWith("<!doctype html><html><head><style>");
      expect(noHead.match(/<head\b/gi)).toHaveLength(1);
      const noHtml = buildHtmlDocument({ content: "<!doctype html><title>t</title><p>x</p>", contentType: "html" });
      expect(noHtml).toStartWith("<!doctype html><style>");
    });

    test('<meta name="brain-render" content="bare"> passes it through untouched', () => {
      const bare = DOC.replace("<title>", '<meta content="bare" name="brain-render"><title>');
      expect(buildHtmlDocument({ content: bare, contentType: "html", title: "ignored" })).toBe(bare);
    });

    test("a bare document still has its remote images placeholdered", () => {
      const bare = '<!doctype html><html><head><meta name="brain-render" content="bare"></head><body><img src="https://example.com/a.jpg" alt="A"></body></html>';
      const html = buildHtmlDocument({ content: bare, contentType: "html" });
      expect(html).toContain("[A — not embedded]");
      expect(html).not.toContain("example.com/a.jpg");
      expect(html).not.toContain("@layer brain-document");
    });

    test("a <head>, <body> or bare <meta> in a comment or an attribute value is not the real one", () => {
      const inComment = buildHtmlDocument({
        content: "<!doctype html><!-- <head> example --><html><head></head><body>x</body></html>",
        contentType: "html",
      });
      expect(inComment).toContain("<!-- <head> example -->");
      expect(inComment).toContain("<html><head><style>");

      const bare = '<!-- <body> example --><!doctype html><html><head><meta name="brain-render" content="bare"></head><body>x</body></html>';
      expect(buildHtmlDocument({ content: bare, contentType: "html", title: "Caller" })).toBe(bare);

      const commentedBare = '<!doctype html><html><head><!-- <meta name="brain-render" content="bare"> --></head><body>x</body></html>';
      expect(buildHtmlDocument({ content: commentedBare, contentType: "html" })).toContain("@layer brain-document");

      const inAttr = buildHtmlDocument({
        content: '<!doctype html><html><head data-note="<body>"><title>Real</title></head><body>x</body></html>',
        contentType: "html",
        title: "Caller",
      });
      expect(inAttr.match(/<title>/g)).toHaveLength(1);
      expect(inAttr).not.toContain("Caller");
    });

    test("a body <title> (an svg's) is not the document's, and entities decode once", () => {
      expect(documentTitle("<!doctype html><p>x</p><svg><title>SVG</title></svg>")).toBeUndefined();
      expect(documentTitle('<!doctype html><title data-note=">">Real</title>')).toBe("Real");
      expect(documentTitle("<!doctype html><title>&copy; &#38;amp; &mdash;</title>")).toBe("\u00A9 &amp; \u2014");
    });

    test("an unquoted remote src is placeholdered too", () => {
      const html = buildHtmlDocument({ content: "<img src=https://example.com/a.png alt=Map>", contentType: "html" });
      expect(html).toContain("[Map — not embedded]");
      expect(html).not.toContain("example.com/a.png");
    });

    test("quoted attribute values, raw text and inert templates are not markup", () => {
      // A "<!--" or "<style>" inside a quoted value starts nothing.
      expect(documentTitle('<!doctype html><html><head data-note="<!--"><title>Real</title></head><body>x</body></html>')).toBe("Real");
      expect(documentTitle('<!doctype html><html><head data-note="<style>"><title>Real</title></head><body>x</body></html>')).toBe("Real");
      // An end tag may carry attributes, and still ends the element.
      expect(documentTitle("<!doctype html><head><style>x</style foo><title>Real</title></head><body>x")).toBe("Real");
      expect(documentTitle("<!doctype html><title>Real</title foo></head><body>x")).toBe("Real");
      // A title inside a template, however nested, is not the document's.
      expect(documentTitle("<!doctype html><head><template><template></template><title>Fake</title></template><title>Real</title></head>")).toBe("Real");
    });

    test("an unquoted value may hold '<', as it may in a browser", () => {
      const img = buildHtmlDocument({ content: '<img data-x=a<b src="https://example.com/a.png" alt="Map">', contentType: "html" });
      expect(img).toContain("[Map — not embedded]");
      expect(documentTitle("<!doctype html><html><head data-note=a<b><title>Real</title></head><body>x</body></html>")).toBe("Real");
    });

    test("only a real <img> is replaced, never one quoted in an attribute or written in a textarea", () => {
      const quoted = '<p data-note="<img src=https://example.com/a.png>">x</p><textarea><img src=https://example.com/b.png></textarea>';
      const html = buildHtmlDocument({ content: quoted, contentType: "html" });
      expect(html).toContain(quoted);
      expect(html).not.toContain("not embedded");
    });

    test("entities: unknown names stay as written, and numeric references may have leading zeros", () => {
      expect(documentTitle("<!doctype html><title>&constructor; &#0000000065; &#x00000041;</title>")).toBe("&constructor; A A");
    });

    test("reads what Chrome reads: the cases a hand-written tokenizer got wrong", () => {
      const build = (content: string, title?: string) => buildHtmlDocument({ content, contentType: "html", title });
      const replaced = (content: string) => build(content).includes("not embedded");
      // A doctype quoted in a leading comment is not where the shell goes.
      expect(build("<!-- <!doctype html> --><!doctype html><body>x", "Caller")).toStartWith("<!-- <!doctype html> --><!doctype html><style>");
      expect(isFullDocument("<!doctype" + " ".repeat(40) + "html><body>x")).toBe(true);
      // A leading BOM is an encoding mark, not text before the doctype.
      expect(build("\uFEFF<!doctype html><html><head><title>T</title></head><body>x</body></html>")).toStartWith("\uFEFF<!doctype html><html><head><style>");
      // Real images are replaced and nothing else is.
      expect(replaced("<!--><img src=https://example.com/x>")).toBe(true);
      expect(replaced("<svg><title/></svg><img src=https://example.com/x>")).toBe(true);
      expect(replaced("<img:foo src=https://example.com/x alt=X>")).toBe(false);
      expect(replaced("<plaintext><img src=https://example.com/x alt=X>")).toBe(false);
      expect(replaced('<img src="data&#58;image/png;base64,AA">')).toBe(false);
      // Attribute values and titles are decoded as the browser decodes them.
      expect(build('<!doctype html><head><meta name="brain&#45;render" content="bare"></head><body>x')).not.toContain("@layer");
      expect(documentTitle("<!doctype html><title>&Aacute; &#128; &#65</title>")).toBe("\u00C1 \u20AC A");
      // Text inside <head> closes it, so a bare meta after the text is in the body.
      expect(build("<!doctype html><head>hello<meta name=brain-render content=bare>")).toContain("@layer brain-document");
    });

    test("malformed markup costs linear time, not quadratic", () => {
      // Each of these once made a tag scan retry from every start position.
      const n = 20_000;
      for (const content of [
        "<!doctype html>" + "<head ".repeat(n),
        "<!doctype html>" + '<a x="'.repeat(n),
        "<!doctype html>" + "<!--".repeat(n),
        "<!doctype html><style>" + "@font-face {".repeat(n),
        "<img ".repeat(n),
        "<style>p{background:url(" + " ".repeat(n * 10) + "data:x)}</style>",
        '<textarea>'.repeat(n),
        "<!doctype html><head>" + "<title>".repeat(n),
      ]) {
        const started = performance.now();
        lintDocument(buildHtmlDocument({ content, contentType: "html" }));
        expect(performance.now() - started).toBeLessThan(500);
      }
    });

    test("markdown is never treated as a document, whatever it starts with", () => {
      const html = buildHtmlDocument({ content: "<!doctype html>\n\n# Heading", contentType: "markdown" });
      expect(html).toStartWith('<!doctype html>\n<html lang="en">\n<head>');
      expect(html).toContain("<h1>Heading</h1>");
      expect(html).toContain("@layer brain-document");
    });
  });

  describe("the PDF footer", () => {
    const footerOf = (html: string) => /@bottom-left \{ content: ([^;]*);/.exec(html)?.[1];

    test("carries the running title and the page count, and skips page 1", () => {
      const html = buildHtmlDocument({ content: "x", contentType: "markdown", title: "Launch day" });
      expect(footerOf(html)).toBe('"Launch day"');
      expect(html).toContain('content: counter(page) " / " counter(pages)');
      expect(html).toContain("@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }");
    });

    test("shows page numbers alone for the default title or when turned off", () => {
      expect(footerOf(buildHtmlDocument({ content: "x", contentType: "markdown" }))).toBe('""');
      expect(footerOf(buildHtmlDocument({ content: "x", contentType: "markdown", title: "T", runningTitle: false }))).toBe('""');
      expect(footerOf(buildHtmlDocument({ content: "x", contentType: "markdown", title: "T", runningTitle: "Other" }))).toBe('"Other"');
    });

    test("takes a full document's own title", () => {
      const html = buildHtmlDocument({ content: "<!doctype html><html><head><title>Invoice EST-004</title></head><body>x</body></html>", contentType: "html" });
      expect(footerOf(html)).toBe('"Invoice EST-004"');
    });

    test("cannot be used to break out of the string or the <style> element", () => {
      const title = 'a"b\\c</style><script>alert(1)</script>';
      const html = buildHtmlDocument({ content: "x", contentType: "markdown", title });
      const footer = footerOf(html)!;
      expect(footer).not.toContain("</");
      expect(footer.slice(1, -1)).not.toContain('"');
      expect(html.match(/<\/style>/g)).toHaveLength(1);
      expect(html).not.toContain("<script>alert");
    });
  });

  test("documentTitle reads and decodes a built document's title", () => {
    expect(documentTitle(buildHtmlDocument({ content: "x", contentType: "markdown", title: "Tom & Jerry's" }))).toBe("Tom & Jerry's");
    expect(documentTitle(buildHtmlDocument({ content: "x", contentType: "markdown" }))).toBe(DEFAULT_TITLE);
    expect(documentTitle("<!doctype html><html><head></head><body><svg><title>no</title></svg></body></html>")).toBeUndefined();
  });

  test("markdown output carries the stylesheet unchanged", () => {
    expect(buildHtmlDocument({ content: "x", contentType: "markdown" })).toContain(STYLES);
  });
});
