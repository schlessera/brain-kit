import { useState } from "react";
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
  spokenText,
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
const EXPLAINER =
  "This chat is restricted, so remembered approvals are off. You allowed these on a card here. They end at the time shown, when the chat returns to normal, when the policy changes or when Brain restarts.";
const EMPTY = "Nothing is allowed in this chat. Each Gmail change asks.";
const UNAVAILABLE = "Allowances for this chat can't be read right now, so each Gmail change asks until they can.";

const expected = (rest: Omit<Expected, "heading" | "explainer">): Expected => ({ heading: HEADING, explainer: EXPLAINER, ...rest });

/** Each row's count line, in order. */
const metas = (canvasElement: HTMLElement) => [...listIn(canvasElement).querySelectorAll<HTMLElement>("[data-google-meta]")];

const NEARLY_USED_NAMES = ["Revoke Archive and Mark as read", "Revoke Save drafts"];

/** One card, one action. */
export const OneGrant = meta.story({
  ...desktop,
  play: async (context) => {
    await looksRight(context, expected({ copy: ["Archive", "84 of 100 changes left · until 18:02"], names: ["Revoke Archive"] }));
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
      copy: ["Archive · Mark as read · Add label Voyage", "84 of 100 changes left · until 18:02"],
      names: ["Revoke Archive, Mark as read and Add label Voyage"],
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
      copy: [ODYSSEUS, PENELOPE, "Remove label Suitors", "40 of 100 changes left · until 21:40"],
      names: [`Revoke Archive and Mark as read for ${ODYSSEUS}`, `Revoke Remove label Suitors for ${PENELOPE}`],
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
    }));
    const [open, low] = metas(context.canvasElement) as [HTMLElement, HTMLElement];
    await expect(getComputedStyle(low).color, "3 left is amber").toBe(amberInk());
    await expect(getComputedStyle(open).color, "84 left is not").not.toBe(amberInk());
    await expect(low.textContent, "the words carry it, not the colour alone").toBe("3 of 100 changes left · until 21:40");
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
    await looksRight(context, expected({ copy: ["Revoking…"], names: NEARLY_USED_NAMES }));
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

const ERROR = "Couldn't revoke Archive and Mark as read. Brain didn't answer; it is still allowed here.";

/** A revoke failed: the rows stay, and a red banner under them says why. */
export const RevokeError = meta.story({
  ...desktop,
  args: { grants: nearlyUsed(), error: ERROR },
  play: async (context) => {
    await looksRight(context, expected({ copy: [ERROR], names: NEARLY_USED_NAMES }));
    await expect(within(listIn(context.canvasElement)).getByRole("alert").textContent).toBe(ERROR);
  },
});
export const RevokeErrorNarrow = RevokeError.extend({ ...narrow });

/** Nothing allowed in this chat. */
export const Empty = meta.story({
  ...desktop,
  args: { grants: [] },
  play: async (context) => {
    await looksRight(context, expected({ copy: [EMPTY], names: [] }));
  },
});
export const EmptyNarrow = Empty.extend({ ...narrow });

/** Reading: two ghost rows, and no claim about what they hold. */
export const Loading = meta.story({
  ...desktop,
  args: { state: "loading" },
  play: async (context) => {
    await looksRight(context, expected({ names: [] }));
    await expect(spokenText(listIn(context.canvasElement)), "loading claims nothing").toBe(HEADING + EXPLAINER);
  },
});
export const LoadingNarrow = Loading.extend({ ...narrow });

/** The allowances cannot be read: say what that means, draw no rows. */
export const Unavailable = meta.story({
  ...desktop,
  args: { state: "unavailable" },
  play: async (context) => {
    await looksRight(context, expected({ copy: [UNAVAILABLE], names: [] }));
  },
});
export const UnavailableNarrow = Unavailable.extend({ ...narrow });

/* ── Keyboard ────────────────────────────────────────────────────────── */

/** Revokes the harness holds until the play lets them finish. */
const pending: (() => void)[] = [];
const finishRevoke = () => pending.shift()?.();

/** The host's side: a revoke goes busy, then the row drops when it is done. */
function Host(p: GoogleAllowanceListProps) {
  const [grants, setGrants] = useState(() => {
    pending.length = 0;
    return p.grants;
  });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <GoogleAllowanceList
      {...p}
      grants={grants}
      busy={busy}
      onRevoke={(id) => {
        p.onRevoke(id);
        setBusy(id);
        pending.push(() => {
          setGrants((all) => all.filter((grant) => grant.id !== id));
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
    await looksRight(context, expected({ names: [...KEYBOARD_NAMES] }));
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
    await expect(context.args.onRevoke).toHaveBeenCalledTimes(3);
  },
});
export const KeyboardRevokeNarrow = KeyboardRevoke.extend({ ...narrow });
