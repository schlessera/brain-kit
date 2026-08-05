import { uiConfig } from "../../config.js";
import { useRef } from "react";
import { BrainMarkdown } from "./brain-markdown.js";
import { ShareMenu, type ShareOption } from "../share/share-menu.js";
import { renderAndShare, shareFile, shareText, copyRichText } from "../../lib/share.js";
import { stripMarkdown } from "../../lib/strip-markdown.js";
import { Share2 } from "lucide-react";

export type ShareBlockFormat = "image" | "pdf" | "text" | "markdown" | "richtext";

const FORMAT_LABELS: Record<ShareBlockFormat, string> = {
  image: "Share as image",
  pdf: "Share as PDF",
  text: "Share as plain text",
  markdown: "Share markdown source",
  richtext: "Copy as rich text",
};

const ORDER: ShareBlockFormat[] = ["image", "pdf", "text", "markdown", "richtext"];

interface ShareBlockProps {
  body: string;
  format?: ShareBlockFormat;
  title?: string;
}

export function ShareBlock({ body, format = "image", title }: ShareBlockProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const filename = sanitizeFilename(title ?? "share");

  const primary = makeAction(format, body, filename, title, bodyRef);
  const secondary: ShareOption[] = ORDER.filter((f) => f !== format).map((f) =>
    makeAction(f, body, filename, title, bodyRef)
  );

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-primary/30 bg-primary/[0.04]">
      <div className="flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/[0.06] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Share2 className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <span className="truncate font-medium text-primary/90">
            {title ?? "Share"}
          </span>
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary/80">
            {format}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void primary.run()}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {primary.label}
          </button>
          <ShareMenu options={secondary} title="Other formats" />
        </div>
      </div>
      <div ref={bodyRef} className="px-4 py-3">
        <BrainMarkdown content={body} className="brain-prose" fileLinks />
      </div>
    </div>
  );
}

function makeAction(
  fmt: ShareBlockFormat,
  body: string,
  filename: string,
  title: string | undefined,
  bodyRef: React.RefObject<HTMLDivElement | null>
): ShareOption {
  return {
    id: fmt,
    label: FORMAT_LABELS[fmt],
    run: () => runFormat(fmt, body, filename, title, bodyRef),
  };
}

async function runFormat(
  fmt: ShareBlockFormat,
  body: string,
  filename: string,
  title: string | undefined,
  bodyRef: React.RefObject<HTMLDivElement | null>
): Promise<boolean> {
  switch (fmt) {
    case "image":
      return renderAndShare({
        content: body,
        contentType: "markdown",
        format: "png",
        filename,
        title: title ?? uiConfig.shareTitle,
      });
    case "pdf":
      return renderAndShare({
        content: body,
        contentType: "markdown",
        format: "pdf",
        filename,
        title: title ?? uiConfig.shareTitle,
      });
    case "text":
      return shareText({ text: stripMarkdown(body), title });
    case "markdown":
      return shareFile(
        new File([body], `${filename}.md`, { type: "text/markdown" }),
        { title: title ?? filename }
      );
    case "richtext": {
      const html = bodyRef.current?.innerHTML ?? `<pre>${escapeHtml(body)}</pre>`;
      return copyRichText(html, stripMarkdown(body));
    }
  }
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "share";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
