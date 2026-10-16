import preview from "#.storybook/preview";
import { useEffect, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { StorageTab } from "../../../ui-react/src/components/settings/storage-tab.js";
import {
  storageViewFixture,
  type StorageScene,
} from "../../../ui-react/tests/fixtures/storage-view.js";
import {
  ConsumerDocument,
  consumerViewport,
  painted,
  accessible,
} from "./_consumer-parity.js";
function StorageTheme({ scene }: { width: number; scene: StorageScene }) {
  const [root] = useState(() =>
    createBrainUiRoot({
      storage: null,
      request: storageViewFixture(scene).request,
    })
  );
  useEffect(() => () => root.dispose(), [root]);
  return (
    <ConsumerDocument>
      <div
        style={{
          display: "flex",
          height: 800,
          margin: -16,
          width: "calc(100% + 32px)",
        }}
      >
        <BrainUiProvider root={root}>
          <StorageTab active />
        </BrainUiProvider>
      </div>
    </ConsumerDocument>
  );
}
const meta = preview.meta({
  title: "Settings/Storage",
  component: StorageTheme,
  parameters: { layout: "fullscreen" },
  beforeEach: consumerViewport,
  args: { width: 320, scene: "dense" as StorageScene },
});
const overview = async ({
  args,
  globals,
}: {
  args: { width: number };
  globals: { theme?: string };
}) => {
  await painted(args.width, globals.theme);
  const screen = within(document.body);
  await screen.findByRole("group", { name: /Storage map/ });
  await accessible(document.querySelector<HTMLElement>("[data-storage-pane]")!);
};
export const Phone = meta.story({ play: overview });
export const Desktop = meta.story({ args: { width: 1280 }, play: overview });
export const SeparateTemporary = meta.story({
  args: { scene: "separate" },
  play: overview,
});
export const Partial = meta.story({
  args: { scene: "partial" },
  play: overview,
});
export const Empty = meta.story({ args: { scene: "empty" } });
export const Unsupported = meta.story({ args: { scene: "unsupported" } });
export const NeverMeasured = meta.story({ args: { scene: "never" } });
export const RemovalAndUndo = meta.story({
  play: async ({ args, globals, userEvent }) => {
    await overview({ args, globals });
    const screen = within(document.body);
    await userEvent.click(
      screen.getByRole("button", { name: "Find large files" })
    );
    for (const name of ["Ithaca-harbor.pdf", "Troy-charts.PDF"]) {
      await userEvent.click(
        await screen.findByRole("button", {
          name: `Inspect ${name}`,
        })
      );
      const select = await screen.findByRole("button", {
        name: "Select file",
      });
      await waitFor(() =>
        expect(select).not.toHaveAttribute("aria-disabled", "true")
      );
      await userEvent.click(select);
    }
    await userEvent.click(
      screen.getByRole("button", { name: "Review selected files" })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove 2 files" })
    );
    await screen.findByText("1 removed · 0 restored · 1 other outcomes");
    await accessible(screen.getByRole("dialog"));
    await userEvent.click(
      screen.getByRole("button", {
        name: "Undo removal of attachments/Ithaca-harbor.pdf",
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Restore 1 file" })
    );
    await screen.findByText("0 removed · 1 restored · 0 other outcomes");
    await accessible(screen.getByRole("dialog"));
  },
});
