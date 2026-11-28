// Render smoke tests for Devices and agents, settings forms and views, and connector approvals: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeSettingsDom, unregisterSmokeSettingsDom } from "./smoke-settings-dom.js";
registerSmokeSettingsDom();

import { installSmokeHarness, changeControlledInput, deferred, flushPromises, policyFactsResponse, principalResponse, render, usePrincipalStore, useUIStore } from "./smoke-harness.js";
import { PushSwitch } from "../../src/components/activity/push-switch.js";
import { LoginForm } from "../../src/components/connectivity/login-form.js";
import { PasskeyList } from "../../src/components/settings/passkey-list.js";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import type { SkillEntry } from "../../src/lib/api-client.js";
import { ApifyView } from "../../src/components/settings/apify-view.js";
import type { ApifySettingsRead } from "@schlessera/brain-ui-sdk/protocol";
import { SkillEditor, SkillsList } from "../../src/components/settings/skills-list.js";
import { WebSearchChain } from "../../src/components/settings/web-search-chain.js";
import { describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { PrincipalList } from "../../src/components/settings/principal-list.js";
import { AccountsList } from "../../src/components/settings/pi-accounts-list.js";
import { ToolPermissionsList } from "../../src/components/settings/tool-permissions-list.js";
import { ModelsCatalogView } from "../../src/components/settings/models-list.js";
import { AddForm } from "../../src/components/quick-actions/add-form.js";
import { BriefingOutput, StreamingOutput } from "../../src/components/quick-actions/streaming-output.js";
import { DevicesAgentsTab } from "../../src/components/settings/devices-agents-tab.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { AppShell } from "../../src/components/layout/app-shell.js";

installSmokeHarness(unregisterSmokeSettingsDom);

function SettingsHarness() {
  const [open, setOpen] = useState(true);
  return (
    <AppShell>
      <SettingsPanel open={open} onClose={() => setOpen(false)} />
    </AppShell>
  );
}

function StoreSettingsHarness() {
  const open = useUIStore((state) => state.settingsPanelOpen);
  const setOpen = useUIStore((state) => state.setSettingsPanelOpen);
  return (
    <AppShell>
      <SettingsPanel open={open} onClose={() => setOpen(false)} />
    </AppShell>
  );
}

const dialogEscapeTarget = (page: ReturnType<typeof render>) => page.getByRole("alertdialog");

function withPolicyFacts(request: typeof fetch): typeof fetch {
  return ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, "https://ithaca.example").pathname === "/api/agent-policy"
      ? Promise.resolve(policyFactsResponse()) : request(input, init);
  }) as typeof fetch;
}

describe("DevicesAgentsTab", () => {
  test("renders active rows with every timestamp, marks this device, and has an empty state", async () => {
    const now = Date.UTC(2026, 8, 14, 12);
    Date.now = () => now;
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL) =>
      principalResponse([
        {
          id: "owner-principal",
          kind: "owner",
          auth_method: "password",
          label: "Firefox on laptop",
          created_at: now - 2 * 60 * 60 * 1000,
          last_seen_at: now - 5 * 60 * 1000,
          expires_at: now + 6 * 24 * 60 * 60 * 1000,
          is_own: true,
        },
        {
          id: "agent-principal",
          kind: "agent",
          auth_method: "delegated",
          label: "Build agent",
          created_at: now - 60 * 1000,
          last_seen_at: null,
          expires_at: now + 24 * 60 * 60 * 1000,
          is_own: false,
        },
      ])) as typeof fetch);

    const page = render(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);

    expect(page.getByText("Firefox on laptop")).toBeTruthy();
    expect(page.getByText("Build agent")).toBeTruthy();
    expect(page.getByText("This device")).toBeTruthy();
    expect(page.getByText("Agent")).toBeTruthy();
    // Searching the whole page for each string passes even when Created and
    // Expires are swapped, which is exactly the mis-mapping this is for. Read
    // each value from its own <dt>'s sibling, per row.
    const valueFor = (rowLabel: string, field: string): string | null => {
      const row = page.getByText(rowLabel).closest("li, div[data-principal-row]");
      const terms = [...(row?.querySelectorAll("dt") ?? [])];
      const dt = terms.find((node) => node.textContent?.trim() === field);
      return dt?.nextElementSibling?.textContent?.trim() ?? null;
    };

    expect(valueFor("Firefox on laptop", "Created")).toBe("2h ago");
    expect(valueFor("Firefox on laptop", "Last seen")).toBe("5m ago");
    expect(valueFor("Firefox on laptop", "Expires")).toBe("in 6d");
    expect(valueFor("Build agent", "Created")).toBe("1m ago");
    expect(valueFor("Build agent", "Last seen")).toBe("Never");
    expect(valueFor("Build agent", "Expires")).toBe("in 1d");
    expect(page.queryByText("No active devices or agents.")).toBeNull();

    cleanup();
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL) =>
      principalResponse([])) as typeof fetch);
    const emptyPage = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(emptyPage.getByText("No active devices or agents.")).toBeTruthy();
  });

  test("shows a minted credential once and never restores it after dismissal or refetch", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let listRequests = 0;
    globalThis.fetch = withPolicyFacts((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({
          id: "new-agent",
          label: "Release helper",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "one-time-secret-value",
        });
      }
      listRequests++;
      return principalResponse(
        listRequests === 1
          ? []
          : [
              {
                id: "new-agent",
                kind: "agent",
                auth_method: "delegated",
                label: "Release helper",
                created_at: Date.now(),
                expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
                last_seen_at: null,
                is_own: false,
              },
            ]
      );
    }) as typeof fetch);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });

    const page = render(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Release helper");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));
    await act(flushPromises);

    expect(page.getByRole("alertdialog")).toBeTruthy();
    expect(page.getByText("This is the only time you will see this value.")).toBeTruthy();
    expect(page.getByText("one-time-secret-value")).toBeTruthy();
    expect(page.getByRole("button", { name: "Done" }).getAttribute("aria-disabled")).toBe("true");
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    dialogEscapeTarget(page).dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(page.getByText("one-time-secret-value")).toBeTruthy();

    fireEvent.click(page.getByRole("button", { name: "Copy credential" }));
    await act(flushPromises);
    expect(copied).toEqual(["one-time-secret-value"]);
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("one-time-secret-value")).toBeNull();
    expect(page.getByText("Release helper")).toBeTruthy();

    page.rerender(
      <AppShell>
        <DevicesAgentsTab active={false} />
      </AppShell>
    );
    page.rerender(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);
    expect(page.queryByText("one-time-secret-value")).toBeNull();
    expect(requests.some(({ init }) => init?.body === JSON.stringify({ label: "Release helper", ttlDays: 7 }))).toBe(true);
  });

  test("mounts the one-time value at the shell, which outlives the panel's own close control", async () => {
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          id: "protected-agent",
          label: "Protected agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "protected-one-time-value",
        });
      }
      return principalResponse([]);
    }) as typeof fetch);
    useUIStore.setState({ settingsTab: "devices" });

    const page = render(<SettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Protected agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));
    await act(flushPromises);

    const dialog = page.getByRole("alertdialog");
    expect(page.container.contains(dialog), "credential belongs to the app shell").toBe(true);
    expect(dialog.closest('[data-panel="Settings"], section[aria-label="Settings"]'), "credential outlives the Settings subtree").toBeNull();
    expect(page.getByText("protected-one-time-value")).toBeTruthy();
    // The test DOM takes the desktop pane (its window is 1024px wide), whose
    // Close control is live even while the credential is unacknowledged: the
    // dialog is the shell's, not the tab's, so closing the panel loses
    // nothing. The drawer's refusal of a stray backdrop click or Escape while
    // protected is slide-panel.test.tsx's.
    fireEvent.click(page.getByRole("button", { name: "Close" }));
    expect(page.queryByRole("tab", { name: "Security" })).toBeNull();
    expect(page.getByText("protected-one-time-value")).toBeTruthy();

    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByRole("alertdialog")).toBeNull();
    expect(usePrincipalStore.getState().oneTimeCredential).toBeNull();
  });

  test("keeps a delayed mint response after its tab unmounts", async () => {
    const mint = deferred<Response>();
    globalThis.fetch = withPolicyFacts((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return mint.promise;
      if (String(input).endsWith("/auth/passkey/list")) {
        return Response.json({ credentials: [] });
      }
      return principalResponse([]);
    }) as typeof fetch);
    useUIStore.setState({ settingsTab: "devices" });

    const page = render(<SettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Delayed agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));

    const securityTab = page.getByRole("tab", { name: "Security" });
    expect(securityTab.hasAttribute("disabled")).toBe(true);
    act(() => useUIStore.getState().setSettingsTab("security"));
    expect(useUIStore.getState().settingsTab).toBe("security");
    // Suspense hides the old tab while the lazy Security tab loads, so an
    // absent heading does NOT prove the devices tab unmounted — and this test
    // only means something if it did. Wait for the new tab's own content, and
    // for the mint form to be gone, before resolving.
    await act(flushPromises);
    await waitFor(() => {
      expect(page.queryByLabelText("Label")).toBeNull();
    });

    await act(async () => {
      mint.resolve(
        Response.json({
          id: "delayed-agent",
          label: "Delayed agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "delayed-one-time-value",
        })
      );
      await flushPromises();
    });

    expect(page.getByText("delayed-one-time-value")).toBeTruthy();

    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("delayed-one-time-value")).toBeNull();
  });

  test("keeps a delayed mint response after a real rail press leaves Settings", async () => {
    const mint = deferred<Response>();
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return mint.promise;
      return principalResponse([]);
    }) as typeof fetch);
    useUIStore.setState({ settingsPanelOpen: true, settingsTab: "devices" });

    const page = render(<StoreSettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Sidebar agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));

    // Rail Settings is the current destination and never closes (D52 N3), so
    // the panel is left through another destination.
    const rail = page.container.querySelector<HTMLElement>('nav[aria-label="Primary"].tablet\\:flex')!;
    const chatButton = within(rail).getByRole("tab", { name: /^Chat/ });
    chatButton.focus();
    expect(document.activeElement).toBe(chatButton);
    fireEvent.click(chatButton);
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(page.queryByLabelText("Label")).toBeNull();

    await act(async () => {
      mint.resolve(
        Response.json({
          id: "sidebar-agent",
          label: "Sidebar agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "sidebar-one-time-value",
        })
      );
      await flushPromises();
    });

    expect(page.getByRole("alertdialog")).toBeTruthy();
    expect(page.getByText("sidebar-one-time-value")).toBeTruthy();
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("sidebar-one-time-value")).toBeNull();
  });

  test("revokes the selected row and warns before revoking this device", async () => {
    const now = Date.now();
    const requests: Array<{ url: string; method: string | undefined }> = [];
    globalThis.fetch = withPolicyFacts((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (init?.method === "DELETE") return Response.json({ ok: true });
      return principalResponse([
        {
          id: "own/id",
          kind: "owner",
          auth_method: "password",
          label: "Current laptop",
          created_at: now,
          expires_at: now + 60_000,
          last_seen_at: now,
          is_own: true,
        },
        {
          id: "phone/id",
          kind: "owner",
          auth_method: "passkey",
          label: "Phone",
          created_at: now,
          expires_at: now + 60_000,
          last_seen_at: now,
          is_own: false,
        },
      ]);
    }) as typeof fetch);
    const confirmations: string[] = [];
    window.confirm = (message?: string) => {
      confirmations.push(message ?? "");
      return message?.startsWith("That device") ?? false;
    };

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    fireEvent.click(page.getByRole("button", { name: "Revoke Phone" }));
    await act(flushPromises);
    expect(confirmations[0]).toContain("That device will be signed out immediately");
    expect(requests).toContainEqual({
      url: "/api/auth/principals/phone%2Fid",
      method: "DELETE",
    });
    expect(page.queryByText("Phone")).toBeNull();

    const deletesBeforeOwn = requests.filter(({ method }) => method === "DELETE").length;
    fireEvent.click(page.getByRole("button", { name: "Revoke Current laptop" }));
    expect(confirmations[1]).toContain(
      "This device will be signed out immediately, and you will return to sign in"
    );
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(deletesBeforeOwn);
  });

  test("renders an HTML-shaped label as bounded text, never markup", async () => {
    const malicious = '<img src=x onerror="alert(1)">' + "x".repeat(80);
    const displayed = Array.from(malicious).slice(0, 64).join("");
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL) =>
      principalResponse([
        {
          id: "html-label",
          kind: "agent",
          auth_method: "delegated",
          label: malicious,
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          last_seen_at: null,
          is_own: false,
        },
      ])) as typeof fetch);

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(page.getByText(displayed).textContent).toBe(displayed);
    expect(page.baseElement.textContent).not.toContain(malicious);
    expect(page.baseElement.querySelector("img")).toBeNull();
  });

  test("explains ambient auth instead of showing a broken or empty list", async () => {
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL) =>
      Response.json({ error: "Principal management is not enabled" }, { status: 400 })) as typeof fetch);

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(
      page.getByText(
        "Devices and agents can only be managed when password authentication is enabled."
      )
    ).toBeTruthy();
    expect(page.queryByText("No active devices or agents.")).toBeNull();
  });

  test("surfaces a failed request as an error rather than an empty list", async () => {
    globalThis.fetch = withPolicyFacts((async (_input: RequestInfo | URL) =>
      Response.json({ error: "Database unavailable" }, { status: 500 })) as typeof fetch);

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(page.getByRole("alert").textContent).toBe("Database unavailable");
    expect(page.queryByText("No active devices or agents.")).toBeNull();
  });
});

/* ── S6: the push view renders from props alone ─────────────────────────── */

describe("PushSwitch", () => {
  test("three states: a named switch, a blocked explanation, an unsupported explanation", () => {
    const onToggle = mock(() => {});
    const off = render(<PushSwitch state="unsubscribed" busy={false} onToggle={onToggle} />);
    const sw = off.getByRole("switch", { name: "Push notifications" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledTimes(1);
    off.unmount();

    const on = render(<PushSwitch state="subscribed" busy={true} onToggle={onToggle} />);
    const busy = on.getByRole("switch", { name: "Push notifications" });
    expect(busy.getAttribute("aria-checked")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(onToggle).toHaveBeenCalledTimes(1);
    on.unmount();

    const blocked = render(<PushSwitch state="blocked" busy={false} onToggle={onToggle} />);
    expect(blocked.queryByRole("switch")).toBeNull();
    expect(blocked.getByText("Blocked in browser settings")).toBeTruthy();
    blocked.unmount();

    const none = render(<PushSwitch state="unsupported" busy={false} onToggle={onToggle} />);
    expect(none.queryByRole("switch")).toBeNull();
    expect(none.getByText("No push here")).toBeTruthy();
    none.unmount();
  });
});

describe("LoginForm", () => {
  test("renders the methods it is given and reports every intent through props", () => {
    const onPassword = mock(() => {}); const onPasskey = mock(() => {}); const onPasswordChange = mock(() => {});
    const both = render(
      <LoginForm appName="Example brain" methods={{ password: true, passkey: true }} password="" busy={false} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(both.getByRole("heading", { name: "Example brain" })).toBeTruthy();
    expect(both.getByText("Use your passkey or enter the password.")).toBeTruthy();
    // No password typed: sign-in is dimmed and inert, the passkey route is live.
    expect(both.getByRole("button", { name: "Sign in" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(both.getByRole("button", { name: "Sign in" }));
    expect(onPassword).not.toHaveBeenCalled();
    fireEvent.click(both.getByRole("button", { name: "Sign in with a passkey" }));
    expect(onPasskey).toHaveBeenCalledTimes(1);
    changeControlledInput(both.getByPlaceholderText("Password") as HTMLInputElement, "x");
    expect(onPasswordChange).toHaveBeenCalledWith("x");
    both.unmount();

    const typed = render(
      <LoginForm appName="Example brain" methods={{ password: true, passkey: false }} password="secret" busy={false} error="Wrong password"
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(typed.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
    expect(typed.getByRole("alert").textContent).toContain("Wrong password");
    fireEvent.click(typed.getByRole("button", { name: "Sign in" }));
    expect(onPassword).toHaveBeenCalledTimes(1);
    // Enter in the field submits the form, which is the same intent.
    fireEvent.submit(typed.getByPlaceholderText("Password").closest("form")!);
    expect(onPassword).toHaveBeenCalledTimes(2);
    typed.unmount();

    const only = render(
      <LoginForm appName="Example brain" methods={{ password: false, passkey: true }} password="" busy={true} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(only.queryByPlaceholderText("Password")).toBeNull();
    expect(only.getByText("Sign in with your passkey.")).toBeTruthy();
    expect(only.getByRole("button", { name: "Sign in with a passkey" }).getAttribute("aria-disabled")).toBe("true");
    only.unmount();

    const none = render(
      <LoginForm appName="Example brain" methods={{ password: false, passkey: false }} password="" busy={false} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(none.getByText(/Password login is disabled/)).toBeTruthy();
    none.unmount();
  });
});

/* ── S6: the web-search chain renders from props alone ──────────────────── */

describe("WebSearchChain", () => {
  const provider = (over: Record<string, unknown>) => ({
    id: "search", label: "Search", enabled: false, hasKeyField: true, keyConfigured: false, keyFromEnv: false,
    keyless: false, costNote: "Free", blurb: "Search provider", ...over,
  });
  const handlers = () => ({
    onToggle: mock((_id: string) => {}), onToggleKey: mock((_id: string) => {}), onKeyDraft: mock((_v: string) => {}),
    onSaveKey: mock((_id: string) => {}), onClearKey: mock((_id: string) => {}), onClearOverride: mock(() => {}),
  });

  test("keyless providers can enable, configured providers can disable, and missing keys block enable", () => {
    const h = handlers();
    const config = { configured: true, order: ["paid"], overriddenBy: null, appliesTo: ["pi-1"], providers: [
      provider({ id: "free", label: "Free search", keyless: true }),
      provider({ id: "paid", label: "Paid search", enabled: true, costNote: "Paid" }),
      provider({ id: "bare", label: "Bare search" }),
    ] };
    const view = render(<WebSearchChain config={config} busy={false} error={null} openKey={null} keyDraft="" savedFlash={false} {...h} />);
    expect(view.getByText(/Applies to/).textContent).toContain("pi-1");
    expect(view.getByText("Order:").parentElement?.textContent).toContain("Paid search");
    const free = view.getByRole("switch", { name: "Enable Free search for web search" });
    expect(free.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(free);
    expect(h.onToggle).toHaveBeenCalledWith("free");
    const paid = view.getByRole("switch", { name: "Enable Paid search for web search" });
    expect(paid.getAttribute("aria-checked")).toBe("true");
    expect(paid.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(paid);
    expect(h.onToggle).toHaveBeenLastCalledWith("paid");
    const bare = view.getByRole("switch", { name: "Enable Bare search for web search" });
    expect(bare.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(bare);
    expect(h.onToggle).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getAllByRole("button", { name: "Needs key" })[0]);
    expect(h.onToggleKey).toHaveBeenCalledWith("free");
    view.unmount();
  });

  test("the open key editor saves and clears by provider, and the override warning clears the pin", () => {
    const h = handlers();
    const config = { configured: true, order: [], overriddenBy: "pinned-search", appliesTo: [], providers: [
      provider({ keyConfigured: true, enabled: true }),
    ] };
    const view = render(<WebSearchChain config={config} busy={false} error="Could not save" openKey="search" keyDraft="new-key" savedFlash={false} {...h} />);
    expect(view.getByText("Could not save")).toBeTruthy();
    expect(view.getByRole("button", { name: "Key stored" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(h.onSaveKey).toHaveBeenCalledWith("search");
    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    expect(h.onClearKey).toHaveBeenCalledWith("search");
    fireEvent.click(view.getByRole("button", { name: "Use the chain instead" }));
    expect(h.onClearOverride).toHaveBeenCalledTimes(1);
    changeControlledInput(view.getByLabelText("API key") as HTMLInputElement, "typed");
    expect(h.onKeyDraft).toHaveBeenCalledWith("typed");
    view.unmount();

    const busy = render(<WebSearchChain config={config} busy={true} error={null} openKey="search" keyDraft="new-key" savedFlash={false} {...h} />);
    expect(busy.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Clear" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Use the chain instead" }).getAttribute("aria-disabled")).toBe("true");
    busy.unmount();
  });
});

/* ── S6: the passkey list renders from props alone ──────────────────────── */

describe("PasskeyList", () => {
  const cred = (over: Partial<PasskeySummary>): PasskeySummary => ({
    id: "k1", label: "Laptop", rpId: "brain.local", createdAt: 1, lastUsedAt: null, backedUp: false,
    deviceType: "singleDevice", transports: [], aaguid: null, ...over,
  });
  const handlers = () => ({ onAdd: mock(() => {}), onRename: mock((_id: string, _l: string) => {}), onDelete: mock((_id: string) => {}), onSignOut: mock(() => {}) });

  test("status decides the list, the empty state and whether Add is offered", () => {
    const h = handlers();
    const loading = render(<PasskeyList credentials={[]} status="loading" busy={false} error={null} supported hostname="brain.local" {...h} />);
    expect(loading.queryByText("No passkeys yet.")).toBeNull();
    loading.unmount();

    const empty = render(<PasskeyList credentials={[]} status="ready" busy={false} error={null} supported hostname="brain.local" {...h} />);
    expect(empty.getByText("No passkeys yet.")).toBeTruthy();
    fireEvent.click(empty.getByRole("button", { name: "Add a passkey" }));
    expect(h.onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(empty.getByRole("button", { name: "Sign out everywhere" }));
    expect(h.onSignOut).toHaveBeenCalledTimes(1);
    empty.unmount();

    const off = render(<PasskeyList credentials={[]} status="unavailable" busy={false} error="boom" supported hostname="brain.local" {...h} />);
    expect(off.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(off.getByText(/password auth mode/)).toBeTruthy();
    expect(off.getByRole("alert").textContent).toBe("boom");
    off.unmount();

    const noWebAuthn = render(<PasskeyList credentials={[]} status="ready" busy={false} error={null} supported={false} hostname="brain.local" {...h} />);
    expect(noWebAuthn.getByText(/does not support passkeys/)).toBeTruthy();
    noWebAuthn.unmount();
  });

  test("rows rename by id, remove by id, and badge a credential from another host", () => {
    const h = handlers();
    const view = render(
      <PasskeyList credentials={[cred({}), cred({ id: "k2", label: "Phone", rpId: "other.example", backedUp: true })]} status="ready" busy={true} error={null} supported hostname="brain.local" {...h} />,
    );
    expect(view.getByRole("button", { name: "Adding a passkey…" }).getAttribute("aria-disabled")).toBe("true");
    expect(view.getByText("other.example")).toBeTruthy();
    expect(view.getByText("synced")).toBeTruthy();
    expect(view.queryByText("brain.local")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Remove Phone" }));
    expect(h.onDelete).toHaveBeenCalledWith("k2");
    fireEvent.click(view.getByRole("button", { name: "Rename Laptop" }));
    changeControlledInput(view.getByLabelText("Passkey name") as HTMLInputElement, "Desk");
    fireEvent.click(view.getByRole("button", { name: "Save name" }));
    expect(h.onRename).toHaveBeenCalledWith("k1", "Desk");
    view.unmount();
  });
});

/* ── S6: the skills list and editor render from props alone ─────────────── */

describe("SkillsList and SkillEditor", () => {
  const entry = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({ name, description: `${name} description`, source: "custom", enabled: true, ...over });
  const handlers = () => ({
    onNewName: mock((_v: string) => {}), onCreate: mock(() => {}), onGithubSource: mock((_v: string) => {}), onOverwrite: mock((_v: boolean) => {}),
    onInstallZip: mock((_f: File) => {}), onInstallGitHub: mock(() => {}), onOpen: mock((_s: SkillEntry) => {}), onToggle: mock((_s: SkillEntry) => {}), onRemove: mock((_s: SkillEntry) => {}),
  });

  test("the list names the skill every row control is about, and gates on busy", () => {
    const h = handlers();
    const skills = [entry("alpha"), entry("beta", { enabled: false, warning: "no description" }), entry("shipped", { source: "builtin" })];
    const view = render(
      <SkillsList skills={skills} busy={null} installing={false} error={null} warning={null} outcomes={[{ name: "x", status: "installed", files: 2 }, { name: "y", status: "skipped", reason: "exists" }]}
        newName="new-one" githubSource="" overwrite={false} {...h} />,
    );
    expect(view.getByText("disabled")).toBeTruthy();
    expect(view.getByText("⚠ no description")).toBeTruthy();
    expect(view.getByText(/x installed \(2 files\)/)).toBeTruthy();
    expect(view.getByText(/y — exists/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    // Install needs a source: the button is inert until one is typed.
    expect(view.getByRole("button", { name: "Install" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Edit beta SKILL.md" }));
    expect(h.onOpen).toHaveBeenLastCalledWith(skills[1]);
    fireEvent.click(view.getByRole("switch", { name: "Enable beta on all backends" }));
    expect(h.onToggle).toHaveBeenLastCalledWith(skills[1]);
    fireEvent.click(view.getByRole("button", { name: "Delete alpha permanently" }));
    expect(h.onRemove).toHaveBeenLastCalledWith(skills[0]);
    fireEvent.click(view.getByRole("button", { name: "View" }));
    expect(h.onOpen).toHaveBeenLastCalledWith(skills[2]);
    view.unmount();

    const busy = render(
      <SkillsList skills={[entry("alpha")]} busy="alpha" installing={true} error="failed" warning="careful" outcomes={null}
        newName="" githubSource="example/skills" overwrite={true} {...h} />,
    );
    expect(busy.getByText("failed")).toBeTruthy();
    expect(busy.getByText("careful")).toBeTruthy();
    expect((busy.getByRole("button", { name: "Edit alpha SKILL.md" }) as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getByRole("button", { name: "Install" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Create" }).getAttribute("aria-disabled")).toBe("true");
    busy.unmount();

    const empty = render(<SkillsList skills={[]} busy={null} installing={false} error={null} warning={null} outcomes={null} newName="" githubSource="a/b" overwrite={false} {...h} />);
    expect(empty.getByText("No custom skills yet.")).toBeTruthy();
    fireEvent.click(empty.getByRole("button", { name: "Install" }));
    expect(h.onInstallGitHub).toHaveBeenCalledTimes(1);
    empty.unmount();
  });

  test("the editor edits, saves and closes; a built-in is read-only with no Save", () => {
    const onChange = mock((_c: string) => {}); const onSave = mock(() => {}); const onClose = mock(() => {});
    const view = render(<SkillEditor name="alpha" content="# alpha" isNew={false} readOnly={false} saving={false} error={null} onChange={onChange} onSave={onSave} onClose={onClose} />);
    changeControlledInput(view.getByLabelText("SKILL.md") as HTMLInputElement, "# alpha\nmore");
    expect(onChange).toHaveBeenCalledWith("# alpha\nmore");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    const ro = render(<SkillEditor name="shipped" content="# shipped" isNew={false} readOnly saving={false} error="nope" onChange={onChange} onSave={onSave} onClose={onClose} />);
    expect(ro.queryByRole("button", { name: "Save" })).toBeNull();
    expect(ro.getByText("built-in · read-only")).toBeTruthy();
    expect((ro.getByLabelText("SKILL.md") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(ro.getByText("nope")).toBeTruthy();
    ro.unmount();

    const saving = render(<SkillEditor name="new" content="" isNew readOnly={false} saving error={null} onChange={onChange} onSave={onSave} onClose={onClose} />);
    expect(saving.getByText("New skill")).toBeTruthy();
    expect(saving.getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    saving.unmount();
  });
});

/* ── S6: the add form and the stream views render from props alone ──────── */

describe("AddForm", () => {
  const draft = { content: "", title: "", type: "", tags: "" };
  const handlers = () => ({ onDraft: mock((_p: Partial<typeof draft>) => {}), onSave: mock(() => {}), onRetryIndex: mock(() => {}), onAddAnother: mock(() => {}), onClose: mock(() => {}) });
  const ref = { current: null };

  test("the form gates Add on content, saves on Ctrl+Enter, and shows the error banner", () => {
    const h = handlers();
    const empty = render(<AddForm state="editing" draft={draft} knownTypes={["note", "talk"]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(empty.getByRole("button", { name: "Add" }).getAttribute("aria-disabled")).toBe("true");
    expect(empty.container.querySelector('option[value="talk"]')).not.toBeNull();
    changeControlledInput(empty.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement, "Remember");
    expect(h.onDraft).toHaveBeenCalledWith({ content: "Remember" });
    fireEvent.click(empty.getByRole("button", { name: "Cancel" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    empty.unmount();

    const typed = render(<AddForm state="error" draft={{ ...draft, content: "Remember" }} knownTypes={[]} error="disk full" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(typed.getByRole("alert").textContent).toContain("disk full");
    fireEvent.click(typed.getByRole("button", { name: "Add" }));
    expect(h.onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(typed.getByPlaceholderText("idea, reading"), { key: "Enter", ctrlKey: true });
    expect(h.onSave).toHaveBeenCalledTimes(2);
    typed.unmount();

    const saving = render(<AddForm state="saving" draft={{ ...draft, content: "Remember" }} knownTypes={[]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(saving.getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    saving.unmount();
  });

  test("the receipt reads the three-valued indexed flag and offers the retry only when it is false", () => {
    const h = handlers();
    const unindexed = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="locked" savedPath="notes/x.md" indexed={false} indexing={false} contentRef={ref} {...h} />);
    expect(unindexed.getByText(/Saved, but not indexed/)).toBeTruthy();
    expect(unindexed.getByText("notes/x.md")).toBeTruthy();
    expect(unindexed.getByRole("status").textContent).toContain("locked");
    fireEvent.click(unindexed.getByRole("button", { name: "Retry indexing" }));
    expect(h.onRetryIndex).toHaveBeenCalledTimes(1);
    fireEvent.click(unindexed.getByRole("button", { name: "Add another" }));
    expect(h.onAddAnother).toHaveBeenCalledTimes(1);
    fireEvent.click(unindexed.getByRole("button", { name: "Done" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    unindexed.unmount();

    const indexing = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed={false} indexing contentRef={ref} {...h} />);
    expect(indexing.getByRole("button", { name: "Indexing…" }).getAttribute("aria-disabled")).toBe("true");
    indexing.unmount();

    const indexed = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed contentRef={ref} indexing={false} {...h} />);
    expect(indexed.getByText(/Saved and indexed/)).toBeTruthy();
    expect(indexed.queryByRole("button", { name: "Retry indexing" })).toBeNull();
    indexed.unmount();

    const unknown = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed={undefined} contentRef={ref} indexing={false} {...h} />);
    expect(unknown.getByText(/did not report/)).toBeTruthy();
    unknown.unmount();
  });
});

describe("StreamingOutput and BriefingOutput", () => {
  test("the stream view names its state, offers Cancel only while running, and lists the lines", () => {
    const onCancel = mock(() => {}); const onClose = mock(() => {});
    const running = render(<StreamingOutput state="running" lines={[]} onCancel={onCancel} onClose={onClose} />);
    expect(running.getByText("Running...")).toBeTruthy();
    expect(running.getByText("Starting...")).toBeTruthy();
    expect(running.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(running.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    running.unmount();

    const done = render(<StreamingOutput state="success" lines={["one", "two"]} onCancel={onCancel} onClose={onClose} />);
    expect(done.getByText("Complete")).toBeTruthy();
    expect(done.getByText("two")).toBeTruthy();
    expect(done.queryByText("Starting...")).toBeNull();
    fireEvent.click(done.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    done.unmount();

    for (const [state, text] of [["error", "Failed"], ["cancelled", "Cancelled"], ["idle", "Ready"]] as const) {
      const v = render(<StreamingOutput state={state} lines={[]} onCancel={onCancel} onClose={onClose} />);
      expect(v.getByText(text)).toBeTruthy();
      v.unmount();
    }
  });

  test("the briefing loads behind a skeleton, then shows the content, an empty briefing or a failure with Retry", () => {
    const onCancel = mock(() => {}); const onClose = mock(() => {}); const onRetry = mock(() => {});
    const props = { onCancel, onClose, onRetry };
    const loading = render(<BriefingOutput state="loading" content={<p>never</p>} {...props} />);
    expect(loading.getByText("Reading the briefing...")).toBeTruthy();
    expect(loading.queryByText("never")).toBeNull();
    fireEvent.click(loading.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    loading.unmount();

    const done = render(<BriefingOutput state="done" content={<p>Ithaca by Thursday</p>} {...props} />);
    expect(done.getByText("Ithaca by Thursday")).toBeTruthy();
    expect(done.queryByRole("button", { name: "Retry" })).toBeNull();
    done.unmount();

    const empty = render(<BriefingOutput state="empty" content={<p>never</p>} {...props} />);
    expect(empty.getByText("Nothing in today's briefing.")).toBeTruthy();
    expect(empty.queryByText("never")).toBeNull();
    empty.unmount();

    const failed = render(<BriefingOutput state="error" error="brain briefing failed" content={<p>never</p>} {...props} />);
    expect(failed.getByText("Briefing unavailable")).toBeTruthy();
    expect(failed.getByText("brain briefing failed")).toBeTruthy();
    fireEvent.click(failed.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(failed.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    failed.unmount();
  });
});

/* ── S7 (settings): principals, accounts and grants render from props ────── */

describe("settings views", () => {
  test("the principal list: states, the mint form gated on a label, revoke by id", () => {
    const h = { onLabel: mock((_v: string) => {}), onTtlDays: mock((_d: number) => {}), onMint: mock(() => {}), onRevoke: mock((_id: string) => {}) };
    const rows = [
      { id: "own", label: "Laptop", kind: "owner", isOwn: true, created: "2h ago", lastSeen: "5m ago", expires: "in 6d" },
      { id: "agent", label: "Build agent", kind: "agent", isOwn: false, created: "1m ago", lastSeen: "Never", expires: "in 1d" },
    ];
    const view = render(<PrincipalList state="ready" principals={rows} error={null} label="" ttlDays={7} minting={false} {...h} />);
    expect(view.getByText("This device")).toBeTruthy();
    expect(view.getByText("Agent")).toBeTruthy();
    expect(view.getByRole("button", { name: "Create agent credential" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Revoke Build agent" }));
    expect(h.onRevoke).toHaveBeenCalledWith("agent");
    changeControlledInput(view.getByLabelText("Label") as HTMLInputElement, "Deploy agent");
    expect(h.onLabel).toHaveBeenCalledWith("Deploy agent");
    view.unmount();

    const ready = render(<PrincipalList state="ready" principals={[]} error="mint failed" label="Deploy agent" ttlDays={7} minting={false} {...h} />);
    expect(ready.getByText("No active devices or agents.")).toBeTruthy();
    expect(ready.getByRole("alert").textContent).toContain("mint failed");
    fireEvent.click(ready.getByRole("button", { name: "Create agent credential" }));
    expect(h.onMint).toHaveBeenCalledTimes(1);
    ready.unmount();

    const off = render(<PrincipalList state="unavailable" principals={[]} error={null} label="" ttlDays={7} minting={false} {...h} />);
    expect(off.getByText(/password authentication is enabled/)).toBeTruthy();
    expect(off.queryByRole("button", { name: "Create agent credential" })).toBeNull();
    off.unmount();
  });

  test("the accounts list: connect, disconnect, the device code, and a settled flow", () => {
    const h = { onConnect: mock((_id: string) => {}), onDisconnect: mock((_id: string) => {}), onCancelFlow: mock(() => {}), onDismissFlow: mock(() => {}) };
    const providers = [
      { providerId: "vendor", name: "Vendor", configured: false, oauth: true, source: null },
      { providerId: "other", name: "Other", configured: true, oauth: true, source: "stored" },
    ] as unknown as Parameters<typeof AccountsList>[0]["providers"];
    const view = render(<AccountsList providers={providers} busy={null} flow={null} error={null} {...h} />);
    expect(view.getByText("Not connected")).toBeTruthy();
    expect(view.getByText("Connected · stored")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Connect" }));
    expect(h.onConnect).toHaveBeenCalledWith("vendor");
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    expect(h.onDisconnect).toHaveBeenCalledWith("other");
    view.unmount();

    const pending = { id: "f", providerId: "vendor", status: "pending", userCode: "ABCD-1234", verificationUri: "https://example.invalid/device", intervalSeconds: 5 } as unknown as NonNullable<Parameters<typeof AccountsList>[0]["flow"]>;
    const waiting = render(<AccountsList providers={providers} busy={null} flow={pending} error={null} {...h} />);
    expect(waiting.getByText("ABCD-1234")).toBeTruthy();
    expect(waiting.getByRole("link", { name: /Open verification page/ }).getAttribute("href")).toBe("https://example.invalid/device");
    expect(waiting.getByRole("button", { name: "Connect" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(waiting.getByRole("button", { name: "Cancel" }));
    expect(h.onCancelFlow).toHaveBeenCalledTimes(1);
    waiting.unmount();

    const failed = render(<AccountsList providers={providers} busy={null} flow={{ ...pending, status: "error", error: "denied" } as typeof pending} error={null} {...h} />);
    expect(failed.getByText("denied")).toBeTruthy();
    fireEvent.click(failed.getByRole("button", { name: "Dismiss" }));
    expect(h.onDismissFlow).toHaveBeenCalledTimes(1);
    failed.unmount();
  });

  test("the grants are kit rows: tapping one revokes, a busy one is inert", () => {
    const onRevoke = mock((_t: string) => {});
    const view = render(<ToolPermissionsList tools={["Read", "Bash"]} busy="Bash" error={null} onRevoke={onRevoke} />);
    fireEvent.click(view.getByRole("button", { name: /Read/ }));
    expect(onRevoke).toHaveBeenCalledWith("Read");
    expect(view.queryByRole("button", { name: /Bash/ })).toBeNull();
    expect(view.getByText("Revoking…")).toBeTruthy();
    view.unmount();
  });
});

describe("ModelsCatalogView", () => {
  test("effort choices come from capabilities; unsupported saved levels stay visible and can be cleared", () => {
    const onThinking = mock(() => {});
    const catalog = { models: [
      { id: "limited", label: "Limited", hidden: false, thinkingLevel: "high", thinkingOverride: "max", supportedThinkingLevels: ["low", "high"] },
      { id: "removed", label: "Removed support", hidden: false, thinkingOverride: "high", supportedThinkingLevels: [] },
      { id: "unknown", label: "Unknown support", hidden: false, thinkingLevel: "low" },
    ], refreshedAt: null, stale: false, discovery: { enabled: true } } as NonNullable<Parameters<typeof ModelsCatalogView>[0]["catalog"]>;
    const view = render(<ModelsCatalogView catalog={catalog} loading={false} refreshing={false} error={null} sections={null} onThinking={onThinking} onToggleHidden={() => {}} onBilling={() => {}} onDefault={() => {}} onCustomModels={() => {}} onRefresh={() => {}} />);
    try {
      const limited = view.getByLabelText("Reasoning effort for Limited") as HTMLSelectElement;
      expect([...limited.options].map((option) => option.value)).toEqual(["auto", "max", "low", "high"]);
      expect(limited.selectedOptions[0].textContent).toBe("max (runs as high)");
      const removed = view.getByLabelText("Reasoning effort for Removed support") as HTMLSelectElement;
      expect([...removed.options].map((option) => option.value)).toEqual(["auto", "high"]);
      expect(removed.selectedOptions[0].textContent).toBe("high (uses model default)");
      fireEvent.change(removed, { target: { value: "auto" } });
      expect(onThinking).toHaveBeenCalledWith(catalog.models[1], "auto");
      const unknown = view.getByLabelText("Reasoning effort for Unknown support") as HTMLSelectElement;
      expect([...unknown.options].map((option) => option.value)).toEqual(["auto"]);
      expect(view.getByText("Effort set here is the default for every new message; the model picker can change it for one message.")).toBeTruthy();
    } finally { view.unmount(); }
  });

  test("the roster: hidden rows say so without opacity dimming, selects keep their names, refresh and add are kit buttons", () => {
    const h = { onToggleHidden: mock(() => {}), onBilling: mock(() => {}), onThinking: mock(() => {}), onDefault: mock(() => {}), onCustomModels: mock((_m: string[]) => {}), onRefresh: mock(() => {}) };
    const catalog = {
      models: [
        { id: "one", label: "Model one", hidden: false, source: "discovered", billingMode: "api", thinkingLevel: "medium", contextWindow: 200000 },
        { id: "two", label: "Model two", hidden: true, source: "declared" },
      ],
      defaultModelId: null, resolvedDefaultId: "one", customModels: ["vendor/custom"], refreshedAt: null,
      discovery: { enabled: true, error: "rate limited" },
    } as unknown as Parameters<typeof ModelsCatalogView>[0]["catalog"];
    const view = render(<ModelsCatalogView catalog={catalog} loading={false} refreshing={false} error={null} sections={<p>sections here</p>} {...h} />);
    const hiddenRow = view.getByText("Model two").closest("li")!;
    expect(hiddenRow).toBeTruthy();
    expect(Number(getComputedStyle(hiddenRow).opacity || "1")).toBe(1);
    expect(hiddenRow.className).not.toMatch(/opacity-(?!100(?:\s|$))/);
    expect(view.getByText("hidden")).toBeTruthy();
    expect(view.getByLabelText("Billing for Model one")).toBeTruthy();
    expect(view.getByLabelText("Reasoning effort for Model one")).toBeTruthy();
    expect(view.getByText(/Last refresh failed \(rate limited\)/)).toBeTruthy();
    expect(view.getByText(/1 in picker · never refreshed/)).toBeTruthy();
    expect(view.getByText("sections here")).toBeTruthy();
    fireEvent.click(view.getByRole("switch", { name: "Show Model two in picker" }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(catalog!.models[1]);
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Remove vendor/custom" }));
    expect(h.onCustomModels).toHaveBeenCalledWith([]);
    changeControlledInput(view.getByLabelText("OpenRouter model id") as HTMLInputElement, "vendor/new");
    fireEvent.click(view.getByRole("button", { name: "Add" }));
    expect(h.onCustomModels).toHaveBeenLastCalledWith(["vendor/custom", "vendor/new"]);
    view.unmount();

    const empty = render(<ModelsCatalogView catalog={{ ...catalog!, models: [], discovery: { enabled: false, error: undefined } }} loading={false} refreshing error="save failed" sections={null} {...h} />);
    expect(empty.getByText("No models available.")).toBeTruthy();
    expect(empty.getByText(/Discovery is disabled/)).toBeTruthy();
    expect(empty.getByRole("alert").textContent).toContain("save failed");
    expect(empty.getByRole("button", { name: "Refreshing…" }).getAttribute("aria-disabled")).toBe("true");
    empty.unmount();
  });
});

test("Apify settings show scoped Actor approvals, revoke the selected Actor and describe estimated overhead", () => {
  const revoke = mock((_id: string) => {});
  const read: ApifySettingsRead = {
    state: "configured", reason: null, account: { id: "IthacaHousehold01", username: "penelope" }, pending_account: null,
    checked_at: "2026-07-12T09:00:00Z",
    actor_approvals: [{ actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: 0 }],
    policy: { path: "context/policies/governance.md", hash: null, valid: true, enabled: true, discovery: "ask", actors: "ask",
      grants: [], limits: null, budgets: { turn_usd: 4, session_usd: 20, day_usd: 40 } },
    spend: { ledger: "read", observed_at: "2026-07-12T09:00:00Z", coverage: "Observed charges plus estimated platform requests, transfer and storage.",
      day: { scope: "day", liability_usd: 0.04, charged_usd: 0.004, reserved_usd: 0.026, residual_usd: 0.01,
        unknown_runs: 0, open_runs: 1, operator_resolved: 0, runs: 1, limit_usd: 4 }, brain_day: null, unresolved: [] },
  };
  const noop = () => {};
  const view = render(<ApifyView read={read} edit={null} announcement="" stale={false} checking={false} headings={{}}
    onRevokeActor={revoke} onTurn={noop} onMode={noop} onRevoke={noop} onCheck={noop} onConfirmAccount={noop}
    onReview={noop} onOpenPolicy={noop} onOpenActivity={noop} onApprove={noop} onDecline={noop} onCheckProposal={noop} />);
  expect(view.getByText("Approved Actors · 1")).toBeTruthy();
  expect(view.container.textContent).toContain("estimated platform overhead held");
  expect(view.container.textContent).toContain("across sessions for this account");
  fireEvent.click(view.getByRole("button", { name: "Revoke odysseus/sea-charts" }));
  expect(revoke).toHaveBeenCalledWith("SeaCharts01");
});
