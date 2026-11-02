/**
 * #3252, Settings and Storage: controls keep their kit paint and reach 44px
 * past it under a coarse pointer, instead of drawing a 44px box.
 *
 * Runs in the rail-fine, rail-coarse and rail-mixed projects, each a native
 * pointer premise with no matchMedia mock. Every scene checks two things:
 *
 * - no kit Button inflates its box to 44px (the failing-first assertion: on
 *   main every one of these Buttons carried `minHeight: 44`);
 * - every enabled control owns `elementFromPoint` just inside each edge of its
 *   target. A reaching control is held to 44px under a coarse pointer; every
 *   neighbour is held to its own paint, so a reach that steals is caught on
 *   the neighbour it steals from.
 */
import { expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
import { PrincipalList } from "../../src/components/settings/principal-list.js";
import { SettingsFields } from "../../src/components/settings/module-settings-fields.js";
import { createModuleSettingsSession } from "../../src/components/settings/module-settings-state.js";
import { OneTimeAgentCredentialDialog } from "../../src/components/settings/one-time-agent-credential.js";
import { AgentPolicyGroup } from "../../src/components/settings/agent-policy-group.js";
import { ModulesTab } from "../../src/components/settings/modules-tab.js";
import { storageViewFixture, type StorageScene } from "../fixtures/storage-view.js";
import { OWNED, coarsePointer, describeHit, probeScope, targetRect } from "./hit-reach.js";
import catalogFixture from "../../../ui-kit/tests/visual/fixtures/module-settings-catalog.json";
import variantFixture from "../../../ui-kit/tests/visual/fixtures/module-settings.json";
import type { ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";

const noop = () => {};

function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "native coarse pointer premise").toBe(mode !== "fine");
  return mode;
}

async function mount(ctx: TestContext, width: number, request: (url: string, init?: RequestInit) => Promise<Response>) {
  premise();
  const viewport = { width: innerWidth, height: innerHeight };
  const theme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = "dark";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 6, 12, 9, 41));
  const style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  style.textContent += "\n*,*::before,*::after{animation:none!important;transition:none!important}";
  document.head.append(style);
  const host = document.createElement("div");
  host.style.cssText = `width:${width}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => request(String(url), init) });
  const renderer = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); style.remove();
    vi.useRealTimers();
    if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  const draw = (children: ReactNode) => flushSync(() => renderer.render(<BrainUiProvider root={ui}>{children}</BrainUiProvider>));
  return { host, ui, draw };
}

/** Both halves of the rule, for one rendered scene. */
function reach(scope: ParentNode, label: string) {
  const buttons = [...scope.querySelectorAll<HTMLElement>("[data-bk-button][role=button]")];
  expect(buttons.length, `${label}: the scene renders Buttons`).toBeGreaterThan(0);
  const inflated = buttons.filter(button => button.style.minHeight === "44px").map(describeHit);
  expect(inflated, `${label}: no Button draws a 44px box to reach 44px`).toEqual([]);
  if (coarsePointer()) {
    // Without this the edge probe passes vacuously: a Button with no reach is
    // probed at its paint. Under a coarse pointer every enabled Button whose
    // paint is under 44px must reach, and must reach 44px.
    const enabled = buttons.filter(button => button.getAttribute("aria-disabled") !== "true");
    const unreached = enabled.filter(button => { const r = button.getBoundingClientRect(); return !button.classList.contains("bk-hit") && (r.height < 44 || r.width < 44); }).map(describeHit);
    expect(unreached, `${label}: no enabled Button stays under 44px`).toEqual([]);
    const short = enabled.filter(button => button.classList.contains("bk-hit"))
      .filter(button => { const t = targetRect(button, 44); return t.width < 44 || t.height < 44; }).map(describeHit);
    expect(short, `${label}: every reaching Button reaches 44px`).toEqual([]);
  }
  const stolen = probeScope(scope).filter(row => JSON.stringify(row.owners) !== JSON.stringify(OWNED));
  expect(stolen, `${label}: every control owns each edge of its target`).toEqual([]);
}

const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });
const dialog = () => page.getByRole("dialog").element();

async function storage(ctx: TestContext, width: number, kind: StorageScene) {
  const fixture = storageViewFixture(kind);
  const s = await mount(ctx, width, (url, init) => fixture.request(url, init));
  s.draw(<StorageTab active />);
  await expect.poll(() => fixture.requests.some(row => row.path === "/api/storage/removals")).toBe(true);
  await expect.poll(() => s.host.querySelectorAll("[data-bk-button]").length).toBeGreaterThan(0);
  return { ...s, fixture };
}

for (const width of [320, 1280]) {
  for (const kind of ["dense", "partial", "empty", "maintenance", "separate"] as const) {
    test(`Storage ${kind} overview at ${width}`, async ctx => {
      const s = await storage(ctx, width, kind);
      reach(s.host, `storage ${kind}`);
    });
  }
  test(`Storage files, inspect and review dialogs at ${width}`, async ctx => {
    const s = await storage(ctx, width, "dense");
    await button("Find large files").click();
    await expect.poll(() => page.getByRole("table").element().textContent).toContain("Ithaca-harbor.pdf");
    reach(s.host, "storage files");
    await button("Inspect Ithaca-harbor.pdf").click();
    await expect.poll(() => button("Select file").elements().length).toBe(1);
    reach(dialog(), "storage inspect dialog");
    await button("Select file").click();
    await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
    await button("Review selected files").click();
    await expect.poll(() => button("Remove 1 file").elements().length).toBe(1);
    reach(dialog(), "storage review dialog");
  });
  test(`Settings principals, module fields and agent policy at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => url.endsWith("/agent-policy")
      ? Response.json({ path: "context/policies/governance.md", hash: "a1b2c3", source: "policy", errors: [], warnings: [],
          profiles: { interactive: "governed", voice: "strict" }, protectedPaths: ["voyage/return.md"], workerLimits: null })
      : Response.json({}));
    const catalog = createModuleSettingsSession(), catalogSnapshot = catalogFixture as ModuleSettingsSnapshot;
    catalog.setState({ snapshot: catalogSnapshot, draft: structuredClone(catalogSnapshot.overrides) });
    const variants = createModuleSettingsSession(), variantSnapshot = variantFixture as ModuleSettingsSnapshot;
    variants.setState({ snapshot: variantSnapshot, draft: structuredClone(variantSnapshot.overrides) });
    function Fields({ store, snapshot }: { store: typeof catalog; snapshot: ModuleSettingsSnapshot }) {
      const session = useStore(store); return <SettingsFields snapshot={snapshot} session={session} store={store} />;
    }
    s.draw(<div style={{ padding: 16 }}>
      <AgentPolicyGroup active />
      <PrincipalList state="ready" principals={[{ id: "eumaeus", label: "Eumaeus", kind: "agent", isOwn: false, created: "2026-07-12", lastSeen: "Never", expires: "2026-07-19" }]} error={null} label="" ttlDays={7} minting={false} onLabel={noop} onTtlDays={noop} onMint={noop} onRevoke={noop} />
      <Fields store={catalog} snapshot={catalogSnapshot} />
      <Fields store={variants} snapshot={variantSnapshot} />
    </div>);
    await expect.poll(() => button("Open governance policy").elements().length).toBe(1);
    reach(s.host, "settings gallery");
  });
  test(`Settings one-time credential at ${width}`, async ctx => {
    const s = await mount(ctx, width, async () => Response.json({}));
    flushSync(() => s.ui.stores.principal.setState({ oneTimeCredential: { id: "eumaeus", label: "Eumaeus", cookie: "odysseus-fixture-cookie", expiresAt: Date.UTC(2026, 6, 19) } }));
    s.draw(<OneTimeAgentCredentialDialog />);
    await expect.poll(() => button("Copy credential").elements().length).toBe(1);
    reach(page.getByRole("alertdialog").element(), "one-time credential");
  });
  test(`Settings module detail at ${width}`, async ctx => {
    const snapshot = catalogFixture as ModuleSettingsSnapshot;
    const s = await mount(ctx, width, async url => url.includes("/modules/") ? Response.json(snapshot) : Response.json({ modules: [] }));
    const store = createModuleSettingsSession();
    store.setState({ name: snapshot.module, snapshot, draft: structuredClone(snapshot.overrides) });
    s.draw(<ModulesTab active session={store} />);
    await expect.poll(() => button("Back to modules").elements().length).toBe(1);
    reach(s.host, "module detail");
  });
}
