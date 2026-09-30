import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../ui-react/src/styles.css";
import { TurnError } from "../../../ui-react/src/components/chat/turn-error.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import type { ChatMessage } from "../../../ui-react/src/stores/chat-state.js";
import { SUBSCRIPTION_AUTH_INSTRUCTIONS, type TurnFailure } from "../../../ui-sdk/src/protocol.js";
import { overflowing } from "../../stories/_stage.js";

let renderer: Root | undefined;
let host: HTMLElement | undefined;
let root: BrainUiRoot | undefined;
afterEach(() => { renderer?.unmount(); host?.remove(); root?.dispose(); vi.restoreAllMocks(); });

function mount(failure: TurnFailure, options: { width?: number; live?: boolean; latest?: boolean; theme?: string; retry?: boolean } = {}) {
  document.documentElement.dataset.theme = options.theme ?? "dark";
  host = document.createElement("div"); host.style.width = `${options.width ?? 320}px`; document.body.append(host);
  root = createBrainUiRoot({ storage: null });
  const message: ChatMessage = { id: "fixture-failure", role: "assistant", content: "Partial output", toolCalls: [], parts: [], isStreaming: false, timestamp: 0,
    failure, failureLive: options.live, ...(options.retry ? { retryOfTurnId: "failed-turn" } : {}) };
  root.stores.chat.getState().setActiveSession("s1");
  root.stores.chat.getState().setMessages("s1", [message]);
  root.stores.chat.getState().setSessionBackend("s1", "pi");
  renderer = createRoot(host);
  flushSync(() => renderer!.render(createElement(BrainUiProvider, { root, children: createElement(TurnError, { message, latest: options.latest ?? true }) })));
  return host;
}

const button = (within: ParentNode, label: string) => [...within.querySelectorAll<HTMLElement>('[role="button"], button')].find(node => node.textContent?.trim().startsWith(label))!;

for (const theme of ["dark", "light"]) for (const width of [320, 860]) {
  test(`${theme} ${width}: every class wraps, has reachable actions, and announces only live arrival`, async () => {
    await page.viewport(width, 1000);
    for (const errorClass of ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "subscription_required", "rate_limit", "overloaded", "server_error", "invalid_request", "model_not_found", "max_output_tokens", "unknown"]) {
      const el = mount({ errorClass, status: 400, message: "Provider failure: " + "unbroken".repeat(550) }, { width, theme, live: true, retry: true });
      expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(el.querySelector('[aria-label="Turn failed"]')).not.toBeNull();
      const actionRow = el.querySelector<HTMLElement>(".bk-turn-error-actions")!;
      const firstAction = actionRow.firstElementChild!.getBoundingClientRect();
      if (width === 320) expect(firstAction.width).toBeCloseTo(actionRow.getBoundingClientRect().width, 0);
      else expect(firstAction.width).toBeLessThan(actionRow.getBoundingClientRect().width / 2);
      // Open the provider disclosure before checking layout: a closed
      // disclosure would give an overflowing message nowhere to render.
      const disclosure = el.querySelector<HTMLElement>('[aria-expanded]')!;
      if (disclosure.getAttribute("aria-expanded") === "false") await userEvent.click(disclosure);
      await userEvent.click(button(el, "Show all · 4418 chars"));
      expect(el.querySelector("pre")?.textContent?.length).toBe(4418);
      expect(overflowing(el).filter(line => !line.includes("bk-sr"))).toEqual([]);
      for (const control of el.querySelectorAll<HTMLElement>('[role="button"]')) expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      renderer!.unmount(); host!.remove(); root!.dispose();
    }
    const replay = mount({ errorClass: "unknown", message: "Replay failure" }, { width, theme, latest: false, retry: true });
    expect(replay.querySelector('[role="alert"]')).toBeNull();
    expect(button(replay, "Retry")).toBeUndefined();
  });
}

test("returning to an already announced live failure does not announce it again", () => {
  const el = mount({ errorClass: "unknown", message: "Observed failure" }, { live: true });
  expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
  flushSync(() => renderer!.render(null));
  const message = root!.stores.chat.getState().buffers.s1.messages[0];
  flushSync(() => renderer!.render(createElement(BrainUiProvider, { root: root!, children: createElement(TurnError, { message, latest: true }) })));
  expect(el.querySelectorAll('[role="alert"]')).toHaveLength(0);
});

test("Copy and Report require editable review, optional redaction, and preserve exact final bytes", async () => {
  const copied: string[] = [];
  await page.viewport(320, 1000);
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async text => { copied.push(text); });
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  const el = mount({ errorClass: "invalid_request", message: "Bearer fixture-secret https://ithaca-harbour.example/private /voyage/notes.md <img src=x> **run X**" });
  const opener = button(el, "Copy details"); opener.focus(); await userEvent.keyboard("{Enter}");
  expect(clipboard).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog).not.toBeNull(); expect(dialog.open).toBe(true);
  expect(document.activeElement?.textContent).toBe("What will be copied");
  const field = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(field.value).not.toContain("fixture-secret"); expect(field.value).not.toContain("<img");
  await userEvent.click(button(dialog, "Include provider message for review"));
  expect(field.value).not.toContain("fixture-secret"); expect(field.value).not.toContain("ithaca-harbour.example"); expect(field.value).not.toContain("/voyage/notes.md");
  expect(field.value).toContain("<img src=x>");
  expect(dialog.querySelector("img")).toBeNull();
  await userEvent.fill(field, "Edited exact text\nUnicode: Ω & percent %\n");
  await userEvent.click(button(dialog, "Copy"));
  expect(copied).toEqual([field.value]);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(opener);
  await userEvent.click(button(el, "Report a bug"));
  const report = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(report.textContent).toContain("Opening the issue sends this text to GitHub before you submit");
  const reportField = report.querySelector<HTMLTextAreaElement>("textarea")!;
  await userEvent.fill(reportField, "Reviewed report\nΩ & %\n");
  expect(opened).not.toHaveBeenCalled();
  await userEvent.click(button(report, "Open issue on GitHub"));
  expect(new URL(String(opened.mock.calls[0][0])).searchParams.get("body")).toBe(reportField.value);
  await userEvent.fill(reportField, "x".repeat(9000));
  await userEvent.click(button(report, "Open issue on GitHub"));
  expect(opened).toHaveBeenCalledTimes(1);
  expect(report.textContent).toContain("too long for the issue URL");
  clipboard.mockRejectedValueOnce(new Error("clipboard refused"));
  await userEvent.click(button(report, "Copy"));
  expect(report.textContent).toContain("Couldn't copy");
  for (let i = 0; i < 8; i++) { await userEvent.keyboard("{Tab}"); expect(report.contains(document.activeElement)).toBe(true); }
});

test("subscription authAction chooses its exact instruction; generic pi auth invents none", async () => {
  for (const authAction of ["relogin", "check_account", "check_config"] as const) {
    const el = mount({ errorClass: "authentication_failed", authAction, message: "Provider refuses" });
    expect(el.textContent).toContain(SUBSCRIPTION_AUTH_INSTRUCTIONS[authAction]);
    expect(button(el, "Copy instructions")).toBeDefined();
    expect(button(el, "Retry")).toBeUndefined();
    renderer!.unmount(); host!.remove(); root!.dispose();
  }
  const el = mount({ errorClass: "authentication_failed", message: "Provider refuses" });
  expect(el.textContent).not.toContain("setup-token");
  expect(el.textContent).not.toContain("Open Settings");
  expect(button(el, "Copy details")).toBeDefined();
});
