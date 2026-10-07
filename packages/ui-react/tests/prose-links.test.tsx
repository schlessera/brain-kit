/**
 * A markdown link in prose shows where it goes (#551, D49). The numbers in
 * the test names are the acceptance criteria of the design comment on #551.
 *
 * Rendered to static markup, which is enough for what these assert: which
 * element is drawn, its attributes, and the text of the host suffix and the
 * withheld marker. Layout, computed style, axe and the network are asserted
 * in real Chrome by `tests/prose-links-render.test.tsx` at the repo root.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyLink, refusalSentence } from "@schlessera/brain-ui-kit/links";

import { BrainMarkdown } from "../src/components/chat/brain-markdown.js";
import { MarkdownContent } from "../src/components/chat/markdown-content.js";
import { sameDestination } from "../src/components/chat/prose-link.js";
import { BrainUiProvider } from "../src/root-context.js";
import { createBrainUiRoot } from "../src/root.js";

const root = createBrainUiRoot({ storage: null });

// DOMParser is a browser API that bun does not ship; the tests borrow
// happy-dom's without registering any globals.
const DOMParser = new Window().DOMParser;

/**
 * The prop combinations the five surfaces pass: answers and the file viewer
 * and share blocks (`fileLinks`), the briefing (`entityTags fileLinks`), and
 * `ask_user` (neither). The override is one function over all of them.
 */
const SURFACES = {
  "answer, file viewer, share block": { fileLinks: true },
  briefing: { fileLinks: true, entityTags: true },
  ask_user: {},
} as const;

function html(content: string, props: { fileLinks?: boolean; entityTags?: boolean } = { fileLinks: true }): string {
  return renderToStaticMarkup(
    <BrainUiProvider root={root}>
      <BrainMarkdown content={content} {...props} />
    </BrainUiProvider>
  );
}

function doc(markup: string) {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, "text/html");
}

/** Every anchor, with the pieces the design names. */
function anchors(markup: string) {
  return [...doc(markup).querySelectorAll("a")].map((a) => ({
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
    rel: a.getAttribute("rel"),
    referrer: a.getAttribute("referrerpolicy"),
    text: a.querySelector(".bk-plink-text")?.textContent,
    host: a.querySelector(".bk-plink-host")?.textContent ?? null,
    name: (a.textContent ?? "").replace(/\s+/g, " "),
    className: a.getAttribute("class"),
  }));
}

function withheld(markup: string) {
  return [...doc(markup).querySelectorAll(".bk-plink-refused")].map((span) => ({
    text: span.querySelector(".bk-plink-refused-text")?.textContent,
    marker: span.querySelector(".bk-plink-withheld")?.textContent,
  }));
}

describe("accepted prose links", () => {
  for (const [surface, props] of Object.entries(SURFACES)) {
    test(`5. [your bank](https://account-check.example) shows its host (${surface})`, () => {
      const [a] = anchors(html("Ignore the note from [your bank](https://account-check.example).", props));
      expect(a).toEqual({
        href: "https://account-check.example/",
        target: "_blank",
        rel: "noopener noreferrer nofollow",
        referrer: "no-referrer",
        text: "your bank",
        host: " (account-check.example)",
        name: "your bank (account-check.example) , new tab",
        className: "bk-plink",
      });
    });
  }

  test("1. the href and the host come from the one verdict", () => {
    const url = "https://records.harbour-master.ithaca.gov.example:8443/notices";
    const verdict = classifyLink(url);
    if (!verdict.ok) throw new Error("fixture refused");
    const [a] = anchors(html(`the [pass notice](${url})`));
    expect(a!.href).toBe(verdict.href);
    expect(a!.host).toBe(` (${verdict.host})`);
  });

  test("the host breaks only after a dot", () => {
    const markup = html("the [pass notice](https://records.harbour-master.ithaca.gov.example:8443/notices)");
    const host = doc(markup).querySelector(".bk-plink-host")!;
    const labels = [...host.querySelectorAll(".bk-plink-label")].map((label) => label.textContent);
    expect(labels).toEqual(["(records.", "harbour-master.", "ithaca.", "gov.", "example:8443)"]);
    // A break opportunity between labels, and nowhere else.
    expect(host.querySelectorAll("wbr")).toHaveLength(labels.length - 1);
    expect(host.innerHTML.replace(/<span class="bk-plink-label">([^<]*)<\/span>/g, "$1")).toBe(
      " (records.<wbr>harbour-master.<wbr>ithaca.<wbr>gov.<wbr>example:8443)"
    );
  });

  test("8. an IDN shows its ASCII host and nothing that reads as Unicode", () => {
    const [a] = anchors(html("[Book XII](https://bücher.example/odyssey/12)"));
    expect(a!.host).toBe(" (xn--bcher-kva.example)");
    expect(a!.name).not.toContain("reads as");
    expect(a!.host).not.toContain("ü");
  });

  test("the markdown title is not carried into a hover-only tooltip", () => {
    const markup = html('[your bank](https://account-check.example "Goes to yourbank.example")');
    expect(markup).not.toContain("yourbank.example");
    expect(markup).not.toContain("title=");
  });

  test("a reference link takes its definition's address", () => {
    const [a] = anchors(html("See [the tides][t].\n\n[t]: https://ithaca-harbour.example/tides"));
    expect(a).toMatchObject({ href: "https://ithaca-harbour.example/tides", host: " (ithaca-harbour.example)" });
  });
});

describe("the redundancy rule (§2)", () => {
  test("9. the suffix is dropped when the text already is the destination", () => {
    for (const md of [
      "see https://x.example/a now", // autolink, t === v.href
      "[https://x.example](https://x.example)", // clause 2
      "see www.x.example now", // clause 3, autolink
      "[x.example](https://x.example/deep)", // clause 3
    ]) {
      const found = anchors(html(md));
      expect(found).toHaveLength(1);
      expect({ md, host: found[0]!.host }).toEqual({ md, host: null });
    }
  });

  test("10. the suffix stays whenever the text is anything else", () => {
    for (const md of [
      "[https://paypal.com](https://account-check.example)",
      "[HTTPS://X.EXAMPLE](https://x.example)",
      "see https://bücher.example now",
      "[`x.example`](https://x.example)",
      "[x.example ](https://x.example)",
      "[https://x.example/](https://x.example/?q)",
    ]) {
      const found = anchors(html(md));
      expect(found).toHaveLength(1);
      expect({ md, host: found[0]!.host }).toEqual({ md, host: expect.stringMatching(/^ \(.+\)$/) });
    }
  });

  test("11. nothing but the anchor text meeting §2 changes or removes the host", () => {
    const hrefs = ["https://account-check.example/", "https://x.example/deep?q=1", "https://bücher.example/", "http://10.0.0.1:8080/"];
    const titles = [
      "your bank",
      "paypal.com",
      "(paypal.com)",
      "x.example)",
      "`x.example`",
      "account-check.example ",
      "xn--bcher-kva.example",
      "bücher.example",
      "10.0.0.1:8080",
      "https://x.example/deep?q=1",
    ];
    let dropped = 0;
    for (const href of hrefs) {
      const verdict = classifyLink(href);
      if (!verdict.ok) throw new Error(`fixture refused: ${href}`);
      for (const title of titles) {
        const [a] = anchors(html(`[${title}](${href})`));
        expect(a!.href).toBe(verdict.href);
        if (a!.host === null) {
          dropped++;
          // Only §2 may drop it, and §2 is about what the reader already sees.
          expect(sameDestination(a!.text, verdict)).toBe(true);
        } else {
          expect(a!.host).toBe(` (${verdict.host})`);
        }
      }
    }
    // The fuzz reaches the drop branch, or it proves nothing about it.
    expect(dropped).toBeGreaterThan(0);
  });
});

describe("mailto:", () => {
  test("4. a mail link keeps its anchor, shows its address, and opens no tab", () => {
    const [a] = anchors(html("write to [Penelope](mailto:penelope@ithaca.example?subject=Supplies&bcc=x@y.example)"));
    expect(a).toEqual({
      href: "mailto:penelope@ithaca.example",
      target: null,
      rel: "noopener noreferrer nofollow",
      referrer: "no-referrer",
      text: "Penelope",
      host: " (penelope@ithaca.example)",
      name: "Penelope (penelope@ithaca.example) , email",
      className: "bk-plink",
    });
  });

  test("an email autolink is its own address, so it has no suffix", () => {
    const [a] = anchors(html("write to penelope@ithaca.example today"));
    expect(a).toMatchObject({ href: "mailto:penelope@ithaca.example", host: null, name: "penelope@ithaca.example , email" });
    // The text `mailto:…` is not the address, so it keeps the suffix.
    expect(anchors(html("[mailto:penelope@ithaca.example](mailto:penelope@ithaca.example)"))[0]!.host).toBe(
      " (penelope@ithaca.example)"
    );
  });

  test("a mail link with a hidden or bidi character is inert", () => {
    const markup = html("write to [Penelope](mailto:penelope@ithaca.example&#x202E;)");
    expect(anchors(markup)).toEqual([]);
    expect(withheld(markup)).toEqual([
      { text: "Penelope", marker: " [link withheld — the address contains invisible or direction-changing characters]" },
    ]);
  });
});

describe("refused prose links", () => {
  const CASES: [string, string][] = [
    ["[Crew roster](https://u:p@x.example/roster)", "credentials"],
    ["[Apple](https://аpple.example)", "mixed-script"],
    ["[run](javascript:alert(1))", "scheme"],
    ["[page](data:text/html,hi)", "scheme"],
    ["[chat](xmpp:odysseus@ithaca.example)", "scheme"],
    ["[room](irc://irc.ithaca.example/crew)", "scheme"],
    ["[bidi](https://ithaca.example/&#x202E;fdp.exe)", "hidden-characters"],
    ["[the index](../archive/index)", "relative"],
  ];

  for (const [surface, props] of Object.entries(SURFACES)) {
    test(`12. a refused link is text: no anchor, no role, no href (${surface})`, () => {
      for (const [md] of CASES) {
        const markup = html(`Before ${md} after.`, props);
        expect({ md, anchors: anchors(markup) }).toEqual({ md, anchors: [] });
        expect(markup).not.toContain("role=");
        expect(markup).not.toContain("href=");
        expect(markup).not.toContain("tabindex");
        expect(withheld(markup)).toHaveLength(1);
      }
    });
  }

  test("13. the marker is the reason's sentence in square brackets", () => {
    for (const [md] of CASES) {
      const url = /\]\((.*)\)$/.exec(md)![1]!.replace("&#x202E;", "\u202E");
      const verdict = classifyLink(url);
      if (verdict.ok) throw new Error(`fixture accepted: ${url}`);
      const [w] = withheld(html(md));
      expect({ md, marker: w!.marker }).toEqual({ md, marker: ` [link withheld — ${refusalSentence(verdict)}]` });
    }
    expect(withheld(html("[chat](xmpp:odysseus@ithaca.example)"))[0]!.marker).toBe(
      " [link withheld — only web addresses open from here · this one is xmpp:]"
    );
  });

  test("14. a refusal whose text is the raw address shows the redacted address", () => {
    const [credentials] = withheld(html("[https://u:p@x.example/roster](https://u:p@x.example/roster)"));
    expect(credentials!.text).toBe("https://•••@x.example/roster");
    const [bidi] = withheld(html("[https://x.example/&#x202E;fdp.exe](https://x.example/&#x202E;fdp.exe)"));
    expect(bidi!.text).toBe("https://x.example/⟨U+202E⟩fdp.exe");
    expect(bidi!.text).not.toContain("\u202E");
  });

  test("15. the text of a withheld link is never linkified afterwards", () => {
    const markup = html("[`notes/crew.md` and **notes/ship.md**](xmpp:odysseus@ithaca.example)", { fileLinks: true, entityTags: true });
    expect(anchors(markup)).toEqual([]);
    expect(markup).not.toContain("brain-file-link");
    expect(withheld(markup)[0]!.text).toBe("notes/crew.md and notes/ship.md");
  });
});

describe("repo links are unchanged", () => {
  test("a repo file and a repo directory still open in the viewer", () => {
    const markup = html("see [the note](notes/crew.md) and [the folder](notes/voyages/)");
    const found = [...doc(markup).querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("class")]);
    expect(found).toEqual([
      ["#/files/notes/crew.md", "brain-file-link"],
      ["#/files/notes/voyages/", "brain-file-link brain-file-link--dir"],
    ]);
  });

  test("without fileLinks a repo path is not a site, so it is withheld", () => {
    expect(withheld(html("see [the note](notes/crew.md)", {}))).toHaveLength(1);
  });
});

describe("the streaming answer", () => {
  function answer(content: string, streaming: boolean): string {
    return renderToStaticMarkup(
      <BrainUiProvider root={root}>
        <MarkdownContent content={content} streaming={streaming} />
      </BrainUiProvider>
    );
  }

  test("19. a half-typed autolink is never an anchor while the answer streams", () => {
    const buffer = "Ignore the note from https://account-check.ex";
    expect(anchors(answer(buffer, true))).toEqual([]);
    expect(answer(buffer, true)).not.toContain("https://");
    // Settled, the same text is drawn as it is.
    expect(anchors(answer(buffer, false))).toHaveLength(1);
  });

  test("19. token by token, no frame has an anchor without its host, or a host other than the final one", () => {
    const full = "Ignore the note from [your bank](https://account-check.example) and read on.";
    let drawn = 0;
    for (let i = 1; i <= full.length; i++) {
      const markup = answer(full.slice(0, i), true);
      const text = doc(markup).body.textContent ?? "";
      expect({ i, raw: text.includes("https://") }).toEqual({ i, raw: false });
      for (const a of anchors(markup)) {
        drawn++;
        expect({ i, host: a.host }).toEqual({ i, host: " (account-check.example)" });
      }
    }
    expect(drawn).toBeGreaterThan(0);
    expect(anchors(answer(full, true))).toHaveLength(1);
  });
});
