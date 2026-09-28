import { describe, expect, test } from "bun:test";

import { buildHtmlDocument } from "../src/template";
import { lintDocument } from "../src/lint";

const codes = (content: string, contentType: "html" | "markdown" = "html") =>
  lintDocument(buildHtmlDocument({ content, contentType })).map((w) => w.code);

describe("lintDocument", () => {
  test("a document of known components raises nothing", () => {
    expect(
      codes('<header class="doc-hero"><h1>T</h1></header><div class="doc-callout doc-callout--warning"><strong>A</strong>b</div>')
    ).toEqual([]);
  });

  test("the shell's own stylesheet is not mistaken for markup", () => {
    // Its comments quote tags such as <li class="is-key">.
    expect(codes("plain")).toEqual([]);
  });

  describe("unknown-class", () => {
    test("names the class and the variants it was probably meant to be", () => {
      const [w] = lintDocument(buildHtmlDocument({ content: '<div class="doc-callout doc-callout--info">x</div>', contentType: "html" }));
      expect(w.code).toBe("unknown-class");
      expect(w.message).toContain('"doc-callout--info"');
      expect(w.message).toContain('"doc-callout--warning"');
    });

    test("ignores classes outside the doc- namespace", () => {
      expect(codes('<div class="my-card doc-card">x</div>')).toEqual([]);
    });
  });

  test("unknown-accent", () => {
    expect(codes('<!doctype html><html><head></head><body data-accent="green"><p>x</p></body></html>')).toEqual(["unknown-accent"]);
    expect(codes('<!doctype html><html><head></head><body data-accent="teal"><p>x</p></body></html>')).toEqual([]);
  });

  describe("openers", () => {
    test("one that is not first", () => {
      expect(codes('<p>intro</p><header class="doc-hero"><h1>T</h1></header>')).toEqual(["opener-not-first"]);
    });

    test("more than one", () => {
      expect(codes('<header class="doc-hero"><h1>T</h1></header><header class="doc-letterhead">x</header>')).toEqual(["several-openers"]);
    });

    test("first in a full document, after head content", () => {
      expect(
        codes('<!doctype html><html><head><title>t</title></head><body>\n<!-- lead -->\n<header class="doc-letterhead">x</header><p>y</p></body></html>')
      ).toEqual([]);
    });

    test("first in a document whose <body> tag is implied", () => {
      expect(codes('<!doctype html><title>t</title><header class="doc-hero"><h1>T</h1></header>')).toEqual([]);
    });
  });

  test("placeholder-image counts skeleton images left in", () => {
    const [w] = lintDocument(
      buildHtmlDocument({ content: '<img data-placeholder src="data:image/png;base64,AA" alt="a"><img data-placeholder src="data:x" alt="b">', contentType: "html" })
    );
    expect(w.code).toBe("placeholder-image");
    expect(w.message).toStartWith("2 skeleton placeholder images");
    expect(codes('<img src="data:image/png;base64,AA" alt="a">')).toEqual([]);
  });

  test("remote-image lists what was not embedded", () => {
    const [w] = lintDocument(buildHtmlDocument({ content: "![The raft](https://example.com/raft.jpg)", contentType: "markdown" }));
    expect(w.code).toBe("remote-image");
    expect(w.message).toContain("The raft");
    expect(w.message).toContain("--allow-host");
  });

  test("empty-link", () => {
    expect(codes('<a href="#">x</a><a href="">y</a><a>z</a>')).toEqual(["empty-link"]);
    expect(codes('<a href="https://example.com/">x</a><a href="#section">y</a>')).toEqual([]);
  });

  test("script", () => {
    expect(codes("<script>document.write('x')</script>")).toEqual(["script"]);
  });

  test("network-resource: stylesheets, imports, webfonts and embeds", () => {
    expect(codes('<link rel="stylesheet" href="https://example.com/a.css">')).toEqual(["network-resource"]);
    expect(codes("<style>@import url(https://example.com/a.css);</style>")).toEqual(["network-resource"]);
    expect(codes("<style>@font-face { font-family: X; src: url(https://example.com/x.woff2); }</style>")).toEqual(["network-resource"]);
    expect(codes('<iframe src="https://example.com/"></iframe>')).toEqual(["network-resource"]);
    expect(codes("<style>@font-face { font-family: X; src: url(data:font/woff2;base64,AA); }</style>")).toEqual([]);
  });

  describe("what is not markup (#530 review)", () => {
    test("textarea, template, comment and attribute-value contents raise nothing", () => {
      expect(codes('<textarea><div class="doc-typo"><a href="#">x</a><script>x</script></textarea>')).toEqual([]);
      expect(codes('<header class="doc-hero"><h1>T</h1></header><template><header class="doc-letterhead"></header></template>')).toEqual([]);
      expect(codes('<div data-note=" class=doc-typo">x</div>')).toEqual([]);
      expect(codes("<!-- <iframe src=\"https://example.com/\"></iframe> -->")).toEqual([]);
      expect(codes("<pre><code>@import url(x);</code></pre>")).toEqual([]);
    });

    test("noscript content renders (the page runs no JavaScript), so it is linted", () => {
      expect(codes('<noscript><div class="doc-typo"><a href="#">x</a></div></noscript>')).toEqual(["unknown-class", "empty-link"]);
    });

    test("nested templates stay inert", () => {
      expect(codes('<header class="doc-hero"><h1>T</h1></header><template><template></template><p class="doc-typo">x</p></template>')).toEqual([]);
    });

    test("a <style> in the body before the opener makes it not first", () => {
      expect(codes('<!doctype html><html><head></head><body><style>p{color:red}</style><header class="doc-hero">T</header></body></html>')).toEqual([
        "opener-not-first",
      ]);
    });
  });

  describe("network-resource, in CSS and markup", () => {
    test("inline fonts and fragment references load nothing", () => {
      expect(codes('<style>@font-face { font-family: X; src: url("data:font/woff2;base64,AA"); }</style>')).toEqual([]);
      expect(codes("<style>@font-face { font-family: X; src: url(  data:font/woff2;base64,AA); }</style>")).toEqual([]);
      expect(codes('<svg><rect fill="url(#g)" style="fill:url(#g)"/></svg>')).toEqual([]);
    });

    test("url() written in a CSS string or comment fetches nothing", () => {
      expect(codes('<style>p:after { content: "url(https://example.com/a)"; } /* url(https://example.com/b) @import x; */</style>')).toEqual([]);
    });

    test("a quoted data: url() does not hide the remote one after it", () => {
      expect(codes('<style>p{background:url("data:image/png;base64,AA")}p{background-image:url(https://example.com/x)}</style>')).toEqual(["network-resource"]);
    });

    test("a remote-image placeholder written in a comment is not one", () => {
      expect(codes('<!-- <span class="remote-image">[Map — not embedded]</span> -->')).toEqual([]);
    });

    test("CSS images, SVG images and media do", () => {
      expect(codes('<div style="background-image:url(https://example.com/a.png)">x</div>')).toEqual(["network-resource"]);
      expect(codes('<svg><image href="https://example.com/a.png"/></svg>')).toEqual(["network-resource"]);
      expect(codes('<video src="https://example.com/a.mp4"></video>')).toEqual(["network-resource"]);
    });
  });
});

