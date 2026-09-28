import { useBrainUiRoot } from "../../root-context.js";
import React, { memo, useContext, useEffect, useMemo } from "react";
import Markdown from "react-markdown";

import {
  classifyRepoPath,
  useFileStore,
} from "../../stores/file-store.js";
import { ShareBlock } from "./share-block.js";
import { ZoomableImage } from "../images/zoomable-image.js";
import { MarkdownPre, MarkdownTable } from "./brain-markdown-code.js";
import {
  processChildText,
  renderEntityTags,
} from "./brain-markdown-entities.js";
import {
  DirLink,
  FileLink,
  repoImageSrc,
} from "./brain-markdown-links.js";
import { splitShareBlocks } from "./brain-markdown-share.js";
import { InsideProseLink, ProseLink } from "./prose-link.js";
import {
  REMARK_PLUGINS,
  useRehypePlugins,
} from "./use-markdown-highlight.js";

export {
  DirLink,
  FileLink,
  WikiLink,
  linkifyPaths,
  repoImageSrc,
} from "./brain-markdown-links.js";

interface BrainMarkdownProps {
  content: string;
  className?: string;
  entityTags?: boolean;
  fileLinks?: boolean;
}
/**
 * Wrap any element's render to process entity markers + file paths in its text
 * children. Inside a prose link no path or wikilink is linkified: a withheld
 * link's text is final (D49 §4), and an anchor inside an anchor is not HTML.
 */
function withTextProcessing<T extends keyof React.JSX.IntrinsicElements>(
  Tag: T,
  opts: { entityTags: boolean; fileLinks: boolean }
) {
  const inLink = { ...opts, fileLinks: false };
  // `node` is react-markdown's hast node, not an attribute.
  return function TextProcessed({ children, node: _node, ...props }: React.ComponentPropsWithoutRef<T> & { children?: React.ReactNode; node?: unknown }) {
    const inside = useContext(InsideProseLink);
    return React.createElement(Tag, props as any, processChildText(children, inside ? inLink : opts));
  };
}
/**
 * Memoized because rendering it means parsing markdown, and the transcript
 * re-renders whenever anything about the surrounding message changes. All four
 * props are primitives, so the default shallow comparison is exactly right.
 */
export const BrainMarkdown = memo(function BrainMarkdown({ content, className, entityTags = false, fileLinks = false }: BrainMarkdownProps) {
  const segments = splitShareBlocks(content);
  if (segments.length > 1 || (segments.length === 1 && segments[0].kind === "share")) {
    return (
      <>
        {segments.map((seg, i) =>
          seg.kind === "share" ? (
            <ShareBlock key={i} body={seg.body} format={seg.format} title={seg.title} />
          ) : seg.text.trim() ? (
            <BrainMarkdownInner
              key={i}
              content={seg.text}
              className={className}
              entityTags={entityTags}
              fileLinks={fileLinks}
            />
          ) : null
        )}
      </>
    );
  }
  return (
    <BrainMarkdownInner
      content={content}
      className={className}
      entityTags={entityTags}
      fileLinks={fileLinks}
    />
  );
});

const BrainMarkdownInner = memo(function BrainMarkdownInner({ content, className, entityTags = false, fileLinks = false }: BrainMarkdownProps) {
  const root = useBrainUiRoot();
  const processed = entityTags ? renderEntityTags(content) : content;
  const ensureWikilinks = useFileStore((s) => s.ensureWikilinks);
  // Entity-tag rendering emits its own markup and must not be re-highlighted.
  const rehypePlugins = useRehypePlugins(!entityTags);

  useEffect(() => {
    if (fileLinks) void ensureWikilinks();
  }, [fileLinks, ensureWikilinks]);

  // Memoized so component identities are stable across the per-token
  // re-renders of a streaming message. Inline arrows here would be a new
  // component type every render, forcing React to unmount and remount every
  // block — which would destroy MermaidBlock's rendered-SVG state mid-stream.
  const components = useMemo(() => {
    const opts = { entityTags, fileLinks };
    // Override block/inline elements that can contain text. We need to do this
    // whenever either entityTags or fileLinks is enabled so we can scan text nodes.
    const textComponents = entityTags || fileLinks
      ? {
          p: withTextProcessing("p", opts),
          li: withTextProcessing("li", opts),
          strong: withTextProcessing("strong", opts),
          em: withTextProcessing("em", opts),
          h1: withTextProcessing("h1", opts),
          h2: withTextProcessing("h2", opts),
          h3: withTextProcessing("h3", opts),
          h4: withTextProcessing("h4", opts),
          td: withTextProcessing("td", opts),
          th: withTextProcessing("th", opts),
          // Paths and wikilinks frequently appear inside inline code spans
          // in brain notes (e.g. `talks/_index.md`). Process code elements
          // too. Note: this also linkifies paths inside fenced code blocks,
          // which is harmless in the brain UI context (paths in shell
          // snippets remain clickable). The known downside is that literal
          // `[[slug]]` syntax shown for teaching purposes will attempt to
          // resolve as a wikilink.
          code: withTextProcessing("code", opts),
        }
      : {};
    return {
      ...textComponents,
      pre: MarkdownPre,
      table: MarkdownTable,
      /**
       * An image the agent wrote into the brain is referenced by its repo path
       * (`![](assets/images/x.png)`), which the browser would resolve against
       * the app origin and 404 — the bytes live behind the files API. Rewrite
       * repo-relative sources to that endpoint so a generated image actually
       * appears. `data:` URIs and absolute URLs are left alone.
       */
      img: ({ src, alt, ...props }: React.ComponentPropsWithoutRef<"img">) => {
        const resolved = typeof src === "string" ? repoImageSrc(src, root) : src;
        // Inline, an image is only as wide as the viewport. Tapping it opens the
        // zoom viewer, the same way a mermaid diagram does.
        if (typeof resolved !== "string") {
          return <img {...props} alt={alt ?? ""} loading="lazy" className="my-2 max-w-full rounded" />;
        }
        return (
          <ZoomableImage
            src={resolved}
            alt={alt}
            className="my-2 max-w-full cursor-zoom-in rounded"
            imgProps={{ ...props, loading: "lazy" }}
          />
        );
      },
      /**
       * Repo paths open in the file viewer and never leave the app. Every
       * other link goes through `ProseLink`, which classifies the address the
       * author wrote (`data-raw-href`, from `remarkRawHref`) and shows its
       * host (#551, D49). The markdown title attribute is dropped: it is the
       * author's words in a hover-only tooltip, beside a destination that is
       * now on screen.
       */
      a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a"> & { "data-raw-href"?: string }) => {
        if (fileLinks) {
          const kind = classifyRepoPath(href);
          if (kind === "file") {
            return <FileLink path={href as string}>{children}</FileLink>;
          }
          if (kind === "dir") {
            return <DirLink path={href as string}>{children}</DirLink>;
          }
        }
        return <ProseLink href={props["data-raw-href"] ?? href ?? ""}>{children}</ProseLink>;
      },
    };
  }, [entityTags, fileLinks, root]);

  return (
    <div className={className ?? "brain-prose"}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {processed}
      </Markdown>
    </div>
  );
});
