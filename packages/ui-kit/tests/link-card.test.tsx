/**
 * `LinkPreviewCard` in link mode (#43), as markup: a pure function of props,
 * like the kit's other unit tests. What only a layout engine can answer (the
 * host wrapping only between labels, staying in the box at 320px, the targets'
 * reach, no request while rendering) is `tests/visual/link-card.visual.tsx`'s.
 * The numbers name the spec's acceptance tests on the issue.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

import { LinkPreviewCard } from "../src/blocks/LinkPreviewCard.js";

/** Parsed by a DOM that is never registered as a global: the card renders on the server path. */
function mount(markup: string): Document {
  const { document } = new Window();
  document.body.innerHTML = markup;
  return document as unknown as Document;
}

const draw = (props: Parameters<typeof LinkPreviewCard>[0]) =>
  mount(renderToStaticMarkup(<LinkPreviewCard {...props} />));

const URL_ = "https://ithaca-harbour.example/tides/2026/week-39?ship=12#high";

describe("LinkPreviewCard: destination", () => {
  test("14. Open is an anchor to the parsed href, in a new tab, with no opener and no referrer", () => {
    const doc = draw({ url: URL_, title: "Harbour tide tables", expanded: true });
    const anchors = doc.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    const open = anchors[0]!;
    expect(open.getAttribute("href")).toBe(URL_);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")!.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
    expect(open.getAttribute("referrerpolicy")).toBe("no-referrer");
    // The disclosure shows exactly the string the anchor navigates to.
    expect(doc.querySelector("[data-link-full]")!.textContent).toBe(open.getAttribute("href")!);
  });

  test("the host is derived from the url: a caller cannot supply one", () => {
    const doc = draw({
      url: "https://account-check.example/login",
      title: "Your bank: verify now",
      meta: "bank.example",
      trust: "verified by bank.example",
    });
    expect(doc.querySelector("[data-link-host]")!.textContent).toBe("account-check.example");
    expect(doc.body.textContent).not.toContain("bank.example ");
    expect(doc.body.textContent).not.toContain("verified by");
    expect(doc.querySelector("section")!.getAttribute("aria-label")).toBe("Link to account-check.example");
    expect(doc.querySelector("a")!.getAttribute("aria-label")).toBe("Open account-check.example in a new tab");
  });

  test("the host is first, whole, and split into its labels with the dots kept", () => {
    const doc = draw({ url: "https://records.harbour-master.ithaca.gov.example:8443/archive", title: "t" });
    const host = doc.querySelector("[data-link-host]")!;
    expect(host.textContent).toBe("records.harbour-master.ithaca.gov.example:8443");
    expect([...host.children].map((label) => label.textContent)).toEqual([
      "records.",
      "harbour-master.",
      "ithaca.",
      "gov.",
      "example:8443",
    ]);
    // Never ellipsised.
    expect(host.outerHTML).not.toContain("ellipsis");
    // The first text in the card is the host.
    expect(doc.querySelector("section")!.textContent!.startsWith("records.")).toBe(true);
  });

  test("16. every destination card carries the attribution line, naming what the brain wrote", () => {
    const line = (props: Parameters<typeof LinkPreviewCard>[0]) =>
      draw(props).querySelector("[data-link-attribution]")?.textContent;
    expect(line({ url: URL_, title: "T", description: "D" })).toBe(
      "Title and summary by the brain · page not opened or checked"
    );
    expect(line({ url: URL_, title: "T" })).toBe("Title by the brain · page not opened or checked");
    expect(line({ url: URL_ })).toBe("Link shown by the brain · page not opened or checked");
  });

  test("no words: no demo default, the card says so; a description alone is not contradicted", () => {
    const doc = draw({ url: URL_ });
    expect(doc.body.textContent).toContain("No description given");
    expect(doc.body.textContent).not.toContain("succession");
    expect(doc.body.textContent).not.toContain("relayed second-hand");
    const described = draw({ url: URL_, description: "High water before dawn." });
    expect(described.body.textContent).toContain("High water before dawn.");
    expect(described.body.textContent).not.toContain("No description given");
  });

  test("18. the model's words render literally: no markdown, no HTML, no autolink", () => {
    const doc = draw({ url: URL_, title: "**bold** <img src=x>", description: "see https://bank.example" });
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("strong")).toBeNull();
    expect(doc.body.textContent).toContain("**bold** <img src=x>");
    expect(doc.querySelectorAll("a")).toHaveLength(1);
  });

  test("notes: the decoded name, an IP literal, plain http", () => {
    const notes = (url: string) => [...draw({ url }).querySelectorAll("[data-link-note]")].map((n) => n.textContent);
    expect(notes("https://bücher.example/")).toEqual(["reads as bücher.example"]);
    expect(draw({ url: "https://bücher.example/" }).querySelector("[data-link-host]")!.textContent).toBe(
      "xn--bcher-kva.example"
    );
    expect(notes("http://10.0.0.1:8080/")).toEqual(["IP address · no name", "not encrypted (http)"]);
    expect(notes(URL_)).toEqual([]);
  });

  test("15. the card itself is not a target: no card role, no tab stop, onClick ignored", () => {
    const doc = draw({ url: URL_, title: "T", onClick: () => undefined });
    expect(doc.querySelector('[role="button"]')).toBeNull();
    expect(doc.querySelector("section")!.getAttribute("tabindex")).toBeNull();
    expect(doc.querySelector(".bk-row")).toBeNull();
  });

  test("Copy appears only when the embedder passes onCopy, and only with the address open", () => {
    const buttons = (props: Parameters<typeof LinkPreviewCard>[0]) =>
      [...draw(props).querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons({ url: URL_, expanded: true })).toEqual(["Full address"]);
    expect(buttons({ url: URL_, expanded: true, onCopy: () => undefined })).toEqual(["Full address", "Copy"]);
    expect(buttons({ url: URL_, onCopy: () => undefined })).toEqual(["Full address"]);
  });

  test("the disclosure names its panel only while the panel exists", () => {
    const closed = draw({ url: URL_ }).querySelector("button")!;
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(closed.getAttribute("aria-controls")).toBeNull();
    const doc = draw({ url: URL_, expanded: true });
    const open = doc.querySelector("button")!;
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(doc.getElementById(open.getAttribute("aria-controls")!)).not.toBeNull();
  });
});

describe("LinkPreviewCard: withheld", () => {
  test("17. a refused address draws no anchor, no link role, no Open and no Copy", () => {
    for (const url of ["javascript:alert(1)", "https://odysseus:nobody@drive.example/roster", "/tides"]) {
      const doc = draw({ url, title: "Crew roster", expanded: true, onCopy: () => undefined });
      expect(doc.querySelector("section")!.getAttribute("aria-label")).toBe("Link withheld");
      expect(doc.querySelector("a")).toBeNull();
      expect(doc.querySelector('[role="link"]')).toBeNull();
      expect(doc.body.textContent).not.toContain("Open");
      expect(doc.body.textContent).not.toContain("Copy");
      expect(doc.querySelector("[href]")).toBeNull();
    }
  });

  test("it says why, keeps the claimed title with its attribution, and shows what was sent as redacted text", () => {
    const doc = draw({ url: "https://odysseus:nobody@drive.example/roster", title: "Crew roster", expanded: true });
    const section = doc.querySelector("section")!;
    const reason = doc.getElementById(section.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toBe("the address carries a sign-in name or password");
    expect(doc.body.textContent).toContain("Crew roster");
    expect(doc.querySelector("[data-link-attribution]")!.textContent).toBe("Title by the brain");
    const sent = doc.querySelector("[data-link-sent]")!;
    expect(sent.textContent).toBe("https://•••@drive.example/roster");
    expect(sent.children).toHaveLength(0);
  });

  test("no title: no attribution line, because the brain claimed nothing", () => {
    const doc = draw({ url: "javascript:alert(1)" });
    expect(doc.querySelector("[data-link-attribution]")).toBeNull();
    expect(doc.body.textContent).toContain("this one is javascript:");
  });
});

describe("LinkPreviewCard: without url, unchanged", () => {
  test("the relayed-share card keeps its single target, thumb and demo defaults", () => {
    const doc = draw({ onClick: () => undefined, trust: "relayed second-hand" });
    expect(doc.querySelector('[role="button"]')).not.toBeNull();
    expect(doc.querySelector("section")).toBeNull();
    expect(doc.querySelector("a")).toBeNull();
    expect(doc.body.textContent).toContain("What the hall is saying about the succession");
  });
});
