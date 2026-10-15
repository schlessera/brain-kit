import preview from "#.storybook/preview";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import type { TurnJournalDetails, TurnJournalSummary, TurnJournalChange } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { TurnJournal } from "../../../ui-react/src/components/chat/turn-journal.js";
import { ConsumerDocument, consumerViewport, painted, bounds, accessible } from "./_consumer-parity.js";

const turnId = "odysseus-journal";
const skill = ".claude/skills/voyage-log/SKILL.md";
const summary: TurnJournalSummary = { state: "complete", changedFiles: 3, steeringFiles: 1, costUsd: null, costIsEstimate: null, profile: "governed", actor: "interactive", model: null, policyHash: null, sharedAttribution: true, observedAt: Date.UTC(2026, 6, 12) };
const version = { kind: "file" as const, mode: 420, bytes: 32, hash: "odysseus-retained", ignored: false };
const observations = [3, 4].map(sequence => ({ turnId, sequence, side: "after" as const }));
const changes: TurnJournalChange[] = [
  { sequence: 1, path: skill, scope: "", class: "steering", actor: "agent", before: version, after: version, overlappingTurnIds: [], tainted: true, taintSourceEventId: 7 },
  { sequence: 2, path: "notes/voyage.md", scope: "", class: "content", actor: "agent", before: version, after: version, overlappingTurnIds: [] },
  ...observations.map(({ sequence }) => ({ sequence, path: "notes/crossing.md", scope: "", class: "content" as const, actor: "agent" as const, before: version, after: version, overlappingTurnIds: ["athena-journal"], conflict: { versions: observations, latest: observations[1]! } })),
];
const details: TurnJournalDetails = { turnId, sessionId: "ithaca", summary, changes, missing: [], outwardActions: ["approved", "declined"].map((decision, i) => ({ id: i + 1, at: summary.observedAt!, tool: "Bash", action: "git_push", target: "github.com/odysseus/voyage.git", decision: decision as "approved" | "declined", historyRewrite: false, revertible: false })) };

function JournalTheme({ onOperation }: { width: number; onOperation: (body: unknown) => void }) {
  const [root] = useState(() => {
    const root = createBrainUiRoot({ storage: null, request: async (input, init) => {
      const url = new URL(String(input), location.href);
      if (url.pathname.endsWith("/journal")) return Response.json(details);
      if (url.pathname.endsWith("/preview")) return Response.json({ inline: true, before: "Ithaca\r\n", after: url.pathname.includes("/1/") ? "Athena reviews the crossing.\n" : "Athena charts the return.\r\n" });
      if (url.pathname.endsWith("/plan")) return Response.json({ turnId, action: url.searchParams.get("action") ?? "revert", paths: url.searchParams.get("action") === "restore" ? [] : changes.slice(0, 2).map(change => ({ path: change.path, state: "eligible", reason: null, quarantined: false })) });
      if (url.pathname.endsWith("/revert") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); onOperation(body);
        return Response.json({ id: body.id, sourceTurnId: turnId, journalTurnId: "odysseus-operation", action: body.action, state: "complete", undoAvailable: true, error: null, paths: [{ path: body.path, state: "restored", reason: null, quarantined: false }], ...(body.version ? { resolution: { path: body.path, version: body.version, expected: body.expected, otherVersion: body.otherVersion } } : {}) });
      }
      if (url.pathname.endsWith("/revert")) return Response.json({ receipt: null });
      throw new Error(`Unexpected journal fixture request: ${url.pathname}`);
    } });
    root.stores.chat.getState().setActiveSession("ithaca");
    return root;
  });
  useEffect(() => () => root.dispose(), [root]);
  return <ConsumerDocument><BrainUiProvider root={root}>
    <h1>The voyage</h1><h2>Turn receipt</h2><textarea aria-label="Message" defaultValue="Ask Penelope about the shroud." />
    <TurnJournal turnId={turnId} summary={summary} />
  </BrainUiProvider></ConsumerDocument>;
}
const meta = preview.meta({
  title: "Conversation/Journal theme", component: JournalTheme,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, onOperation: fn() },
});
export const Phone = meta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const screen = within(document.body);
    const disclosure = screen.getByRole("button", { name: /3 changed files/ });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(disclosure).toHaveTextContent("1 steering");
    await expect(screen.queryByRole("heading", { name: "Steering" })).toBeNull();
    await expect(disclosure.getBoundingClientRect().height, "journal disclosure target height").toBeGreaterThanOrEqual(44);
    await bounds(disclosure, "journal disclosure");
    disclosure.focus(); await userEvent.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Review notes/voyage.md" });
    const groups = [...document.querySelectorAll("[data-turn-journal] section h3")].map(node => node.textContent);
    await expect(groups.indexOf("Steering")).toBeLessThan(groups.indexOf("Content"));
    await expect(screen.getByText("Review recommended: recorded untrusted input (source event 7).", { exact: true })).toBeVisible();
    await expect(screen.queryByRole("button", { name: /Revert steering/i })).toBeNull();
    await expect(screen.getByRole("heading", { name: "Outward actions" })).toBeVisible();
    await expect(screen.getByText("These receipts record approval, not external completion. External actions are irreversible here; restoring local files cannot undo them.")).toBeVisible();
    for (const decision of ["Approved", "Declined"]) await expect(screen.getByText(`Git push · ${decision} · github.com/odysseus/voyage.git`)).toBeVisible();
    await expect(screen.queryByRole("button", { name: /Revert.*push/i })).toBeNull();
    await accessible(document.querySelector<HTMLElement>("[data-turn-journal]")!);

    for (const path of ["notes/voyage.md", skill, "notes/crossing.md"]) {
      const trigger = screen.getAllByRole("button", { name: `Review ${path}` })[0]!;
      trigger.focus(); await userEvent.keyboard("{Enter}");
      const reader = await screen.findByRole("dialog", { name: "Retained change" });
      const content = within(reader);
      await content.findByText(path === skill ? "Athena reviews the crossing." : "Athena charts the return.", { exact: true });
      await expect(document.activeElement).toBe(content.getByRole("heading", { name: path }));
      await expect(reader.ownerDocument).toBe(document);
      await expect(getComputedStyle(reader).colorScheme).toBe(globals.theme);
      await bounds(reader.querySelector<HTMLElement>(".bk-overlay-surface")!, `${path} reader`);
      await accessible(reader);
      const before = content.getByRole("link", { name: "Download before (32 bytes)" });
      await expect(before).toHaveAttribute("download");
      await expect(before.getAttribute("href")).toContain("/before");
      if (path === skill) await expect(content.getByText("Review recommended: this steering observation follows recorded untrusted input (source event 7).")).toBeVisible();
      if (path === "notes/crossing.md") {
        await expect(content.getByText(/Distinct versions were observed while turns overlapped/)).toBeVisible();
        const keep = content.getByRole("button", { name: "Keep both observations 3 and 4" });
        await expect(keep.getBoundingClientRect().height, "journal conflict target height").toBeGreaterThanOrEqual(44);
        await userEvent.click(content.getByRole("button", { name: "Review observation 4" }));
        await content.findByRole("button", { name: "Keep both observations 4 and 3" });
        await expect(content.getByRole("combobox", { name: "Other observed version" })).toHaveValue("3");
        await userEvent.click(content.getByRole("button", { name: "Keep both observations 4 and 3" }));
        await waitFor(() => expect(args.onOperation).toHaveBeenLastCalledWith(expect.objectContaining({ action: "keep_both", path, version: observations[1], otherVersion: observations[0], expected: observations[1] })));
      } else {
        const revert = await content.findByRole("button", { name: `Revert ${path}` });
        await expect(revert.getBoundingClientRect().height, "journal file revert target height").toBeGreaterThanOrEqual(44);
        await userEvent.click(revert);
        await waitFor(() => expect(args.onOperation).toHaveBeenLastCalledWith(expect.objectContaining({ action: "revert", path })));
      }
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Switching conflict observations changes the selected trigger internally;
      // the component deliberately returns to the original Review control.
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
    }
    await expect(args.onOperation).toHaveBeenCalledTimes(3);
    // Fixture receipts establish UI dispatch only, never real file restoration.
  },
});
export const Desktop = Phone.extend({ args: { width: 1280 } });
