import React from "react";
import { CodeBlock } from "@schlessera/brain-ui-kit";
import { CopyButton } from "./copy-button.js";
import { ContentRendererView } from "../content-renderer.js";

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

export function MarkdownPre({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement(child)) continue;
    const code = child.props as { className?: string; children?: React.ReactNode };
    const language = code.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
    if (language) return <ContentRendererView language={language} source={extractText(code.children).replace(/\n$/, "")} fallback={<CodePre {...props}>{children}</CodePre>} />;
  }
  return <CodePre {...props}>{children}</CodePre>;
}

function CodePre({ children }: React.ComponentPropsWithoutRef<"pre">) {
  const source = extractText(children).replace(/\n$/, "");
  let language: string | undefined;
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement(child)) continue;
    const props = child.props as { className?: string };
    const match = props.className?.match(/(?:^|\s)language-([^\s]+)/);
    if (match) { language = match[1]; break; }
  }
  return (
    <div data-chat-code className="my-3">
      <CodeBlock code={source} lang={language} fontSize={13} action={
        <span className="print:hidden -mr-1 flex shrink-0"><CopyButton getText={() => source} size="md" tone="mute" /></span>
      }>{children}</CodeBlock>
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
