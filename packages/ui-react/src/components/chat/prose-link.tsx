import React, { createContext } from "react";
import {
  classifyLink,
  classifyMailto,
  refusalSentence,
} from "@schlessera/brain-ui-kit/links";

/**
 * A markdown link in prose, drawn so it shows where it goes (#551, D49).
 *
 * Every non-repo anchor that `BrainMarkdown` draws comes through here, on
 * every surface that renders through it. The address is classified once, by
 * `classifyLink` (or `classifyMailto`, the one scheme prose keeps live), and
 * the `href` and the host shown beside the text are both read from that one
 * verdict. The words are the model's, or the note's, and are drawn as a
 * link. The destination is Brain's, drawn as a label that is always the last
 * visible thing inside the anchor, so nothing the author writes lands after
 * it. A refused address is inert text with a withheld marker: no `<a>`, no
 * `role`, nothing that navigates.
 *
 * `href` is the address as the author wrote it (`remarkRawHref`), not the
 * one react-markdown hands the override: that one has been percent-encoded
 * and passed through `urlTransform`, which would hide a bidi control from the
 * raw-string checks and blank a `javascript:` address before it could be
 * named.
 */
export function ProseLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const text = plainText(children);

  if (/^mailto:/i.test(href)) {
    const verdict = classifyMailto(href);
    if (!verdict.ok) return <Withheld text={text === href ? verdict.shown : children} reason={refusalSentence(verdict)} />;
    return (
      <a href={verdict.href} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="bk-plink">
        <Words>{children}</Words>
        {text === verdict.display ? null : <Suffix>{labelled(verdict.display)}</Suffix>}
        <span className="bk-sr"> , email</span>
      </a>
    );
  }

  const verdict = classifyLink(href);
  if (!verdict.ok) return <Withheld text={text === href ? verdict.shown : children} reason={refusalSentence(verdict)} />;
  return (
    <a
      href={verdict.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="bk-plink"
    >
      <Words>{children}</Words>
      {sameDestination(text, verdict) ? null : <Suffix>{labelled(verdict.host)}</Suffix>}
      <span className="bk-sr"> , new tab</span>
    </a>
  );
}

/**
 * True inside a prose link, accepted or withheld. The text passes that turn
 * repo paths and wikilinks into links read it and stand down: a withheld
 * link's text is final (D49 §4), and an anchor inside an anchor is not HTML.
 */
export const InsideProseLink = createContext(false);

function Words({ children }: { children?: React.ReactNode }) {
  return (
    <span className="bk-plink-text">
      <InsideProseLink.Provider value={true}>{children}</InsideProseLink.Provider>
    </span>
  );
}

function Suffix({ children }: { children: React.ReactNode }) {
  return <span className="bk-plink-host"> {children}</span>;
}

function Withheld({ text, reason }: { text: React.ReactNode; reason: string }) {
  return (
    <span className="bk-plink-refused">
      <span className="bk-plink-refused-text">
        <InsideProseLink.Provider value={true}>{text}</InsideProseLink.Provider>
      </span>
      <span className="bk-plink-withheld"> [link withheld — {reason}]</span>
    </span>
  );
}

/**
 * The redundancy rule (design §2 on #551): the suffix is dropped only when
 * the visible text already is the destination, spelled the way the verdict
 * spells it. Byte comparisons against the verdict's own `href` and `host`,
 * never the raw address, whose Unicode host is exactly what the ASCII
 * suffix exists to replace.
 */
export function sameDestination(
  text: string | undefined,
  verdict: { href: string; host: string; path: string }
): boolean {
  if (text === undefined) return false;
  return text === verdict.href || (verdict.path === "" && `${text}/` === verdict.href) || text === verdict.host;
}

/** The children as one string, only when they are exactly one string. */
function plainText(children: React.ReactNode): string | undefined {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") return children[0];
  return undefined;
}

/**
 * The parenthesised host, one unbreakable unit per label with a break
 * opportunity after each ".", the only place the card breaks a host. A label
 * is an inline block, so the line never breaks at a `-` inside it; only a
 * label wider than the line wraps within itself (`.bk-plink-label`). "(" is
 * part of the first label and ")" of the last, so neither is left alone at
 * a line's edge. For a mail address the "." rule applies to the whole
 * address, the local part included.
 */
function labelled(host: string): React.ReactNode {
  const labels = host.split(".");
  return labels.map((label, i) => {
    const first = i === 0;
    const last = i === labels.length - 1;
    return (
      <React.Fragment key={i}>
        <span className="bk-plink-label">
          {first ? "(" : ""}
          {label}
          {last ? ")" : "."}
        </span>
        {last ? null : <wbr />}
      </React.Fragment>
    );
  });
}

interface MdNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * Keep each link's address exactly as written, as `data-raw-href`.
 *
 * mdast-util-to-hast percent-encodes a link's URL, and react-markdown's
 * `urlTransform` then blanks any scheme it dislikes, so by the time the `a`
 * override runs a U+202E is `%E2%80%AE` and `javascript:` is `""`. The
 * policy is about what the author sent, so the author's string rides along
 * beside the `href` the override no longer uses for anything but repo paths.
 * Reference links take their definition's address.
 */
export function remarkRawHref() {
  return (tree: MdNode) => {
    const definitions = new Map<string, string>();
    walk(tree, (node) => {
      if (node.type === "definition" && node.identifier !== undefined && node.url !== undefined) {
        const key = node.identifier.toUpperCase();
        // The first definition wins, as it does in to-hast.
        if (!definitions.has(key)) definitions.set(key, node.url);
      }
    });
    walk(tree, (node) => {
      const url =
        node.type === "link"
          ? node.url
          : node.type === "linkReference" && node.identifier !== undefined
            ? definitions.get(node.identifier.toUpperCase())
            : undefined;
      if (url === undefined) return;
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, dataRawHref: url };
    });
  };
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
