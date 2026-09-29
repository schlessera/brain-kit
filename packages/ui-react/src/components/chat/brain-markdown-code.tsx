import React, { useRef } from "react";
import { CopyButton } from "./copy-button.js";
import { MermaidBlock } from "./mermaid-block.js";

/** Concatenate all text descendants of a React node tree. */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/**
 * If a <pre>'s children are a ```mermaid / ```mmd fence, recover the raw
 * diagram source. Text is extracted recursively because rehype-highlight
 * and the linkify pass may have wrapped parts of it in elements.
 */
function mermaidSourceFrom(children: React.ReactNode): string | null {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement(child)) continue;
    const props = child.props as { className?: string; children?: React.ReactNode };
    if (typeof props.className === "string" && /\blanguage-(?:mermaid|mmd)\b/.test(props.className)) {
      return extractText(props.children).replace(/\n$/, "");
    }
  }
  return null;
}

export function MarkdownPre({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const mermaid = mermaidSourceFrom(children);
  if (mermaid !== null) return <MermaidBlock source={mermaid} />;
  return <CodePre {...props}>{children}</CodePre>;
}

function CodePre({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/copy relative">
      <pre
        ref={ref}
        className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed"
        {...props}
      >
        {children}
      </pre>
      <CopyButton getText={() => ref.current?.textContent ?? ""} />
    </div>
  );
}

export function MarkdownTable({ children, ...props }: React.ComponentPropsWithoutRef<"table">) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table {...props}>{children}</table>
    </div>
  );
}
