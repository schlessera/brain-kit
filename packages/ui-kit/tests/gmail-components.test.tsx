/**
 * The Gmail components as markup (#4209): a pure function of props. What
 * only a browser can answer (focus, geometry, targets, the interstitial) is
 * in their stories' play functions under `stories/google/`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GmailLabel as SdkLabel, GmailSearchPayload } from "@schlessera/brain-ui-sdk/tool-contracts";

import {
  contentThreads, herdsMessage, hiddenCharsMessage, hiddenCharsThread, L, loomMessages, midQuoteMessage, noBodyMessage, structuredMessages,
  structuredThreads, unreadBudgetMessage,
} from "../fixtures/gmail.js";
import { GitHubDetailSection } from "../src/github/GitHubDetailSection.js";
import { GmailLabels } from "../src/google/GmailLabels.js";
import { GmailMessage, type GmailContentMessage, type GmailDetailState, type GmailStructuredMessage } from "../src/google/GmailMessage.js";
import { GmailResultList, type GmailStructuredThread } from "../src/google/GmailResultList.js";
import { GmailThread } from "../src/google/GmailThread.js";
import { shownLabels, STRUCTURED_LINE, type GmailLabel, type GmailSizeBucket } from "../src/google/shared.js";

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

const text = (doc: Document) => doc.body.textContent ?? "";

/**
 * Where each needle appears: `unguarded` lists every text node holding one
 * outside an untrusted field or text block, `guarded` every needle found at
 * least once inside one. Both together prove containment: a needle that is
 * not on screen at all is missing from `guarded`.
 */
function containment(doc: Document, needles: string[]): { unguarded: string[]; guarded: string[] } {
  const unguarded: string[] = [];
  const guarded = new Set<string>();
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (const needle of needles) {
      if (!value.includes(needle)) continue;
      if ((node.parentElement as Element | null)?.closest("[data-untrusted-field], [data-untrusted-text]")) guarded.add(needle);
      else unguarded.push(needle);
    }
  }
  return { unguarded, guarded: needles.filter((needle) => guarded.has(needle)) };
}

describe("the payload's shapes fit the kit's", () => {
  test("compile-time proof (tsc, not this runner): a ui-sdk label and size bucket type-check as the kit's", () => {
    // The proof is the typecheck: these assignments fail `tsc` if the contract's
    // shapes drift from the kit's. The runtime lines only keep the bindings used.
    const label: GmailLabel = { id: "Label_1", name: "Family" } satisfies SdkLabel;
    type Hit = Extract<GmailSearchPayload, { view: "structured" }>["threads"][number];
    const bucket: GmailSizeBucket | null = (null as unknown as Hit)?.size_bucket ?? null;
    expect(label.id).toBe("Label_1");
    expect(bucket).toBeNull();
  });
});

describe("structured rows show only what the structured view carries (G1)", () => {
  test("no sender, subject, snippet or address appears, and the header says why once", () => {
    const doc = draw(<GmailResultList view="structured" query="category:promotions older_than:30d" threads={structuredThreads} initial={25} />);
    const shown = text(doc);
    expect(doc.querySelectorAll("[data-gmail-row='structured']")).toHaveLength(25);
    expect(doc.querySelectorAll("[data-untrusted-text]")).toHaveLength(0);
    // The only untrusted field is the query the call sent.
    expect([...doc.querySelectorAll("[data-untrusted-field]")].map((n) => n.textContent)).toEqual(["category:promotions older_than:30d"]);
    for (const absent of ["@", "Penelope", "no subject", "sender", "From", "Subject"]) expect(shown).not.toContain(absent);
    expect(shown.split(STRUCTURED_LINE)).toHaveLength(2);
    // Rows do not expand: the only control in a structured row is a label list's "+N".
    const controls = [...doc.querySelectorAll("[data-gmail-row='structured'] button")].map((b) => b.getAttribute("aria-label"));
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.filter((name) => !/^Show \d+ more labels?$/.test(name ?? ""))).toEqual([]);
    expect(doc.querySelectorAll("[data-gmail-row='structured'][tabindex], [data-gmail-row='structured'] [aria-expanded]")).toHaveLength(0);
  });

  test("a structured list handed content-view items still shows nothing a stranger wrote", () => {
    // ui-react maps the payload; if it ever passed content items to the structured view, no row may show their text.
    const doc = draw(<GmailResultList view="structured" threads={contentThreads as unknown as GmailStructuredThread[]} />);
    for (const t of contentThreads) {
      for (const value of Object.values(t.untrusted)) if (value) expect(text(doc)).not.toContain(value.slice(0, 12));
    }
    expect(doc.querySelectorAll("[data-untrusted-field], [data-untrusted-text]")).toHaveLength(0);
  });

  test("a row names the date, the count, the labels as words and the flags as words", () => {
    const doc = draw(<GmailResultList view="structured" threads={structuredThreads.slice(0, 1)} />);
    const row = doc.querySelector("[data-gmail-row='structured']")!;
    expect(row.querySelector("time")!.getAttribute("datetime")).toBe("2026-07-11T18:02:00+02:00");
    expect(row.textContent).toContain("Sat 11 Jul 18:02 · 3 messages");
    expect([...row.querySelectorAll("[data-gmail-label]")].map((n) => n.textContent)).toEqual(["Inbox", "Promotions", "Voyage"]);
    expect(row.querySelector("[data-gmail-flags]")!.textContent).toBe("unread\u{a0}·\u{a0}attachment\u{a0}·\u{a0}under 1 MB");
  });

  test("a flag the payload did not give is not shown as false", () => {
    const sparse: GmailStructuredThread = { threadId: "19a0ff00aa11bb22", labels: [L.inbox], date: null, messageCount: null, sizeBucket: null, unread: null, starred: null, hasAttachment: null };
    const doc = draw(<GmailResultList view="structured" threads={[sparse]} />);
    const row = doc.querySelector("[data-gmail-row='structured']")!;
    expect(row.querySelector("[data-gmail-flags]")).toBeNull();
    expect(row.textContent).toBe("Inbox");
  });

  test("a structured thread and message handed content-view messages still show nothing a stranger wrote", () => {
    // As for the list: if ui-react ever passed content messages to the structured view, no row may show their text.
    const values = loomMessages.flatMap((m) => [m.untrusted.from, m.untrusted.to, m.untrusted.cc, m.untrusted.subject, m.untrusted.snippet, m.untrusted.body, ...m.untrusted.attachments.map((a) => a.filename)]).filter((v): v is string => !!v);
    expect(values.length).toBeGreaterThan(10);
    for (const element of [
      <GmailThread view="structured" messages={loomMessages as unknown as GmailStructuredMessage[]} />,
      <GmailMessage view="structured" message={loomMessages[4] as unknown as GmailStructuredMessage} />,
    ]) {
      const doc = draw(element);
      expect(doc.querySelectorAll("[data-gmail-row='structured']").length).toBeGreaterThan(0);
      for (const value of values) expect(text(doc)).not.toContain(value.slice(0, 12));
      expect(doc.querySelectorAll("[data-untrusted-field], [data-untrusted-text]")).toHaveLength(0);
    }
  });

  test("a structured thread and message carry the G1 line and no text a stranger wrote", () => {
    for (const element of [<GmailThread view="structured" messages={structuredMessages} />, <GmailMessage view="structured" message={structuredMessages[4]!} />]) {
      const doc = draw(element);
      expect(doc.querySelector("[data-gmail-view-line]")!.textContent).toMatch(/^Structured view · dates, labels and counts only\. Brain didn't read th(ese messages|is message)\.$/);
      expect(doc.querySelectorAll("[data-untrusted-field], [data-untrusted-text]")).toHaveLength(0);
      expect(text(doc)).not.toContain("Penelope");
    }
  });
});

describe("content rows", () => {
  test("every sender, subject and snippet sits under an untrusted field", () => {
    const doc = draw(<GmailResultList view="content" query="from:penelope" threads={contentThreads} />);
    const strings = [...new Set(contentThreads.flatMap((t) => [t.untrusted.subject, t.untrusted.snippet, "Penelope", "Eumaeus", "Telemachus", "Calypso"]).filter((s): s is string => !!s))];
    const where = containment(doc, strings);
    expect(where.unguarded).toEqual([]);
    expect(where.guarded, "each one is on screen, inside a field").toEqual(strings);
    expect(text(doc)).toContain("— no subject");
    expect(doc.querySelectorAll("a")).toHaveLength(0);
  });

  test("labels inside a row's button are phrasing content with a count, not a list with a control", () => {
    const doc = draw(<GmailResultList view="content" threads={contentThreads.slice(0, 1)} />);
    const button = doc.querySelector("[data-gmail-row='content'] > button")!;
    expect(button.querySelectorAll("ul, li, button")).toHaveLength(0);
    expect(button.querySelector("[data-gmail-labels='static']")!.textContent).toBe("Labels: InboxFamilyIthaca+1and 1 more label");
    expect(button.getAttribute("aria-label")).toBe("Unread, Penelope, The loom, again, Saturday 11 July 2026, 18:02, 5 messages, has an attachment");
  });

  test("hidden characters in a sender, subject and snippet are shown as named markers", () => {
    const doc = draw(<GmailResultList view="content" threads={[hiddenCharsThread]} />);
    const markers = [...doc.querySelectorAll("[data-hidden-char]")].map((n) => n.getAttribute("data-hidden-char"));
    expect(markers).toEqual(["‹U+200B›", "‹U+202E›", "‹U+200B ×4›", "‹U+E0049›", "‹U+E0047›", "‹U+E004E›", "‹U+E004F›", "‹U+E0052›", "‹U+E0045›"]);
    expect(text(doc)).not.toMatch(/[\u{200B}\u{202E}\u{E0049}]/u);
    expect(doc.querySelector("[data-hidden-char='‹U+202E›'] .bk-sr-only")!.textContent).toBe(" hidden character: right-to-left override ");
    // The row's name says what each marker is, as the field does to a screen reader; never the hex marker.
    const name = doc.querySelector("button")!.getAttribute("aria-label")!;
    expect(name).toContain("Ithaca hidden character: zero-width space Steward, Invoice for the shroud wool hidden character: right-to-left override txt.exe");
    expect(name).not.toContain("‹U+");
  });

  test("an empty search says so and keeps the query", () => {
    const doc = draw(<GmailResultList view="content" query="from:poseidon" threads={[]} />);
    expect(text(doc)).toContain("0 threads");
    expect(text(doc)).toContain("— Gmail found nothing for this search.");
    expect(text(doc)).toContain("from:poseidon");
  });

  test("the footnote says Gmail has more only when the page has a next cursor, and never a total", () => {
    expect(text(draw(<GmailResultList view="structured" threads={structuredThreads.slice(0, 3)} nextPage />))).toContain("Gmail has more matches. Ask Brain for the next page.");
    expect(text(draw(<GmailResultList view="structured" threads={structuredThreads.slice(0, 3)} />))).not.toContain("Gmail has more");
  });
});

describe("labels (G5)", () => {
  test("system labels are words; unread, starred and superstars are flags; user labels follow in order", () => {
    expect(shownLabels([L.family, L.unread, L.inbox, L.starred, L.yellowStar, L.primary, L.ithaca, L.promotions]).map((l) => l.text)).toEqual([
      "Inbox", "Primary", "Promotions", "Family", "Ithaca",
    ]);
  });

  test("three chips, then +N with an accessible name; an escaped name stays escaped; a withheld name shows its id", () => {
    const doc = draw(<GmailLabels labels={[L.inbox, L.family, L.ithaca, L.voyage, L.escaped, L.withheld]} />);
    expect([...doc.querySelectorAll("li[data-gmail-label]")].map((n) => n.textContent)).toEqual(["Inbox", "Family", "Ithaca"]);
    expect(doc.querySelector("button")!.getAttribute("aria-label")).toBe("Show 3 more labels");
    expect(doc.querySelector("button")!.textContent).toBe("+3");
    const all = draw(<GmailLabels labels={[L.escaped, L.withheld]} />);
    expect([...all.querySelectorAll("li[data-gmail-label]")].map((n) => n.textContent)).toEqual(["Suitors \\u{202E}gol", "Label_8"]);
    expect(all.querySelector("[data-gmail-label='Label_8']")!.hasAttribute("data-id-only")).toBe(true);
  });

  test("no colour: every chip is the same neutral chip", () => {
    const doc = draw(<GmailLabels labels={[L.inbox, L.important, L.family]} />);
    expect([...doc.querySelectorAll("li[data-gmail-label]")].every((n) => n.getAttribute("class") === "bk-gm-label" && !n.getAttribute("style"))).toBe(true);
  });
});

describe("thread", () => {
  test("oldest first, the newest open, and four or more earlier messages fold all but the last two", () => {
    const doc = draw(<GmailThread view="content" messages={loomMessages} />);
    expect(doc.querySelector("[data-gmail-fold]")!.textContent).toBe("Show 2 earlier messages");
    expect([...doc.querySelectorAll("[data-gmail-thread-message]")].map((n) => n.getAttribute("data-gmail-thread-message"))).toEqual(["closed", "closed", "open"]);
    expect(doc.querySelector("h3")!.textContent).toBe("The loom, again");
    expect([...doc.querySelectorAll("header [data-gmail-label]")].map((n) => n.textContent)).toEqual(["Inbox", "Sent", "Family"]);
  });

  test("three earlier messages do not fold", () => {
    const doc = draw(<GmailThread view="content" messages={loomMessages.slice(1)} />);
    expect(doc.querySelector("[data-gmail-fold]")).toBeNull();
    expect(doc.querySelectorAll("[data-gmail-thread-message]")).toHaveLength(4);
  });

  test("a trailing quote folds behind Show quoted text; a quote in the middle stays", () => {
    const doc = draw(<GmailMessage view="content" message={loomMessages[4]!} />);
    expect(doc.querySelector("[data-gmail-quoted-toggle]")!.textContent).toBe("···Show quoted text");
    expect(doc.querySelector("[data-gmail-quoted]")!.hasAttribute("hidden")).toBe(true);
    expect(doc.querySelector("[data-gmail-body]")!.textContent).not.toContain("Tell them it's for Laertes");
    const mid = draw(<GmailMessage view="content" message={midQuoteMessage} />);
    expect(mid.querySelector("[data-gmail-quoted-toggle]")).toBeNull();
    expect(mid.querySelector("blockquote")!.textContent).toBe("Keep unweaving.");
  });
});

describe("message body", () => {
  test("a body that holds hidden characters shows each as a marker; the joiner inside an emoji stays", () => {
    const doc = draw(<GmailMessage view="content" message={hiddenCharsMessage} />);
    const body = doc.querySelector("[data-gmail-body]")!.textContent!;
    expect(body).toContain("invoice-‹U+202E›fdp.exe");
    expect(body).toContain("Pay‹U+200B ×5›ment");
    expect(body).toContain("‹U+E0049›‹U+E0047›‹U+E004E›‹U+E004F›‹U+E0052›‹U+E0045›");
    expect(body).toContain("\u{1F9D1}\u{200D}\u{1F33E}");
    expect([...doc.querySelectorAll("[data-gmail-attachments] [data-hidden-char]")].map((n) => n.getAttribute("data-hidden-char"))).toEqual(["‹U+202E›"]);
  });

  test("no text body says so", () => {
    expect(text(draw(<GmailMessage view="content" message={noBodyMessage} />))).toContain("— This message has no text body.");
  });

  test("a cut body says how much Brain read, and the rest is offered with its size", () => {
    const doc = draw(<GmailMessage view="content" message={{ ...herdsMessage, detail: { state: "idle" } }} />);
    expect(doc.querySelector("[data-brain-read]")!.textContent).toBe("Brain read the first 32,768 of 49,152 characters.");
    expect(doc.querySelector("[data-gmail-detail='idle'] [data-bk-button]")!.textContent).toBe("Show the rest · 16,384 characters");
    expect(text(doc)).toContain("Loads from Gmail when you ask. Brain won't see it.");
    expect(doc.querySelector("[data-gmail-quoted-toggle]")).toBeNull();
  });

  test("a message whose thread budget was spent says Brain read none of it", () => {
    const doc = draw(<GmailMessage view="content" message={{ ...unreadBudgetMessage, detail: { state: "idle" } }} />);
    expect(doc.querySelector("[data-brain-read]")!.textContent).toBe("Brain read none of this message's 6,240 characters.");
    expect(doc.querySelector("[data-gmail-body]")).toBeNull();
  });

  test("the rest's loading state is busy and keeps the line", () => {
    const doc = draw(<GmailMessage view="content" message={{ ...herdsMessage, detail: { state: "loading" } }} />);
    expect(doc.querySelector("[data-gmail-detail='loading']")!.getAttribute("aria-busy")).toBe("true");
    expect(doc.querySelector("[data-gmail-detail='loading']")!.getAttribute("aria-label")).toBe("the rest of this message");
    expect(doc.querySelector("[data-brain-read]")!.textContent).toBe("Brain read the first 32,768 of 49,152 characters.");
  });

  test.each<[GmailDetailState, string]>([
    ["error", "Couldn't load the rest of this message. Gmail answered 502."],
    ["rate-limited", "Gmail's request limit is used up. It resets at 07:10 (in 30 min)."],
    ["unavailable", "The rest of this message can't load: Gmail isn't available to this brain right now. What the tool returned is still shown above."],
    ["gone", "Gmail no longer shows this message to this brain (removed, or access changed)."],
  ])("the rest's %s state", (state, copy) => {
    const doc = draw(<GmailMessage view="content" message={{ ...herdsMessage, detail: { state, errorStatus: 502, resetAt: "07:10", resetIn: "30 min" } }} />);
    expect(doc.querySelector(`[data-gmail-detail='${state}']`)).not.toBeNull();
    expect(text(doc)).toContain(copy);
    expect(doc.querySelector("[data-brain-read]")!.textContent).toBe("Brain read the first 32,768 of 49,152 characters.");
  });

  test("the loaded rest is untrusted text after the line, which does not change, under its own rule", () => {
    const doc = draw(<GmailMessage view="content" message={{ ...herdsMessage, detail: { state: "loaded", rest: "Day 400: the last tally." } }} />);
    const rest = doc.querySelector("[data-gmail-rest]")!;
    expect(rest.querySelector("[data-untrusted-text]")!.textContent).toBe("Day 400: the last tally.");
    expect(text(doc)).toContain("Loaded for you · Brain hasn't read this");
    expect(doc.querySelector("[data-brain-read]")!.textContent).toBe("Brain read the first 32,768 of 49,152 characters.");
  });
});

describe("a cut body whose length the payload did not give (F4)", () => {
  const partial = (body: string, bodyLength: number | null): GmailContentMessage => ({
    ...herdsMessage,
    untrusted: { ...herdsMessage.untrusted, body, bodyLength },
    detail: { state: "idle" },
  });
  /** The read line and the rest's button: asserted present, so a body shown as uncut fails here, by name. */
  const cutParts = (doc: Document) => {
    const line = doc.querySelector("[data-brain-read]");
    const rest = doc.querySelector("[data-gmail-detail='idle'] [data-bk-button]");
    expect(line, "the body is shown as cut: a read line").not.toBeNull();
    expect(rest, "the body is shown as cut: the rest is offered").not.toBeNull();
    return { line: line!.textContent, rest: rest!.textContent };
  };

  test.each<[string, number | null]>([
    ["no length", null],
    ["a length no greater than what arrived", 32_768],
    ["a length shorter than what arrived", 100],
  ])("with %s, the explicit cut wins: the read line names no total and the rest is offered without a count", (_name, length) => {
    const doc = draw(<GmailMessage view="content" message={partial(herdsMessage.untrusted.body!, length)} />);
    expect(cutParts(doc)).toEqual({ line: "Brain read the first 32,768 characters of this message.", rest: "Show the rest" });
    expect(text(doc)).toContain("Loads from Gmail when you ask. Brain won't see it.");
    expect(text(doc)).not.toContain("whole message");
  });

  test("a cut body never folds its quote, length or not (D4)", () => {
    const doc = draw(<GmailMessage view="content" message={partial("Come home.\n\n> Tell them it's for Laertes.", null)} />);
    expect(doc.querySelector("[data-gmail-quoted-toggle]")).toBeNull();
    expect(doc.querySelector("[data-gmail-body]")!.textContent).toContain("Tell them it's for Laertes.");
  });

  test("nothing read and no length: Brain read none of it, and it does not claim the message has no body", () => {
    const doc = draw(<GmailMessage view="content" message={partial("", null)} />);
    expect(cutParts(doc)).toEqual({ line: "Brain read none of this message.", rest: "Show the rest" });
    expect(text(doc)).not.toContain("no text body");
    expect(doc.querySelector("[data-gmail-body]")).toBeNull();
  });

  test("a known length is unchanged (D1)", () => {
    const doc = draw(<GmailMessage view="content" message={partial(herdsMessage.untrusted.body!, 49_152)} />);
    expect(cutParts(doc)).toEqual({ line: "Brain read the first 32,768 of 49,152 characters.", rest: "Show the rest · 16,384 characters" });
  });
});

describe("what the guard reveals survives every reading of the text (F3)", () => {
  const message: GmailContentMessage = {
    ...loomMessages[4]!,
    untrusted: {
      ...loomMessages[4]!.untrusted,
      from: "Penelope\u{FEFF} <\u{2028}penelope@example.com>",
      body: "Come home before the last of the wool.\u{FEFF}\n\nOn Fri, 10 Jul 2026 at 07:05, Odysseus <odysseus@example.com> wrote:\n> Tell them it's for Laertes.",
    },
  };

  test("a hidden character just before a folded quote shows a marker in the body", () => {
    const doc = draw(<GmailMessage view="content" message={message} />);
    expect(doc.querySelector("[data-gmail-quoted-toggle]"), "the quote still folds").not.toBeNull();
    expect([...doc.querySelectorAll("[data-gmail-body] > [data-untrusted-text]")].map((n) => n.textContent).join("\n")).toContain("the wool.‹U+FEFF›");
  });

  test("a hidden character at a mailbox's name and address boundaries shows a marker in each", () => {
    const doc = draw(<GmailMessage view="content" message={message} />);
    const markers = [...doc.querySelectorAll("header ~ div [data-untrusted-field] [data-hidden-char]")].map((n) => n.getAttribute("data-hidden-char"));
    expect(markers).toEqual(["‹U+FEFF›", "‹U+2028›"]);
    expect(doc.querySelector("article")!.getAttribute("aria-label")).toBe("Email from Penelope hidden character: zero-width no-break space");
  });

  test("the same holds in a content row's sender", () => {
    const doc = draw(<GmailResultList view="content" threads={[{ ...contentThreads[0]!, untrusted: { ...contentThreads[0]!.untrusted, from: "\u{FEFF}Penelope <penelope@example.com>" } }]} />);
    expect([...doc.querySelectorAll(".bk-gm-grow [data-hidden-char]")].map((n) => n.getAttribute("data-hidden-char"))).toEqual(["‹U+FEFF›"]);
  });
});

describe("GitHubDetailSection after the extraction (G2)", () => {
  test("it still carries data-github-detail and GitHub's own copy", () => {
    const doc = draw(<GitHubDetailSection state="no-credential" noun="commits" object="pull request" idleLabel="Show commits" />);
    expect(doc.querySelector("[data-github-detail='no-credential']")).not.toBeNull();
    expect(doc.querySelector("[data-detail]")).toBeNull();
    expect(text(doc)).toContain("Details can't load: this brain has no GitHub access set up. What the tool returned is still shown above.");
  });
});
