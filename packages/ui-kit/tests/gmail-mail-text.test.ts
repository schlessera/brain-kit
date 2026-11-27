/**
 * The Gmail components' readings of untrusted mail text (#4209): who an
 * address header names, and where a body's trailing quoted history starts
 * (ruling G3). Layout decisions only; the text itself is never changed.
 */
import { describe, expect, test } from "bun:test";

import { parseUntrusted } from "../src/evidence/untrusted-markdown.js";
import { mailboxLabel, mailboxLabels, readMailbox, splitMailboxes, splitQuotedTail } from "../src/google/mail-text.js";

describe("address headers", () => {
  test("a comma splits mailboxes only outside quotes, angle brackets and comments", () => {
    expect(splitMailboxes('"Laertes, son of Arcesius" <laertes@example.com>, eumaeus@example.com')).toEqual([
      '"Laertes, son of Arcesius" <laertes@example.com>',
      "eumaeus@example.com",
    ]);
    expect(splitMailboxes("Penelope <penelope@example.com> (the queen, at the loom), Eurycleia <eurycleia@example.com>")).toHaveLength(2);
    expect(splitMailboxes('"a \\" , b" <a@example.com>')).toEqual(['"a \\" , b" <a@example.com>']);
    expect(splitMailboxes(" , ,")).toEqual([]);
  });

  test("a mailbox reads as its display name, else its address, else as written", () => {
    expect(readMailbox("Penelope <penelope@example.com>")).toEqual({ name: "Penelope", address: "penelope@example.com" });
    expect(readMailbox('"Laertes, son of Arcesius" <laertes@example.com>')).toEqual({ name: "Laertes, son of Arcesius", address: "laertes@example.com" });
    expect(readMailbox("<argos@example.com>")).toEqual({ name: null, address: "argos@example.com" });
    expect(readMailbox("telemachus@example.com")).toEqual({ name: null, address: "telemachus@example.com" });
    expect(readMailbox("undisclosed-recipients:;")).toEqual({ name: "undisclosed-recipients:;", address: null });
    expect(mailboxLabel("telemachus@example.com")).toBe("telemachus@example.com");
    expect(mailboxLabels("Odysseus <odysseus@example.com>, Eumaeus <eumaeus@example.com>")).toEqual(["Odysseus", "Eumaeus"]);
  });
});

describe("splitQuotedTail (G3)", () => {
  const wrote = "On Fri, 10 Jul 2026 at 07:05, Odysseus <odysseus@example.com> wrote:";

  test("trailing quote blocks fold, with the attribution line before them", () => {
    const body = `Come home before the last of the wool.\n\n${wrote}\n> Tell them it's for Laertes.\n>\n> On Thu, Penelope wrote:\n>> Eurycleia knows.\n`;
    expect(splitQuotedTail(body)).toEqual({
      body: "Come home before the last of the wool.",
      attribution: wrote,
      quoted: "> Tell them it's for Laertes.\n>\n> On Thu, Penelope wrote:\n>> Eurycleia knows.",
    });
  });

  test("an attribution the client wrapped onto two lines is still the attribution", () => {
    const body = "Yes.\n\nOn Fri, 10 Jul 2026 at 07:05, Odysseus\n<odysseus@example.com> wrote:\n> Tell them.";
    expect(splitQuotedTail(body)?.attribution).toBe("On Fri, 10 Jul 2026 at 07:05, Odysseus\n<odysseus@example.com> wrote:");
    expect(splitQuotedTail(body)?.body).toBe("Yes.");
  });

  test("a trailing quote with no attribution folds on its own", () => {
    expect(splitQuotedTail("Agreed.\n\n> Keep unweaving.\n> Tell no one.")).toEqual({ body: "Agreed.", attribution: null, quoted: "> Keep unweaving.\n> Tell no one." });
  });

  test("several trailing quote blocks, blank lines between, fold together", () => {
    expect(splitQuotedTail("Agreed.\n\n> one\n\n> two\n\n")?.quoted).toBe("> one\n\n> two");
  });

  test("a quote with the sender's own words after it stays where it is", () => {
    expect(splitQuotedTail("> Keep unweaving.\n\nI am. Every night.")).toBeNull();
    const body = "Agreed.\n\n> Keep unweaving.\n\nI am.\n\n> Tell no one.";
    expect(splitQuotedTail(body)).toEqual({ body: "Agreed.\n\n> Keep unweaving.\n\nI am.", attribution: null, quoted: "> Tell no one." });
  });

  test("nothing folds when there is no trailing quote, or nothing but the quote", () => {
    expect(splitQuotedTail("Tell them it's for Laertes.")).toBeNull();
    expect(splitQuotedTail("> All of this is quoted.\n> All of it.")).toBeNull();
    expect(splitQuotedTail(`${wrote}\n> Only a quote under an attribution.`)).toBeNull();
    expect(splitQuotedTail("")).toBeNull();
  });

  test("a quote marker inside a code fence is code, not a quote", () => {
    expect(splitQuotedTail("See the log:\n\n```\n> not a quote\n> still code")).toBeNull();
    expect(splitQuotedTail("See:\n\n```\n> code\n```\n\n> a real quote")?.quoted).toBe("> a real quote");
  });

  test("an 'On … wrote:' line that is not right before the quote is the sender's own text", () => {
    const body = "On Tuesday Antinous wrote: nothing.\n\nI am weaving.\n\n> Keep unweaving.";
    expect(splitQuotedTail(body)).toEqual({ body: "On Tuesday Antinous wrote: nothing.\n\nI am weaving.", attribution: null, quoted: "> Keep unweaving." });
  });

  test("what folds is exactly the quote blocks the renderer draws", () => {
    const body = `Come home.\n\n${wrote}\n> Tell them.\n>\n>> Eurycleia knows.`;
    const split = splitQuotedTail(body)!;
    const quoted = parseUntrusted(split.quoted);
    expect(quoted.length, "the renderer draws the folded part as blocks").toBeGreaterThan(0);
    expect(quoted.every((block) => block.type === "quote")).toBe(true);
    expect(parseUntrusted(split.body).some((block) => block.type === "quote")).toBe(false);
    expect(`${split.body}\n\n${split.attribution}\n${split.quoted}`).toBe(body);
  });

  test("Windows line endings read the same", () => {
    expect(splitQuotedTail("Agreed.\r\n\r\n> Keep unweaving.\r\n")?.quoted).toBe("> Keep unweaving.");
  });
});

// Trimming removes mail whitespace only (#4209 review, F3): every character
// the guard reveals reaches `revealInvisibles`, at the edge of a slice too.
describe("trimming keeps what the guard reveals", () => {
  test.each([
    ["a byte-order mark", "\u{FEFF}"],
    ["a line separator", "\u{2028}"],
    ["a paragraph separator", "\u{2029}"],
    ["a no-break space", "\u{00A0}"],
    ["an ideographic space", "\u{3000}"],
  ])("%s before a folded quote stays in the body", (_name, ch) => {
    expect(splitQuotedTail(`Visible${ch}\n\n> quoted`)).toEqual({ body: `Visible${ch}`, attribution: null, quoted: "> quoted" });
  });

  test("a line holding only a hidden character is not blank, so the quote above it does not fold", () => {
    expect(splitQuotedTail("Visible.\n\n> quoted\n\u{FEFF}")).toBeNull();
    expect(splitQuotedTail("Visible.\n\u{2028}\n> quoted")).toEqual({ body: "Visible.\n\u{2028}", attribution: null, quoted: "> quoted" });
  });

  test("a hidden character at the edge of an attribution stays in it", () => {
    expect(splitQuotedTail("Yes.\n\n\u{FEFF}On Fri, Odysseus wrote:\u{2029}\n> Tell them.")?.attribution).toBe("\u{FEFF}On Fri, Odysseus wrote:\u{2029}");
  });

  test("a hidden character at a mailbox's name or address boundary stays with it", () => {
    expect(readMailbox("\u{FEFF}Penelope <penelope@example.com>")).toEqual({ name: "\u{FEFF}Penelope", address: "penelope@example.com" });
    expect(readMailbox("Penelope\u{2028} <\u{2029}penelope@example.com\u{FEFF}>")).toEqual({ name: "Penelope\u{2028}", address: "\u{2029}penelope@example.com\u{FEFF}" });
    expect(readMailbox("Penelope <penelope@example.com>\u{FEFF}")).toEqual({ name: "Penelope <penelope@example.com>\u{FEFF}", address: null });
    expect(readMailbox('"Penelope\u{FEFF}" <penelope@example.com>').name).toBe("Penelope\u{FEFF}");
    expect(splitMailboxes("\u{FEFF}, Odysseus <odysseus@example.com>\u{2028}")).toEqual(["\u{FEFF}", "Odysseus <odysseus@example.com>\u{2028}"]);
    expect(mailboxLabel("\u{FEFF}")).toBe("\u{FEFF}");
  });

  test("ASCII whitespace still trims", () => {
    expect(readMailbox(" \t Penelope \r\n <penelope@example.com> \n")).toEqual({ name: "Penelope", address: "penelope@example.com" });
    expect(splitMailboxes(" a@example.com ,\tb@example.com\n")).toEqual(["a@example.com", "b@example.com"]);
  });
});
