import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";

// Send bug report (#598) in real Chromium with the published stylesheet: the
// row sibling's measured targets, its visible label either side of 480px, the
// review sheet at 320px and desktop in both themes, and keyboard/touch
// activation. Only transports are fixtures; `window.open` is a stub, so no
// test opens GitHub.
class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}

const T0 = Date.parse("2026-07-12T06:00:00Z");
const LONG = "Penelope's loom ledger for the harbour at Ithaca, reconciled against every suitor's unpaid wine bill since the tenth year";
const run = (over: Record<string, unknown>) => ({
  origin: "cron", name: "cron", sessionId: null, jobName: null, startedAt: T0, endedAt: T0 + 9000, outcome: "success",
  running: false, durationMs: 9000, costUsd: 0, effectiveCostUsd: 0, billingMode: "subscription", failureReason: null,
  detailPruned: false, ...over,
});
const HISTORY = [
  run({ runId: "run-harbour", jobName: "Harbour-ledger sync", outcome: "timeout", durationMs: 242_000,
    failureReason: "/home/penelope/loom/ledger.md ".repeat(20) }),
  run({ runId: "run-loom", origin: "session", name: "Ask about the loom order", sessionId: "session-telemachus", outcome: "error" }),
  run({ runId: "run-long", jobName: LONG, outcome: "interrupted", detailPruned: true }),
  run({ runId: "run-digest", jobName: "Weekly digest" }),
];

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
let outerBefore: { width: number; height: number } | undefined;
let frameBefore: { width: number; height: number } | undefined;
let opened: string[] = [];

beforeEach(() => {
  opened = [];
  vi.stubGlobal("WebSocket", FixtureSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/activity/runs?")) return Response.json({ live: [], history: HISTORY });
    if (/\/activity\/runs\/run-harbour/.test(url)) return Response.json({ runId: "run-harbour", detailPruned: false, spans: [], events: [] });
    if (url.includes("/activity/rollups")) return Response.json({ timeZone: "UTC", days: [] });
    if (url.includes("/activity/inbox")) return Response.json({ intents: [] });
    if (url.endsWith("/status")) return Response.json({ healthy: true, uptime: 1, version: "a1b2c3d", software: { release: "0.41.2", sourceCommit: "a1b2c3d" }, cronJobs: [], activeSession: false });
    return Response.json({ entries: [], providers: [], stale: false, error: null });
  }));
  vi.stubGlobal("open", (url: string) => { opened.push(url); return null; });
});

afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  renderer = undefined; ui = undefined; host = undefined; style = undefined;
  vi.unstubAllGlobals();
  if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height);
  if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
});

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until<T>(read: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mount(width: number, height: number, theme: "dark" | "light") {
  frameBefore = { width: window.innerWidth, height: window.innerHeight };
  outerBefore = await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;display:flex;flex-direction:column;width:${width}px;height:${height}px`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null });
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui}><ActivityPage /></BrainUiProvider>));
  await until(() => host!.querySelectorAll("button[data-report-run]").length === 3, "three report buttons");
  await nextFrame();
  return host;
}

const sibling = (root: HTMLElement, runId: string) => root.querySelector<HTMLButtonElement>(`button[data-report-run="${runId}"]`)!;
const rowOf = (button: HTMLElement) => button.closest("[data-failed-run]")!.querySelector<HTMLElement>("[role=button]")!;
const visible = (el: HTMLElement) => [...el.querySelectorAll("span")].filter((s) => s.getClientRects().length > 0).map((s) => s.textContent);
const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of [[320, 640], [479, 800], [480, 800], [1280, 800]] as const) {
    test(`${theme} ${width}px: the row sibling is a separate ≥44px target with the right visible label`, async () => {
      const root = await mount(width, height, theme);
      const rows: DOMRect[] = [];
      for (const id of ["run-harbour", "run-loom", "run-long"]) {
        const button = sibling(root, id);
        const rect = button.getBoundingClientRect();
        const row = rowOf(button).getBoundingClientRect();
        expect(rect.width, `${id} width`).toBeGreaterThanOrEqual(44);
        expect(rect.height, `${id} height`).toBeGreaterThanOrEqual(44);
        expect(row.height, `${id} row height`).toBeGreaterThanOrEqual(44);
        expect(intersects(rect, row), `${id} targets do not overlap`).toBe(false);
        expect(rect.left - row.right, `${id} gap`).toBeGreaterThanOrEqual(8);
        expect(document.elementFromPoint(rect.left + 2, rect.top + 2) && button.contains(document.elementFromPoint(rect.left + 2, rect.top + 2)), `${id} corner hits the button`).toBe(true);
        expect(visible(button)).toEqual([width < 480 ? "Report" : "Send bug report"]);
        expect(button.getAttribute("aria-label")).toMatch(/^Send bug report: .+, (timeout|error|interrupted), .+/);
        rows.push(row);
      }
      expect(root.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
      const long = sibling(root, "run-long").getBoundingClientRect();
      expect(long.right, "long title row keeps its button on screen").toBeLessThanOrEqual(width);
    });

    test(`${theme} ${width}px: the review sheet fits, wraps long text and returns focus`, async () => {
      const root = await mount(width, height, theme);
      const button = sibling(root, "run-harbour");
      button.focus();
      await userEvent.keyboard("{Enter}");
      const dialog = await until(() => document.querySelector<HTMLDialogElement>("dialog[open]"), "the review dialog");
      expect(document.activeElement?.tagName).toBe("H2");
      const add = await until(() => [...dialog.querySelectorAll<HTMLElement>("[role=button]")].find((b) => b.textContent?.startsWith("+ Add failure reason")), "the inclusion");
      await userEvent.click(add);
      await nextFrame();
      const rect = dialog.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      const textarea = dialog.querySelector("textarea")!;
      expect(textarea.value).toContain("Failure reason (review before sharing)");
      expect(textarea.scrollWidth, "long text wraps inside the field").toBeLessThanOrEqual(textarea.clientWidth + 1);
      for (const control of dialog.querySelectorAll<HTMLElement>("[role=button]:not([aria-disabled=true])")) {
        const box = control.getBoundingClientRect();
        if (box.width === 0) continue;
        expect(box.height, `${control.textContent} height`).toBeGreaterThanOrEqual(44);
      }
      const openGitHub = [...dialog.querySelectorAll<HTMLElement>("[role=button]")].find((b) => b.textContent?.startsWith("Open issue on GitHub"))!;
      await userEvent.click(openGitHub);
      await userEvent.click(openGitHub);
      expect(opened, "a double tap opens one draft").toHaveLength(1);
      await userEvent.keyboard("{Escape}");
      await until(() => !document.querySelector("dialog[open]"), "the dialog to close");
      expect(document.activeElement).toBe(button);
    });
  }
}
