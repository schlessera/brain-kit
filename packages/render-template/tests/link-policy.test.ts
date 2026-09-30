import { describe, expect, test } from "bun:test";
import { buildHtmlDocument } from "../src/template.ts";
import { applyExportLinkPolicy } from "../src/link-policy.ts";
import { attribute, elements, parseDocument, textOf } from "../src/html.ts";
import { classifyLink as kitLink, classifyMailto as kitMail } from "../../ui-kit/src/links.ts";
import { classifyLink, classifyMailto } from "../src/links.ts";

const opts = { contentType: "html" as const, linkPolicy: "visible-destinations" as const };
function anchors(html: string) { return [...elements(parseDocument(html))].filter((el) => el.tagName === "a" && attribute(el, "href") !== undefined); }
function build(content: string) { return buildHtmlDocument({ ...opts, content }); }

describe("export link policy", () => {
  test("UI-kit imports re-export the same pure classifier functions", () => {
    expect(kitLink).toBe(classifyLink); expect(kitMail).toBe(classifyMailto);
  });
  test("one verdict supplies both canonical href and ASCII destination", () => {
    const html = build('<a href="https://bücher.example:8443/read">A familiar brand</a>');
    const [a] = anchors(html);
    expect(attribute(a, "href")).toBe("https://xn--bcher-kva.example:8443/read");
    expect(textOf(a)).toBe("A familiar brand (xn--bcher-kva.example:8443)");
    expect(attribute(a, "rel")).toBe("noopener noreferrer nofollow");
    expect(attribute(a, "referrerpolicy")).toBe("no-referrer");
  });
  test("mailto queries never become recipients; the actual address is visible", () => {
    const html = build('<a href="mailto:odysseus@ithaca.example?bcc=other@example.test&amp;body=private">Write</a>');
    expect(attribute(anchors(html)[0], "href")).toBe("mailto:odysseus@ithaca.example");
    expect(textOf(anchors(html)[0])).toBe("Write (odysseus@ithaca.example)");
    expect(html).not.toContain("bcc="); expect(html).not.toContain("private");
  });
  test.each(["javascript:alert(1)", "data:text/html,x", "file:///notes/log.md", "https://odysseus:secret@unsafe.example/", "https://аpple.example/", "https://ithaca.example/ti\u202Edes", "mailto:ody%E2%80%AE@ithaca.example"])("a refused target is inert: %s", (raw) => {
    const html = build(`<a href="${raw}">Words</a>`);
    expect(anchors(html)).toHaveLength(0); expect(html).toContain("link withheld");
  });
  test("entities and raw Markdown controls reach the classifier before URI encoding", () => {
    for (const content of ['<a href="https://ithaca.example/ti&#x202E;des">Words</a>', '[Words](https://ithaca.example/ti\u202Edes)', '<https://ithaca.example/ti\u202Edes>', '[Write](mailto:ody%E2%80%AE@ithaca.example)']) {
      const html = buildHtmlDocument({ content, contentType: "markdown", linkPolicy: "visible-destinations" });
      expect(anchors(html)).toHaveLength(0); expect(html).toContain("link withheld");
    }
    // Accepted percent-encoded web paths remain accepted under the existing rules.
    expect(anchors(build('<a href="https://ithaca.example/%E2%80%AE">Words</a>'))).toHaveLength(1);
  });
  test("a supplied base cannot resolve fragments or unavailable repo targets", () => {
    const html = build('<base href="https://other.example/"><h2 id="chapter">Chapter</h2><a href="#chapter">Jump</a><a href="notes/log.md">Log</a><a href="/notes/log.md">Root log</a>');
    expect(html).not.toContain("<base");
    expect(anchors(html).map((a) => attribute(a, "href"))).toEqual(["#chapter"]);
    expect(html).toContain("notes/log.md"); expect(html).not.toContain("other.example");
  });
  test("processing twice retains words and has exactly one destination", () => {
    for (const content of ['<a href="https://ithaca.example/tides">Tides</a>', '<a href="https://ithaca.example/">https://ithaca.example/</a>', '<a href="mailto:odysseus@ithaca.example">odysseus@ithaca.example</a>']) {
      const once = build(content); expect(applyExportLinkPolicy(once)).toBe(once);
      expect(once.match(/data-brain-link-destination/g)).toHaveLength(1);
    }
  });
  test("source-supplied markers do not bypass classification or duplicate a forged suffix", () => {
    const html = build('<a data-brain-export-link href="https://odysseus:secret@unsafe.example/">Words<span data-brain-link-destination>trusted.example</span></a>');
    expect(anchors(html)).toHaveLength(0); expect(html).not.toContain("trusted.example");
    expect(html).not.toContain("secret");
  });
  test("default CLI document bytes and useful block markup retain their behavior", () => {
    const content = '<!doctype html><html><head><meta name="brain-render" content="bare"></head><body><div data-block="quote">Sing.</div><a href="https://odysseus:secret@unsafe.example/">Words</a></body></html>';
    expect(buildHtmlDocument({ content, contentType: "html" })).toBe(content);
    expect(build(content)).toContain('<div data-block="quote">Sing.</div>');
  });
});

describe("raw NUL normalization", () => {
  test.each(["html", "markdown"] as const)("%s keeps raw NUL refusal before HTML replacement", (contentType) => {
    for (const content of ['<a href="https://ithaca.example/nu\u0000l">Words</a>', '<a href="https://ithaca.example/nu&#0;l">Words</a>', '<svg><a xlink:href="https://ithaca.example/nu\u0000l"><text>Words</text></a></svg>', '<a href="https://ithaca.example/nu\u0000l" href="https://safe.example/">Words</a>']) {
      const html = buildHtmlDocument({ content, contentType, linkPolicy: "visible-destinations" });
      expect(anchors(html)).toHaveLength(0); expect(textOf(parseDocument(html))).toContain("invisible or direction-changing");
    }
  });
  test("Markdown tokens and autolinks keep the same raw refusal", () => {
    for (const content of ['[Words](https://ithaca.example/nu\u0000l)', '<https://ithaca.example/nu\u0000l>']) {
      const html = buildHtmlDocument({ content, contentType: "markdown", linkPolicy: "visible-destinations" });
      expect(anchors(html)).toHaveLength(0); expect(textOf(parseDocument(html))).toContain("invisible or direction-changing");
    }
  });
  test("a stand-in collision is resolved and numeric references are decoded once", () => {
    const html = build('<a href="https://ithaca.example/__brain_export_null_0__nu&#x0000;l">Words</a><a href="https://ithaca.example/&amp;#0;">Entity text</a>');
    expect(anchors(html)).toHaveLength(1);
    expect(attribute(anchors(html)[0], "href")).toBe("https://ithaca.example/&#0;");
  });
});

test("a raw-control autolink uses the classifier's redacted visible address", () => {
  const html = buildHtmlDocument({ content: "<https://odysseus:secret@ithaca.example/nu\u0000l>", contentType: "markdown", linkPolicy: "visible-destinations" });
  expect(anchors(html)).toHaveLength(0);
  expect(textOf(parseDocument(html))).not.toContain("secret");
  expect(textOf(parseDocument(html))).toContain("U+0000");
});
