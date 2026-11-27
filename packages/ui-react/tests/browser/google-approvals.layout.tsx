/**
 * #4212: remembered Gmail approvals in the real Settings panel, Security tab,
 * beside the always-allowed tools, at a phone and a desktop width in both
 * themes. The list must sit inside its column without widening the page, and
 * a revoke must reach the owner-only route and move focus as the kit's rule
 * says. Captures are review images for the placement sign-off, not baselines.
 */
import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import type { TrustSettingsRead } from "../../src/lib/trust-settings.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";

const trustRead = {
  revision: "0", policyHash: null, error: null, rules: [], origins: [], repositories: [], mutationAllowed: false,
  capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: false, readOnlyReason: null },
} satisfies TrustSettingsRead;

const ODYSSEUS = "odysseus@example.com", PENELOPE = "penelope@example.com";
const approval = (id: string, account: string, operation: string, entity: string, at: Date) =>
  ({ id, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: account, operation, entity, approved_at: at.getTime() });
const APPROVALS = [
  approval("appr-drafts", ODYSSEUS, "gmail.draft.save", "drafts", new Date(2026, 6, 9, 8, 5)),
  approval("appr-suitors", PENELOPE, "gmail.modify", "unlabel:Label_7", new Date(2026, 6, 9, 8, 5)),
  approval("appr-voyage", ODYSSEUS, "gmail.modify", "label:Label_12", new Date(2026, 6, 10, 17, 40)),
  approval("appr-archive", ODYSSEUS, "gmail.modify", "archive", new Date(2026, 6, 11, 9, 14)),
];

for (const width of [320, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`Security tab: remembered Gmail approvals at ${width} ${theme}`, async ctx => {
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    const outer = await commands.formViewport(width, 900);
    await page.viewport(width, 900);
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); host.style.height = "900px"; document.body.append(host);
    let approvals = APPROVALS;
    const sent: Array<{ path: string; method: string; body: unknown }> = [];
    const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
      const path = new URL(String(url), location.href).pathname;
      sent.push({ path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (path.endsWith("/trust-settings")) return Response.json(trustRead);
      if (path.endsWith("/agent-policy")) return Response.json({ error: "Not configured" }, { status: 404 });
      if (path.endsWith("/tool-permissions")) return Response.json({ tools: ["Bash"] });
      if (path.endsWith("/google/approvals")) return Response.json({ approvals });
      if (path.endsWith("/google/approvals/revoke")) {
        const { id } = JSON.parse(String(init?.body)) as { id: string };
        approvals = approvals.filter(row => row.id !== id);
        return Response.json({ revoked: true });
      }
      return Response.json({ credentials: [], principals: [] });
    } });
    ui.stores.ui.setState({ theme });
    ui.stores.ui.getState().openSettings("security");
    const react = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
      if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    flushSync(() => react.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={() => {}} /></BrainUiProvider>));
    await import("../../src/components/settings/passkey-tab.js");
    await expect.poll(() => document.querySelector("[data-google-approvals]")?.getAttribute("data-google-approvals")).toBe("ready");
    await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain("Always-allowed tools");

    const panel = page.getByRole("tabpanel").element() as HTMLElement;
    const section = document.querySelector<HTMLElement>("[data-google-approvals-section]")!;
    const list = section.querySelector<HTMLElement>("[data-google-approvals]")!;
    const rows = () => [...list.querySelectorAll<HTMLElement>('[role="button"][data-google-target]')];
    expect(rows().map(row => row.getAttribute("aria-label")), "GOOGLE_SETTINGS_BROWSER_ROWS").toEqual([
      `Revoke Archive for ${ODYSSEUS}`, `Revoke Add label Label_12 for ${ODYSSEUS}`, `Revoke Save drafts for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`,
    ]);
    // After the always-allowed tools, in the same column.
    const tools = [...panel.querySelectorAll("*")].find(node => node.textContent === "Always-allowed tools")!;
    expect(tools.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING, "GOOGLE_SETTINGS_AFTER_TOOL_GRANTS").toBeTruthy();

    // No horizontal overflow: not the page, not the column, not the list, not a row.
    const fits = () => {
      const p = panel.getBoundingClientRect(), s = section.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= innerWidth,
        column: s.left >= p.left - 0.5 && s.right <= p.right + 0.5,
        list: list.scrollWidth <= list.clientWidth + 0.5,
        rows: rows().every(row => { const r = row.getBoundingClientRect(); return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && row.scrollWidth <= row.clientWidth + 0.5; }),
      };
    };
    expect(fits(), "GOOGLE_SETTINGS_NO_HORIZONTAL_OVERFLOW").toEqual({ page: true, column: true, list: true, rows: true });
    for (const row of rows()) expect(row.getBoundingClientRect().height, "a whole-row revoke target").toBeGreaterThanOrEqual(44);

    // A review capture of the tab with the section scrolled into view, below the tool grants.
    section.scrollIntoView({ block: "end" });
    await new Promise(done => requestAnimationFrame(() => done(null)));
    await page.screenshot({ path: `../../.vitest-attachments/google-standing/settings-${theme}-${width}.png` });
    expect(fits(), "GOOGLE_SETTINGS_NO_HORIZONTAL_OVERFLOW (scrolled)").toEqual({ page: true, column: true, list: true, rows: true });

    // Revoke from the keyboard: the route gets the id, and focus moves to the next row.
    const voyage = rows()[1]!;
    voyage.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => rows().length).toBe(3);
    expect(sent.filter(row => row.path.endsWith("/google/approvals/revoke")), "GOOGLE_SETTINGS_BROWSER_REVOKE").toEqual([{ path: "/api/google/approvals/revoke", method: "POST", body: { id: "appr-voyage" } }]);
    expect(document.activeElement?.getAttribute("aria-label"), "GOOGLE_SETTINGS_BROWSER_FOCUS_NEXT").toBe(`Revoke Save drafts for ${ODYSSEUS}`);
  });
}

// #4212 round 2: the kit's failed and partial states, placed in the same
// Security tab at a phone width. The failed state must draw the red error box
// and Try again, and claim nothing is loading; the partial state must draw
// the count notice under the rows and never "None yet". Neither may widen the
// column.
const CALENDAR = approval("appr-calendar", ODYSSEUS, "calendar.event.create", "events", new Date(2026, 6, 11, 9, 14));
for (const [kind, answer] of [
  ["failed", () => Response.json({ error: "Internal" }, { status: 500 })],
  ["partial", () => Response.json({ approvals: [...APPROVALS.slice(2), CALENDAR] })],
] as const) for (const theme of ["dark", "light"] as const) {
  test(`Security tab: remembered Gmail approvals, ${kind}, at 320 ${theme}`, async ctx => {
    const width = 320;
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    const outer = await commands.formViewport(width, 900);
    await page.viewport(width, 900);
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); host.style.height = "900px"; document.body.append(host);
    const ui = createBrainUiRoot({ storage: null, request: async url => {
      const path = new URL(String(url), location.href).pathname;
      if (path.endsWith("/trust-settings")) return Response.json(trustRead);
      if (path.endsWith("/agent-policy")) return Response.json({ error: "Not configured" }, { status: 404 });
      if (path.endsWith("/tool-permissions")) return Response.json({ tools: ["Bash"] });
      if (path.endsWith("/google/approvals")) return answer();
      return Response.json({ credentials: [], principals: [] });
    } });
    ui.stores.ui.setState({ theme });
    ui.stores.ui.getState().openSettings("security");
    const react = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
      if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    flushSync(() => react.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={() => {}} /></BrainUiProvider>));
    await import("../../src/components/settings/passkey-tab.js");
    await expect.poll(() => document.querySelector("[data-google-approvals]")?.getAttribute("data-google-approvals")).toBe(kind === "failed" ? "failed" : "ready");
    await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain("Always-allowed tools");

    const panel = page.getByRole("tabpanel").element() as HTMLElement;
    const section = document.querySelector<HTMLElement>("[data-google-approvals-section]")!;
    const list = section.querySelector<HTMLElement>("[data-google-approvals]")!;
    expect(list.textContent, "GOOGLE_SETTINGS_BROWSER_NO_EMPTY_CLAIM").not.toContain("None yet");
    if (kind === "failed") {
      expect(list.querySelector("[aria-busy]"), "GOOGLE_SETTINGS_BROWSER_FAILED_NOT_BUSY").toBeNull();
      expect(list.querySelector("[data-google-failed]")?.textContent).toContain("Couldn't load remembered approvals.");
      const retry = page.getByRole("button", { name: "Try again" }).element() as HTMLElement;
      expect(section.contains(retry), "Try again sits in the section").toBe(true);
    } else {
      expect(list.querySelector("[data-google-unshown]")?.textContent, "GOOGLE_SETTINGS_BROWSER_PARTIAL").toBe("1 remembered approval can't be shown here. brain google approvals lists it.");
      const rows = [...list.querySelectorAll<HTMLElement>('[role="button"][data-google-target]')];
      expect(rows.map(row => row.getAttribute("aria-label"))).toEqual([`Revoke Archive for ${ODYSSEUS}`, `Revoke Add label Label_12 for ${ODYSSEUS}`]);
      expect(list.querySelector("[data-google-unshown]")!.getBoundingClientRect().top, "the notice is under the rows").toBeGreaterThanOrEqual(rows.at(-1)!.getBoundingClientRect().bottom);
    }
    const fits = () => {
      const p = panel.getBoundingClientRect(), s = section.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= innerWidth,
        column: s.left >= p.left - 0.5 && s.right <= p.right + 0.5,
        list: list.scrollWidth <= list.clientWidth + 0.5,
        children: [...list.querySelectorAll<HTMLElement>("*")].every(node => { const r = node.getBoundingClientRect(); return r.width === 0 || (r.left >= s.left - 0.5 && r.right <= s.right + 0.5); }),
      };
    };
    expect(fits(), "GOOGLE_SETTINGS_STATE_NO_HORIZONTAL_OVERFLOW").toEqual({ page: true, column: true, list: true, children: true });
    section.scrollIntoView({ block: "end" });
    await new Promise(done => requestAnimationFrame(() => done(null)));
    await page.screenshot({ path: `../../.vitest-attachments/google-standing/settings-${kind}-${theme}-${width}.png` });
  });
}
