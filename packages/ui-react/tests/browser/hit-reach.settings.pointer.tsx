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
import { expect, test, type TestContext } from "vitest";
import { page } from "vitest/browser";
import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
import { PrincipalList } from "../../src/components/settings/principal-list.js";
import { SettingsFields } from "../../src/components/settings/module-settings-fields.js";
import { createModuleSettingsSession } from "../../src/components/settings/module-settings-state.js";
import { OneTimeAgentCredentialDialog } from "../../src/components/settings/one-time-agent-credential.js";
import { AgentPolicyGroup } from "../../src/components/settings/agent-policy-group.js";
import { ModulesTab } from "../../src/components/settings/modules-tab.js";
import { storageViewFixture, type StorageScene } from "../fixtures/storage-view.js";
import { mount, reach } from "./hit-reach-scene.js";
import catalogFixture from "../../../ui-kit/tests/visual/fixtures/module-settings-catalog.json";
import variantFixture from "../../../ui-kit/tests/visual/fixtures/module-settings.json";
import type { ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";

const noop = () => {};

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
