import { expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ModelsCatalogView } from "../../src/components/settings/models-list.js";
import { PasskeyList } from "../../src/components/settings/passkey-list.js";
import { SkillsList } from "../../src/components/settings/skills-list.js";
import { PrincipalList } from "../../src/components/settings/principal-list.js";
import { WebSearchChain } from "../../src/components/settings/web-search-chain.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { SettingsFields } from "../../src/components/settings/module-settings-fields.js";
import { createModuleSettingsSession } from "../../src/components/settings/module-settings-state.js";
import { OneTimeAgentCredentialDialog } from "../../src/components/settings/one-time-agent-credential.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";
import variantFixture from "../../../ui-kit/tests/visual/fixtures/module-settings.json";
import catalogFixture from "../../../ui-kit/tests/visual/fixtures/module-settings-catalog.json";
import type { ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";

const noop = () => {};
const controls = [
  ["button", "Remove vendor/ithaca"], ["switch", "Show Ithaca model in picker"],
  ["button", "Rename Ithaca laptop"], ["button", "Remove Ithaca laptop"],
  ["button", "Edit voyage-plan SKILL.md"], ["switch", "Enable voyage-plan on all backends"],
  ["button", "Delete voyage-plan permanently"], ["button", "Revoke Eumaeus"],
  ["button", "Needs key"], ["button", "Share voyage"],
  ["button", "Decrease Count"], ["button", "Increase Count"], ["button", "Remove Ithaca"],
  ["button", "Move Crew down"], ["button", "Move Fleet up"],
] as const;

async function mount(ctx: TestContext, width: number, theme: "dark" | "light") {
  const viewport = { width: innerWidth, height: innerHeight };
  const beforeTheme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = theme;
  const styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
  const host = document.createElement("div"); host.style.cssText = "width:100%;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ models: [], discovery: { enabled: false }, customModels: [], providers: [], modules: [], tools: [] }) });
  const renderer = createRoot(host);
  const modelToggle = vi.fn(); const skillToggle = vi.fn();
  const store = createModuleSettingsSession();
  const snapshot = catalogFixture as ModuleSettingsSnapshot;
  store.setState({ snapshot, draft: structuredClone(snapshot.overrides) });
  const variantStore = createModuleSettingsSession();
  const variant = variantFixture as ModuleSettingsSnapshot;
  variantStore.setState({ snapshot: variant, draft: structuredClone(variant.overrides) });
  function Variants() { const session = useStore(variantStore); return <SettingsFields snapshot={variant} session={session} store={variantStore} />; }
  function Fields() { const session = useStore(store); return <SettingsFields snapshot={snapshot} session={session} store={store} />; }
  function Gallery({ busy = false }: { busy?: boolean }) {
    return <BrainUiProvider root={ui}>
      <ModelsCatalogView catalog={{ models: [{ id: "ithaca", label: "Ithaca model", hidden: false }], customModels: ["vendor/ithaca"], stale: false, discovery: { enabled: false }, refreshedAt: null }} loading={false} refreshing={false} error={null} sections={null} onToggleHidden={modelToggle} onBilling={noop} onThinking={noop} onDefault={noop} onCustomModels={noop} onRefresh={noop} />
      <PasskeyList credentials={[{ id: "laptop", label: "Ithaca laptop", rpId: "fixture.invalid", createdAt: Date.UTC(2026, 6, 12), lastUsedAt: null, backedUp: false, deviceType: "singleDevice", transports: [], aaguid: null }]} status="ready" busy={false} error={null} supported hostname="fixture.invalid" onAdd={noop} onRename={noop} onDelete={noop} onSignOut={noop} />
      <SkillsList skills={[{ name: "voyage-plan", description: "Plan the return to Ithaca", source: "custom", enabled: true }]} busy={busy ? "voyage-plan" : null} installing={false} error={null} warning={null} outcomes={null} newName="" githubSource="" overwrite={false} onNewName={noop} onCreate={noop} onGithubSource={noop} onOverwrite={noop} onInstallZip={noop} onInstallGitHub={noop} onOpen={noop} onToggle={skillToggle} onRemove={noop} />
      <PrincipalList state="ready" principals={[{ id: "eumaeus", label: "Eumaeus", kind: "agent", isOwn: false, created: "2026-07-12", lastSeen: "Never", expires: "2026-07-19" }]} error={null} label="" ttlDays={7} minting={false} onLabel={noop} onTtlDays={noop} onMint={noop} onRevoke={noop} />
      <WebSearchChain config={{ configured: true, order: [], overriddenBy: null, appliesTo: [], providers: [{ id: "voyage", label: "Voyage search", enabled: false, hasKeyField: true, keyConfigured: false, keyFromEnv: false, keyless: false, costNote: "Paid", blurb: "Find sailing notes" }] }} busy={false} error={null} openKey={null} keyDraft="" savedFlash={false} onToggle={noop} onToggleKey={noop} onKeyDraft={noop} onSaveKey={noop} onClearKey={noop} onClearOverride={noop} />
      <div style={{ padding: 16, display: "flex", justifyContent: "flex-end" }}><ShareMenu title="Share voyage" options={[{ id: "copy", label: "Copy voyage", hint: "Copy the sailing notes", run: async () => true }, { id: "save", label: "Save voyage", run: async () => true }]} /></div>
      <div style={{ padding: 16 }}><Fields /></div>
    </BrainUiProvider>;
  }
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); styles.remove();
    if (beforeTheme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = beforeTheme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  flushSync(() => renderer.render(<Gallery />));
  const find = (role: string, name: string) => page.getByRole(role, { name, exact: true });
  const rename = async () => { await find("button", "Rename Ithaca laptop").click(); };
  const menu = async () => { await find("button", "Share voyage").click(); };
  const tabs = async () => {
    ui.stores.ui.getState().setSettingsTab("appearance");
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={noop} /></BrainUiProvider>));
    await expect.poll(() => page.getByRole("tab", { name: width < 900 ? "Models" : "Appearance & input", exact: true }).elements().length).toBe(1);
  };
  const variants = () => flushSync(() => renderer.render(<Variants />));
  const credential = async () => {
    flushSync(() => {
      ui.stores.principal.setState({ oneTimeCredential: { id: "eumaeus", label: "Eumaeus", cookie: "odysseus-fixture-cookie", expiresAt: Date.UTC(2026, 6, 19) } });
      renderer.render(<BrainUiProvider root={ui}><OneTimeAgentCredentialDialog /></BrainUiProvider>);
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  return { find, rename, menu, tabs, variants, credential, modelToggle, skillToggle,
    busy: () => flushSync(() => renderer.render(<Gallery busy />)) };
}

/** Shared by layout and the three real pointer projects; no pointer emulation. */
export function settingsButtonCases(pointer: () => "fine" | "coarse" | "mixed") {
  for (const width of [320, 1280]) for (const theme of ["dark", "light"] as const) {
    const prefix = `batch4 ${width} ${theme}`;
    test(`${prefix} names`, async ctx => {
      const s = await mount(ctx, width, theme);
      const named = (role: string) => page.getByRole(role).elements().map(el => el.getAttribute("aria-label") ?? el.textContent);
      const found = controls.map(([role, name]) => named(role).includes(name));
      await s.rename();
      found.push(named("button").includes("Save name"), named("button").includes("Cancel rename"));
      await s.credential();
      found.push(named("button").includes("Copy credential"), named("button").includes("Done"));
      expect(found, "batch4 controls have explicit stable accessible names").toEqual(Array(19).fill(true));
    });
    test(`${prefix} target reach`, async ctx => {
      const s = await mount(ctx, width, theme);
      const results: boolean[] = [];
      for (const [role, name] of controls) {
        const el = s.find(role, name).element() as HTMLElement; el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        if (role === "switch") {
          results.push([b.top - 10.5, b.bottom + 10.5].every(y => el.contains(document.elementFromPoint(b.left + b.width / 2, y))));
          results.push([b.left - 2.5, b.right + 2.5].every(x => el.contains(document.elementFromPoint(x, b.top + b.height / 2))));
        } else {
          const floor = el.classList.contains("bk-icon-btn") && el.dataset.size === "sm" && pointer() === "fine" ? 28 : 44;
          results.push(b.width >= floor && b.height >= floor && b.left >= 0 && b.right <= width);
        }
      }
      await s.rename();
      for (const name of ["Save name", "Cancel rename"]) { const b = s.find("button", name).element().getBoundingClientRect(); const floor = pointer() === "fine" ? 28 : 44; results.push(b.width >= floor && b.height >= floor && b.left >= 0 && b.right <= width); }
      await s.credential();
      for (const name of ["Copy credential", "Done"]) { const b = s.find("button", name).element().getBoundingClientRect(); results.push(b.width >= 44 && b.height >= 44); }
      expect(results, "batch4 targets reach their pointer floor without stealing neighbours").toEqual(Array(results.length).fill(true));
    });
    test(`${prefix} focus rings`, async ctx => {
      const s = await mount(ctx, width, theme);
      const results: Array<[boolean, string, string, string]> = [];
      await userEvent.keyboard("{Tab}");
      function inspect(el: HTMLElement, offset: string) { el.focus(); const css = getComputedStyle(el); results.push([document.activeElement === el, css.outlineWidth, css.outlineStyle, css.outlineOffset]); return [true, "2px", "solid", offset] as [boolean, string, string, string]; }
      const expected = controls.map(([role, name]) => inspect(s.find(role, name).element() as HTMLElement, "2px"));
      await s.rename(); await userEvent.keyboard("{Tab}");
      for (const name of ["Save name", "Cancel rename"]) expected.push(inspect(s.find("button", name).element() as HTMLElement, "2px"));
      await s.menu(); await userEvent.keyboard("{Tab}");
      expected.push(inspect(s.find("menuitem", "Copy voyage Copy the sailing notes").element() as HTMLElement, "-2px"));
      await s.tabs(); await userEvent.keyboard("{Tab}");
      expected.push(inspect(s.find("tab", width < 900 ? "Models" : "Appearance & input").element() as HTMLElement, "-2px"));
      s.variants(); await userEvent.keyboard("{Tab}");
      expected.push(inspect(s.find("button", "Graded tiers").element() as HTMLElement, "-2px"));
      await s.credential();
      const copy = s.find("button", "Copy credential").element() as HTMLElement;
      // Record opening focus before inspect() focuses anything itself.
      results.push([document.activeElement === copy, getComputedStyle(copy).outlineWidth, getComputedStyle(copy).outlineStyle, getComputedStyle(copy).outlineOffset]);
      expected.push([true, "2px", "solid", "2px"]);
      await page.getByRole("checkbox", { name: "I have saved this credential somewhere safe." }).click();
      await userEvent.keyboard("{Tab}");
      expected.push(inspect(s.find("button", "Done").element() as HTMLElement, "2px"));
      expect(results, "batch4 controls and rows show keyboard focus rings").toEqual(expected);
    });
    test(`${prefix} selected variant hover paint`, async ctx => {
      const s = await mount(ctx, width, theme);
      s.variants();
      const selected = s.find("button", "Graded tiers").element() as HTMLElement;
      const rest = getComputedStyle(selected).backgroundColor;
      await userEvent.hover(selected);
      expect(getComputedStyle(selected).backgroundColor, "selected variant keeps its amber paint on hover").toBe(rest);
    });
    test(`${prefix} switch keyboard and busy semantics`, async ctx => {
      const s = await mount(ctx, width, theme);
      const model = s.find("switch", "Show Ithaca model in picker").element() as HTMLElement;
      const skill = s.find("switch", "Enable voyage-plan on all backends").element() as HTMLElement;
      model.focus(); await userEvent.keyboard(" "); skill.focus(); await userEvent.keyboard(" ");
      const state = [model.getAttribute("aria-checked"), skill.getAttribute("aria-checked"), s.modelToggle.mock.calls.length, s.skillToggle.mock.calls.length];
      s.busy();
      const locked = s.find("switch", "Enable voyage-plan on all backends").element() as HTMLElement;
      locked.click(); locked.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect([...state, locked.getAttribute("aria-disabled"), locked.tabIndex, s.skillToggle.mock.calls.length], "batch4 switches activate by Space and busy stays inert").toEqual(["true", "true", 1, 1, "true", -1, 1]);
    });
  }
}
