import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
let fixture: { id: string; url: string } | undefined,
  ui: BrainUiRoot | undefined,
  renderer: Root | undefined,
  host: HTMLElement | undefined,
  style: HTMLElement | undefined;
const before = { width: innerWidth, height: innerHeight };
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  if (fixture) await commands.storageServer({ op: "stop", id: fixture.id });
  fixture = undefined;
  await page.viewport(before.width, before.height);
});
type Witness = {
  exists: boolean;
  hash: string | null;
  originalHash: string;
  confirms: number;
  latest: { state: string };
};
const patch = (value: Record<string, unknown> = {}) =>
  commands.storageServer({
    op: "set",
    id: fixture!.id,
    patch: value,
  }) as Promise<Witness>;
const button = (name: string) =>
  page.getByRole("button", { name, exact: true });
async function scene(width: number) {
  await page.viewport(width, 900);
  fixture = (await commands.storageServer({ op: "start" })) as typeof fixture;
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText =
    "height:900px;display:flex;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  ui = createBrainUiRoot({
    storage: null,
    config: { backendUrl: fixture!.url },
    request: fetch,
  });
  renderer = createRoot(host);
  flushSync(() =>
    renderer!.render(
      <BrainUiProvider root={ui!}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  await expect.poll(() => page.getByRole("table").elements().length).toBe(1);
  await button("Find large files").click();
  await expect
    .poll(() => button("Inspect chart.pdf").elements().length)
    .toBe(1);
  await button("Inspect chart.pdf").click();
  await expect
    .poll(() => button("Select file").element().getAttribute("aria-disabled"))
    .not.toBe("true");
  await button("Select file").click();
  await button("Review selected files").click();
  await expect.poll(() => button("Remove 1 file").elements().length).toBe(1);
}
for (const width of [320, 1280])
  test(`Storage HTTP removal and Undo retain exact bytes at ${width}`, async () => {
    await scene(width);
    const initial = await patch({ drop: true });
    expect(initial.exists).toBe(true);
    await button("Remove 1 file").click();
    await expect
      .poll(() => page.getByRole("dialog").element().textContent, {
        timeout: 15000,
      })
      .toContain("1 removed");
    const removed = await patch();
    expect(removed.exists, "STORAGE_BROWSER_REAL_UNLINK").toBe(false);
    expect(removed.confirms, "STORAGE_BROWSER_ORIGINAL_ID_ONLY").toBe(1);
    await button("Check original receipt").click();
    expect((await patch()).confirms).toBe(1);
    await button("Undo removal of attachments/chart.pdf").click();
    await expect.poll(() => button("Restore 1 file").elements().length).toBe(1);
    await button("Restore 1 file").click();
    await expect
      .poll(() => page.getByRole("dialog").element().textContent, {
        timeout: 15000,
      })
      .toContain("1 restored");
    const restored = await patch();
    expect(restored.exists).toBe(true);
    expect(restored.hash, "STORAGE_BROWSER_EXACT_RESTORED_BYTES").toBe(
      initial.originalHash
    );
    expect(restored.confirms).toBe(2);
  }, 30000);
test("Storage HTTP rechecks a file changed after the visible review", async () => {
  await scene(320);
  const changed = await patch({ change: true });
  await button("Remove 1 file").click();
  await expect
    .poll(() => page.getByRole("dialog").element().textContent, {
      timeout: 15000,
    })
    .toContain("changed");
  const result = await patch();
  expect(result.exists, "STORAGE_BROWSER_STALE_TARGET_SURVIVES").toBe(true);
  expect(result.hash).toBe(changed.hash);
  expect(result.confirms).toBe(1);
}, 30000);
