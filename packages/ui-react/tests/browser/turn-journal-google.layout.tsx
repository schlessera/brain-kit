import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { JournalOutwardAction, TurnJournalDetails, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { TurnJournal } from "../../src/components/chat/turn-journal.js";

// The turn journal's two Google classes (#4216) under the consumer stylesheet
// alone (`@schlessera/brain-ui-react/styles.css`), the only CSS a ui-react host
// loads: the kit list's rhythm must come from the kit tokens it imports.
const turnId = "odysseus-journal", draft = "r-8f2c41d9e0b7a6c5", at = Date.UTC(2026, 6, 12);
const summary: TurnJournalSummary = { state: "complete", changedFiles: 1, steeringFiles: 0, keptFiles: 1, costUsd: null, costIsEstimate: null, profile: "governed", actor: "interactive", model: null, policyHash: null, sharedAttribution: false, observedAt: at };
const version = { kind: "file" as const, mode: 420, bytes: 32, hash: "odysseus-retained", ignored: false };
const reversible = (id: number, operation: string, decision: "allowed" | "approved" | "declined", target: string, admission: "session_allowance" | null) =>
  ({ id, at, callId: `call-${id}`, tool: "brain_google_gmail", operation, effect: "reversible" as const, target, tainted: true, decision, admission, revertible: false as const, undoAvailable: false as const });
const google = (id: number, decision: JournalOutwardAction["decision"], target: string, operation: string): JournalOutwardAction =>
  ({ id, at, tool: "brain_google_gmail", action: "google_write", target, decision, historyRewrite: false, revertible: false, google: { callId: `call-${id}`, operation, effect: "irreversible" } });
const details: TurnJournalDetails = { turnId, sessionId: "ithaca", summary, missing: [],
  changes: [{ sequence: 2, path: "notes/voyage.md", scope: "", class: "content", actor: "agent", before: version, after: version, overlappingTurnIds: [] }],
  googleActions: [reversible(11, "gmail.modify", "allowed", "gmail.modify", "session_allowance"), reversible(12, "gmail.draft.save", "approved", draft, null), reversible(13, "gmail.modify", "declined", "gmail.modify", null)],
  outwardActions: [google(21, "approved", draft, "gmail.draft.send"), google(22, "refused", "gmail.trash", "gmail.trash"),
    { id: 23, at, tool: "Bash", action: "git_push", target: "github.com/odysseus/voyage.git", decision: "approved", historyRewrite: false, revertible: false }] };

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, previousTheme: string | undefined;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previousTheme;
  await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120);
});
for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}: reversible Google calls sit ahead of the outward receipts and fit`, async () => {
    viewport = { width: innerWidth, height: innerHeight }; previousTheme = document.documentElement.dataset.theme;
    outer = await commands.formViewport(width, 1400); await page.viewport(width, 1400); document.documentElement.dataset.theme = theme;
    const requests: string[] = [];
    root = createBrainUiRoot({ storage: null, request: async input => {
      const path = new URL(String(input), location.href).pathname; requests.push(path);
      if (path.endsWith("/journal")) return Response.json(details);
      if (path.endsWith("/plan")) return Response.json({ turnId, action: "revert", paths: [] });
      if (path.endsWith("/revert")) return Response.json({ receipt: null });
      throw new Error(`Unexpected journal request: ${path}`);
    } });
    root.stores.chat.getState().setActiveSession("ithaca");
    host = document.createElement("div"); host.style.cssText = `width:${width}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`; document.body.append(host); renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><div className="px-4 md:px-6"><div className="mx-auto max-w-3xl"><p>Athena recorded the return.</p><TurnJournal turnId={turnId} summary={summary} /></div></div></BrainUiProvider>));
    await userEvent.click(page.getByRole("button", { name: /changed file/ }));
    await expect.poll(() => host!.querySelector("[data-google-journal-calls]")).not.toBeNull();
    const section = host.querySelector<HTMLElement>("[data-google-journal-calls]")!, list = section.querySelector<HTMLElement>("ul")!;
    const outward = [...host.querySelectorAll("h3")].find(h => h.textContent === "Outward actions")!.closest("section")!;
    expect(section.compareDocumentPosition(outward) & Node.DOCUMENT_POSITION_FOLLOWING, "reversible calls come first").toBeTruthy();
    expect(getComputedStyle(list).rowGap, "the kit list keeps the journal's row rhythm under consumer CSS").toBe(matchMedia("(any-pointer: coarse)").matches ? "16px" : "8px");
    expect(getComputedStyle(list).marginTop).toBe("8px");
    expect(getComputedStyle(list).listStyleType).toBe("none");
    expect([...outward.querySelectorAll("li")].map(li => li.textContent?.trim()).slice(0, 2)).toEqual([`Gmail send · Approved · ${draft}`, "Gmail trash · Refused"]);
    expect(host.scrollWidth, "journal has no horizontal overflow").toBeLessThanOrEqual(host.clientWidth + 1);
    for (const block of [section, outward as HTMLElement]) expect(block.scrollWidth, "each Google block fits the journal column").toBeLessThanOrEqual(block.clientWidth + 1);
    await commands.formViewport(width, Math.ceil(host.scrollHeight) + 32); await page.viewport(width, Math.ceil(host.scrollHeight) + 32);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/turn-journal-google/journal-${theme}-${width}.png` });
    expect(requests.filter(path => !/\/(journal|plan|revert)$/.test(path))).toEqual([]);
  });
}
