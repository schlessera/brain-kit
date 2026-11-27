import { useRef, useState } from "react";
import preview from "#.storybook/preview";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { GoogleAllowanceList, type GoogleAllowanceListProps } from "../../src/index.js";
import {
  ARCHIVE,
  DRAFTS,
  MARK_READ,
  ODYSSEUS,
  PENELOPE,
  STAR,
  SUITORS,
  UNTIL_1802,
  UNTIL_2140,
  VOYAGE,
  amberInk,
  blurActive,
  column,
  desktop,
  listIn,
  looksRight,
  narrow,
  nearlyUsed,
  failedRead,
  loadingRows,
  spokenText,
  statusRegion,
  unshownNotice,
  type Expected,
} from "./_google.js";

/**
 * A restricted chat's Gmail allowances (#4212): one row per card the owner
 * allowed in this chat, its remaining budget and end time, and a Revoke.
 * Every story is drawn at the 680px desktop column and, as `…Narrow`, at
 * 320px.
 */
const meta = preview.meta({
  title: "Google/Allowance list",
  component: GoogleAllowanceList,
  decorators: [column],
  args: {
    state: "ready" as const,
    grants: [{ id: "card-archive", address: ODYSSEUS, actions: [ARCHIVE], remaining: 84, limit: 100, until: UNTIL_1802 }],
    busy: null,
    error: null,
    onRevoke: fn(),
  },
});

const HEADING = "Allowed in this chat";
/** With nothing to list, the explainer is its first sentence alone. */
const EXPLAINER_LEAD = "This chat is restricted, so remembered approvals are off.";
const EXPLAINER = `${EXPLAINER_LEAD} You allowed these on a card here. They end at the time shown, when the chat returns to normal, when the policy changes or when Brain restarts.`;
const EMPTY = "Nothing is allowed in this chat. Each Gmail change asks.";
const UNAVAILABLE = "Allowances for this chat can't be read right now, so each Gmail change asks until they can.";
const FAILED = "Couldn't load this chat's allowances.";
const FAILED_DETAIL = "Any you allowed here may still apply.";
/** How often the story's `onRetry` spy was called: a subject run repeats a story without clearing its spies. */
const retries = (args: { onRetry?: () => void }) => (args.onRetry as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
const CLAIMS = { failed: FAILED, detail: FAILED_DETAIL, empty: "Nothing is allowed", unavailable: "can't be read right now" };
const unshownText = (count: number) => `${count} allowance${count === 1 ? "" : "s"} in this chat can't be shown here. ${count === 1 ? "It still applies." : "They still apply."}`;

/** Allowances have no account groups; the full explainer unless a story says otherwise. */
const expected = ({ explainer = EXPLAINER, ...rest }: Omit<Expected, "heading" | "explainer" | "groups"> & { explainer?: string }): Expected =>
  ({ heading: HEADING, explainer, groups: [], ...rest });

/** Each row's count line, in order. */
const metas = (canvasElement: HTMLElement) => [...listIn(canvasElement).querySelectorAll<HTMLElement>("[data-google-meta]")];

const NEARLY_USED_NAMES = ["Revoke Archive and Mark as read", "Revoke Save drafts"];

/** One card, one action. */
export const OneGrant = meta.story({
  ...desktop,
  play: async (context) => {
    await looksRight(context, expected({ copy: ["Archive", "84 of 100 changes left · until 18:02"], names: ["Revoke Archive"], lists: [1] }));
    const revoke = within(listIn(context.canvasElement)).getByRole("button", { name: "Revoke Archive" });
    await expect(revoke, "until has the host's full time as its description").toHaveAccessibleDescription("until Sunday 12 July 2026 at 18:02");
    await expect(revoke.classList.contains("bk-hit"), "the Revoke reaches under a coarse pointer").toBe(true);
    await expect(listIn(context.canvasElement).textContent, "one account: no address").not.toContain(ODYSSEUS);
    await userEvent.click(revoke);
    await expect(context.args.onRevoke).toHaveBeenCalledWith("card-archive");
    blurActive();
  },
});
export const OneGrantNarrow = OneGrant.extend({ ...narrow });

/** One card that allowed three changes: the words join with " · ", the name with "and". */
export const MultiActionGrant = meta.story({
  ...desktop,
  args: { grants: [{ id: "card-voyage", address: ODYSSEUS, actions: [ARCHIVE, MARK_READ, VOYAGE], remaining: 84, limit: 100, until: UNTIL_1802 }] },
  play: async (context) => {
    await looksRight(context, expected({
      copy: ["Archive · Mark as read · Add label “Voyage”", "84 of 100 changes left · until 18:02"],
      names: ["Revoke Archive, Mark as read and Add label “Voyage”"],
      lists: [1],
    }));
  },
});
export const MultiActionGrantNarrow = MultiActionGrant.extend({ ...narrow });

/** Grants for two accounts: each row names its account, in mono and in its Revoke's name. */
export const TwoAccounts = meta.story({
  ...desktop,
  args: {
    grants: [
      { id: "card-ithaca", address: ODYSSEUS, actions: [ARCHIVE, MARK_READ], remaining: 84, limit: 100, until: UNTIL_1802 },
      { id: "card-suitors", address: PENELOPE, actions: [SUITORS], remaining: 40, limit: 100, until: UNTIL_2140 },
    ],
  },
  play: async (context) => {
    await looksRight(context, expected({
      copy: [ODYSSEUS, PENELOPE, "Remove label “Suitors”", "40 of 100 changes left · until 21:40"],
      names: [`Revoke Archive and Mark as read for ${ODYSSEUS}`, `Revoke Remove label “Suitors” for ${PENELOPE}`],
      lists: [2],
    }));
    for (const address of [ODYSSEUS, PENELOPE]) {
      const line = within(listIn(context.canvasElement)).getByText(address);
      await expect(getComputedStyle(line).fontFamily, `${address} is mono`).toMatch(/JetBrains Mono/);
    }
  },
});
export const TwoAccountsNarrow = TwoAccounts.extend({ ...narrow });

/** The mock: 84 left, and 3 left in amber; the count says it either way. */
export const NearlyUsed = meta.story({
  ...desktop,
  args: { grants: nearlyUsed() },
  play: async (context) => {
    await looksRight(context, expected({
      copy: ["Archive · Mark as read", "84 of 100 changes left · until 18:02", "Save drafts", "3 of 100 changes left · until 21:40"],
      names: NEARLY_USED_NAMES,
      lists: [2],
    }));
    const [open, low] = metas(context.canvasElement) as [HTMLElement, HTMLElement];
    await expect(getComputedStyle(low).color, "3 left is amber").toBe(amberInk());
    await expect(getComputedStyle(open).color, "84 left is not").not.toBe(amberInk());
    await expect(low.textContent, "the words carry it, not the colour alone").toBe("3 of 100 changes left · until 21:40");
    // The first row paints the divider; its ends stay straight (#4212 re-review R1).
    const first = context.canvasElement.querySelector<HTMLElement>("[data-google-grant]")!;
    await expect(getComputedStyle(first).borderBottomWidth, "the first row draws a divider").not.toBe("0px");
    await expect([getComputedStyle(first).borderBottomLeftRadius, getComputedStyle(first).borderBottomRightRadius], "the divider's ends are square").toEqual(["0px", "0px"]);
  },
});
export const NearlyUsedNarrow = NearlyUsed.extend({ ...narrow });

/** A card's budget is spent: it says so, dims, and can still be revoked. */
export const UsedUp = meta.story({
  ...desktop,
  args: {
    grants: [
      { id: "card-ithaca", address: ODYSSEUS, actions: [ARCHIVE, MARK_READ], remaining: 0, limit: 100, until: UNTIL_1802 },
      { id: "card-drafts", address: ODYSSEUS, actions: [DRAFTS], remaining: 12, limit: 100, until: UNTIL_2140 },
    ],
  },
  play: async (context) => {
    await looksRight(context, expected({
      copy: ["All 100 used · each change asks again", "12 of 100 changes left · until 21:40"],
      names: NEARLY_USED_NAMES,
      lists: [2],
    }));
    const list = listIn(context.canvasElement);
    const [used, open] = metas(context.canvasElement) as [HTMLElement, HTMLElement];
    await expect(used.textContent).toBe("All 100 used · each change asks again");
    await expect(getComputedStyle(used).color, "used up is amber").toBe(amberInk());
    await expect(getComputedStyle(open).color, "12 left is not").not.toBe(amberInk());
    const [usedRow, openRow] = [...list.querySelectorAll<HTMLElement>("[data-google-grant]")] as [HTMLElement, HTMLElement];
    await expect(usedRow.dataset.googleGrant).toBe("used");
    const title = (row: HTMLElement) => getComputedStyle(row.querySelector("span > span")!).color;
    await expect(title(usedRow), "the used-up row dims").not.toBe(title(openRow));
    const revoke = within(list).getByRole("button", { name: "Revoke Archive and Mark as read" });
    await expect(revoke.getAttribute("aria-disabled"), "still revocable").toBeNull();
    await userEvent.click(revoke);
    await expect(context.args.onRevoke).toHaveBeenCalledWith("card-ithaca");
    blurActive();
  },
});
export const UsedUpNarrow = UsedUp.extend({ ...narrow });

/** The first card's revoke is in flight: Revoking…, dimmed, still focusable. */
export const Revoking = meta.story({
  ...desktop,
  args: { grants: nearlyUsed(), busy: "card-ithaca" },
  play: async (context) => {
    await looksRight(context, expected({ copy: ["Revoking…"], names: NEARLY_USED_NAMES, lists: [2] }));
    const [busy, other] = within(listIn(context.canvasElement)).getAllByRole("button") as [HTMLElement, HTMLElement];
    await expect(busy.textContent).toBe("Revoking…");
    await expect(busy.getAttribute("aria-disabled")).toBe("true");
    await expect(busy.tabIndex, "a busy Revoke keeps its tab stop").toBe(0);
    await expect(other.textContent).toBe("Revoke");
    await userEvent.click(busy);
    await expect(context.args.onRevoke, "a busy Revoke does not revoke twice").not.toHaveBeenCalled();
    blurActive();
  },
});
export const RevokingNarrow = Revoking.extend({ ...narrow });

const ERROR = "Couldn't confirm Archive and Mark as read were revoked. Brain didn't answer, so they may still be allowed here.";

/** A revoke failed: the rows stay, and a red banner under them says why. */
export const RevokeError = meta.story({
  ...desktop,
  args: { grants: nearlyUsed(), error: ERROR },
  play: async (context) => {
    await looksRight(context, expected({ copy: [ERROR], names: NEARLY_USED_NAMES, lists: [2] }));
    await expect(within(listIn(context.canvasElement)).getByRole("alert").textContent).toBe(ERROR);
  },
});
export const RevokeErrorNarrow = RevokeError.extend({ ...narrow });

/** Nothing allowed in this chat. */
export const Empty = meta.story({
  ...desktop,
  args: { grants: [] },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [EMPTY], names: [], lists: [] }));
  },
});
export const EmptyNarrow = Empty.extend({ ...narrow });

/** Reading: two ghost rows, and no claim about what they hold. */
export const Loading = meta.story({
  ...desktop,
  args: { state: "loading" },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, names: [], lists: [] }));
    await loadingRows(listIn(context.canvasElement));
    await expect(spokenText(listIn(context.canvasElement)), "the placeholder claims nothing").toBe(HEADING + EXPLAINER_LEAD);
  },
});
export const LoadingNarrow = Loading.extend({ ...narrow });

/** The allowances cannot be read: say what that means, draw no rows. */
export const Unavailable = meta.story({
  ...desktop,
  args: { state: "unavailable" },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [UNAVAILABLE], names: [], lists: [] }));
  },
});
export const UnavailableNarrow = Unavailable.extend({ ...narrow });

/* ── A failed read, and allowances the host cannot show (#4212 round 2) ─── */

/** The read finished without a list: say so, claim nothing allowed and nothing running, offer Try again. */
export const Failed = meta.story({
  ...desktop,
  args: { state: "failed", onRetry: fn() },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [FAILED, FAILED_DETAIL], names: [], controls: ["Try again"], lists: [] }));
    const list = listIn(context.canvasElement);
    await failedRead(list, CLAIMS);
    await expect(list.getAttribute("data-google-allowances")).toBe("failed");
    await userEvent.tab();
    const retry = within(list).getByRole("button", { name: "Try again" });
    await expect(document.activeElement, "Try again is the first tab stop").toBe(retry);
    await expect(retry.classList.contains("bk-hit"), "Try again reaches under a coarse pointer").toBe(true);
    const before = retries(context.args);
    await userEvent.keyboard("{Enter}");
    await expect(retries(context.args), "Enter on Try again calls onRetry once").toBe(before + 1);
    blurActive();
  },
});
export const FailedNarrow = Failed.extend({ ...narrow });

/** A failed read whose host offers no retry: the same words, and no control. */
export const FailedNoRetry = meta.story({
  ...desktop,
  args: { state: "failed" },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [FAILED, FAILED_DETAIL], names: [], lists: [] }));
    await failedRead(listIn(context.canvasElement), CLAIMS);
  },
});
export const FailedNoRetryNarrow = FailedNoRetry.extend({ ...narrow });

/** Only allowances the host cannot name: never "Nothing is allowed"; they still apply. */
export const PartialOnly = meta.story({
  ...desktop,
  args: { grants: [], unshown: 1 },
  play: async (context) => {
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [unshownText(1)], names: [], lists: [] }));
    await unshownNotice(listIn(context.canvasElement), { count: 1, text: unshownText(1), empty: "Nothing is allowed" });
  },
});
export const PartialOnlyNarrow = PartialOnly.extend({ ...narrow });

/** Shown cards, and two more allowances the host cannot name, counted under them. */
export const Partial = meta.story({
  ...desktop,
  args: { grants: nearlyUsed(), unshown: 2 },
  play: async (context) => {
    await looksRight(context, expected({ copy: [unshownText(2)], names: NEARLY_USED_NAMES, lists: [2] }));
    await unshownNotice(listIn(context.canvasElement), { count: 2, text: unshownText(2), empty: "Nothing is allowed" });
    await expect(within(listIn(context.canvasElement)).queryByRole("alert"), "the notice is not a revoke error").toBeNull();
  },
});
export const PartialNarrow = Partial.extend({ ...narrow });

/** The count notice and a revoke error at once: two separate notices, the banner last. */
export const PartialRevokeError = meta.story({
  ...desktop,
  args: { grants: nearlyUsed(), unshown: 1, error: ERROR },
  play: async (context) => {
    await looksRight(context, expected({ copy: [unshownText(1), ERROR], names: NEARLY_USED_NAMES, lists: [2] }));
    const list = listIn(context.canvasElement);
    await unshownNotice(list, { count: 1, text: unshownText(1), empty: "Nothing is allowed" });
    await expect(within(list).getByRole("alert").textContent).toBe(ERROR);
  },
});
export const PartialRevokeErrorNarrow = PartialRevokeError.extend({ ...narrow });

/* ── Keyboard ────────────────────────────────────────────────────────── */

/** Revokes the harness holds until the play lets them finish. */
const pending: (() => void)[] = [];
const finishRevoke = () => pending.shift()?.();

type Grants = GoogleAllowanceListProps["grants"];

/**
 * The host's side: a revoke goes busy, then, when the play lets it finish,
 * the row drops, or the host's refreshed list (the next of `replies`)
 * replaces the rows, as a response carrying changes made elsewhere would.
 */
function Host({ replies = [], ...p }: GoogleAllowanceListProps & { replies?: Grants[] }) {
  const [grants, setGrants] = useState(() => {
    pending.length = 0;
    return p.grants;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const queue = useRef(replies.slice());
  return (
    <GoogleAllowanceList
      {...p}
      grants={grants}
      busy={busy}
      onRevoke={(id) => {
        p.onRevoke(id);
        setBusy(id);
        pending.push(() => {
          const reply = queue.current.shift();
          setGrants(reply ?? ((all) => all.filter((grant) => grant.id !== id)));
          setBusy(null);
        });
      }}
    />
  );
}

const KEYBOARD_NAMES = ["Revoke Archive and Mark as read", "Revoke Save drafts", "Revoke Star"] as const;

/**
 * Tab to a Revoke, Enter revokes it, and when the host drops the row focus
 * goes to the next row's Revoke; for the last row, the previous one; when
 * none is left, the heading.
 */
export const KeyboardRevoke = meta.story({
  ...desktop,
  args: { grants: [...nearlyUsed(), { id: "card-star", address: ODYSSEUS, actions: [STAR], remaining: 51, limit: 100, until: UNTIL_2140 }] },
  render: (args) => <Host {...args} />,
  play: async (context) => {
    await looksRight(context, expected({ names: [...KEYBOARD_NAMES], lists: [3] }));
    const list = listIn(context.canvasElement);
    const revoke = (name: string) => within(list).getByRole("button", { name });
    const [ithaca, drafts, star] = KEYBOARD_NAMES;

    await userEvent.tab();
    await expect(document.activeElement, "the first tab stop is the first Revoke").toBe(revoke(ithaca));
    await userEvent.tab();
    await expect(document.activeElement).toBe(revoke(drafts));
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("card-drafts");
    await waitFor(() => expect(revoke(drafts).textContent).toBe("Revoking…"));
    await expect(document.activeElement, "the busy Revoke keeps focus").toBe(revoke(drafts));
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: drafts })).toBeNull());
    await expect(document.activeElement, "a middle row's revoke focuses the next Revoke").toBe(revoke(star));

    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("card-star");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: star })).toBeNull());
    await expect(document.activeElement, "the last row's revoke focuses the previous Revoke").toBe(revoke(ithaca));

    await userEvent.keyboard(" ");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("card-ithaca");
    finishRevoke();
    await waitFor(() => expect(within(list).queryAllByRole("button")).toHaveLength(0));
    await expect(document.activeElement, "the only row's revoke focuses the heading").toBe(within(list).getByRole("heading"));
    await expect(list.textContent).toContain(EMPTY);
    await expect(list.querySelector("p")?.textContent, "with nothing left, the explainer is its first sentence").toBe(EXPLAINER_LEAD);
    await expect(context.args.onRevoke).toHaveBeenCalledTimes(3);
  },
});
export const KeyboardRevokeNarrow = KeyboardRevoke.extend({ ...narrow });

/**
 * The host's response replaces rows instead of only dropping the revoked one.
 * When the focused row's old neighbours are gone too but the list still has
 * rows, focus goes to the first Revoke now shown, never to the heading:
 * first `[a]` → `[b, c]`, then every old row replaced.
 */
export const KeyboardRevokeReplaced = meta.story({
  ...desktop,
  args: { grants: [{ id: "card-ithaca", address: ODYSSEUS, actions: [ARCHIVE, MARK_READ], remaining: 84, limit: 100, until: UNTIL_1802 }] },
  render: (args) => (
    <Host
      {...args}
      replies={[
        [
          { id: "card-star", address: ODYSSEUS, actions: [STAR], remaining: 51, limit: 100, until: UNTIL_2140 },
          { id: "card-drafts", address: ODYSSEUS, actions: [DRAFTS], remaining: 3, limit: 100, until: UNTIL_2140 },
        ],
        [
          { id: "card-voyage", address: ODYSSEUS, actions: [VOYAGE], remaining: 90, limit: 100, until: UNTIL_1802 },
          { id: "card-mark-read", address: ODYSSEUS, actions: [MARK_READ], remaining: 20, limit: 100, until: UNTIL_2140 },
        ],
      ]}
    />
  ),
  play: async (context) => {
    await looksRight(context, expected({ names: ["Revoke Archive and Mark as read"], lists: [1] }));
    const list = listIn(context.canvasElement);
    const revoke = (name: string) => within(list).getByRole("button", { name });

    await userEvent.tab();
    await expect(document.activeElement).toBe(revoke("Revoke Archive and Mark as read"));
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("card-ithaca");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: "Revoke Archive and Mark as read" })).toBeNull());
    await expect(document.activeElement, "[a] → [b, c]: the first Revoke now shown").toBe(revoke("Revoke Star"));

    await userEvent.tab();
    await expect(document.activeElement).toBe(revoke("Revoke Save drafts"));
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("card-drafts");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: "Revoke Save drafts" })).toBeNull());
    await expect(document.activeElement, "every old row replaced: the first Revoke now shown").toBe(revoke("Revoke Add label “Voyage”"));
  },
});
export const KeyboardRevokeReplacedNarrow = KeyboardRevokeReplaced.extend({ ...narrow });

/* ── Try again ───────────────────────────────────────────────────────── */

/** Reads the harness holds until the play lets them finish. */
const reads: (() => void)[] = [];
const finishRead = () => reads.shift()?.();

/** The host's side of a retry: the list reads (loading), then lands with the mock's grants. */
function RetryHost({ lands = "ready", ...p }: GoogleAllowanceListProps & { lands?: "ready" | "failed" }) {
  const [state, setState] = useState<GoogleAllowanceListProps["state"]>(() => {
    reads.length = 0;
    return "failed";
  });
  return (
    <GoogleAllowanceList
      {...p}
      state={state}
      grants={state === "ready" ? nearlyUsed() : []}
      onRetry={() => {
        p.onRetry?.();
        setState("loading");
        reads.push(() => setState(lands));
      }}
    />
  );
}

/**
 * Tab to Try again and press Enter: the list reads, Try again goes with the
 * failed state, and focus waits on the heading; the grants land and Tab
 * reaches the first Revoke.
 */
export const RetryKeyboard = meta.story({
  ...desktop,
  args: { onRetry: fn() },
  render: (args) => <RetryHost {...args} />,
  play: async (context) => {
    const list = listIn(context.canvasElement);
    await failedRead(list, CLAIMS);
    const region = await statusRegion(list);
    await userEvent.tab();
    await expect(document.activeElement).toBe(within(list).getByRole("button", { name: "Try again" }));
    const before = retries(context.args);
    await userEvent.keyboard("{Enter}");
    await expect(retries(context.args), "Enter on Try again calls onRetry once").toBe(before + 1);
    await waitFor(() => expect(list.getAttribute("data-google-allowances")).toBe("loading"));
    await loadingRows(list);
    await expect(document.activeElement, "focus waits on the heading while it reads").toBe(within(list).getByRole("heading"));
    await expect(await statusRegion(list), "the status region stays mounted while it reads").toBe(region);
    await expect(region.textContent, "loading announces nothing").toBe("");
    await expect(region.querySelector("[aria-busy]"), "the reading placeholder is outside the region").toBeNull();
    finishRead();
    await waitFor(() => expect(list.getAttribute("data-google-allowances")).toBe("ready"));
    await expect(await statusRegion(list), "and while the rows show, empty").toBe(region);
    await expect(region.textContent).toBe("");
    await looksRight(context, expected({ names: NEARLY_USED_NAMES, lists: [2] }));
    await userEvent.tab();
    await expect(document.activeElement, "the next Tab reaches the first Revoke").toBe(within(list).getByRole("button", { name: NEARLY_USED_NAMES[0] }));
    blurActive();
  },
});
export const RetryKeyboardNarrow = RetryKeyboard.extend({ ...narrow });

/**
 * Tab to Try again, press Enter, and the read fails again: focus stays on the
 * heading, and the status region that was empty while it read now holds the
 * failure, a change a screen reader announces once, politely.
 */
export const RetryFailsAgain = meta.story({
  ...desktop,
  args: { onRetry: fn() },
  render: (args) => <RetryHost {...args} lands="failed" />,
  play: async (context) => {
    const list = listIn(context.canvasElement);
    await failedRead(list, CLAIMS);
    const region = await statusRegion(list);
    await userEvent.tab();
    await expect(document.activeElement).toBe(within(list).getByRole("button", { name: "Try again" }));
    const before = retries(context.args);
    await userEvent.keyboard("{Enter}");
    await expect(retries(context.args), "Enter on Try again calls onRetry once").toBe(before + 1);
    await waitFor(() => expect(list.getAttribute("data-google-allowances")).toBe("loading"));
    await loadingRows(list);
    await expect(await statusRegion(list), "the region stays mounted while it reads").toBe(region);
    await expect(region.textContent, "loading announces nothing").toBe("");
    finishRead();
    await waitFor(() => expect(list.getAttribute("data-google-allowances")).toBe("failed"));
    await failedRead(list, CLAIMS);
    await expect(await statusRegion(list), "failing again fills the same region: announced, not a new region").toBe(region);
    await expect(document.activeElement, "focus stays on the heading").toBe(within(list).getByRole("heading"));
    await looksRight(context, expected({ explainer: EXPLAINER_LEAD, copy: [FAILED, FAILED_DETAIL], names: [], controls: ["Try again"], lists: [] }));
    blurActive();
  },
});
export const RetryFailsAgainNarrow = RetryFailsAgain.extend({ ...narrow });
