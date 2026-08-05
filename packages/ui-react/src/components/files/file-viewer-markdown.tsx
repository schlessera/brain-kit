import { useMemo } from "react";
import { BrainMarkdown } from "../chat/brain-markdown.js";
import { splitFrontmatter } from "../../lib/frontmatter.js";
import { FrontmatterPanel } from "./frontmatter-panel.js";

export function FileViewerMarkdown({ content }: { content: string }) {
  const { fields, body } = useMemo(() => splitFrontmatter(content), [content]);
  return (
    <div className="px-6 py-4">
      {fields.length > 0 && <FrontmatterPanel fields={fields} />}
      <BrainMarkdown content={body} className="brain-prose max-w-none" fileLinks />
    </div>
  );
}
