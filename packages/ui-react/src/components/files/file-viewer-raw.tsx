import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function FileViewerRaw({ content, fileName }: { content: string; fileName: string }) {
  const [copied, setCopied] = useState(false);
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
        <button
          onClick={() => {
            navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy file content"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
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
