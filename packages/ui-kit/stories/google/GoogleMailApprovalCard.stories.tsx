import preview from "#.storybook/preview";
import { expect, fn, waitFor, within } from "storybook/test";

import { L } from "../../fixtures/gmail.js";
import {
  CREW_BCC, CREW_CC, CREW_TO, DRAFT_ID, EUMAEUS, PENELOPE, PREVIOUS_BODY, TELEMACHUS, fullMessage, hiddenMessage, idOnlyTargets, linkMessage, longMessage,
  loomThread, manyMessage, matchesFor, minimalMessage, promotionTargets, replyMessage, suitorTargets, updatedMessage,
} from "../../fixtures/gmail-approval.js";
import { GOOGLE_SEND_RECIPIENT_REFUSAL, GoogleMailApprovalCard, type GoogleMailApprovalCardProps } from "../../src/index.js";
import { color, font } from "../../src/tokens.js";
import { stage } from "../_stage.js";
import { Hosted, cardIn, desktop, holds, narrow, noStandingChoice, printed, widthOf } from "./_mail-approval.js";

/**
 * The approval card for one Gmail write (#4215; brief of 2026-11-20, rulings
 * M1–M6 of 2026-11-24). Send, draft save, draft delete, trash and modify, in
 * the taint states and effect classes each can have, at the 680px desktop
 * column and, as `…Narrow`, on a 320px phone. Every story is hosted as
 * ui-react will host it (#4216): a focusable group bound to exactly the keys
 * the card prints.
 */
const meta = preview.meta({
  title: "Google/Mail approval card",
  component: GoogleMailApprovalCard,
  decorators: [stage],
  render: (args) => <Hosted {...(args as GoogleMailApprovalCardProps)} />,
});

const SEND_AS = { address: "odysseus@example.com", displayName: "Odysseus" };
/** Handed to every irreversible card: a host that offers a standing choice anyway. The card must ignore it. */
const OFFER_ANYWAY = { offers: { allowAlways: true, allowForSession: true }, onStanding: fn() };
const ALWAYS = { allowAlways: true, allowForSession: false };
const SESSION = { allowAlways: false, allowForSession: true };

const sendArgs = (message = minimalMessage, rest: Record<string, unknown> = {}) => ({
  operation: "gmail.draft.send" as const,
  tainted: false,
  sendAs: SEND_AS,
  accountAlias: "ithaca",
  message,
  threadId: null,
  recipientMatches: matchesFor(message),
  shortcuts: true,
  onAllow: fn(),
  onDeny: fn(),
  ...OFFER_ANYWAY,
  ...rest,
});

/** The standing choice's handler, which only the reversible props declare. */
const standingSpy = (args: object) => (args as { onStanding?: unknown }).onStanding;

/** The host group: focused, it answers to the card's keys. */
const host = (canvasElement: HTMLElement) => canvasElement.querySelector<HTMLElement>("[data-approval-host]")!;
const allowButton = (card: HTMLElement) => card.querySelector<HTMLElement>("[data-kit-approval-actions] [data-bk-button]")!;

/** Irreversible (M4): `a` neither printed nor bound, `d` both. */
async function irreversibleKeys(canvasElement: HTMLElement, args: { onAllow?: unknown; onDeny?: unknown; shortcuts?: boolean }, userEvent: { keyboard: (keys: string) => Promise<void> }) {
  const card = cardIn(canvasElement);
  const [allow, deny] = printed(card);
  await expect(allow, "Allow prints no key").not.toMatch(/ a$/);
  if (args.shortcuts) await expect(deny, "Deny prints d").toMatch(/ d$/);
  host(canvasElement).focus();
  await userEvent.keyboard("a");
  await expect(args.onAllow, "a does not allow").not.toHaveBeenCalled();
  await userEvent.keyboard("d");
  await expect(args.onDeny, "d denies").toHaveBeenCalledTimes(1);
}

/* ── Send ─────────────────────────────────────────────────────────────── */

/** To only: no Cc, no Bcc row (M2), no Reply-To. The summary still counts Bcc. */
export const SendMinimal = meta.story({
  args: sendArgs(),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, "Penelope", "The raft sails at seven", "Keep unpicking it at night."]);
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 0 · Bcc 0 — 1 person gets this");
    await expect([...card.querySelectorAll(".bk-gma-env > dt")].map((dt) => dt.textContent)).toEqual(["From", "To", "Subject", "In reply to"]);
    await expect(card.querySelector("[data-google-bcc]"), "an empty Bcc has no row").toBeNull();
    await expect(within(card).getByText("Sends email. It cannot be unsent.")).toBeVisible();
    await expect(within(card).getByText("Can't be unsent")).toBeVisible();
    await expect(allowButton(card)).toHaveAccessibleName(args.shortcuts ? "Send email, irreversible" : "Send email irreversible");
    await noStandingChoice(card);
    await irreversibleKeys(canvasElement, args, userEvent);
  },
});
export const SendMinimalNarrow = SendMinimal.extend({ ...narrow });

/** Cc, Bcc and a Reply-To that is not From, in a tainted chat: the banner first, Bcc on its own row. */
export const SendFullEnvelope = meta.story({
  args: sendArgs(fullMessage, { tainted: true }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, TELEMACHUS.address, EUMAEUS.address, "steward@ithaca-steward.example", "Re: The loom, again", "<CAOgygia.loom.5@mail.example.com>"]);
    const card = cardIn(canvasElement);
    const banner = card.querySelector<HTMLElement>("[data-google-taint-banner]")!;
    await expect(banner).toHaveTextContent("This chat has read mail or events written by other people. Check this is something you asked for.");
    await expect(banner.compareDocumentPosition(card.querySelector("[data-google-envelope]")!) & Node.DOCUMENT_POSITION_FOLLOWING, "the banner is read before the payload").toBeTruthy();
    await expect(card.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 1 · Bcc 1 — 3 people get this");
    const bcc = card.querySelector<HTMLElement>("[data-google-bcc]")!;
    await expect(bcc).toBeVisible();
    await expect(bcc.textContent).toBe("Bcc · hidden from the others");
    await expect(bcc.querySelector("svg"), "Bcc carries its glyph, not colour alone").not.toBeNull();
    // At 320px the Bcc label spans the row: it starts at the label column's edge and ends at the value column's.
    const env = card.querySelector<HTMLElement>(".bk-gma-env")!.getBoundingClientRect();
    await expect(Math.round(bcc.getBoundingClientRect().left)).toBe(Math.round(env.left));
    await expect(Math.abs(bcc.getBoundingClientRect().right - env.right)).toBeLessThan(1.5);
    const recipients = [...card.querySelectorAll("[data-google-recipient='to'], [data-google-recipient='cc'], [data-google-recipient='bcc']")];
    await expect(recipients.map((r) => r.querySelector("[data-google-match]")?.textContent ?? "no match"), "every recipient has its match").toEqual(["*@example.com", "*@example.com", "*@example.com"]);
    await expect(card.querySelector("[data-google-replies-elsewhere]")).toHaveTextContent("Replies go here, not to From.");
    await noStandingChoice(card);
  },
});
export const SendFullEnvelopeNarrow = SendFullEnvelope.extend({ ...narrow });

/**
 * A 42-line reply, quoted history and all: it scrolls inside the card, the
 * keyboard reaches it, the cue says how much is left, and Allow is enabled
 * from the start (M3). Native key scrolling is proved in
 * `tests/visual/google-mail-approval.visual.tsx`, where input is real.
 */
export const SendLongBody = meta.story({
  args: sendArgs(longMessage),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), ["Day 17: keep the Great Bear on the left hand", "Sent from the raft"]);
    const card = cardIn(canvasElement);
    const region = card.querySelector<HTMLElement>("[data-google-body-region]")!;
    await expect(region).toHaveAccessibleName("Message body, 42 lines");
    await expect(region.getAttribute("tabindex"), "a scrolling body is a tab stop").toBe("0");
    await expect(region.scrollHeight, "the body is longer than its region").toBeGreaterThan(region.clientHeight + 100);
    await expect(region.clientHeight).toBe(widthOf(parameters) === "narrow" ? 280 : 360);
    const cue = card.querySelector<HTMLElement>("[data-google-more-lines]")!;
    const before = Number(cue.dataset.googleMoreLines);
    await expect(before).toBeGreaterThan(10);
    await expect(cue.textContent).toBe(`↓ ${before} more lines`);
    await expect(card.querySelector("[data-google-body-header]")!.textContent).toMatch(/^Body · 42 lines · \d(\.\d)? KB · plain text$/);
    // Tab from the host's group reaches the body before the buttons.
    host(canvasElement).focus();
    await userEvent.tab();
    await expect(document.activeElement).toBe(region);
    region.scrollTop = region.scrollHeight;
    await waitFor(() => expect(card.querySelector("[data-google-more-lines]"), "the cue goes at the end").toBeNull());
    // M3: no gate. Allow works whether or not the end was reached.
    await expect(allowButton(card).getAttribute("aria-disabled")).toBeNull();
    region.scrollTop = 0;
    await waitFor(() => expect(card.querySelector("[data-google-more-lines]")).not.toBeNull());
    await userEvent.click(allowButton(card));
    await expect(args.onAllow).toHaveBeenCalledTimes(1);
  },
});
export const SendLongBodyNarrow = SendLongBody.extend({ ...narrow });

/** Hidden characters in the subject, a display name and the body: each a visible marker, and a line under the envelope says so. */
export const SendHiddenChars = meta.story({
  args: sendArgs(hiddenMessage),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, "Invoice", "harbour"]);
    const card = cardIn(canvasElement);
    await expect([...card.querySelectorAll("[data-hidden-char]")].map((m) => m.getAttribute("data-hidden-char"))).toEqual(["‹U+202E›", "‹U+200B›", "‹U+202E›"]);
    for (const marker of card.querySelectorAll<HTMLElement>("[data-hidden-char]")) await expect(marker).toBeVisible();
    await expect(card.querySelector("[data-google-hidden-summary]")).toHaveTextContent("3 hidden characters in To and Subject are shown as ‹U+…›.");
    const body = card.querySelector("[data-google-body-region]")!.textContent!;
    await expect(body).toContain("Argo‹U+202E›gro");
    await expect(body).toContain("‹U+200B ×3›");
    await expect(card.querySelector("[data-google-body-header]")!.textContent).toBe("Body · 2 lines · 104 bytes · plain text · 5 hidden characters");
    await expect(card.textContent ?? "", "no raw hidden character reaches the screen").not.toMatch(/[\u{200B}\u{202E}]/u);
  },
});
export const SendHiddenCharsNarrow = SendHiddenChars.extend({ ...narrow });

/** A link in the body is a button that opens the full-address interstitial; nothing navigates. */
export const SendLinkInBody = meta.story({
  args: sendArgs(linkMessage),
  ...desktop,
  play: async ({ canvas, canvasElement, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), ["Read it before you agree"]);
    await expect(cardIn(canvasElement).querySelectorAll("a[href]"), "no anchor on the card").toHaveLength(0);
    const link = canvas.getByRole("button", { name: "tides at Ogygia, outside link to ithaca.example, asks first" });
    link.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await waitFor(() => {
      const open = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]");
      if (!open?.open) throw new Error("the interstitial is not open yet");
      return open;
    });
    await expect(dialog.textContent).toContain("This link was written in this draft. Brain hasn't checked where it goes.");
    await expect(dialog.querySelector("[data-untrusted-gate-address]")!.textContent).toBe("https://tides.ithaca.example/ogygia/july");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(link));
  },
});
export const SendLinkInBodyNarrow = SendLinkInBody.extend({ ...narrow });

/** Twenty-one recipients: every one on its own line with its match, nothing cut, nothing past the edge. */
export const SendManyRecipients = meta.story({
  args: sendArgs(manyMessage),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters), [CREW_TO[11]!.address, CREW_CC[5]!.address, CREW_BCC[2]!.address]);
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 12 · Cc 6 · Bcc 3 — 21 people get this");
    const rows = [...card.querySelectorAll("[data-google-recipient='to'], [data-google-recipient='cc'], [data-google-recipient='bcc']")];
    await expect(rows).toHaveLength(21);
    await expect(rows.filter((r) => !r.querySelector("[data-google-match]")).map((r) => r.textContent), "every recipient has its match").toEqual([]);
  },
});
export const SendManyRecipientsNarrow = SendManyRecipients.extend({ ...narrow });

/* ── Draft save ───────────────────────────────────────────────────────── */

const saveArgs = (rest: Record<string, unknown>) => ({
  operation: "gmail.draft.save" as const,
  effect: "reversible" as const,
  action: "create" as const,
  tainted: false,
  draftId: null,
  threadId: null,
  message: minimalMessage,
  shortcuts: true,
  onAllow: fn(),
  onDeny: fn(),
  onStanding: fn(),
  ...rest,
});

/** A new draft, untainted: reversible, with "Always allow saving drafts" under the buttons. No send-list matches: nothing is sent. */
export const DraftCreate = meta.story({
  args: saveArgs({ offers: ALWAYS }),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, "The raft sails at seven"]);
    const card = cardIn(canvasElement);
    await expect(printed(card)).toEqual(args.shortcuts ? ["Save draft a", "Don't save d"] : ["Save draft", "Don't save"]);
    await expect(card.querySelector("[data-google-envelope-summary]")!.textContent).toBe("To 1 · Cc 0 · Bcc 0");
    await expect(card.querySelectorAll("[data-google-match], [data-google-match-missing]")).toHaveLength(0);
    await expect(within(card).getByText("Changes only your mailbox. Brain records how to reverse it.")).toBeVisible();
    const always = card.querySelector<HTMLElement>("[data-kit-approval-always]")!;
    await expect(within(always).getByRole("button", { name: /^Always allow saving drafts/ })).toBeVisible();
    await expect(always.querySelector("[data-kit-approval-always-note]")).toHaveTextContent("Saved to your Google approvals. Revoke in Settings.");
    // The standing choice is its own row, under the buttons: Allow never grants it.
    await expect(always.getBoundingClientRect().top).toBeGreaterThan(card.querySelector("[data-kit-approval-actions]")!.getBoundingClientRect().bottom);
    await userEvent.click(allowButton(card));
    await expect(args.onAllow).toHaveBeenCalledTimes(1);
    await expect(standingSpy(args)).not.toHaveBeenCalled();
    await userEvent.click(within(always).getByRole("button"));
    await expect(standingSpy(args)).toHaveBeenCalledTimes(1);
  },
});
export const DraftCreateNarrow = DraftCreate.extend({ ...narrow });

/** A reply in a tainted chat: the banner, the thread it replies to, and the chat allowance with what taint means. */
export const DraftReply = meta.story({
  args: saveArgs({ action: "reply", tainted: true, threadId: "19a1a01f10000005", thread: loomThread, message: replyMessage, offers: SESSION }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters), ["Re: The loom, again", "Antinous says the shroud is a story."]);
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-taint-banner]")).not.toBeNull();
    const dts = [...card.querySelectorAll(".bk-gma-env > dt")];
    const reply = dts.find((dt) => dt.textContent === "In reply to")!.nextElementSibling!;
    await expect(reply.textContent).toBe("Re: The loom, again · Sat 11 Jul 18:02");
    const always = card.querySelector<HTMLElement>("[data-kit-approval-always]")!;
    await expect(within(always).getByRole("button", { name: /^Allow saving drafts for this chat/ })).toBeVisible();
    await expect(always.querySelector("[data-kit-approval-always-note]")).toHaveTextContent("This chat has read others' mail, so this lasts only here: up to 24 hours or 100 messages.");
  },
});
export const DraftReplyNarrow = DraftReply.extend({ ...narrow });

/** An update: what it replaces, the change in the body, then the whole new body. */
export const DraftUpdate = meta.story({
  args: saveArgs({ action: "update", draftId: DRAFT_ID, message: updatedMessage, previousBody: PREVIOUS_BODY, replacedAt: { short: "11:02", full: "Sunday 12 July 2026 at 11:02" }, offers: ALWAYS }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters), ["I'm still on Ogygia; Calypso won't hear of a raft.", "I've left Ogygia; the raft sails at seven, if the wind holds east."]);
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-replaces]")).toHaveTextContent("Replaces the draft saved at 11:02.");
    const rows = [...card.querySelectorAll<HTMLElement>("[data-google-body-changes] [data-sign]")];
    await expect(rows.map((r) => r.dataset.sign)).toEqual(["…", " ", "-", "+", " ", "…"]);
    await expect(rows[2]!.textContent).toContain("I'm still on Ogygia");
    await expect(rows[3]!.textContent).toContain("I've left Ogygia");
    await expect(card.querySelector("[data-google-body-changes]")!.compareDocumentPosition(card.querySelector("[data-google-body]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  },
});
export const DraftUpdateNarrow = DraftUpdate.extend({ ...narrow });

/**
 * An update the host classified irreversible (a draft Brain didn't write, or
 * one changed since): the irreversible column, so no standing choice and no
 * `a`, even with an offer handed in.
 */
export const DraftUpdateIrreversible = meta.story({
  args: saveArgs({ effect: "irreversible", action: "update", tainted: true, draftId: DRAFT_ID, message: updatedMessage, offers: { allowAlways: true, allowForSession: true } }),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), ["I've left Ogygia"]);
    const card = cardIn(canvasElement);
    await expect(within(card).getByText("Can't be undone")).toBeVisible();
    await expect(within(card).getByText("Replaces the draft as it is now. Brain can't bring it back.")).toBeVisible();
    await noStandingChoice(card);
    await irreversibleKeys(canvasElement, args, userEvent);
  },
});
export const DraftUpdateIrreversibleNarrow = DraftUpdateIrreversible.extend({ ...narrow });

/* ── Draft delete ─────────────────────────────────────────────────────── */

const deleteArgs = (rest: Record<string, unknown>) => ({
  operation: "gmail.draft.delete" as const,
  tainted: false,
  draftId: DRAFT_ID,
  shortcuts: true,
  onAllow: fn(),
  onDeny: fn(),
  ...OFFER_ANYWAY,
  ...rest,
});

/** The draft about to go, when the host shows it: its envelope, and its body clamped to six lines behind "Show whole draft". */
export const DraftDelete = meta.story({
  args: deleteArgs({ message: { ...longMessage, cc: [TELEMACHUS] } }),
  ...desktop,
  play: async ({ canvas, canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, "Penelope,"]);
    const card = cardIn(canvasElement);
    await expect(printed(card)[0]).toMatch(/^Delete draft$/);
    await expect(within(card).getByText("Deletes the draft. Brain can't bring it back.")).toBeVisible();
    await expect(card.querySelectorAll("[data-google-match], [data-google-match-missing]")).toHaveLength(0);
    await noStandingChoice(card);
    const field = card.querySelector<HTMLElement>("[data-google-body] .bk-ut")!;
    await expect(field.classList.contains("bk-ut-clamp"), "the body is clamped").toBe(true);
    await expect(field.hasAttribute("data-cut"), "and cut: there is more than six lines").toBe(true);
    await expect(Math.round(field.getBoundingClientRect().height / parseFloat(getComputedStyle(field).lineHeight))).toBe(6);
    await expect(canvas.getByRole("button", { name: "Show whole draft" })).toBeVisible();
    await irreversibleKeys(canvasElement, args, userEvent);
  },
});
export const DraftDeleteNarrow = DraftDelete.extend({ ...narrow });

/** "Show whole draft" un-clamps in place: the whole draft is on the card before it goes. */
export const DraftDeleteExpanded = meta.story({
  args: deleteArgs({ message: { ...longMessage, cc: [TELEMACHUS] } }),
  ...desktop,
  play: async ({ canvas, canvasElement, parameters, userEvent }) => {
    const card = cardIn(canvasElement);
    const field = card.querySelector<HTMLElement>("[data-google-body] .bk-ut")!;
    await userEvent.click(canvas.getByRole("button", { name: "Show whole draft" }));
    await waitFor(() => expect(field.classList.contains("bk-ut-clamp")).toBe(false));
    await expect(field.scrollHeight, "the whole draft shows").toBeLessThanOrEqual(field.clientHeight + 1);
    await expect(within(card).getByText(/Sent from the raft/)).toBeVisible();
    await holds(canvasElement, widthOf(parameters), [PENELOPE.address, "Sent from the raft"]);
  },
});
export const DraftDeleteExpandedNarrow = DraftDeleteExpanded.extend({ ...narrow });

/** What today's delete card carries: the draft's id only. Tainted: the banner shows on an irreversible card too. */
export const DraftDeleteIdOnly = meta.story({
  args: deleteArgs({ tainted: true }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-taint-banner]")).not.toBeNull();
    await expect(within(card).getByText(`draft ${DRAFT_ID}`)).toBeVisible();
    await expect(card.querySelector("[data-google-envelope]")).toBeNull();
    await noStandingChoice(card);
  },
});
export const DraftDeleteIdOnlyNarrow = DraftDeleteIdOnly.extend({ ...narrow });

/* ── Trash ────────────────────────────────────────────────────────────── */

const trashArgs = (rest: Record<string, unknown>) => ({
  operation: "gmail.trash" as const,
  tainted: false,
  messages: suitorTargets,
  shortcuts: true,
  onAllow: fn(),
  onDeny: fn(),
  ...OFFER_ANYWAY,
  ...rest,
});

/** Three messages to Trash: who wrote them and what about, each in a field. Irreversible until its inverse is proven. */
export const Trash3 = meta.story({
  args: trashArgs({}),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), ["Antinous <antinous@ithaca.example>", "Choose one of us before the wine runs out", "An apology, of sorts"]);
    const card = cardIn(canvasElement);
    await expect(printed(card)[0]).toBe("Move 3 to Trash");
    await expect(within(card).getByText("Moves 3 messages to Trash. Brain can't undo this yet.")).toBeVisible();
    await expect(card.querySelectorAll("[data-google-target]")).toHaveLength(3);
    await expect(card.querySelector("[data-google-targets-more]")).toBeNull();
    await noStandingChoice(card);
    await irreversibleKeys(canvasElement, args, userEvent);
  },
});
export const Trash3Narrow = Trash3.extend({ ...narrow });

/** What today's trash card carries for each message, its id, in a tainted chat. */
export const TrashIdsOnlyTainted = meta.story({
  args: trashArgs({ tainted: true, messages: idOnlyTargets }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-taint-banner]")).not.toBeNull();
    await expect([...card.querySelectorAll("[data-google-message-id]")].map((el) => el.textContent)).toEqual(idOnlyTargets.map((t) => t.messageId));
    await noStandingChoice(card);
  },
});
export const TrashIdsOnlyTaintedNarrow = TrashIdsOnlyTainted.extend({ ...narrow });

/* ── Modify ───────────────────────────────────────────────────────────── */

const modifyArgs = (rest: Record<string, unknown>) => ({
  operation: "gmail.modify" as const,
  effect: "reversible" as const,
  tainted: false,
  messages: promotionTargets,
  threads: 5,
  addLabels: [],
  removeLabels: [L.inbox],
  shortcuts: true,
  onAllow: fn(),
  onDeny: fn(),
  onStanding: fn(),
  ...rest,
});

/** Archive twelve, untainted: the delta in words, five rows and "+7 more", `a` bound, and "Always allow archiving". */
export const ModifyArchive12 = meta.story({
  args: modifyArgs({ offers: ALWAYS }),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect(within(card).getByText("12 messages in 5 threads")).toBeVisible();
    await expect(within(card).getByText("Only your mailbox")).toBeVisible();
    await expect([...card.querySelectorAll("[data-google-delta]")].map((p) => p.textContent)).toEqual(["Removes Inbox from 12 messages."]);
    await expect(card.querySelectorAll("[data-google-target]")).toHaveLength(5);
    await expect(within(card).getByRole("button", { name: "Show 7 more messages" })).toHaveTextContent("+7 more");
    await expect(printed(card)).toEqual(args.shortcuts ? ["Archive 12 a", "Don't archive d"] : ["Archive 12", "Don't archive"]);
    await expect(allowButton(card)).toHaveAccessibleName(args.shortcuts ? "Archive 12, reversible" : "Archive 12 reversible");
    const always = card.querySelector<HTMLElement>("[data-kit-approval-always]")!;
    await expect(within(always).getByRole("button", { name: /^Always allow archiving/ })).toBeVisible();
    host(canvasElement).focus();
    await userEvent.keyboard("a");
    await expect(args.onAllow, "a reversible card's a allows").toHaveBeenCalledTimes(1);
    await expect(standingSpy(args)).not.toHaveBeenCalled();
  },
});
export const ModifyArchive12Narrow = ModifyArchive12.extend({ ...narrow });

/** The same archive in a tainted chat: the banner, and the chat allowance instead of Always allow. */
export const ModifyArchive12Tainted = meta.story({
  args: modifyArgs({ tainted: true, offers: SESSION }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect(card.querySelector("[data-google-taint-banner]")).not.toBeNull();
    const always = card.querySelector<HTMLElement>("[data-kit-approval-always]")!;
    await expect(within(always).getByRole("button", { name: /^Allow archiving for this chat/ })).toBeVisible();
    await expect(always.querySelector("[data-kit-approval-always-note]")).toHaveTextContent("This chat has read others' mail, so this lasts only here: up to 24 hours or 100 messages.");
    await expect(card.textContent ?? "").not.toMatch(/Always allow/);
  },
});
export const ModifyArchive12TaintedNarrow = ModifyArchive12Tainted.extend({ ...narrow });

/** "+7 more" opens the whole list in place, and focus moves to the first row it revealed. */
export const ModifyArchive12Expanded = meta.story({
  args: modifyArgs({ offers: ALWAYS }),
  ...desktop,
  play: async ({ canvasElement, parameters, userEvent }) => {
    const card = cardIn(canvasElement);
    const more = within(card).getByRole("button", { name: "Show 7 more messages" });
    more.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(card.querySelectorAll("[data-google-target]")).toHaveLength(12));
    const rows = [...card.querySelectorAll<HTMLElement>("[data-google-target]")];
    await waitFor(() => expect(document.activeElement, "focus is on the sixth row").toBe(rows[5]));
    await expect(card.querySelector("[data-google-targets-more]")).toBeNull();
    await holds(canvasElement, widthOf(parameters));
  },
});
export const ModifyArchive12ExpandedNarrow = ModifyArchive12Expanded.extend({ ...narrow });

/** Several changes at once: one line per change, "Change 4", and one standing choice naming all three. */
export const ModifyMixedDelta = meta.story({
  args: modifyArgs({ tainted: true, offers: SESSION, messages: promotionTargets.slice(0, 4), threads: null, addLabels: [L.voyage], removeLabels: [L.inbox, L.unread] }),
  ...desktop,
  play: async ({ canvasElement, args, parameters }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect([...card.querySelectorAll("[data-google-delta]")].map((p) => p.textContent)).toEqual(["Removes Inbox from 4 messages.", "Marks 4 messages read.", "Adds “Voyage” to 4 messages."]);
    await expect(printed(card)).toEqual(args.shortcuts ? ["Change 4 a", "Don't change d"] : ["Change 4", "Don't change"]);
    await expect(within(card).getByText("4 messages")).toBeVisible();
    await expect(within(card.querySelector<HTMLElement>("[data-kit-approval-always]")!).getByRole("button", { name: /^Allow archiving, marking read and adding “Voyage” for this chat/ })).toBeVisible();
  },
});
export const ModifyMixedDeltaNarrow = ModifyMixedDelta.extend({ ...narrow });

/** Add a label to messages the card knows only by id: the standing choice names the label. */
export const ModifyAddLabel = meta.story({
  args: modifyArgs({ offers: ALWAYS, messages: idOnlyTargets, threads: null, addLabels: [L.voyage], removeLabels: [] }),
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holds(canvasElement, widthOf(parameters));
    const card = cardIn(canvasElement);
    await expect([...card.querySelectorAll("[data-google-delta]")].map((p) => p.textContent)).toEqual(["Adds “Voyage” to 4 messages."]);
    await expect(printed(card)[0]).toMatch(/^Label 4( a)?$/);
    await expect(within(card.querySelector<HTMLElement>("[data-kit-approval-always]")!).getByRole("button", { name: /^Always allow adding “Voyage”/ })).toBeVisible();
  },
});
export const ModifyAddLabelNarrow = ModifyAddLabel.extend({ ...narrow });

/** A modify the host classified irreversible (a system label like Spam): the irreversible column, no standing choice, no `a`. */
export const ModifyIrreversible = meta.story({
  args: modifyArgs({ effect: "irreversible", offers: { allowAlways: true, allowForSession: true }, messages: suitorTargets, threads: null, addLabels: [{ id: "SPAM", name: "SPAM" }], removeLabels: [L.inbox] }),
  ...desktop,
  play: async ({ canvasElement, args, parameters, userEvent }) => {
    await holds(canvasElement, widthOf(parameters), ["Antinous <antinous@ithaca.example>"]);
    const card = cardIn(canvasElement);
    await expect([...card.querySelectorAll("[data-google-delta]")].map((p) => p.textContent)).toEqual(["Removes Inbox from 3 messages.", "Adds Spam to 3 messages."]);
    await expect(within(card).getByText("Can't be undone")).toBeVisible();
    await expect(within(card).getByText("Changes system labels. Brain can't undo this.")).toBeVisible();
    await noStandingChoice(card);
    await irreversibleKeys(canvasElement, args, userEvent);
  },
});
export const ModifyIrreversibleNarrow = ModifyIrreversible.extend({ ...narrow });

/* ── The refusal (M6) ─────────────────────────────────────────────────── */

/**
 * A recipient off the send list never reaches a card: the host refuses
 * first. This is the sentence the tool row shows instead (#4216), drawn here
 * as plain text so it can be read and signed off. It names no address.
 */
export const SendRefusalCopy = meta.story({
  ...desktop,
  render: () => (
    <div data-google-mail-approval="refusal" style={{ width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: `500 9px/1.4 ${font.mono}`, letterSpacing: ".08em", textTransform: "uppercase", color: color.inkMute }}>Tool row error · brain_google_gmail_send</span>
      <p style={{ margin: 0, font: `400 12.5px/1.5 ${font.body}`, color: color.ink }} data-google-refusal="">
        {GOOGLE_SEND_RECIPIENT_REFUSAL}
      </p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const line = canvasElement.querySelector<HTMLElement>("[data-google-refusal]")!;
    await expect(line).toBeVisible();
    await expect(line.textContent).toBe("Not sent: one recipient isn't on your send list.");
    await expect(line.textContent).not.toContain("@");
  },
});
export const SendRefusalCopyNarrow = SendRefusalCopy.extend({ ...narrow });
