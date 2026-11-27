import { useRef, useState } from "react";
import preview from "#.storybook/preview";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { GoogleApprovalList, type GoogleApprovalListProps } from "../../src/index.js";
import {
  LONG_LABEL_NAME,
  blurActive,
  ODYSSEUS,
  PENELOPE,
  SAT_11,
  FRI_10,
  column,
  desktop,
  listIn,
  looksRight,
  narrow,
  oneAccount,
  spokenText,
  twoAccounts,
  type Expected,
  failedRead,
  loadingRows,
  statusRegion,
  unshownNotice,
} from "./_google.js";
import { ROW_RING, ring } from "../_stage.js";

/**
 * Remembered Gmail approvals, in Settings (#4212): grouped by account, each
 * with a Revoke, and the states around them. Every story is drawn at the
 * 680px desktop column and, as `…Narrow`, at 320px.
 */
const meta = preview.meta({
  title: "Google/Approval list",
  component: GoogleApprovalList,
  decorators: [column],
  args: { state: "ready" as const, accounts: oneAccount(), busy: null, error: null, onRevoke: fn() },
});

const HEADING = "Remembered Gmail approvals";
const EXPLAINER =
  "These run without asking while a chat is normal. In a restricted chat every change asks again. Sending, trashing and deleting always ask. Revoke one to be asked again.";
const EMPTY = "None yet. Every Gmail change asks first. Choose “Allow always” on a card to remember one.";
const UNAVAILABLE = "Remembered approvals can't be read right now, so every Gmail change asks until they can.";
const FAILED = "Couldn't load remembered approvals.";
const FAILED_DETAIL = "Any you have may still run without asking.";
/** How often the story's `onRetry` spy was called: a subject run repeats a story without clearing its spies. */
const retries = (args: { onRetry?: () => void }) => (args.onRetry as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
const CLAIMS = { failed: FAILED, detail: FAILED_DETAIL, empty: "None yet", unavailable: "can't be read right now" };
const unshownText = (count: number) => `${count} remembered approval${count === 1 ? "" : "s"} can't be shown here. brain google approvals lists ${count === 1 ? "it" : "them"}.`;

const expected = (rest: Omit<Expected, "heading" | "explainer">): Expected => ({ heading: HEADING, explainer: EXPLAINER, ...rest });

const ONE_ACCOUNT_NAMES = [
  `Revoke Archive for ${ODYSSEUS}`,
  `Revoke Add label “Voyage” for ${ODYSSEUS}`,
  `Revoke Save drafts for ${ODYSSEUS}`,
];

/** The mock: one account, three approvals. The address line shows even for one. */
export const OneAccount = meta.story({
  ...desktop,
  play: async (context) => {
    await looksRight(context, expected({
      copy: [ODYSSEUS, "Archive", "since Sat 11 Jul", "Add label “Voyage”", "since Fri 10 Jul", "Save drafts", "since Thu 9 Jul", "Revoke"],
      names: ONE_ACCOUNT_NAMES,
      lists: [3],
      groups: [ODYSSEUS],
    }));
    const list = listIn(context.canvasElement);
    await expect(list.querySelectorAll("[data-google-account]"), "one account, one group").toHaveLength(1);
    const first = within(list).getByRole("button", { name: ONE_ACCOUNT_NAMES[0] });
    await expect(first, "since has the host's full time as its description").toHaveAccessibleDescription("since Saturday 11 July 2026 at 09:14");
    await expect(first.getAttribute("aria-disabled")).toBeNull();
    // "since" sits under the words on a phone and beside them on desktop.
    const words = first.querySelector(".bk-google-row-title")!.getBoundingClientRect();
    const since = first.querySelector(".bk-google-row-since")!.getBoundingClientRect();
    const wide = context.parameters.googleWidth === 680;
    await expect(since.top >= words.bottom - 1, wide ? "since is beside the words" : "since is under the words").toBe(!wide);
  },
});
export const OneAccountNarrow = OneAccount.extend({ ...narrow });

/** Two accounts: a group each, under its own address, names carrying it. */
export const TwoAccounts = meta.story({
  ...desktop,
  args: { accounts: twoAccounts() },
  play: async (context) => {
    await looksRight(context, expected({
      copy: [ODYSSEUS, PENELOPE, "Remove label “Suitors”", "Add label “Estate · herds and orchards”", "since Wed 8 Jul"],
      lists: [2, 2],
      groups: [ODYSSEUS, PENELOPE],
      names: [
        `Revoke Archive for ${ODYSSEUS}`,
        `Revoke Add label “Voyage” for ${ODYSSEUS}`,
        `Revoke Remove label “Suitors” for ${PENELOPE}`,
        `Revoke Add label “Estate · herds and orchards” for ${PENELOPE}`,
      ],
    }));
    const groups = [...listIn(context.canvasElement).querySelectorAll<HTMLElement>("[data-google-account]")];
    await expect(groups.map((group) => group.firstElementChild?.textContent)).toEqual([ODYSSEUS, PENELOPE]);
    await expect(groups.map((group) => group.querySelectorAll('[role="button"]').length)).toEqual([2, 2]);
  },
});
export const TwoAccountsNarrow = TwoAccounts.extend({ ...narrow });

/** The host withheld the label names: each row shows the label id, in mono. */
export const WithheldLabelName = meta.story({
  ...desktop,
  args: {
    accounts: [
      {
        address: ODYSSEUS,
        approvals: [
          { id: "appr-label-7", action: { kind: "label", labelId: "Label_7", labelName: null }, since: SAT_11 },
          { id: "appr-unlabel-12", action: { kind: "unlabel", labelId: "Label_12", labelName: null }, since: FRI_10 },
        ],
      },
    ],
  },
  play: async (context) => {
    await looksRight(context, expected({
      copy: ["Add label Label_7", "Remove label Label_12"],
      names: [`Revoke Add label Label_7 for ${ODYSSEUS}`, `Revoke Remove label Label_12 for ${ODYSSEUS}`],
      lists: [2],
      groups: [ODYSSEUS],
    }));
    await expect(listIn(context.canvasElement).textContent, "a withheld name's id is never quoted").not.toMatch(/[“”]/);
    const ids = [...listIn(context.canvasElement).querySelectorAll<HTMLElement>("[data-google-label-id]")];
    await expect(ids.map((id) => id.textContent)).toEqual(["Label_7", "Label_12"]);
    for (const id of ids) await expect(getComputedStyle(id).fontFamily, "the id is mono").toMatch(/JetBrains Mono/);
    await expect(listIn(context.canvasElement).querySelector("bdi"), "no name, so nothing to isolate").toBeNull();
  },
});
export const WithheldLabelNameNarrow = WithheldLabelName.extend({ ...narrow });

/** A 2,250-character name with no break opportunity: it wraps, inside the card. */
export const LongLabelName = meta.story({
  ...desktop,
  args: {
    accounts: [
      {
        address: ODYSSEUS,
        approvals: [
          { id: "appr-long", action: { kind: "label", labelId: "Label_40", labelName: LONG_LABEL_NAME }, since: SAT_11 },
          { id: "appr-archive", action: { kind: "archive" }, since: FRI_10 },
        ],
      },
    ],
  },
  play: async (context) => {
    await expect(LONG_LABEL_NAME.length).toBe(2250);
    await expect(LONG_LABEL_NAME).not.toMatch(/\s/);
    await looksRight(context, expected({
      copy: [`Add label “${LONG_LABEL_NAME}”`, "since Sat 11 Jul"],
      names: [`Revoke Add label “${LONG_LABEL_NAME}” for ${ODYSSEUS}`, `Revoke Archive for ${ODYSSEUS}`],
      lists: [2],
      groups: [ODYSSEUS],
    }));
    const name = listIn(context.canvasElement).querySelector("bdi")!;
    await expect(name.textContent, "the name is the plain text the host sent").toBe(LONG_LABEL_NAME);
    await expect(getComputedStyle(name).overflowWrap).toBe("anywhere");
    await expect(name.getClientRects().length, "the name wraps onto many lines").toBeGreaterThan(5);
  },
});
export const LongLabelNameNarrow = LongLabelName.extend({ ...narrow });

/** The second row's revoke is in flight: it reads Revoking…, dims, and stays focusable. */
export const Revoking = meta.story({
  ...desktop,
  args: { busy: "appr-voyage" },
  play: async (context) => {
    await looksRight(context, expected({ copy: ["Revoking…"], names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    const list = listIn(context.canvasElement);
    const [archive, voyage] = within(list).getAllByRole("button");
    await expect(voyage!.getAttribute("aria-disabled")).toBe("true");
    await expect(voyage!.tabIndex, "a busy row keeps its tab stop").toBe(0);
    await expect(voyage!.textContent).toContain("Revoking…");
    await expect(archive!.textContent).not.toContain("Revoking…");
    await expect(getComputedStyle(voyage!.querySelector(".bk-google-row-title")!).color, "the busy row dims")
      .not.toBe(getComputedStyle(archive!.querySelector(".bk-google-row-title")!).color);
    await userEvent.click(voyage!);
    await expect(context.args.onRevoke, "a busy row does not revoke twice").not.toHaveBeenCalled();
    await userEvent.click(archive!);
    await expect(context.args.onRevoke).toHaveBeenCalledWith("appr-archive");
    blurActive();
  },
});
export const RevokingNarrow = Revoking.extend({ ...narrow });

const ERROR = "Couldn't confirm Archive was revoked. Brain didn't answer, so it may still run without asking.";

/** A revoke failed: the rows stay, and a red banner under them says why. */
export const RevokeError = meta.story({
  ...desktop,
  args: { error: ERROR },
  play: async (context) => {
    await looksRight(context, expected({ copy: [ERROR], names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    const alert = within(listIn(context.canvasElement)).getByRole("alert");
    await expect(alert.textContent).toBe(ERROR);
    const rows = within(listIn(context.canvasElement)).getAllByRole("button");
    await expect(alert.getBoundingClientRect().top, "the banner is under the list").toBeGreaterThanOrEqual(rows.at(-1)!.getBoundingClientRect().bottom);
  },
});
export const RevokeErrorNarrow = RevokeError.extend({ ...narrow });

/** Nothing remembered yet. */
export const Empty = meta.story({
  ...desktop,
  args: { accounts: [] },
  play: async (context) => {
    await looksRight(context, expected({ copy: [EMPTY], names: [], lists: [], groups: [] }));
  },
});
export const EmptyNarrow = Empty.extend({ ...narrow });

/** Reading: two ghost rows, and no claim about what they hold. */
export const Loading = meta.story({
  ...desktop,
  args: { state: "loading" },
  play: async (context) => {
    await looksRight(context, expected({ names: [], lists: [], groups: [] }));
    const list = listIn(context.canvasElement);
    await loadingRows(list);
    await expect(spokenText(list), "the placeholder claims nothing").toBe(HEADING + EXPLAINER);
  },
});
export const LoadingNarrow = Loading.extend({ ...narrow });

/** The approvals cannot be read: say what that means, draw no rows. */
export const Unavailable = meta.story({
  ...desktop,
  play: async (context) => {
    await looksRight(context, expected({ copy: [UNAVAILABLE], names: [], lists: [], groups: [] }));
    await expect(listIn(context.canvasElement).querySelectorAll("[data-google-account]")).toHaveLength(0);
  },
  args: { state: "unavailable" },
});
export const UnavailableNarrow = Unavailable.extend({ ...narrow });

/* ── A failed read, and approvals the host cannot show (#4212 round 2) ──── */

/** The read finished without a list: say so, claim no empty list and nothing running, offer Try again. */
export const Failed = meta.story({
  ...desktop,
  args: { state: "failed", onRetry: fn() },
  play: async (context) => {
    await looksRight(context, expected({ copy: [FAILED, FAILED_DETAIL], names: [], controls: ["Try again"], lists: [], groups: [] }));
    const list = listIn(context.canvasElement);
    await failedRead(list, CLAIMS);
    await expect(list.getAttribute("data-google-approvals")).toBe("failed");
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
    await looksRight(context, expected({ copy: [FAILED, FAILED_DETAIL], names: [], lists: [], groups: [] }));
    await failedRead(listIn(context.canvasElement), CLAIMS);
  },
});
export const FailedNoRetryNarrow = FailedNoRetry.extend({ ...narrow });

/** Only approvals the host cannot name: never "None yet"; the CLI lists them. */
export const PartialOnly = meta.story({
  ...desktop,
  args: { accounts: [], unshown: 1 },
  play: async (context) => {
    await looksRight(context, expected({ copy: [unshownText(1)], names: [], lists: [], groups: [] }));
    const list = listIn(context.canvasElement);
    await unshownNotice(list, { count: 1, text: unshownText(1), empty: "None yet" });
    const command = list.querySelector<HTMLElement>("[data-google-unshown] code")!;
    await expect(command.textContent).toBe("brain google approvals");
    await expect(getComputedStyle(command).fontFamily, "the command is mono").toMatch(/JetBrains Mono/);
  },
});
export const PartialOnlyNarrow = PartialOnly.extend({ ...narrow });

/** Shown rows, and two more the host cannot name, counted under them. */
export const Partial = meta.story({
  ...desktop,
  args: { unshown: 2 },
  play: async (context) => {
    await looksRight(context, expected({ copy: [unshownText(2)], names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    await unshownNotice(listIn(context.canvasElement), { count: 2, text: unshownText(2), empty: "None yet" });
    await expect(within(listIn(context.canvasElement)).queryByRole("alert"), "the notice is not a revoke error").toBeNull();
  },
});
export const PartialNarrow = Partial.extend({ ...narrow });

/** The count notice and a revoke error at once: two separate notices, the banner last. */
export const PartialRevokeError = meta.story({
  ...desktop,
  args: { unshown: 1, error: ERROR },
  play: async (context) => {
    await looksRight(context, expected({ copy: [unshownText(1), ERROR], names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    const list = listIn(context.canvasElement);
    await unshownNotice(list, { count: 1, text: unshownText(1), empty: "None yet" });
    await expect(within(list).getByRole("alert").textContent).toBe(ERROR);
  },
});
export const PartialRevokeErrorNarrow = PartialRevokeError.extend({ ...narrow });

/* ── Keyboard ────────────────────────────────────────────────────────── */

/** Revokes the harness holds until the play lets them finish. */
const pending: (() => void)[] = [];
const finishRevoke = () => pending.shift()?.();

type Accounts = GoogleApprovalListProps["accounts"];

/**
 * The host's side: a revoke goes busy, then, when the play lets it finish,
 * the row drops, or the host's refreshed list (the next of `replies`)
 * replaces the rows, as a response carrying changes made elsewhere would.
 */
function Host({ replies = [], ...p }: GoogleApprovalListProps & { replies?: Accounts[] }) {
  const [accounts, setAccounts] = useState(() => {
    pending.length = 0;
    return p.accounts;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const queue = useRef(replies.slice());
  return (
    <GoogleApprovalList
      {...p}
      accounts={accounts}
      busy={busy}
      onRevoke={(id) => {
        p.onRevoke(id);
        setBusy(id);
        pending.push(() => {
          const reply = queue.current.shift();
          setAccounts(reply ?? ((all) => all.map((account) => ({ ...account, approvals: account.approvals.filter((approval) => approval.id !== id) }))));
          setBusy(null);
        });
      }}
    />
  );
}

/**
 * Tab to a row, Enter revokes it, and when the host drops the row focus goes
 * to the next one; for the last row, the previous one; when none is left,
 * the heading.
 */
export const KeyboardRevoke = meta.story({
  ...desktop,
  render: (args) => <Host {...args} />,
  play: async (context) => {
    await looksRight(context, expected({ names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    const list = listIn(context.canvasElement);
    const row = (name: string) => within(list).getByRole("button", { name });
    const [archive, voyage, drafts] = ONE_ACCOUNT_NAMES as [string, string, string];

    await userEvent.tab();
    await expect(document.activeElement, "the first tab stop is the first row").toBe(row(archive));
    // The ring is a row's, inside the row, and the first row's follows the card's corners.
    await expect(ring(row(archive))).toEqual(ROW_RING);
    const corner = getComputedStyle(row(archive).closest("ul")!).borderTopLeftRadius;
    await expect(corner, "the card's corner reaches the list").not.toBe("0px");
    await expect(getComputedStyle(row(archive)).borderTopLeftRadius, "the focused first row takes the card's corner").toBe(corner);
    await userEvent.tab();
    await expect(document.activeElement).toBe(row(voyage));
    await expect(getComputedStyle(row(voyage)).borderTopLeftRadius, "a focused middle row stays square").toBe("0px");
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("appr-voyage");
    await waitFor(() => expect(row(voyage).getAttribute("aria-disabled")).toBe("true"));
    await expect(document.activeElement, "the busy row keeps focus").toBe(row(voyage));
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: voyage })).toBeNull());
    await expect(document.activeElement, "a middle row's revoke focuses the next row").toBe(row(drafts));

    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("appr-drafts");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: drafts })).toBeNull());
    await expect(document.activeElement, "the last row's revoke focuses the previous row").toBe(row(archive));

    await userEvent.keyboard(" ");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("appr-archive");
    finishRevoke();
    await waitFor(() => expect(within(list).queryAllByRole("button")).toHaveLength(0));
    await expect(document.activeElement, "the only row's revoke focuses the heading").toBe(within(list).getByRole("heading"));
    await expect(list.textContent).toContain(EMPTY);
    await expect(context.args.onRevoke).toHaveBeenCalledTimes(3);
  },
});
export const KeyboardRevokeNarrow = KeyboardRevoke.extend({ ...narrow });

/**
 * The host's response replaces rows instead of only dropping the revoked one.
 * When the focused row's old neighbours are gone too but the list still has
 * rows, focus goes to the first row now shown, never to the heading:
 * first `[a]` → `[b, c]`, then every old row replaced.
 */
export const KeyboardRevokeReplaced = meta.story({
  ...desktop,
  args: { accounts: [{ address: ODYSSEUS, approvals: [{ id: "appr-archive", action: { kind: "archive" }, since: SAT_11 }] }] },
  render: (args) => (
    <Host
      {...args}
      replies={[
        [{ address: ODYSSEUS, approvals: [{ id: "appr-star", action: { kind: "star" }, since: FRI_10 }, { id: "appr-drafts", action: { kind: "drafts" }, since: FRI_10 }] }],
        [{ address: PENELOPE, approvals: [{ id: "appr-suitors", action: { kind: "unlabel", labelId: "Label_7", labelName: "Suitors" }, since: SAT_11 }, { id: "appr-mark-read", action: { kind: "mark_read" }, since: FRI_10 }] }],
      ]}
    />
  ),
  play: async (context) => {
    await looksRight(context, expected({ names: [`Revoke Archive for ${ODYSSEUS}`], lists: [1], groups: [ODYSSEUS] }));
    const list = listIn(context.canvasElement);
    const row = (name: string) => within(list).getByRole("button", { name });

    await userEvent.tab();
    await expect(document.activeElement).toBe(row(`Revoke Archive for ${ODYSSEUS}`));
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("appr-archive");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` })).toBeNull());
    await expect(document.activeElement, "[a] → [b, c]: the first row now shown").toBe(row(`Revoke Star for ${ODYSSEUS}`));

    await userEvent.tab();
    await expect(document.activeElement).toBe(row(`Revoke Save drafts for ${ODYSSEUS}`));
    await userEvent.keyboard("{Enter}");
    await expect(context.args.onRevoke).toHaveBeenLastCalledWith("appr-drafts");
    finishRevoke();
    await waitFor(() => expect(within(list).queryByRole("button", { name: `Revoke Save drafts for ${ODYSSEUS}` })).toBeNull());
    await expect(document.activeElement, "every old row replaced: the first row now shown").toBe(row(`Revoke Remove label “Suitors” for ${PENELOPE}`));
    await expect(within(list).getByRole("group", { name: PENELOPE })).toBeTruthy();
  },
});
export const KeyboardRevokeReplacedNarrow = KeyboardRevokeReplaced.extend({ ...narrow });

/* ── Try again ───────────────────────────────────────────────────────── */

/** Reads the harness holds until the play lets them finish. */
const reads: (() => void)[] = [];
const finishRead = () => reads.shift()?.();

/** The host's side of a retry: the list reads (loading), then lands with the mock's rows. */
function RetryHost({ lands = "ready", ...p }: GoogleApprovalListProps & { lands?: "ready" | "failed" }) {
  const [state, setState] = useState<GoogleApprovalListProps["state"]>(() => {
    reads.length = 0;
    return "failed";
  });
  return (
    <GoogleApprovalList
      {...p}
      state={state}
      accounts={state === "ready" ? oneAccount() : []}
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
 * failed state, and focus waits on the heading; the rows land and Tab
 * reaches the first.
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
    await waitFor(() => expect(list.getAttribute("data-google-approvals")).toBe("loading"));
    await loadingRows(list);
    await expect(document.activeElement, "focus waits on the heading while it reads").toBe(within(list).getByRole("heading"));
    await expect(await statusRegion(list), "the status region stays mounted while it reads").toBe(region);
    await expect(region.textContent, "loading announces nothing").toBe("");
    await expect(region.querySelector("[aria-busy]"), "the reading placeholder is outside the region").toBeNull();
    finishRead();
    await waitFor(() => expect(list.getAttribute("data-google-approvals")).toBe("ready"));
    await expect(await statusRegion(list), "and while the rows show, empty").toBe(region);
    await expect(region.textContent).toBe("");
    await looksRight(context, expected({ names: ONE_ACCOUNT_NAMES, lists: [3], groups: [ODYSSEUS] }));
    await userEvent.tab();
    await expect(document.activeElement, "the next Tab reaches the first row").toBe(within(list).getByRole("button", { name: ONE_ACCOUNT_NAMES[0] }));
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
    await waitFor(() => expect(list.getAttribute("data-google-approvals")).toBe("loading"));
    await loadingRows(list);
    await expect(await statusRegion(list), "the region stays mounted while it reads").toBe(region);
    await expect(region.textContent, "loading announces nothing").toBe("");
    finishRead();
    await waitFor(() => expect(list.getAttribute("data-google-approvals")).toBe("failed"));
    await failedRead(list, CLAIMS);
    await expect(await statusRegion(list), "failing again fills the same region: announced, not a new region").toBe(region);
    await expect(document.activeElement, "focus stays on the heading").toBe(within(list).getByRole("heading"));
    await looksRight(context, expected({ copy: [FAILED, FAILED_DETAIL], names: [], controls: ["Try again"], lists: [], groups: [] }));
    blurActive();
  },
});
export const RetryFailsAgainNarrow = RetryFailsAgain.extend({ ...narrow });
