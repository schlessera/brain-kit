import { RelatedFiles } from "@schlessera/brain-ui-kit";
import type { Block } from "@schlessera/brain-ui-sdk/client";
import { useBrainUiRoot } from "../../../root-context.js";
import { openableLocalFilePath } from "../../../lib/local-file-path.js";

type FilesBlock = Extract<Block, { kind: "files" }>;

/** Reasons are answer text; opening a row uses the existing authenticated viewer. */
export function SupportingFiles({ block, isStatic }: { block: FilesBlock; isStatic: boolean }) {
  const root = useBrainUiRoot();
  return <RelatedFiles label="Supporting files" meta="" items={block.items.map(item => ({
    path: item.path,
    reason: item.reason ?? "",
    score: "",
    ...(!isStatic && openableLocalFilePath(item.path) ? { onClick: () => {
      root.stores.ui.getState().setFilePanelOpen(true);
      void root.stores.file.getState().openFile(item.path);
    } } : {}),
  }))} />;
}
