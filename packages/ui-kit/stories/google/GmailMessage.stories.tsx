import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn, waitFor } from "storybook/test";

import {
  clampedMessage, herdsMessage, herdsRest, hiddenCharsMessage, L, linkMessage, loomMessages, noBodyMessage, spartaMessages, structuredMessages, UNBROKEN_ADDRESS, UNBROKEN_FILENAME,
  unbrokenMessage, unreadBudgetMessage,
} from "../../fixtures/gmail.js";
import { GmailMessage, type GmailBodyDetail, type GmailContentMessage, type GmailDetailState } from "../../src/google/GmailMessage.js";
import { STRUCTURED_LINE_ONE } from "../../src/google/shared.js";
import { stage } from "../_stage.js";
import { cards, desktop, holdsTogether, narrow, widthOf } from "./_gmail.js";

/**
 * One Gmail message (#4209; brief §3, §4, §6; rulings G2–G4). The body is
 * what the model saw, behind a provenance rule. When the payload cut it, one
 * line says how much Brain read, and the rest loads on demand through the
 * detail section GitHub uses, in its idle, loading, loaded, error,
 * rate-limited, unavailable and gone states.
 */
const meta = preview.meta({
  title: "Gmail/GmailMessage",
  component: GmailMessage,
  decorators: [stage],
  args: { view: "content", message: spartaMessages[0]! },
});

const READ_LINE = "Brain read the first 32,768 of 49,152 characters.";

/** The body a removed control hands focus to: a labelled group that takes focus from script only. */
const bodyRegion = (canvasElement: HTMLElement) => canvasElement.querySelector<HTMLElement>("[data-gmail-message-body]")!;

const cut = (state: GmailDetailState, extra: Partial<GmailBodyDetail> = {}): GmailContentMessage => ({
  ...herdsMessage,
  detail: { state, onLoad: fn(), onRetry: fn(), ...extra },
});

/** A short message: sender, address, recipients, body. */
const short: GmailContentMessage = {
  ...spartaMessages[0]!,
  untrusted: { ...spartaMessages[0]!.untrusted, body: "Nestor sent me on with a chariot and his son. I will write from Sparta." },
};

export const Short = meta.story({
  args: { view: "content", message: short },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByRole("article", { name: "Email from Telemachus" })).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Leaving for Sparta" })).toBeVisible();
    await expect(canvasElement.querySelector("[data-gmail-recipients]")!.textContent).toBe("to Odysseus · cc Penelope");
    await expect(canvas.queryByRole("button", { name: /Show whole message/ }), "a short body is not clamped").toBeNull();
    await expect(canvasElement.querySelector("[data-brain-read]"), "an uncut body has no read line").toBeNull();
  },
});
export const ShortNarrow = Short.extend({ ...narrow });

/**
 * A long body: six lines on desktop, four on a phone, then "Show whole
 * message", which un-clamps in place. The button goes with the clamp, so
 * focus moves to the message body, where the text now continues.
 */
export const Clamped = meta.story({
  args: { view: "content", message: clampedMessage },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const field = canvasElement.querySelector<HTMLElement>("[data-gmail-body] .bk-ut")!;
    const line = parseFloat(getComputedStyle(field).lineHeight);
    await expect(Math.round(field.getBoundingClientRect().height / line)).toBe(widthOf(parameters) === "narrow" ? 4 : 6);
    const expand = canvas.getByRole("button", { name: "Show whole message" });
    expand.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(field.classList.contains("bk-ut-clamp")).toBe(false));
    await expect(canvas.getByText(/asked for a cup instead/)).toBeVisible();
    await waitFor(() => expect(document.activeElement, "focus moves to the message body").toBe(bodyRegion(canvasElement)));
    await expect(document.activeElement).toHaveAccessibleName("Message body");
    await expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
  },
});
export const ClampedNarrow = Clamped.extend({ ...narrow });

/** A link in the body is a button that asks first; only the interstitial's Open is a link, and it names no author. */
export const LinkInBody = meta.story({
  args: { view: "content", message: linkMessage },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvasElement.querySelectorAll("a"), "no anchor in the body").toHaveLength(0);
    const link = canvas.getByRole("button", { name: "the route from Pharos, outside link to pharos.example, asks first" });
    link.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await waitFor(() => {
      const open = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]");
      if (!open?.open) throw new Error("the interstitial is not open yet");
      return open;
    });
    await expect(dialog.textContent).toContain("This link was written in this email. Brain hasn't checked where it goes.");
    await expect(dialog.querySelector("[data-untrusted-gate-address]")!.textContent).toBe("https://charts.pharos.example/route?from=pharos&to=ithaca");
    await expect(document.activeElement?.textContent, "focus starts on Stay here").toBe("Stay here");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(link));
  },
});
export const LinkInBodyNarrow = LinkInBody.extend({ ...narrow });

/** An override, a run of zero-width spaces and tag characters, each a visible marker; the joiner inside an emoji stays. */
export const RtlOverrideInBody = meta.story({
  args: { view: "content", message: hiddenCharsMessage },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    // The phone clamps the body to four lines, so it has "Show whole message"; the desktop shows it all.
    await holdsTogether(canvasElement, widthOf(parameters), { controls: widthOf(parameters) === "narrow" ? 1 : 0 });
    const body = canvasElement.querySelector("[data-gmail-body]")!.textContent!;
    await expect(body).toContain("invoice-‹U+202E›fdp.exe");
    await expect(body).toContain("Pay‹U+200B ×5›ment");
    await expect(body).toContain("‹U+E0049›‹U+E0047›‹U+E004E›‹U+E004F›‹U+E0052›‹U+E0045›");
    await expect(body).toContain("\u{1F9D1}\u{200D}\u{1F33E}");
    await expect(canvasElement.textContent ?? "").not.toMatch(/[\u{202E}\u{200B}\u{E0049}]/u);
    // The marker and "fdp.exe" read left to right: the override no longer reverses anything.
    const text = canvasElement.querySelector<HTMLElement>("[data-gmail-body] .bk-ut-p")!;
    const range = document.createRange();
    const node = [...text.querySelectorAll("bdi")].map((b) => b.firstChild).find((n) => n?.nodeValue?.includes("fdp.exe"))!;
    const at = node.nodeValue!.indexOf("‹U+202E›");
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const marker = range.getBoundingClientRect();
    range.setStart(node, at + "‹U+202E›".length);
    range.setEnd(node, at + "‹U+202E›".length + 1);
    await expect(range.getBoundingClientRect().left, "f follows the marker").toBeGreaterThanOrEqual(marker.left);
  },
});
export const RtlOverrideInBodyNarrow = RtlOverrideInBody.extend({ ...narrow });

/** No text body (an HTML-only message that converted to nothing), with an attachment. */
export const NoBody = meta.story({
  args: { view: "content", message: noBodyMessage },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByText("— This message has no text body.")).toBeVisible();
    await expect(canvas.getByRole("list", { name: "Attachment" }).textContent).toBe("harbour.jpg · 2.4 MB · not loaded");
  },
});
export const NoBodyNarrow = NoBody.extend({ ...narrow });

/** Quoted history folds in a single message too. */
export const QuotedHistory = meta.story({
  args: { view: "content", message: loomMessages[4]! },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByRole("button", { name: "Show quoted text" })).toHaveAttribute("aria-expanded", "false");
  },
});
export const QuotedHistoryNarrow = QuotedHistory.extend({ ...narrow });

// ----------------------------------------------------- the rest, on demand

/** Idle: how much Brain read, and the rest offered with its size. Pressing it asks the host. */
export const TruncatedIdle = meta.story({
  args: { view: "content", message: cut("idle") },
  ...desktop,
  play: async ({ args, canvas, canvasElement, userEvent, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByText(READ_LINE)).toBeVisible();
    await expect(canvas.getByText("Loads from Gmail when you ask. Brain won't see it.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show what Brain read" })).toBeVisible();
    const load = canvas.getByRole("button", { name: "Show the rest · 16,384 characters" });
    load.focus();
    await userEvent.keyboard("{Enter}");
    await expect((args.message as GmailContentMessage).detail!.onLoad).toHaveBeenCalled();
  },
});
export const TruncatedIdleNarrow = TruncatedIdle.extend({ ...narrow });

/** Loading: ghost lines; the part Brain read stops clamping, because the reader asked to read on. */
export const TruncatedLoading = meta.story({
  args: { view: "content", message: cut("loading") },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvasElement.querySelector("[data-gmail-detail='loading']")).toHaveAttribute("aria-busy", "true");
    await expect(canvasElement.querySelector("[data-gmail-body] .bk-ut-clamp")).toBeNull();
    await expect(canvas.getByText(READ_LINE)).toBeVisible();
  },
});
export const TruncatedLoadingNarrow = TruncatedLoading.extend({ ...narrow });

/**
 * Loading under reduced motion: the ghost holds still. Storybook cannot set
 * the media feature, so `tests/visual/gmail.visual.tsx` renders this story
 * with `prefers-reduced-motion: reduce` emulated and asserts nothing animates.
 */
export const TruncatedLoadingReducedMotion = meta.story({
  args: { view: "content", message: cut("loading") },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvasElement.querySelector("[data-gmail-detail='loading']")).toHaveAttribute("aria-busy", "true");
  },
});

/** Loaded: the rest under its own rule, after the line Brain's reading stopped at, which never changes. */
export const TruncatedLoaded = meta.story({
  args: { view: "content", message: cut("loaded", { rest: herdsRest }) },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByText(READ_LINE)).toBeVisible();
    await expect(canvas.getByText("Loaded for you · Brain hasn't read this")).toBeVisible();
    const line = canvasElement.querySelector("[data-brain-read]")!.getBoundingClientRect();
    const rest = canvasElement.querySelector("[data-gmail-rest]")!.getBoundingClientRect();
    await expect(rest.top, "the rest follows the line").toBeGreaterThan(line.bottom);
  },
});
export const TruncatedLoadedNarrow = TruncatedLoaded.extend({ ...narrow });

/**
 * Idle to loaded, as the host drives it, from the keyboard: Load, then the
 * rest arrives. The button goes as soon as the load starts, so focus moves
 * to the message body and stays there when the rest arrives.
 */
export const TruncatedLoadsOnDemand = meta.story({
  ...desktop,
  render: () => {
    const [state, setState] = useState<GmailDetailState>("idle");
    return <GmailMessage view="content" message={{ ...herdsMessage, detail: { state, rest: state === "loaded" ? herdsRest : null, onLoad: () => { setState("loading"); setTimeout(() => setState("loaded"), 50); } } }} />;
  },
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    const load = canvas.getByRole("button", { name: "Show the rest · 16,384 characters" });
    load.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(canvasElement.querySelector("[data-gmail-detail='loaded']")).not.toBeNull());
    await expect(canvas.getByText(READ_LINE)).toBeVisible();
    await expect(document.activeElement, "focus moved to the message body, not the page").toBe(bodyRegion(canvasElement));
    await expect(document.activeElement).toHaveAccessibleName("Message body");
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
  },
});
export const TruncatedLoadsOnDemandNarrow = TruncatedLoadsOnDemand.extend({ ...narrow });

/** Error: what Gmail answered, and Try again. */
export const TruncatedError = meta.story({
  args: { view: "content", message: cut("error", { errorStatus: 502 }) },
  ...desktop,
  play: async ({ args, canvas, canvasElement, userEvent, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByRole("status")).toHaveTextContent("Couldn't load the rest of this message. Gmail answered 502.");
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect((args.message as GmailContentMessage).detail!.onRetry).toHaveBeenCalled();
  },
});
export const TruncatedErrorNarrow = TruncatedError.extend({ ...narrow });

/** Error with no answer at all. */
export const TruncatedNoAnswer = meta.story({
  args: { view: "content", message: cut("error") },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByText(/Gmail didn't answer\./)).toBeVisible();
  },
});
export const TruncatedNoAnswerNarrow = TruncatedNoAnswer.extend({ ...narrow });

/** Rate limited: when the limit resets; Try again stays enabled. */
export const TruncatedRateLimited = meta.story({
  args: { view: "content", message: cut("rate-limited", { resetAt: "07:10", resetIn: "30 min" }) },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByRole("button", { name: "Try again after 07:10" })).toBeVisible();
  },
});
export const TruncatedRateLimitedNarrow = TruncatedRateLimited.extend({ ...narrow });

/** Unavailable: Gmail cannot be reached from this brain right now (not connected, refused, or off by policy). */
export const TruncatedUnavailable = meta.story({
  args: { view: "content", message: cut("unavailable") },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByRole("status")).toHaveTextContent("The rest of this message can't load: Gmail isn't available to this brain right now.");
    await expect(canvas.queryByRole("button", { name: /Try again|Show the rest/ })).toBeNull();
  },
});
export const TruncatedUnavailableNarrow = TruncatedUnavailable.extend({ ...narrow });

/** Gone: Gmail no longer shows this message to this brain (deleted, or hidden since). */
export const TruncatedGone = meta.story({
  args: { view: "content", message: cut("gone") },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByRole("status")).toHaveTextContent("Gmail no longer shows this message to this brain.");
  },
});
export const TruncatedGoneNarrow = TruncatedGone.extend({ ...narrow });

/** A later message in a thread whose reading budget was spent: Brain read none of it. */
export const TruncatedNoneRead = meta.story({
  args: { view: "content", message: { ...unreadBudgetMessage, detail: { state: "idle", onLoad: fn() } } },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByText("Brain read none of this message's 6,240 characters.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show the rest · 6,240 characters" })).toBeVisible();
  },
});
export const TruncatedNoneReadNarrow = TruncatedNoneRead.extend({ ...narrow });

/**
 * The payload cut the body but gave no length (or none longer than what
 * arrived): the cut still wins. The line names no total, and the rest is
 * offered with no count.
 */
export const TruncatedLengthUnknown = meta.story({
  args: { view: "content", message: { ...herdsMessage, untrusted: { ...herdsMessage.untrusted, bodyLength: null }, detail: { state: "idle", onLoad: fn() } } },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 2 });
    await expect(canvas.getByText("Brain read the first 32,768 characters of this message.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show the rest" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show what Brain read" }), "a cut body never claims to be whole").toBeVisible();
    await expect(canvas.queryByRole("button", { name: /whole message|quoted text/ })).toBeNull();
  },
});
export const TruncatedLengthUnknownNarrow = TruncatedLengthUnknown.extend({ ...narrow });

/** Cut, nothing read and no length: Brain read none of it, and the rest is offered with no count. */
export const TruncatedNoneReadLengthUnknown = meta.story({
  args: { view: "content", message: { ...unreadBudgetMessage, untrusted: { ...unreadBudgetMessage.untrusted, bodyLength: null }, detail: { state: "idle", onLoad: fn() } } },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByText("Brain read none of this message.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show the rest" })).toBeVisible();
    await expect(canvas.queryByText(/no text body/)).toBeNull();
  },
});
export const TruncatedNoneReadLengthUnknownNarrow = TruncatedNoneReadLengthUnknown.extend({ ...narrow });

/**
 * The longest unbroken strings the payload carries: a 2,250-character label
 * name, a From address filling the 2,000-character header and a
 * 255-character file name. Each wraps inside the card, at both widths.
 */
export const LongestUnbroken = meta.story({
  args: { view: "content", message: unbrokenMessage },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvasElement.querySelector(`[data-gmail-label='${L.longest.id}']`)!.textContent, "the whole label name is drawn").toBe(L.longest.name);
    const fields = [...canvasElement.querySelectorAll("[data-untrusted-field]")].map((f) => f.textContent);
    await expect(fields, "the whole address and the whole file name are drawn").toEqual(expect.arrayContaining([UNBROKEN_ADDRESS, UNBROKEN_FILENAME]));
  },
});
export const LongestUnbrokenNarrow = LongestUnbroken.extend({ ...narrow });

/** Every on-demand state at 320px, for one capture. */
export const EveryDetailState = meta.story({
  ...narrow,
  play: async ({ canvasElement, parameters }) => {
    // Only the idle body's "Show what Brain read": these sections get no handlers, so their buttons are not controls.
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 1 });
    await expect(cards(canvasElement).map((c) => c.querySelector("[data-gmail-detail]")?.getAttribute("data-gmail-detail"))).toEqual(["idle", "loading", "loaded", "error", "rate-limited", "unavailable", "gone"]);
  },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, width: "100%" }}>
      {(["idle", "loading", "loaded", "error", "rate-limited", "unavailable", "gone"] as const).map((state) => (
        <GmailMessage
          key={state}
          view="content"
          message={{
            ...herdsMessage,
            untrusted: { ...herdsMessage.untrusted, body: herdsMessage.untrusted.body!.slice(0, 600), bodyLength: 49_152 - 32_768 + 600 },
            detail: { state, rest: state === "loaded" ? herdsRest.slice(0, 600) : null, errorStatus: 502, resetAt: "07:10", resetIn: "30 min" },
          }}
        />
      ))}
    </div>
  ),
});

/** The structured view of one message: its date, labels, size and attachment count, under the one-message G1 line. */
export const Structured = meta.story({
  args: { view: "structured", message: structuredMessages[4]! },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByText(STRUCTURED_LINE_ONE)).toBeVisible();
    await expect(canvasElement.querySelector("[data-gmail-row]")!.textContent).toContain("Sat 11 Jul 18:02");
    await expect(canvasElement.querySelector("[data-gmail-flags]")!.textContent).toBe("unread\u{a0}·\u{a0}starred\u{a0}·\u{a0}1 attachment\u{a0}·\u{a0}under 1 MB");
    for (const word of ["Penelope", "loom", "@"]) await expect(canvasElement.textContent ?? "").not.toContain(word);
  },
});
export const StructuredNarrow = Structured.extend({ ...narrow });
