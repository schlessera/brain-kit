/**
 * Durable Actions and the secondary Queue in the real Actions page (#684).
 *
 * The real ActivityPage, SideRail and MobileTabBar render in Chromium against
 * real client roots. The durable inbox is the in-browser fixture server
 * (`tests/fixtures/inbox-fixture-server.ts`): it speaks the stream protocol,
 * and every frame it sends passes the SDK wire parser before the client's own
 * frame handler sees it. The real server's protocol is exercised against the
 * same client store by `tests/inbox-actions-stream.test.ts`.
 *
 * Numbers in test names are the approved design's browser checks.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import type { ClientMessage, InboxActionItem, InboxQueueItem, InboxThread, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { SideRail } from "../../src/components/layout/side-rail.js";
import { MobileTabBar } from "../../src/components/layout/mobile-tab-bar.js";
import { createInboxFixtureServer, type InboxFixtureServer } from "../fixtures/inbox-fixture-server.js";

const DAY = 86_400_000;
const T0 = Date.now();

class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}

function thread(id: string, extra: Partial<InboxThread> = {}): InboxThread {
  return {
    id, trustClass: "untrusted", source: "share", status: "open",
    stateMd: `Harbour-fee notice from Ithaca port (${id})\nPenelope forwarded it.`,
    stakes: 1, createdAt: T0 - DAY, lastSeenAt: T0, ...extra,
  };
}

function decision(id: string, threadId: string, extra: Partial<InboxActionItem> = {}): InboxActionItem {
  return {
    id, dedupKey: id, threadId, queue: "actions", type: "approve", status: "pending",
    version: 1, createdAt: T0 - 2 * 3_600_000, updatedAt: T0, expiresAt: T0 + 30 * DAY,
    payload: { title: `File the harbour-fee notice into the port ledger? (${id})`, detail: "Penelope forwarded the Ithaca port notice." },
    options: [
      {
        id: "approve", label: "File it",
        effect: { kind: "enqueue", payload: { instruction: "Append the fee row", operation: {
          toolName: "Edit", targetPath: "finances/ithaca-port.md",
          input: { path: "finances/ithaca-port.md", append: "| 2026-07-12 | harbour fee | 12 dr |" },
        } } },
      },
      { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
    ],
    ...extra,
  };
}

function blockedWork(id: string, threadId: string, by: string, extra: Partial<InboxQueueItem> = {}): InboxQueueItem {
  return {
    id, dedupKey: id, threadId, queue: "queue", type: "triage", status: "blocked", blockedByItemId: by,
    version: 2, attempts: 1, maxAttempts: 3, createdAt: T0 - 3 * 3_600_000, updatedAt: T0 - 2 * 3_600_000,
    expiresAt: T0 + 30 * DAY, payload: { stagingId: `share-${id}` }, ...extra,
  } as InboxQueueItem;
}

interface Device {
  id: string;
  ui: BrainUiRoot;
  host: HTMLDivElement;
  frames: () => ClientMessage[];
  hello: () => Promise<void>;
}

let server: InboxFixtureServer;
const devices: Array<{ device: Device; renderer: Root }> = [];
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };

beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = `${await commands.formConsumerStyles()}\n${await commands.rankFooterFonts()}`;
  document.head.append(styles);
});
afterAll(async () => {
  styles?.remove();
  await page.viewport(viewport.width, viewport.height);
});
afterEach(() => {
  for (const { device, renderer } of devices.splice(0)) {
    flushSync(() => renderer.unmount());
    device.ui.dispose();
    device.host.remove();
  }
  document.documentElement.dataset.theme = "dark";
  vi.unstubAllGlobals();
});

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

/** Routes the Actions page asks for; every one is keyless fixture data. */
function api(notices: unknown[] = [], runs: Record<string, unknown> = {}) {
  return async (url: string) => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: notices });
    const run = /\/activity\/runs?\/([^/]+)$/.exec(path);
    if (run && runs[decodeURIComponent(run[1]!)]) return Response.json(runs[decodeURIComponent(run[1]!)]);
    return new Response("{}", { status: 404 });
  };
}

async function device(id: string, opts: { width?: number; height?: number; theme?: string; notices?: unknown[]; runs?: Record<string, unknown>; approval?: boolean } = {}): Promise<Device> {
  vi.stubGlobal("WebSocket", FixtureSocket);
  await page.viewport(opts.width ?? 320, opts.height ?? 800);
  document.documentElement.dataset.theme = opts.theme ?? "dark";
  const host = document.createElement("div");
  host.dataset.theme = opts.theme ?? "dark";
  host.style.height = `${opts.height ?? 800}px`;
  host.style.display = "flex";
  host.style.flexDirection = "column";
  // The app's own ground: translucent tints are measured against it.
  host.className = "bg-background text-foreground";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: api(opts.notices, opts.runs) });
  ui.stores.connection.setState({ wsStatus: "connected" } as never);
  const client = server.connect(id, (msg: ServerMessage) => ui.connection.handleServerMessage(msg));
  ui.connection.send = (msg: ClientMessage) => server.receive(id, msg);
  if (opts.approval) {
    ui.stores.chat.setState({
      draft: {
        isStreaming: true, askUser: null, lastTouched: 0,
        messages: [{ id: "m1", role: "assistant", content: "", isStreaming: true, timestamp: T0, parts: [],
          toolCalls: [{ id: "tool-live", name: "Write", input: { file_path: "journeys/ogygia.md", content: "Raft lashings checked." }, inputJson: "{}", status: "pending_approval", approvalKind: "tool" }] }],
      },
    } as never);
  }
  const renderer = createRoot(host);
  flushSync(() => renderer.render(
    <BrainUiProvider root={ui}>
      <div data-rail=""><SideRail /></div>
      <div data-bar=""><MobileTabBar /></div>
      <ActivityPage />
    </BrainUiProvider>,
  ));
  const dev: Device = {
    id, ui, host,
    frames: () => client.sent,
    hello: async () => {
      ui.connection.handleServerMessage({ type: "server_hello", protocolRev: 2, capabilities: { inbox: true } });
      await settle();
    },
  };
  devices.push({ device: dev, renderer });
  await dev.hello();
  return dev;
}

function cards(d: Device): HTMLElement[] {
  return [...d.host.querySelectorAll<HTMLElement>("[data-decision-list] [data-decision-card]")];
}
function card(d: Device, id: string): HTMLElement {
  const el = d.host.querySelector<HTMLElement>(`[data-decision-list] [data-decision-id="${id}"]`);
  if (!el) throw new Error(`no card ${id}`);
  return el;
}
function button(scope: HTMLElement, name: string | RegExp): HTMLElement {
  const all = [...scope.querySelectorAll<HTMLElement>('[role="button"], [role="tab"], button')];
  const match = all.find((b) => {
    const label = b.getAttribute("aria-label") ?? b.textContent ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!match) throw new Error(`no button ${name} in ${all.map((b) => b.getAttribute("aria-label") ?? b.textContent).join(" | ")}`);
  return match;
}
async function click(el: HTMLElement) {
  el.click();
  await settle();
}
function badges(d: Device): string[] {
  const read = (sel: string) => {
    const tab = [...d.host.querySelectorAll<HTMLElement>(sel + ' [role="tab"]')]
      .find((t) => (t.getAttribute("aria-label") ?? t.textContent ?? "").startsWith("Actions"));
    if (!tab) throw new Error("no Actions tab in " + sel);
    return (tab.textContent ?? "").replace("Actions", "").replace(/⌘\d/, "").trim() || "0";
  };
  const chip = /needs you (\d+)/.exec(d.host.textContent ?? "")?.[1] ?? "?";
  const heading = d.host.querySelector("[data-needs-you-count]")?.textContent?.split(" ")[0] ?? "?";
  return [read("[data-rail]"), read("[data-bar]"), chip, heading];
}
async function key(target: HTMLElement, k: string) {
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  await settle();
}
function noOverflow(el: HTMLElement) {
  const out: string[] = [];
  for (const node of el.querySelectorAll<HTMLElement>("*")) {
    if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible") out.push(node.tagName + "." + node.className);
  }
  expect(document.documentElement.scrollWidth, "no page-level horizontal overflow").toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  return out;
}

describe("durable Actions", () => {
  test("1 · 2: live approval, durable decisions and notices, in that order, with one badge number", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-harbour", "t-harbour"), decision("a-fyi", "t-harbour", { type: "fyi", options: [], payload: { title: "A decision was dropped at the Actions limit", detail: "Raft repairs" } })]);
    const notice = { id: 7, runId: "run-sweep", spanId: null, kind: "failure", tag: "t", title: "Nightly sweep failed", body: "", status: "sent", acknowledged: false, createdAt: T0 };
    const d = await device("laptop", { notices: [notice], approval: true });
    await settle(8);
    const text = d.host.textContent!;
    const live = text.indexOf("Live approval");
    const durable = text.indexOf("Approve?");
    const notices = text.indexOf("Notices · 1");
    expect(live, "live approval label").toBeGreaterThan(-1);
    expect(durable, "durable kind label after live").toBeGreaterThan(live);
    expect(notices, "notices after durable decisions").toBeGreaterThan(durable);
    // N = live approvals + pending non-FYI durable decisions; notice and FYI excluded.
    expect(badges(d)).toEqual(["2", "2", "2", "2"]);
    // Only the live approval pulses; the durable card's dot is static.
    const durableCard = card(d, "a-harbour");
    expect(durableCard.querySelector("[style*='animation']")).toBeNull();
  });

  test("3 · 4: the exact effect is on screen before Approve, and a 180-character path wraps at 320px", async () => {
    server = createInboxFixtureServer();
    const path = `journeys/${"the-long-way-home-from-troy-by-way-of-ogygia-and-scheria/".repeat(3)}raft.md`;
    expect(path.length).toBeGreaterThanOrEqual(180);
    const long = decision("a-long", "t-raft");
    long.options[0] = { id: "approve", label: "Write it", effect: { kind: "enqueue", payload: { instruction: "Write the raft log", operation: { toolName: "Write", targetPath: path, input: { lines: Array.from({ length: 44 }, (_, i) => `oar ${i + 1} inspected`) } } } } };
    server.seed(thread("t-raft"), [decision("a-harbour", "t-raft"), long]);
    const d = await device("phone");
    const harbour = card(d, "a-harbour");
    const effect = harbour.querySelector("[data-effect-preview]")!;
    expect(effect.textContent).toContain("Edit");
    expect(effect.textContent).toContain("finances/ithaca-port.md");
    expect(harbour.querySelector("[data-effect-input]")!.textContent).toContain("| 2026-07-12 | harbour fee | 12 dr |");
    expect(button(harbour, "Approve: Edit finances/ithaca-port.md")).toBeTruthy();
    // A 48-line input: no Approve until the whole of it has been shown.
    const longCard = card(d, "a-long");
    expect(() => button(longCard, /^Approve:/)).toThrow();
    const pathEl = longCard.querySelector<HTMLElement>("[data-effect-path]")!;
    expect(pathEl.textContent).toBe(path);
    expect(pathEl.getBoundingClientRect().right).toBeLessThanOrEqual(longCard.getBoundingClientRect().right + 0.5);
    expect(getComputedStyle(pathEl).textOverflow).not.toBe("ellipsis");
    expect(noOverflow(longCard)).toEqual([]);
    await click(button(longCard, /^Show all 48 lines/));
    expect(longCard.querySelector("[data-effect-input]")!.textContent!.split("\n")).toHaveLength(48);
    expect(button(longCard, `Approve: Write ${path}`)).toBeTruthy();
  });

  test("5 · 6: applying keeps the card and the count; confirmation shows the receipt and moves focus", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour", { createdAt: T0 - 3_600_000 })]);
    const d = await device("laptop");
    server.hold("laptop");
    await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    const applying = card(d, "a-one");
    expect(applying.textContent).toContain("Recording…");
    for (const b of applying.querySelectorAll("[data-disposition-bar] [role='button']")) expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(badges(d)).toEqual(["2", "2", "2", "2"]);
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(1);
    server.release("laptop");
    await settle(6);
    const receipt = d.host.querySelector("[data-decision-receipt='a-one']")!;
    expect(receipt.textContent).toContain("Approved · queued Edit → finances/ithaca-port.md");
    expect(receipt.getAttribute("role")).toBe("status");
    expect(d.host.querySelector("[aria-live='polite']")?.textContent).toContain("Approved");
    expect(document.activeElement).toBe(card(d, "a-two"));
    expect(badges(d)).toEqual(["1", "1", "1", "1"]);
    await click(button(card(d, "a-two"), "Approve: Edit finances/ithaca-port.md"));
    await settle(6);
    // After the last decision, focus is on the empty state's heading, and the
    // receipt is the toast above it.
    expect(document.activeElement?.getAttribute("role"), document.activeElement?.outerHTML.slice(0, 120)).toBe("heading");
    expect(document.activeElement?.textContent).toBe(d.host.querySelector("[role='heading'][aria-level='2']")?.textContent);
    expect(d.host.querySelector("[aria-live='polite']")?.textContent).toContain("Approved");
    expect(badges(d)).toEqual(["0", "0", "0", "0"]);
  });

  test("7: two devices — one resolution, the other told, and its late Dismiss not applied", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const a = await device("laptop", { width: 1280 });
    const b = await device("phone", { width: 1280 });
    server.hold("phone");
    await click(button(card(a, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    await click(button(card(b, "a-one"), "Dismiss: File the harbour-fee notice into the port ledger? (a-one)"));
    await click(button(card(b, "a-one"), "Dismiss with no reason"));
    server.release("phone");
    await settle(6);
    expect(b.host.querySelector("[data-decision-receipt='a-one']")!.textContent).toContain("Already resolved on another device. Your Dismiss was not applied.");
    expect(server.resolutions.get("a-one")).toMatchObject({ optionId: "approve", client: "laptop" });
    expect([...server.items.values()].filter((i) => i.queue === "queue" && i.type === "execute")).toHaveLength(1);
  });

  test("8 · 25: a changed decision disables every answer until its changes are reviewed", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour")]);
    const d = await device("laptop");
    server.revise("a-one", { payload: { title: "File the corrected harbour fee? (a-one)", detail: "Penelope forwarded the Ithaca port notice." } });
    await settle();
    const c = card(d, "a-one");
    expect(c.textContent).toContain("This decision changed while you were reading it. Changed: title");
    const approve = button(c, "Approve: Edit finances/ithaca-port.md");
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    await click(approve);
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
    await click(button(c, "Review changes"));
    expect(card(d, "a-one").querySelector("[data-decision-review]")!.textContent).toContain("File the corrected harbour fee? (a-one)");
    expect(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md").getAttribute("aria-disabled")).toBeNull();
  });

  test("9 · 24: a refusal is announced, the card stays, nothing is retried", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour")]);
    const d = await device("laptop");
    server.refuseNext();
    await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    await settle(6);
    const alert = card(d, "a-one").querySelector<HTMLElement>("[data-decision-alert]")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Couldn't apply that decision. Nothing changed.");
    expect(document.activeElement).toBe(alert);
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(1);
    expect(d.frames().filter((f) => f.type === "inbox_subscribe" && f.view === "actions")).toHaveLength(2);
  });

  test("10 · 11: offline disables answers; a send lost in flight reconciles on reconnect without resending", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop");
    // Lost after the send: it lands for a-one, never arrives for a-two.
    server.hold("laptop");
    await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    server.disconnect("laptop");
    d.ui.stores.inbox.getState().connectionLost();
    await settle();
    expect(d.host.querySelector("[data-inbox-offline]")!.textContent).toContain("Reconnecting · showing state as of");
    expect(card(d, "a-one").textContent).toContain("Sent, not confirmed — reconnecting.");
    const two = card(d, "a-two");
    expect(two.textContent).toContain("needs the host");
    await click(button(two, "Approve: Edit finances/ithaca-port.md"));
    const sentBefore = d.frames().length;
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(1);
    server.reconnect("laptop");
    await d.hello();
    await settle(6);
    expect(d.host.querySelector("[data-decision-receipt='a-one']")!.textContent).toContain("confirmed after reconnect");
    expect(d.frames().slice(sentBefore).filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
  });

  test("11: an answer that never arrived says so and re-enables the card", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour")]);
    const d = await device("laptop");
    server.disconnect("laptop");
    // The client still believes it is connected for one tap.
    d.ui.connection.send = () => true;
    await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    d.ui.stores.inbox.getState().connectionLost();
    server.reconnect("laptop");
    d.ui.connection.send = (msg) => server.receive("laptop", msg);
    await d.hello();
    await settle(6);
    const c = card(d, "a-one");
    expect(c.textContent).toContain("Your Approve was not received. Nothing was applied.");
    expect(button(c, "Approve: Edit finances/ithaca-port.md").getAttribute("aria-disabled")).toBeNull();
    expect(server.resolutions.size).toBe(0);
  });

  test("12: dismiss sends one frame, with no reason or the exact one, and writes no policy", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop");
    await click(button(card(d, "a-one"), /^Dismiss: /));
    await click(button(card(d, "a-one"), "Dismiss with no reason"));
    await settle();
    await click(button(card(d, "a-two"), /^Dismiss: /));
    const c = card(d, "a-two");
    const chip = [...c.querySelectorAll<HTMLButtonElement>("[data-dismiss-confirm] button[aria-pressed]")].find((b) => b.textContent === "Don't ask again")!;
    await click(chip);
    await click(button(card(d, "a-two"), "Dismiss with reason: Don't ask again"));
    await settle();
    const resolves = d.frames().filter((f) => f.type === "inbox_resolve");
    expect(resolves).toEqual([
      { type: "inbox_resolve", itemId: "a-one", optionId: "dismiss" },
      { type: "inbox_resolve", itemId: "a-two", optionId: "dismiss", reason: "dont_ask_again" },
    ]);
    expect(server.policyWrites).toEqual([]);
    // The last decision's receipt is the toast above the empty state.
    expect(d.host.querySelector("[aria-live='polite']")!.textContent).toContain("Dismissed");
  });

  test("13 · 14 · 21: Later previews before any frame, the receipt carries the server's time, and snoozed items live under Later", async () => {
    server = createInboxFixtureServer();
    server.setSnoozeFor(3 * DAY);
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop");
    await click(button(card(d, "a-one"), /^Later: /));
    expect(card(d, "a-one").querySelector("[data-later-confirm]")!.textContent).toContain("Later → back at the next scheduled time");
    expect(d.frames().filter((f) => f.type === "inbox_snooze")).toHaveLength(0);
    expect(badges(d)[2]).toBe("2");
    await click(button(card(d, "a-one"), "Snooze until the next scheduled time"));
    await settle(6);
    const waitUntil = server.action("a-one").waitUntil!;
    expect(waitUntil).toBeGreaterThan(Date.now() + 2 * DAY);
    // The receipt stays where the card was and prints the server's time.
    expect(d.host.querySelector("[data-decision-list] [data-decision-receipt='a-one']")!.textContent).toMatch(/^Snoozed until /);
    expect(document.activeElement).toBe(card(d, "a-two"));
    expect(badges(d)).toEqual(["1", "1", "1", "1"]);
    const later = d.host.querySelector<HTMLElement>("[data-later-section]")!;
    expect(later.textContent).toContain("Later · 1 · next back");
    // 21: a snoozed item expands into the same card and can be approved directly.
    await click(button(later, /^Later · 1/));
    const snoozed = later.querySelector<HTMLElement>("[data-decision-id='a-one']")!;
    expect(snoozed.textContent).toContain("Already snoozed until");
    expect(() => button(snoozed, /^Later: /)).toThrow();
    await click(button(snoozed, "Approve: Edit finances/ithaca-port.md"));
    await settle(6);
    expect(server.action("a-one").status).toBe("resolved");
  });

  /** Snoozes `id`, opens Later and then the snoozed card's detail. */
  async function snoozedDetail(d: Device, id: string) {
    await click(button(card(d, id), /^Later: /));
    await click(button(card(d, id), "Snooze until the next scheduled time"));
    await settle(6);
    const later = d.host.querySelector<HTMLElement>("[data-later-section]")!;
    await click(button(later, /^Later · 1/));
    const snoozed = later.querySelector<HTMLElement>(`[data-decision-id='${id}']`)!;
    await click(button(snoozed, /^Details: /));
    expect(d.host.querySelector("[data-decision-detail]"), "the snoozed decision's detail is open").not.toBeNull();
    return () => later.querySelector<HTMLElement>(`[data-decision-id='${id}']`);
  }

  test("#1078: pressing Actions again focuses a snoozed decision selected under Later", async () => {
    server = createInboxFixtureServer();
    server.setSnoozeFor(3 * DAY);
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop", { width: 1280 });
    // This harness draws the page itself; the store says Actions is shown.
    d.ui.stores.ui.getState().setActiveView("activity");
    const snoozed = await snoozedDetail(d, "a-one");
    await click(button(d.host.querySelector<HTMLElement>("[data-rail]")!, /^Actions/));
    expect(d.host.querySelector("[data-decision-detail]"), "the detail stays open").not.toBeNull();
    expect(document.activeElement, "the selected card in Later").toBe(snoozed());
  });

  test("#1078: Back from a snoozed decision's detail returns focus to its card under Later", async () => {
    server = createInboxFixtureServer();
    server.setSnoozeFor(3 * DAY);
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("phone");
    const snoozed = await snoozedDetail(d, "a-one");
    await click(button(d.host.querySelector<HTMLElement>("[data-decision-detail]")!, "Back to Actions"));
    await settle(4);
    expect(document.activeElement, "the card the detail was opened from").toBe(snoozed());
  });

  test("15: a decision dropped at the cap leaves on its delta; its detail says so; its FYI is filed under Notes", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour")]);
    const d = await device("laptop", { width: 1280 });
    await click(button(card(d, "a-one"), /^Details: /));
    expect(d.host.querySelector("[data-decision-detail]")!.textContent).toContain("Why this one");
    server.retire("a-one", "dropped");
    server.putItem(decision("fyi-one", "t-harbour", { type: "fyi", options: [], payload: { title: "A decision was dropped at the Actions limit", detail: "File the harbour-fee notice" } }));
    await settle(6);
    expect(d.host.querySelector("[data-decision-list] [data-decision-id='a-one']")).toBeNull();
    expect(d.host.querySelector("[data-decision-detail]")!.textContent).toContain("Dropped at the cap (60)");
    expect(d.host.querySelector("[data-decision-detail] [data-disposition-bar]")).toBeNull();
    await click(button(d.host, /^done /));
    expect(d.host.querySelector("[data-note-card]")!.textContent).toContain("A decision was dropped at the Actions limit");
    expect(d.host.querySelector("[data-note-card] [tabindex]")).toBeNull();
  });

  test("16 · 17 · 18: malformed effects show raw text, deferred effects are unavailable, payloads are data", async () => {
    server = createInboxFixtureServer();
    const bad = decision("a-bad", "t-harbour", {
      payload: { title: "<img src=x onerror=\"window.__pwned=1\"> **bold**", detail: "[link](javascript:alert(1))" },
    });
    bad.options[0] = { id: "approve", label: "File it", effect: { kind: "enqueue", payload: { instruction: "x", operation: { toolName: "Edit", targetPath: "finances/ithaca-port.md", input: { capability: "everything" } } } } };
    const deferred = decision("a-policy", "t-harbour");
    deferred.options.push({ id: "always", label: "Always allow", effect: { kind: "write_policy", policy: { slug: "harbour", content: "always" } } });
    server.seed(thread("t-harbour"), [bad, deferred]);
    const d = await device("laptop");
    const c = card(d, "a-bad");
    expect(c.querySelector("[data-effect-preview='malformed']")!.textContent).toContain("This effect can't be displayed.");
    expect(c.querySelector("[data-effect-raw]")!.textContent).toContain("\"capability\": \"everything\"");
    expect(button(c, /^Approve \(unavailable/).getAttribute("aria-disabled")).toBe("true");
    expect(c.textContent).toContain("Can't approve what can't be shown.");
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("<img src=x onerror=\"window.__pwned=1\"> **bold**");
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(c.querySelector("a")).toBeNull();
    await click(button(c, /^Dismiss: /));
    await click(button(card(d, "a-bad"), "Dismiss with no reason"));
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toEqual([{ type: "inbox_resolve", itemId: "a-bad", optionId: "dismiss" }]);
    const p = card(d, "a-policy");
    expect(p.textContent).toContain("Not available in this version.");
    const always = button(p, /^Always allow/);
    expect(always.getAttribute("aria-disabled")).toBe("true");
    await click(always);
    expect(d.frames().filter((f) => f.type === "inbox_resolve" && f.optionId === "always")).toHaveLength(0);
  });

  test("19: while an answer is in flight a higher-priority arrival waits behind a 'new' row", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop");
    const before = cards(d).map((c) => c.dataset.decisionId);
    server.stall();
    await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
    server.putThread(thread("t-urgent", { stakes: 3, deadline: Date.now() + 3_600_000 }));
    server.putItem(decision("a-urgent", "t-urgent"));
    await settle();
    expect(d.ui.stores.inbox.getState().items["a-urgent"]).toBeDefined();
    expect(cards(d).map((c) => c.dataset.decisionId)).toEqual(before);
    expect(d.host.querySelector("[data-decision-fresh]")!.textContent).toBe("1 new · show");
    await click(d.host.querySelector<HTMLElement>("[data-decision-fresh]")!);
    expect(cards(d)[0]!.dataset.decisionId).toBe("a-urgent");
  });

  test("20: sixty decisions at 320px — ten full, fifty compact, every control at least 44 x 44", async () => {
    server = createInboxFixtureServer();
    const list = Array.from({ length: 60 }, (_, i) => decision(`a-${String(i).padStart(2, "0")}`, "t-harbour", { createdAt: T0 - (i + 1) * 60_000 }));
    server.seed(thread("t-harbour"), list);
    const d = await device("phone", { width: 320 });
    const all = cards(d);
    expect(all).toHaveLength(60);
    expect(all.filter((c) => !c.hasAttribute("data-compact"))).toHaveLength(10);
    const compact = all.filter((c) => c.hasAttribute("data-compact"));
    expect(compact).toHaveLength(50);
    for (const c of compact) expect(() => button(c, /^Approve: /)).toThrow();
    expect(compact[0]!.textContent).toContain("Edit · finances/ithaca-port.md");
    for (const control of d.host.querySelectorAll<HTMLElement>("[data-decision-list] [role='button'], [data-decision-list] button")) {
      const box = control.getBoundingClientRect();
      if (box.width === 0) continue;
      expect(box.height, control.getAttribute("aria-label") ?? control.textContent ?? "").toBeGreaterThanOrEqual(44);
      expect(box.width, control.getAttribute("aria-label") ?? control.textContent ?? "").toBeGreaterThanOrEqual(44);
    }
    // j / k reach every card, full and compact.
    all[0]!.focus();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add((document.activeElement as HTMLElement).dataset.decisionId!);
      await key(document.activeElement as HTMLElement, "j");
    }
    expect(seen.size).toBe(60);
    // `a` on a compact card opens its details instead of approving.
    await key(compact[0]!, "a");
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
    expect(d.host.querySelector("[data-decision-detail]")).not.toBeNull();
    expect(noOverflow(d.host)).toEqual([]);
  });

  test("21 · 22 · 23: the Queue opens from the header, the running lens and the blocking card, and links both ways", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [
      decision("a-one", "t-harbour"),
      blockedWork("q-blocked", "t-harbour", "a-one"),
      blockedWork("q-pruned", "t-harbour", "none", { status: "failed", blockedByItemId: undefined, runId: "run-pruned", attempts: 3 }),
      blockedWork("q-ready", "t-harbour", "none", { status: "ready", blockedByItemId: undefined, attempts: 0 }),
    ]);
    const runs = { "run-pruned": { rollup: { runId: "run-pruned", origin: "autonomous", outcome: "error", startedAt: T0 - DAY, durationMs: 1000, costUsd: null, effectiveCostUsd: null, failureReason: "fetch failed", name: "triage", jobName: null }, detailPruned: true } };
    const d = await device("laptop", { width: 1280, runs });
    // FilterRow still has three lenses; the rail and bar gain no item.
    expect(/needs you \d+/.test(d.host.textContent!)).toBe(true);
    expect(d.host.querySelector("[data-rail]")!.textContent).not.toContain("Queue");
    await click(button(d.host, /^Open the queue, 3 items$/));
    expect(d.host.querySelector("[data-queue-view]")).not.toBeNull();
    await click(button(d.host, "Back to Actions"));
    await click(button(d.host, /^running /));
    await click(d.host.querySelector<HTMLElement>("[data-running-queue]")!);
    expect(d.host.querySelector("[data-queue-view]")).not.toBeNull();
    await click(button(d.host, "Back to Actions"));
    await click(button(d.host, /^needs you /));
    // Card → its blocked row, focused.
    await click(button(card(d, "a-one"), /^Open the queue item blocked on/));
    expect(document.activeElement?.closest("[data-queue-row]")?.getAttribute("data-queue-row")).toBe("q-blocked");
    // Blocked row → back to its Action, focused.
    await click(document.activeElement as HTMLElement);
    await settle(4);
    expect((document.activeElement as HTMLElement).dataset.decisionId).toBe("a-one");
    // Pruned run → rollup with the note; no run → item receipt.
    await click(button(card(d, "a-one"), /^Open the queue item blocked on/));
    await click(d.host.querySelector<HTMLElement>("[data-queue-row='q-pruned'] [role='button']")!);
    await settle(6);
    expect(d.host.textContent).toContain("Trace pruned · this run's rollup is kept.");
    await click(d.host.querySelector<HTMLElement>("[data-queue-row='q-ready'] [role='button']")!);
    expect(d.host.querySelector("[data-queue-receipt]")!.textContent).toContain("share-q-ready");
  });

  test("22 (phone): ⏎ opens details, the detail's Queue link shows the Queue, and an answer from the detail keeps focus there", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour"), blockedWork("q-blocked", "t-harbour", "a-one")]);
    const d = await device("phone", { width: 320 });
    await key(card(d, "a-one"), "Enter");
    const detail = d.host.querySelector<HTMLElement>("[data-decision-detail]")!;
    expect(detail).not.toBeNull();
    await click(button(detail, /^Open the queue item blocked on/));
    const queue = d.host.querySelector<HTMLElement>("[data-queue-view]")!;
    expect(queue).not.toBeNull();
    expect(queue.getBoundingClientRect().width, "the Queue is on screen, not hidden by the detail").toBeGreaterThan(0);
    expect(document.activeElement?.closest("[data-queue-row]")?.getAttribute("data-queue-row")).toBe("q-blocked");
    await click(button(queue, "Back to Actions"));
    await click(button(card(d, "a-two"), /^Details: /));
    await click(button(d.host.querySelector<HTMLElement>("[data-decision-detail]")!, "Approve: Edit finances/ithaca-port.md"));
    await settle(6);
    expect(document.activeElement?.hasAttribute("data-decision-detail-status")).toBe(true);
    expect(d.host.querySelector("[data-decision-detail] [data-decision-receipt='a-two']")!.textContent).toContain("Approved · queued Edit → finances/ithaca-port.md");
    // The last one, from its detail: the receipt survives the list emptying.
    await click(button(d.host.querySelector<HTMLElement>("[data-decision-detail]")!, "Back to Actions"));
    await click(button(card(d, "a-one"), /^Details: /));
    await click(button(d.host.querySelector<HTMLElement>("[data-decision-detail]")!, "Approve: Edit finances/ithaca-port.md"));
    await settle(6);
    expect(d.host.querySelector("[data-decision-detail] [data-decision-receipt='a-one']")!.textContent).toContain("Approved · queued Edit");
    expect(document.activeElement?.hasAttribute("data-decision-detail-status")).toBe(true);
  });

  test("24: a / d / s act only with focus inside the card, and the setting switches them off", async () => {
    server = createInboxFixtureServer();
    server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour")]);
    const d = await device("laptop");
    // Outside any card: nothing happens.
    d.host.querySelector<HTMLElement>("[data-needs-you-heading]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await settle();
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
    await key(card(d, "a-one"), "s");
    expect(card(d, "a-one").querySelector("[data-later-confirm]")).not.toBeNull();
    await key(card(d, "a-two"), "d");
    expect(card(d, "a-two").querySelector("[data-dismiss-confirm]")).not.toBeNull();
    d.ui.stores.ui.setState({ singleKeyShortcuts: false } as never);
    await settle();
    await click(button(card(d, "a-two"), "Keep this decision"));
    await key(card(d, "a-two"), "a");
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toHaveLength(0);
    d.ui.stores.ui.setState({ singleKeyShortcuts: true } as never);
    await settle();
    await key(card(d, "a-two"), "a");
    await settle(4);
    expect(d.frames().filter((f) => f.type === "inbox_resolve")).toEqual([{ type: "inbox_resolve", itemId: "a-two", optionId: "approve" }]);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`25: ${theme} — durable states keep text contrast at or above 4.5:1`, async () => {
      server = createInboxFixtureServer();
      const bad = decision("a-bad", "t-harbour");
      bad.options[0] = { id: "approve", label: "x", effect: { kind: "enqueue", payload: { instruction: "x", operation: { toolName: "Edit", targetPath: "finances/ithaca-port.md", input: { grant: "all" } } } } };
      server.seed(thread("t-harbour"), [decision("a-one", "t-harbour"), decision("a-two", "t-harbour"), bad]);
      const d = await device("laptop", { theme, width: 1280 });
      server.revise("a-two", { payload: { title: "Changed (a-two)", detail: "Penelope" } });
      server.refuseNext();
      await click(button(card(d, "a-one"), "Approve: Edit finances/ithaca-port.md"));
      await settle(6);
      expect(card(d, "a-one").textContent).toContain("Couldn't apply");
      const result = await axe.run(d.host.querySelector("[data-decision-list]")!, { runOnly: { type: "rule", values: ["color-contrast"] } });
      expect(result.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary}`))).toEqual([]);
    });
  }
});
