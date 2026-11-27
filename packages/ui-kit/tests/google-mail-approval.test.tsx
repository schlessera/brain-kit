/**
 * The Gmail approval cards (#4215) as words and markup: a pure function of
 * props. What only a browser can answer (the scroll region and its cue,
 * focus after "+N more", the keys a focused card answers to, the link
 * interstitial, geometry and targets) is in the stories' play functions,
 * `stories/google/GoogleMailApprovalCard.stories.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoogleMailApproval } from "@schlessera/brain-ui-sdk/tool-contracts";

import { L } from "../fixtures/gmail.js";
import {
  DRAFT_ID, EUMAEUS, PENELOPE, PREVIOUS_BODY, fullMessage, hiddenMessage, idOnlyTargets, matchesFor, minimalMessage, promotionTargets, suitorTargets,
  updatedMessage,
} from "../fixtures/gmail-approval.js";
import { ApprovalCard } from "../src/decisions/ApprovalCard.js";
import {
  GoogleMailApprovalCard, type GoogleMailApprovalCardProps, type GoogleMailbox, type GoogleMailMessage,
} from "../src/google/GoogleMailApprovalCard.js";
import {
  GOOGLE_SEND_RECIPIENT_REFUSAL, bodyChanges, bodyHeader, bodySize, deltaLine, deltaText, envelopeSummary, googleApprovalKeys, hiddenSummary,
  lineCount, linesBelow, modifyActions, modifyWords, standingLabel,
} from "../src/google/mail-approval.js";
import type { GmailLabel } from "../src/google/shared.js";

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

const text = (doc: Document) => doc.body.textContent ?? "";
const noop = () => {};

/** Each button's printed label, without its effect chip: the label is the Button's first span. */
const buttonLabels = (doc: Document) => [...doc.querySelectorAll("[data-bk-button]")].map((b) => b.querySelector("span")?.textContent ?? "");

/** Where each needle appears: outside an untrusted field or text block (`unguarded`), or inside one at least once (`guarded`). */
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

const OFFERS = { allowAlways: true, allowForSession: true };
const ARCHIVE = { addLabels: [] as GmailLabel[], removeLabels: [L.inbox] };

const send = (over: Partial<Extract<GoogleMailApprovalCardProps, { operation: "gmail.draft.send" }>> = {}): GoogleMailApprovalCardProps => ({
  operation: "gmail.draft.send",
  tainted: false,
  sendAs: { address: "odysseus@example.com", displayName: "Odysseus" },
  accountAlias: "ithaca",
  message: minimalMessage,
  threadId: null,
  recipientMatches: matchesFor(minimalMessage),
  onAllow: noop,
  onDeny: noop,
  ...over,
});

/** Every irreversible card, each handed a standing offer and a handler it must ignore. */
const IRREVERSIBLE: [name: string, props: GoogleMailApprovalCardProps][] = [
  ["send", { ...send(), offers: OFFERS, onStanding: noop } as unknown as GoogleMailApprovalCardProps],
  ["draft delete", { operation: "gmail.draft.delete", tainted: false, draftId: DRAFT_ID, message: minimalMessage, onAllow: noop, onDeny: noop, offers: OFFERS, onStanding: noop } as unknown as GoogleMailApprovalCardProps],
  ["trash", { operation: "gmail.trash", tainted: false, messages: suitorTargets, onAllow: noop, onDeny: noop, offers: OFFERS, onStanding: noop } as unknown as GoogleMailApprovalCardProps],
  ["irreversible modify", { operation: "gmail.modify", effect: "irreversible", tainted: false, messages: promotionTargets, addLabels: [{ id: "SPAM", name: "SPAM" }], removeLabels: [L.inbox], offers: OFFERS, onStanding: noop, onAllow: noop, onDeny: noop }],
  ["irreversible draft update", { operation: "gmail.draft.save", effect: "irreversible", action: "update", tainted: true, draftId: DRAFT_ID, threadId: null, message: updatedMessage, offers: OFFERS, onStanding: noop, onAllow: noop, onDeny: noop }],
];

/* ── Keys (M4) ──────────────────────────────────────────────────────────── */

describe("the single keys", () => {
  test.each([
    ["reversible", { allow: "a", deny: "d" }],
    ["irreversible", { deny: "d" }],
  ] as const)("a %s card answers to %p", (effect, keys) => {
    expect(googleApprovalKeys(effect)).toEqual(keys);
  });

  test.each(IRREVERSIBLE)("an irreversible %s card prints d on Deny and no key on Allow", (_, props) => {
    const doc = draw(<GoogleMailApprovalCard {...props} shortcuts />);
    const [allow, deny] = buttonLabels(doc);
    expect(deny).toMatch(/ d$/);
    expect(allow).not.toMatch(/ a$/);
    expect(allow).not.toBe("");
  });

  test("a reversible card prints a on Allow and d on Deny", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.modify" effect="reversible" tainted={false} messages={promotionTargets} {...ARCHIVE} shortcuts onAllow={noop} onDeny={noop} />);
    expect(buttonLabels(doc).slice(0, 2)).toEqual(["Archive 12 a", "Don't archive d"]);
  });

  test("without shortcuts no key is printed, and Allow keeps its effect in its name", () => {
    const doc = draw(<GoogleMailApprovalCard {...send()} />);
    expect(buttonLabels(doc).slice(0, 2)).toEqual(["Send email", "Don't send"]);
    expect(doc.querySelector("[data-bk-button]")!.textContent).toBe("Send emailirreversible");
  });
});

/* ── Standing choices ───────────────────────────────────────────────────── */

describe("the standing choice", () => {
  test.each(IRREVERSIBLE)("an irreversible %s card draws no standing choice, even when offered one", (_, props) => {
    const doc = draw(<GoogleMailApprovalCard {...props} />);
    expect(doc.querySelector("[data-kit-approval-actions]"), "the card's decision row is there").not.toBeNull();
    expect(doc.querySelector("[data-google-mail-approval]")!.getAttribute("data-effect")).toBe("irreversible");
    expect([...doc.querySelectorAll("[data-kit-approval-always]")].map((el) => el.textContent)).toEqual([]);
    expect(text(doc)).not.toMatch(/Always allow|for this chat/);
  });

  test("an untainted reversible card offers Always allow, with its note", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.modify" effect="reversible" tainted={false} messages={promotionTargets} {...ARCHIVE} offers={{ allowAlways: true, allowForSession: false }} onStanding={noop} />);
    const always = doc.querySelector("[data-kit-approval-always]")!;
    expect(always.querySelector("[data-bk-button] span")!.textContent).toBe("Always allow archiving");
    expect(always.querySelector("[data-kit-approval-always-note]")!.textContent).toBe("Saved to your Google approvals. Revoke in Settings.");
  });

  test("a tainted reversible card offers the chat allowance, with its note", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.draft.save" effect="reversible" action="create" tainted draftId={null} threadId={null} message={minimalMessage} offers={{ allowAlways: false, allowForSession: true }} onStanding={noop} />);
    const always = doc.querySelector("[data-kit-approval-always]")!;
    expect(always.querySelector("[data-bk-button] span")!.textContent).toBe("Allow saving drafts for this chat");
    expect(always.querySelector("[data-kit-approval-always-note]")!.textContent).toBe("This chat has read others' mail, so this lasts only here: up to 24 hours or 100 messages.");
  });

  test.each([
    ["tainted, offered only Always allow", true, { allowAlways: true, allowForSession: false }],
    ["untainted, offered only the chat allowance", false, { allowAlways: false, allowForSession: true }],
    ["offered nothing", false, { allowAlways: false, allowForSession: false }],
  ] as const)("a reversible card %s draws none", (_, tainted, offers) => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.modify" effect="reversible" tainted={tainted} messages={promotionTargets} {...ARCHIVE} offers={offers} onStanding={noop} />);
    expect(doc.querySelector("[data-kit-approval-actions]")).not.toBeNull();
    expect([...doc.querySelectorAll("[data-kit-approval-always]")].map((el) => el.textContent)).toEqual([]);
  });
});

/* ── The modify's words ─────────────────────────────────────────────────── */

describe("a modify in words", () => {
  const VOYAGE = { id: "Label_3", name: "Voyage" };
  const WITHHELD = { id: "Label_8", name: null };
  test.each([
    ["archive", [], [L.inbox], { tool: "Archive", allow: "Archive 12", deny: "Don't archive" }, ["Removes Inbox from 12 messages."], "archiving"],
    ["unarchive", [L.inbox], [], { tool: "Move to Inbox", allow: "Move 12 to Inbox", deny: "Don't move" }, ["Adds Inbox to 12 messages."], "moving to Inbox"],
    ["mark read", [], [L.unread], { tool: "Mark read", allow: "Mark 12 read", deny: "Don't mark" }, ["Marks 12 messages read."], "marking read"],
    ["mark unread", [L.unread], [], { tool: "Mark unread", allow: "Mark 12 unread", deny: "Don't mark" }, ["Marks 12 messages unread."], "marking unread"],
    ["star", [L.starred], [], { tool: "Star", allow: "Star 12", deny: "Don't star" }, ["Stars 12 messages."], "starring"],
    ["unstar", [], [L.starred], { tool: "Remove star", allow: "Unstar 12", deny: "Don't unstar" }, ["Removes the star from 12 messages."], "removing stars"],
    ["add a label", [VOYAGE], [], { tool: "Add label", allow: "Label 12", deny: "Don't label" }, ["Adds “Voyage” to 12 messages."], "adding “Voyage”"],
    ["remove a label", [], [VOYAGE], { tool: "Remove label", allow: "Unlabel 12", deny: "Don't unlabel" }, ["Removes “Voyage” from 12 messages."], "removing “Voyage”"],
    ["a label whose name was withheld", [WITHHELD], [], { tool: "Add label", allow: "Label 12", deny: "Don't label" }, ["Adds label Label_8 to 12 messages."], "adding label Label_8"],
    ["a mixed delta", [VOYAGE], [L.inbox, L.unread], { tool: "Change labels", allow: "Change 12", deny: "Don't change" },
      ["Removes Inbox from 12 messages.", "Marks 12 messages read.", "Adds “Voyage” to 12 messages."], "archiving, marking read and adding “Voyage”"],
  ] as const)("%s", (_, add, remove, words, lines, gerunds) => {
    const actions = modifyActions(add, remove);
    expect(modifyWords(actions, 12)).toEqual(words);
    expect(actions.map((a) => deltaText(deltaLine(a, 12)))).toEqual([...lines]);
    expect(standingLabel(actions, false)).toBe(`Always allow ${gerunds}`);
    expect(standingLabel(actions, true)).toBe(`Allow ${gerunds} for this chat`);
  });

  test("one message is one message", () => {
    expect(deltaText(deltaLine({ kind: "archive" }, 1))).toBe("Removes Inbox from 1 message.");
    expect(modifyWords([{ kind: "archive" }], 1).allow).toBe("Archive 1");
  });

  test("a system label beyond Inbox, Unread and Starred is named, and changes the verb to Change", () => {
    const actions = modifyActions([{ id: "SPAM", name: "SPAM" }], [{ id: "CATEGORY_PROMOTIONS", name: null }]);
    expect(actions.map((a) => deltaText(deltaLine(a, 3)))).toEqual(["Removes Promotions from 3 messages.", "Adds Spam to 3 messages."]);
    expect(modifyWords(actions, 3).allow).toBe("Change 3");
  });
});

/* ── The envelope ──────────────────────────────────────────────────────── */

describe("the envelope", () => {
  const m = (to: number, cc: number, bcc: number) => {
    const list = (n: number, at: string) => Array.from({ length: n }, (_, i): GoogleMailbox => ({ address: `crew${i}@${at}`, displayName: null }));
    return { to: list(to, "to.example"), cc: list(cc, "cc.example"), bcc: list(bcc, "bcc.example") };
  };
  test.each([
    [1, 0, 0, true, "To 1 · Cc 0 · Bcc 0 — 1 person gets this"],
    [1, 1, 1, true, "To 1 · Cc 1 · Bcc 1 — 3 people get this"],
    [12, 6, 3, true, "To 12 · Cc 6 · Bcc 3 — 21 people get this"],
    [1, 1, 1, false, "To 1 · Cc 1 · Bcc 1"],
  ] as const)("To %i, Cc %i, Bcc %i (sends: %p)", (to, cc, bcc, sends, expected) => {
    expect(envelopeSummary(m(to, cc, bcc), sends)).toBe(expected);
  });

  test("a person on two lines is one person", () => {
    const p = { address: "penelope@example.com", displayName: null };
    expect(envelopeSummary({ to: [p], cc: [{ ...p, address: "Penelope@example.com" }], bcc: [] }, true)).toBe("To 1 · Cc 1 · Bcc 0 — 1 person gets this");
  });

  test("an empty Bcc draws no Bcc row; a non-empty one draws its own emphasised row", () => {
    const without = draw(<GoogleMailApprovalCard {...send()} />);
    expect(without.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 0 · Bcc 0 — 1 person gets this");
    expect([...without.querySelectorAll("[data-google-bcc]")].map((el) => el.textContent)).toEqual([]);
    expect(without.querySelectorAll("[data-google-recipient='bcc']")).toHaveLength(0);
    expect([...without.querySelectorAll(".bk-gma-env > dt")].map((dt) => dt.textContent)).toEqual(["From", "To", "Subject", "In reply to"]);

    const withBcc = draw(<GoogleMailApprovalCard {...send({ message: fullMessage, recipientMatches: matchesFor(fullMessage) })} />);
    expect(withBcc.querySelector("[data-google-bcc]")!.textContent).toBe("Bcc · hidden from the others");
    expect([...withBcc.querySelectorAll("[data-google-recipient='bcc'] [data-untrusted-field]")].map((f) => f.textContent)).toEqual([EUMAEUS.address]);
    expect([...withBcc.querySelectorAll(".bk-gma-env > dt")].map((dt) => dt.textContent)).toEqual(["From", "To", "Cc", "Bcc · hidden from the others", "Reply-To", "Subject", "In reply to"]);
  });

  test("every recipient shows the send-list entry it matched", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ message: fullMessage, recipientMatches: matchesFor(fullMessage) })} />);
    const rows = [...doc.querySelectorAll("[data-google-recipient='to'], [data-google-recipient='cc'], [data-google-recipient='bcc']")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector("[data-google-match]")?.getAttribute("data-google-match") ?? "none")).toEqual(["*@example.com", "*@example.com", "*@example.com"]);
    expect(doc.querySelector("[data-google-recipient='from'] [data-google-match]")!.getAttribute("data-google-match")).toBe("self");
  });

  test("a recipient the host failed to match is drawn as a host bug, not as matched", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ recipientMatches: [] })} />);
    expect(doc.querySelector("[data-google-recipient='to'] [data-google-match-missing]")!.textContent).toBe("not on your send list");
    expect(doc.querySelector("[data-google-recipient='to'] [data-google-match]")).toBeNull();
  });

  test("a Reply-To that is not From says where replies go", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ message: fullMessage, recipientMatches: matchesFor(fullMessage) })} />);
    expect(doc.querySelector("[data-google-replies-elsewhere]")!.textContent).toBe("Replies go here, not to From.");
    const same = draw(<GoogleMailApprovalCard {...send({ message: { ...minimalMessage, replyTo: [{ address: "odysseus@example.com", displayName: null }] } })} />);
    expect(same.querySelectorAll("[data-google-recipient='reply-to']")).toHaveLength(1);
    expect(same.querySelector("[data-google-replies-elsewhere]")).toBeNull();
  });

  test.each([
    ["the thread the host showed", { thread: { subject: "Re: The loom, again", date: { short: "Sat 11 Jul 18:02", full: "Saturday 11 July 2026, 18:02" } } }, "Re: The loom, again · Sat 11 Jul 18:02"],
    ["the In-Reply-To id", { message: { ...minimalMessage, inReplyTo: ["<CAOgygia.loom.5@mail.example.com>"] } }, "<CAOgygia.loom.5@mail.example.com>"],
    ["an existing conversation", { threadId: "19a1a01f10000005" }, "an existing conversation"],
    ["a new conversation", {}, "new conversation"],
  ] as const)("In reply to: %s", (_, over, expected) => {
    const doc = draw(<GoogleMailApprovalCard {...send(over)} />);
    const dts = [...doc.querySelectorAll(".bk-gma-env > dt")];
    const at = dts.findIndex((dt) => dt.textContent === "In reply to");
    expect(at).toBeGreaterThan(0);
    expect(dts[at]!.nextElementSibling!.textContent).toBe(expected);
  });
});

/* ── Hidden characters and untrusted text ───────────────────────────────── */

describe("hidden characters", () => {
  test("in the subject, a display name and the body, each is shown as its marker", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ message: hiddenMessage, recipientMatches: matchesFor(hiddenMessage) })} />);
    const markers = [...doc.querySelectorAll("[data-hidden-char]")].map((el) => el.getAttribute("data-hidden-char"));
    expect(markers).toEqual(["‹U+202E›", "‹U+200B›", "‹U+202E›"]);
    expect(doc.querySelector("[data-google-subject] [data-hidden-char]")!.getAttribute("data-hidden-char")).toBe("‹U+200B›");
    const body = doc.querySelector("[data-google-body] [data-untrusted-text]")!.textContent!;
    expect(body).toContain("Argo‹U+202E›gro");
    expect(body).toContain("harbour‹U+200B›master's house‹U+200B ×3›");
    expect(body).not.toMatch(/[\u{200B}\u{202E}]/u);
    expect(doc.querySelector("[data-google-hidden-summary]")!.textContent).toBe("3 hidden characters in To and Subject are shown as ‹U+…›.");
    expect(doc.querySelector("[data-google-body-header]")!.textContent).toBe("Body · 2 lines · 104 bytes · plain text · 5 hidden characters");
  });

  test("a card with none says nothing about them", () => {
    const doc = draw(<GoogleMailApprovalCard {...send()} />);
    expect(doc.querySelector("[data-google-envelope]")).not.toBeNull();
    expect(doc.querySelector("[data-google-hidden-summary]")).toBeNull();
    expect(doc.querySelectorAll("[data-hidden-char]")).toHaveLength(0);
  });

  test.each([
    [[["Subject", ["a\u{200B}b"]]], "1 hidden character in Subject is shown as ‹U+…›."],
    [[["To", ["x\u{202E}"]], ["Subject", ["\u{200B}\u{200B}"]]], "3 hidden characters in To and Subject are shown as ‹U+…›."],
    [[["To", ["plain"]], ["Subject", [null]]], null],
  ] as const)("the summary of %p", (fields, expected) => {
    expect(hiddenSummary(fields as never)).toBe(expected);
  });
});

describe("untrusted text", () => {
  test("every address, display name, subject, id and body line on a send sits in a field or text block", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ message: fullMessage, recipientMatches: matchesFor(fullMessage) })} />);
    const needles = [PENELOPE.address, "Penelope", "telemachus@example.com", EUMAEUS.address, "steward@ithaca-steward.example", "Re: The loom, again", "<CAOgygia.loom.5@mail.example.com>", "Keep unpicking it at night."];
    expect(containment(doc, needles)).toEqual({ unguarded: [], guarded: needles });
  });

  test("a trashed message's sender and subject sit in fields", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.trash" tainted messages={suitorTargets} />);
    const needles = ["Antinous <antinous@ithaca.example>", "Choose one of us before the wine runs out", "An apology, of sorts"];
    // The third row is past nothing: three messages, all shown.
    expect(containment(doc, needles)).toEqual({ unguarded: [], guarded: needles });
  });

  test("a draft update's change rows are fields too", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.draft.save" effect="reversible" action="update" tainted={false} draftId={DRAFT_ID} threadId={null} message={updatedMessage} previousBody={PREVIOUS_BODY} />);
    const needles = ["I'm still on Ogygia; Calypso won't hear of a raft.", "I've left Ogygia; the raft sails at seven, if the wind holds east."];
    expect(containment(doc, needles)).toEqual({ unguarded: [], guarded: needles });
  });
});

/* ── The body ──────────────────────────────────────────────────────────── */

describe("the body", () => {
  test.each([
    ["", 0],
    ["one", 1],
    ["one\ntwo", 2],
    ["one\r\ntwo\rthree\n", 4],
  ] as const)("lineCount(%p) is %i", (body, n) => {
    expect(lineCount(body)).toBe(n);
  });

  test.each([
    ["a", "1 byte"],
    ["a".repeat(860), "860 bytes"],
    ["a".repeat(1024), "1 KB"],
    ["a".repeat(2150), "2.1 KB"],
    ["é".repeat(600), "1.2 KB"],
  ] as const)("bodySize of %#", (body, size) => {
    expect(bodySize(body)).toBe(size);
  });

  test("the header counts lines, size and kind", () => {
    expect(bodyHeader("one\ntwo")).toBe("Body · 2 lines · 7 bytes · plain text");
  });

  test.each([
    ["at the top of a body twice its view", 41, 1000, 0, 500, 21],
    ["half way", 41, 1000, 250, 500, 11],
    ["one pixel short of the end", 41, 1000, 498, 500, 1],
    ["at the end", 41, 1000, 500, 500, 0],
    ["a body that fits", 5, 200, 0, 200, 0],
    ["no lines", 0, 1000, 0, 500, 0],
  ] as const)("linesBelow %s", (_, total, scrollHeight, scrollTop, clientHeight, n) => {
    expect(linesBelow(total, scrollHeight, scrollTop, clientHeight)).toBe(n);
  });

  test("the scroll region is named for its lines, and the whole body is in it", () => {
    const doc = draw(<GoogleMailApprovalCard {...send()} />);
    const region = doc.querySelector("[data-google-body-region]")!;
    expect(region.getAttribute("aria-label")).toBe("Message body, 5 lines");
    expect(region.getAttribute("role")).toBe("group");
    expect(region.textContent).toContain("I've left Ogygia; the raft sails at seven, if the wind holds east.");
    expect(region.textContent).toContain("O.");
  });
});

describe("a draft update's change", () => {
  test("one changed line, with one line of context each side", () => {
    expect(bodyChanges("a\nb\nc\nd\ne", "a\nb\nX\nd\ne")).toEqual([
      { sign: "…", count: 1 },
      { sign: " ", text: "b" },
      { sign: "-", text: "c" },
      { sign: "+", text: "X" },
      { sign: " ", text: "d" },
      { sign: "…", count: 1 },
    ]);
  });

  test("an added and a removed line", () => {
    expect(bodyChanges("a\nb", "a\nb\nc")).toEqual([{ sign: "…", count: 1 }, { sign: " ", text: "b" }, { sign: "+", text: "c" }]);
    expect(bodyChanges("a\nb\nc", "b\nc")).toEqual([{ sign: "-", text: "a" }, { sign: " ", text: "b" }, { sign: "…", count: 1 }]);
  });

  test("a change in the middle keeps the common lines between", () => {
    expect(bodyChanges("h\nx\nk\ny\nt", "h\nX\nk\nY\nt")).toEqual([
      { sign: " ", text: "h" }, { sign: "-", text: "x" }, { sign: "+", text: "X" }, { sign: " ", text: "k" }, { sign: "-", text: "y" }, { sign: "+", text: "Y" }, { sign: " ", text: "t" },
    ]);
  });

  test("nothing changed", () => {
    expect(bodyChanges("same\ntext", "same\ntext")).toEqual([]);
  });

  test("past the comparison's bound it is still exact: all removed, then all added", () => {
    const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join("\n");
    const rows = bodyChanges(before, after);
    expect(rows).toHaveLength(2400);
    expect(rows[0]).toEqual({ sign: "-", text: "old 0" });
    expect(rows[1199]).toEqual({ sign: "-", text: "old 1199" });
    expect(rows[1200]).toEqual({ sign: "+", text: "new 0" });
  });
});

/* ── The cards' other states ────────────────────────────────────────────── */

describe("the cards", () => {
  test("a tainted card shows the taint banner above the payload", () => {
    const doc = draw(<GoogleMailApprovalCard {...send({ tainted: true })} />);
    const banner = doc.querySelector("[data-kit-approval-top] [data-google-taint-banner]")!;
    expect(banner.textContent).toBe("This chat has read mail or events written by other people. Check this is something you asked for.");
    expect(banner.getAttribute("role")).toBe("note");
    const order = [...doc.querySelectorAll("[data-kit-approval-top], [data-google-envelope]")].map((el) => (el.hasAttribute("data-kit-approval-top") ? "banner" : "envelope"));
    expect(order).toEqual(["banner", "envelope"]);
    const untainted = draw(<GoogleMailApprovalCard {...send()} />);
    expect(untainted.querySelector("[data-google-envelope]")).not.toBeNull();
    expect(untainted.querySelector("[data-google-taint-banner]")).toBeNull();
  });

  test.each([
    ["send", send(), "Send email", "as odysseus@example.com (ithaca)", "Can't be unsent", "Sends email. It cannot be unsent.", ["Send email", "Don't send"]],
    ["draft delete", { operation: "gmail.draft.delete", tainted: false, draftId: DRAFT_ID }, "Delete draft", `draft ${DRAFT_ID}`, "Can't be undone", "Deletes the draft. Brain can't bring it back.", ["Delete draft", "Keep draft"]],
    ["trash", { operation: "gmail.trash", tainted: false, messages: suitorTargets }, "Move to Trash", "3 messages", "Can't be undone", "Moves 3 messages to Trash. Brain can't undo this yet.", ["Move 3 to Trash", "Don't trash"]],
    ["archive", { operation: "gmail.modify", effect: "reversible", tainted: false, messages: promotionTargets, threads: 5, ...ARCHIVE }, "Archive", "12 messages in 5 threads", "Only your mailbox", "Changes only your mailbox. Brain records how to reverse it.", ["Archive 12", "Don't archive"]],
    ["draft create", { operation: "gmail.draft.save", effect: "reversible", action: "create", tainted: false, draftId: null, threadId: null, message: minimalMessage }, "Save draft", "in your drafts", "Only your mailbox", "Changes only your mailbox. Brain records how to reverse it.", ["Save draft", "Don't save"]],
    ["draft reply", { operation: "gmail.draft.save", effect: "reversible", action: "reply", tainted: false, draftId: null, threadId: "19a1a01f10000005", message: minimalMessage }, "Save draft reply", "in your drafts", "Only your mailbox", "Changes only your mailbox. Brain records how to reverse it.", ["Save draft reply", "Don't save"]],
    ["draft update", { operation: "gmail.draft.save", effect: "reversible", action: "update", tainted: false, draftId: DRAFT_ID, threadId: null, message: updatedMessage }, "Update draft", `draft ${DRAFT_ID}`, "Only your mailbox", "Changes only your mailbox. Brain records how to reverse it.", ["Update draft", "Don't update"]],
  ] as const)("%s: head, badge, risk and buttons", (_, props, tool, target, badge, risk, buttons) => {
    const doc = draw(<GoogleMailApprovalCard {...(props as GoogleMailApprovalCardProps)} onAllow={noop} onDeny={noop} />);
    const head = doc.querySelector("[data-kit-approval-card] > div")!;
    // The head is the tool icon, then the tool, the target and the badge.
    expect([...head.querySelectorAll(":scope > span")].slice(1).map((s) => s.textContent)).toEqual([tool, target, badge]);
    expect(doc.querySelector("[data-google-risk]")!.textContent).toBe(risk);
    expect(buttonLabels(doc).slice(0, 2)).toEqual([...buttons]);
  });

  test("a draft delete whose card carries no message shows its id and nothing it doesn't have", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.draft.delete" tainted={false} draftId={DRAFT_ID} />);
    expect(text(doc)).toContain(`draft ${DRAFT_ID}`);
    expect(doc.querySelector("[data-google-envelope]")).toBeNull();
    expect(doc.querySelector("[data-google-body]")).toBeNull();
  });

  test("a draft delete with its message clamps the body behind Show whole draft", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.draft.delete" tainted={false} draftId={DRAFT_ID} message={fullMessage} />);
    expect(doc.querySelector("[data-google-body] .bk-ut-clamp")).not.toBeNull();
    expect(doc.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 1 · Bcc 1");
    expect(doc.querySelectorAll("[data-google-match], [data-google-match-missing]")).toHaveLength(0);
  });

  test("an update says what it replaces and shows the change above the new body", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.draft.save" effect="reversible" action="update" tainted={false} draftId={DRAFT_ID} threadId={null} message={updatedMessage} previousBody={PREVIOUS_BODY} replacedAt={{ short: "11:02", full: "Sunday 12 July 2026 at 11:02" }} />);
    expect(doc.querySelector("[data-google-replaces]")!.textContent).toBe("Replaces the draft saved at 11:02.");
    expect([...doc.querySelectorAll("[data-google-body-changes] [data-sign]")].map((row) => row.getAttribute("data-sign"))).toEqual(["…", " ", "-", "+", " ", "…"]);
    const order = [...doc.querySelectorAll("[data-google-body-changes], [data-google-body]")].map((el) => (el.hasAttribute("data-google-body") ? "body" : "changes"));
    expect(order).toEqual(["changes", "body"]);
  });

  test("the affected list shows five, then +N more", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.modify" effect="reversible" tainted={false} messages={promotionTargets} {...ARCHIVE} />);
    expect(doc.querySelectorAll("[data-google-target]")).toHaveLength(5);
    const more = doc.querySelector("[data-google-targets-more]")!;
    expect(more.textContent).toBe("+7 more");
    expect(more.getAttribute("aria-label")).toBe("Show 7 more messages");
    expect(doc.querySelector("[data-google-targets]")!.getAttribute("aria-label")).toBe("12 messages affected");
    expect(doc.querySelector("[data-google-target]")!.textContent).toBe("Sat 11 Jul\u{a0}·\u{a0}Inbox, Promotions");
  });

  test("a message the card knows only by id shows its id", () => {
    const doc = draw(<GoogleMailApprovalCard operation="gmail.trash" tainted={false} messages={idOnlyTargets} />);
    expect([...doc.querySelectorAll("[data-google-message-id]")].map((el) => el.textContent)).toEqual(idOnlyTargets.map((t) => t.messageId));
    expect(doc.querySelector("[data-google-targets-more]")).toBeNull();
  });

  test("the refusal sentence names no address", () => {
    expect(GOOGLE_SEND_RECIPIENT_REFUSAL).toBe("Not sent: one recipient isn't on your send list.");
  });
});

/* ── ApprovalCard's additive props (M1) ─────────────────────────────────── */

describe("ApprovalCard's additive props", () => {
  test("without them, the standing choice still reads Always allow and nothing sits above the payload", () => {
    const doc = draw(<ApprovalCard tool="Edit" target="talks/lisbon-2026.md" onAllow={noop} onDeny={noop} onAlwaysAllow={noop} shortcuts={{ allow: "a", deny: "d" }} />);
    expect(doc.querySelector("[data-kit-approval-top]")).toBeNull();
    expect(doc.querySelector("[data-kit-approval-always-note]")).toBeNull();
    expect(buttonLabels(doc)).toEqual(["Allow a", "Deny d", "Always allow"]);
    expect(doc.querySelector("[data-kit-approval-always] [data-bk-button]")!.textContent).toBe("Always allowwrite_policy");
  });

  test("top goes between the head and the payload; the standing label and note replace the defaults", () => {
    const doc = draw(
      <ApprovalCard tool="Edit" target="t" diff="" top={<p data-probe="top">first</p>} onAllow={noop} onAlwaysAllow={noop} alwaysLabel="Always allow archiving" alwaysNote="kept">
        <p data-probe="child">payload</p>
      </ApprovalCard>,
    );
    const card = doc.querySelector("[data-kit-approval-card]")!;
    expect([...card.querySelectorAll("[data-probe]")].map((el) => el.getAttribute("data-probe"))).toEqual(["top", "child"]);
    expect(card.children[1]!.hasAttribute("data-kit-approval-top")).toBe(true);
    expect(doc.querySelector("[data-kit-approval-always] [data-bk-button] span")!.textContent).toBe("Always allow archiving");
    expect(doc.querySelector("[data-kit-approval-always-note]")!.textContent).toBe("kept");
  });

  test("a shortcut set with no allow key prints none on Allow and keeps the effect in its name", () => {
    const doc = draw(<ApprovalCard tool="Edit" target="t" allowLabel="Send email" allowEffect="irreversible" onAllow={noop} onDeny={noop} shortcuts={{ deny: "d" }} />);
    const allow = doc.querySelector("[data-bk-button]")!;
    expect(allow.querySelector("span")!.textContent).toBe("Send email");
    expect(allow.getAttribute("aria-label")).toBe("Send email, irreversible");
  });
});

/* ── The payload map (#4216 wires it) ────────────────────────────────────── */

/**
 * #4214's additions to the send card, not on this branch's schema yet
 * (optional, display-only): the account alias and each recipient's match.
 */
type SendCard = Extract<GoogleMailApproval, { operation: "gmail.draft.send" }> & {
  payload: { account_alias?: string; recipient_matches?: { field: "to" | "cc" | "bcc"; address: string; entry: string | null }[] };
};
type Card = Exclude<GoogleMailApproval, { operation: "gmail.draft.send" }> | SendCard;
type ApprovalMessage = Extract<GoogleMailApproval, { operation: "gmail.draft.send" }>["payload"]["message"];

const mailbox = (m: ApprovalMessage["from"]): GoogleMailbox => ({ address: m.address, displayName: m.display_name });
const mail = (m: ApprovalMessage): GoogleMailMessage => ({
  from: mailbox(m.from), to: m.to.map(mailbox), cc: m.cc.map(mailbox), bcc: m.bcc.map(mailbox), replyTo: m.reply_to.map(mailbox),
  subject: m.subject, inReplyTo: m.in_reply_to, body: m.body_text,
});

/**
 * The props-to-payload map, as code the type checker holds to the card
 * schema: a field renamed or retyped in `GoogleMailApproval` fails `tsc` here.
 * Label names, per-message dates and senders, the thread's subject and date,
 * an update's previous body and a deleted draft's message are not in the
 * payload; the host adds them where it has them, and the card draws without.
 */
function fromCard(card: Card): GoogleMailApprovalCardProps {
  const offers = { allowAlways: card.offers.allow_always, allowForSession: card.offers.allow_for_session };
  const label = (id: string): GmailLabel => ({ id, name: null });
  switch (card.operation) {
    case "gmail.draft.send":
      return {
        operation: card.operation, effect: card.effect, tainted: card.tainted, sendAs: mailbox(card.payload.send_as), accountAlias: card.payload.account_alias,
        message: mail(card.payload.message), threadId: card.payload.thread_id, recipientMatches: card.payload.recipient_matches,
      };
    case "gmail.draft.save":
      return {
        operation: card.operation, effect: card.effect, tainted: card.tainted, offers, action: card.payload.action, draftId: card.payload.draft_id,
        threadId: card.payload.thread_id, message: mail(card.payload.message),
      };
    case "gmail.draft.delete":
      return { operation: card.operation, effect: card.effect, tainted: card.tainted, draftId: card.payload.draft_id };
    case "gmail.trash":
      return { operation: card.operation, effect: card.effect, tainted: card.tainted, messages: card.payload.message_ids.map((messageId) => ({ messageId })) };
    case "gmail.modify":
      return {
        operation: card.operation, effect: card.effect, tainted: card.tainted, offers, messages: card.payload.message_ids.map((messageId) => ({ messageId })),
        addLabels: card.payload.add_label_ids.map(label), removeLabels: card.payload.remove_label_ids.map(label),
      };
  }
}

describe("the payload map", () => {
  test("a send card's payload draws as the card it describes", () => {
    const parsed = (m: GoogleMailbox) => ({ address: m.address, local: m.address.split("@")[0]!, domain: m.address.split("@")[1]!, display_name: m.displayName });
    const card: SendCard = {
      operation: "gmail.draft.send", effect: "irreversible", tainted: false, entities: [], offers: { allow_always: false, allow_for_session: false },
      payload: {
        draft_id: DRAFT_ID, thread_id: null, send_as: parsed({ address: "odysseus@example.com", displayName: "Odysseus" }),
        message: {
          digest: "a".repeat(64), bytes: 412, from: parsed(fullMessage.from), to: fullMessage.to.map(parsed), cc: fullMessage.cc.map(parsed), bcc: fullMessage.bcc.map(parsed),
          reply_to: fullMessage.replyTo.map(parsed), subject: fullMessage.subject, in_reply_to: [...fullMessage.inReplyTo], references: [], body_text: fullMessage.body,
        },
        account_alias: "ithaca",
        recipient_matches: matchesFor(fullMessage),
      },
    };
    const doc = draw(<GoogleMailApprovalCard {...fromCard(card)} />);
    expect(doc.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 1 · Bcc 1 — 3 people get this");
    expect(doc.querySelector("[data-kit-approval-card] > div > span:nth-of-type(3)")!.textContent).toBe("as odysseus@example.com (ithaca)");
    expect([...doc.querySelectorAll("[data-google-match]")].map((el) => el.getAttribute("data-google-match"))).toEqual(["self", "*@example.com", "*@example.com", "*@example.com"]);
  });
});
