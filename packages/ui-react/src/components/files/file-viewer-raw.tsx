import { useState } from "react";
import { CopyButton } from "../chat/copy-button.js";

export function FileViewerRaw({ content, fileName }: { content: string; fileName: string }) {
  const [wrap, setWrap] = useState(false);

  return (
    <div className="group relative">
      <div className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border/30 bg-surface/80 px-4 py-1.5 backdrop-blur">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
            className="h-3 w-3 accent-primary"
          />
          Wrap
        </label>
        <CopyButton
          label="Copy file content"
          showLabel
          getText={() => content}
        />
      </div>
      <pre
        className={
          wrap
            ? "whitespace-pre-wrap break-words p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-foreground"
            : "overflow-x-auto p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-foreground"
        }
      >
        <code data-filename={fileName}>{content}</code>
      </pre>
    </div>
  );
}
