import preview from "#.storybook/preview";
import { expect, waitFor, within } from "storybook/test";

import { antinous, hostileBody, issueBody } from "../../fixtures/github.js";
import { UntrustedText } from "../../src/evidence/UntrustedText.js";
import { stage } from "../_stage.js";
import { viewportAt } from "../_viewports.js";
import { desktop, narrow } from "../github/_github.js";

/**
 * Text written on GitHub, as a safe markdown subset (#3800, design #3795 §3
 * and revision 2 §3′). Links ask first through a full-URL interstitial; only
 * `https:` can open, in a new tab. Images, HTML and every other scheme stay
 * text.
 */
const meta = preview.meta({
  title: "Evidence/UntrustedText",
  component: UntrustedText,
  decorators: [stage],
  args: { text: hostileBody, source: "GitHub", author: `@${antinous.login}` },
});

const LINKS =
  "Nobody is draining anything. Proof: [the steward's report](https://ithaca-steward.example/r?id=7&ref=hall#seal). Old notes: [the cellar sheet](http://cellar.ithaca.example/sheet). And [click here](javascript:alert(1)).";

/** The subset: headings as bold paragraphs, links that ask, an image placeholder, HTML as literal text, static task boxes. */
export const Subset = meta.story({ ...desktop });
export const SubsetNarrow = meta.story({ ...narrow });

/** How each kind of link reads before it is activated. */
export const Links = meta.story({ args: { text: LINKS }, ...desktop });
export const LinksNarrow = meta.story({ args: { text: LINKS }, ...narrow });

/** A lookalike: the registrable domain, not the `github.com.` prefix, is what the link and the interstitial name. */
export const Lookalike = meta.story({
  args: { text: "Signed off here: [GitHub review](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal)." },
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "GitHub review, outside link to ithaca-steward.example, asks first" })).toBeVisible();
  },
});

/** An internationalised domain is named in its ASCII (punycode) form, never its Unicode one. */
export const InternationalDomain = meta.story({
  args: { text: "The map is [at the harbour office](https://hafen-münchen.example/karte)." },
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: /outside link to xn--hafen-mnchen-jlb\.example/ })).toBeVisible();
  },
});

/** `http:` and `javascript:` links are text with a muted reason: no underline, no focus stop. */
export const InertLinks = meta.story({
  args: { text: "Old notes: [the cellar sheet](http://cellar.ithaca.example/sheet). And [click here](javascript:alert(1))." },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("button, a")).toHaveLength(0);
    await expect(canvasElement.textContent).toContain("(http link · won't open)");
    await expect(canvasElement.textContent).toContain("(not a web link)");
  },
});

/** A bidi control in the address: the classifier refuses it, and the words stay with "(link removed)". */
export const BidiRefused = meta.story({
  args: { text: "The invoice: [invoice.pdf](https://ithaca.example/‮fdp.exe). Paid in full." },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("button, a")).toHaveLength(0);
    await expect(canvasElement.textContent).toContain("(link removed)");
  },
});

/** Right-to-left words inside the text do not reorder the domain label or reason beside them. */
export const Bidi = meta.story({
  args: { text: "‮emit retteb a si sihT [read more](https://ithaca.example/notes) — and שלום עולם [the log](http://log.example/)." },
  ...desktop,
});

/** Image and HTML content is inert text. */
export const InertContent = meta.story({
  args: { text: '![seal](https://tracker.example/p.gif)\n\n<img src="https://tracker.example/pixel.gif" onerror="alert(1)">\n\nInline <b>bold</b> stays literal.' },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("img, b")).toHaveLength(0);
  },
});

/** Clamped at 6 lines, then "Show more" in place. */
export const Clamped = meta.story({
  args: { text: [issueBody, issueBody, issueBody].join("\n\n"), frame: "rule", caption: false, lines: 6, expandLabel: "Show whole comment" },
  ...desktop,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show whole comment" }));
    await expect(canvas.queryByRole("button", { name: "Show whole comment" })).toBeNull();
  },
});
export const ClampedNarrow = Clamped.extend({ ...narrow });

/** Past `maxChars` the rest is never rendered, and the field says it was cut. */
export const HardTruncated = meta.story({
  args: { text: `${issueBody} ${issueBody}`, maxChars: 160, truncatedNote: "Truncated · the rest is on GitHub" },
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Truncated · the rest is on GitHub")).toBeVisible();
  },
});

const ASK = "Nobody is draining anything. Proof: [the steward's report](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal).";

/**
 * The interstitial at desktop: a dialog. Focus starts on Stay here, so a
 * double Enter cannot open the site, and Stay here returns focus to the link.
 */
export const Interstitial = meta.story({
  args: { text: ASK },
  globals: viewportAt(1280),
  parameters: { stageWidth: 680 },
  play: async ({ canvas, userEvent }) => {
    const link = canvas.getByRole("button", { name: /outside link to ithaca-steward\.example/ });
    await userEvent.click(link);
    const dialog = await within(document.body).findByRole("dialog", { name: "Open a link from GitHub?" });
    const stay = within(dialog).getByRole("button", { name: "Stay here" });
    await waitFor(() => expect(document.activeElement).toBe(stay));
    await expect(within(dialog).getByRole("link", { name: /Open ithaca-steward\.example/ })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
  },
});

/** The same at 320: a bottom sheet, Open above Stay here. Opening closes it and returns focus to the link. */
export const InterstitialSheet = meta.story({
  args: { text: ASK },
  ...narrow,
  play: async ({ canvas, userEvent }) => {
    const link = canvas.getByRole("button", { name: /outside link to ithaca-steward\.example/ });
    await userEvent.click(link);
    const dialog = await within(document.body).findByRole("dialog", { name: "Open a link from GitHub?" });
    const open = within(dialog).getByRole("link", { name: /Open ithaca-steward\.example/ });
    // Keep the capture on this page: the anchor's own attributes are the claim.
    open.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEvent.click(open);
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
  },
});

/** Open, then leave it open for the capture: the dialog at desktop, the sheet at 320. */
export const InterstitialOpen = meta.story({
  args: { text: ASK },
  globals: viewportAt(1280),
  parameters: { stageWidth: 680 },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /outside link/ }));
    await within(document.body).findByRole("dialog");
  },
});
export const InterstitialOpenNarrow = InterstitialOpen.extend({ ...narrow });
