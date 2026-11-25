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
    expect(parseUntrusted(split.quoted).every((block) => block.type === "quote")).toBe(true);
    expect(parseUntrusted(split.body).some((block) => block.type === "quote")).toBe(false);
    expect(`${split.body}\n\n${split.attribution}\n${split.quoted}`).toBe(body);
  });

  test("Windows line endings read the same", () => {
    expect(splitQuotedTail("Agreed.\r\n\r\n> Keep unweaving.\r\n")?.quoted).toBe("> Keep unweaving.");
  });
});
