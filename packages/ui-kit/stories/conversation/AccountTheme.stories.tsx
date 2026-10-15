import preview from "#.storybook/preview";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { AssociateRecordings } from "../../../ui-react/src/components/voice/associate-recordings.js";
import { PasskeyTab } from "../../../ui-react/src/components/settings/passkey-tab.js";
import type { RecordingStore, Recording } from "../../../ui-react/src/lib/recordings.js";
import { ConsumerDocument, consumerViewport, painted, bounds, targets, accessible } from "./_consumer-parity.js";

const rows: Recording[] = ["sirens", "aeolus"].map((id, index) => ({
  id, partition: "unassigned", state: "saved", createdAt: Date.UTC(2026, 6, 12, 9 + index),
  mime: "audio/webm", durationMs: 10_000, savedThroughMs: 10_000, bytes: 1000, contentHash: id, chunkCount: 1,
}));

function AccountTheme({ onAssign, onSignOut }: { width: number; onAssign: (id: string) => Promise<void>; onSignOut: () => Promise<void> }) {
  const [associate, setAssociate] = useState(false);
  const [root] = useState(() => {
    const root = createBrainUiRoot({ storage: null, request: async input => {
      const url = new URL(String(input), location.href);
      if (url.pathname === "/api/auth/passkey/list") return Response.json({ credentials: [] });
      throw new Error(`Unexpected account fixture request: ${url.pathname}`);
    } });
    root.stores.connection.setState({ accountKey: "odysseus" });
    // Rendering collaborator only: native IndexedDB/association/deletion stays
    // in association-signout-runtime. Unimplemented methods throw, never pass.
    const recordings = root.recordings;
    root.recordings = new Proxy({ list: async () => rows, subscribe: () => () => {}, assign: onAssign, dispose: () => {} }, {
      get(target, key) { if (key in target) return target[key as keyof typeof target]; throw new Error(`Unexpected recording operation: ${String(key)}`); },
    }) as unknown as RecordingStore;
    const dispose = root.dispose;
    root.dispose = () => { root.recordings = recordings; dispose(); };
    root.localWorkFlow.loss = async () => ({ account: "odysseus", epoch: 0, recordings: 2, bytes: 1048576, transcripts: 1, accepted: 1, drafts: 1, tracks: 1, review: false, unassigned: 2, unknown: false, otherTabs: false, otherUnknown: false });
    root.localWorkFlow.signOut = onSignOut;
    return root;
  });
  useEffect(() => () => root.dispose(), [root]);
  return <ConsumerDocument><BrainUiProvider root={root}>
    <button onClick={() => setAssociate(true)}>Review unassigned recordings</button>
    {associate && <AssociateRecordings onClose={() => setAssociate(false)} />}
    <PasskeyTab active />
  </BrainUiProvider></ConsumerDocument>;
}

const meta = preview.meta({
  title: "Conversation/Account theme", component: AccountTheme,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, onAssign: fn(async () => {}), onSignOut: fn(async () => {}) },
});

export const Phone320 = meta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const screen = within(document.body);
    const opener = screen.getByRole("button", { name: "Review unassigned recordings" });
    opener.focus(); await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Drafts recorded before you signed in" });
    await waitFor(() => expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2));
    await expect(document.activeElement).toBe(within(dialog).getByRole("heading"));
    await expect(dialog.ownerDocument).toBe(document);
    await expect(getComputedStyle(dialog).colorScheme).toBe(globals.theme);
    await expect(within(dialog).getAllByRole("button", { name: /^Play recording from / })).toHaveLength(2);
    await bounds(dialog.querySelector<HTMLElement>(".bk-overlay-surface")!, "association");
    await targets(dialog, "association"); await accessible(dialog);
    const choices = within(dialog).getAllByRole("checkbox");
    for (const choice of choices) {
      await expect(choice).toHaveAccessibleName(/^Add recording from /);
      await expect(choice).toHaveAttribute("aria-checked", "false");
    }
    const add = within(dialog).getByRole("button", { name: "Add selected to my account" });
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(choices[0]!);
    await expect(choices[0]).toHaveAttribute("aria-checked", "true");
    await expect(add).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await expect(args.onAssign).not.toHaveBeenCalled();
    await userEvent.click(opener);
    const reopened = await screen.findByRole("dialog", { name: "Drafts recorded before you signed in" });
    await waitFor(() => expect(within(reopened).getAllByRole("checkbox")).toHaveLength(2));
    for (const choice of within(reopened).getAllByRole("checkbox")) await expect(choice).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const signout = screen.getByRole("button", { name: "Sign out everywhere" });
    signout.focus(); await userEvent.keyboard("{Enter}");
    const warning = await screen.findByRole("dialog", { name: "Sign out of Brain?" });
    const content = within(warning);
    await expect(content.getByText("2 recordings not yet added to a draft · 1.0 MB · 1 with an unaccepted transcript")).toBeVisible();
    for (const text of ["1 accepted recordings awaiting cleanup", "1 unsent drafts, including their images", "1 staged track references"]) await expect(content.getByText(text)).toBeVisible();
    const keep = content.getByRole("button", { name: "Keep working" });
    await expect(document.activeElement).toBe(keep);
    await expect(content.getByRole("checkbox", { name: "Also delete 2 recordings not linked to any account" })).toHaveAttribute("aria-checked", "false");
    await expect(warning.ownerDocument).toBe(document);
    await expect(getComputedStyle(warning).colorScheme).toBe(globals.theme);
    await bounds(warning.querySelector<HTMLElement>(".bk-overlay-surface")!, "sign-out");
    await targets(warning, "sign-out"); await accessible(warning);
    await userEvent.click(content.getByRole("checkbox"));
    await expect(content.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(signout));
    await expect(args.onSignOut).not.toHaveBeenCalled();
    await userEvent.click(signout);
    const final = await screen.findByRole("dialog", { name: "Sign out of Brain?" });
    await expect(within(final).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    // Leave a real dialog for the unchanged addon accessibility gate.
  },
});
export const Phone390 = Phone320.extend({ args: { width: 390 } });
export const Laptop900 = Phone320.extend({ args: { width: 900 } });
export const Desktop1280 = Phone320.extend({ args: { width: 1280 } });
