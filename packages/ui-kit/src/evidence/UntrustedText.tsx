import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { getDomain } from "tldts";
import { Overlay } from "../chrome/Overlay.js";
import { classifyLink } from "../links.js";
import { accent, color, font, token } from "../tokens.js";
import {
  parseUntrusted,
  inlineText,
  type Block,
  type Inline,
} from "./untrusted-markdown.js";

/**
 * `UntrustedText` — text written somewhere Brain does not control, shown as
 * a safe markdown subset (#3800, design #3795 §3 and revision 2 §3′).
 *
 * It is not `BrainMarkdown`. It is a small renderer over
 * `parseUntrusted` that keeps what carries meaning (paragraphs, emphasis,
 * code, lists, task boxes, quotes, headings as bold paragraphs) and turns
 * everything else into text:
 *
 * - **No HTML.** A tag is literal code text. Nothing is parsed or injected:
 *   every string reaches the DOM as a React text child.
 * - **No images.** An image is a dashed placeholder naming its host. No
 *   `<img>`, no CSS background, no request.
 * - **Links ask first.** An `https:` link is a `<button>`, never an `<a>`. It
 *   opens a full-URL interstitial, and only the interstitial's Open action
 *   navigates, in a new tab with `noopener noreferrer`. An `http:` link, any
 *   other scheme and anything the classifier refuses (`classifyLink`) is
 *   plain text with a muted reason. Bare URLs are not autolinked.
 * - **Bidi is isolated.** The field is `unicode-bidi: isolate`, and every run
 *   of untrusted words is its own `<bdi>`, so a stray RLO cannot reorder the
 *   chrome beside it (a link's domain label, a reason).
 * - **Bounded.** `maxChars` is a hard cut before parsing; `lines` clamps what
 *   shows first, behind an in-place expand control.
 *
 * Shared, not GitHub-specific: `source` names where the text was written.
 */
export interface UntrustedTextProps {
  /** The untrusted text, as written. */
  text: string;
  /** Where it was written, for the caption and the interstitial: "GitHub". */
  source: string;
  /** How the interstitial places the link: "on GitHub" (the default, `on {source}`), "in this draft". */
  sourcePhrase?: string;
  /** Who wrote it, with its sigil: "@antinous". `null` or absent for an unknown author. */
  author?: string | null;
  /**
   * How the text is set off from Brain's own words:
   * - `box`: a provenance-bordered card with the caption inside (a PR or issue body);
   * - `rule`: a provenance rule on the left (a comment or review body);
   * - `none`: no frame and no caption.
   * Defaults to `box`.
   */
  frame?: "box" | "rule" | "none";
  /** Replaces the default caption, "Written on {source} by {author} · not checked". `false` hides it. */
  caption?: string | false;
  /** Lines shown before the expand control. Absent: the whole text shows. */
  lines?: number;
  /** Lines shown below 480px wide, when that differs from `lines`. */
  linesNarrow?: number;
  /** The expand control's words. Defaults to "Show more". */
  expandLabel?: string;
  /** Hard bound, in characters. Text past it is never rendered. */
  maxChars?: number;
  /** The text was already cut by its producer (GitHub's own bound, a payload limit). */
  truncated?: boolean;
  /** Shown under the text when it was cut. Defaults to "Truncated". */
  truncatedNote?: ReactNode;
}

/** How a link reads before it is activated. */
type LinkReading =
  | { kind: "asks"; href: string; host: string; domain: string }
  | { kind: "insecure" }
  | { kind: "scheme" }
  | { kind: "removed" };

/** The registrable domain of an ASCII host, from the public-suffix list (`tldts`). */
export function registrableDomain(host: string): string {
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.replace(/:\d+$/, "");
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

function readLink(url: string): LinkReading {
  const verdict = classifyLink(url);
  if (!verdict.ok)
    return { kind: verdict.reason === "scheme" ? "scheme" : "removed" };
  if (verdict.insecure) return { kind: "insecure" };
  return {
    kind: "asks",
    href: verdict.href,
    host: verdict.host,
    domain: registrableDomain(verdict.host),
  };
}

/** The host an image would have been fetched from, when its address parses. */
function imageHost(url: string): string | null {
  const verdict = classifyLink(url);
  return verdict.ok ? verdict.host : null;
}

const MONO_META: CSSProperties = {
  font: `400 0.86em/1 ${font.mono}`,
  color: color.inkMute,
};

type Open = (
  link: Extract<LinkReading, { kind: "asks" }>,
  button: HTMLButtonElement
) => void;

function Inlines({ nodes, open }: { nodes: Inline[]; open: Open }) {
  return (
    <>
      {nodes.map((node, i) => (
        <InlineNode key={i} node={node} open={open} />
      ))}
    </>
  );
}

function InlineNode({ node, open }: { node: Inline; open: Open }) {
  switch (node.type) {
    case "text":
      return <bdi>{node.text}</bdi>;
    case "strong":
      return (
        <strong style={{ fontWeight: 650 }}>
          <Inlines nodes={node.children} open={open} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.children} open={open} />
        </em>
      );
    case "code":
    case "html":
      return (
        <code className="bk-ut-code">
          <bdi>{node.text}</bdi>
        </code>
      );
    case "url":
      // Not autolinked: the address is text.
      return (
        <span
          style={{ font: `400 0.9em/1 ${font.mono}`, overflowWrap: "anywhere" }}
        >
          <bdi>{node.text}</bdi>
        </span>
      );
    case "image": {
      const host = imageHost(node.url);
      return (
        <span className="bk-ut-image" data-untrusted-image="">
          <span aria-hidden="true">▨ </span>
          image
          {node.alt ? (
            <>
              {" "}
              “<bdi>{node.alt}</bdi>”
            </>
          ) : null}{" "}
          not loaded{host ? <> · {host}</> : null}
        </span>
      );
    }
    case "link":
      return <LinkNode node={node} open={open} />;
  }
}

function LinkNode({
  node,
  open,
}: {
  node: Extract<Inline, { type: "link" }>;
  open: Open;
}) {
  const reading = readLink(node.url);
  const words = (
    <bdi>
      <Inlines nodes={node.children} open={open} />
    </bdi>
  );
  if (reading.kind !== "asks") {
    const reason =
      reading.kind === "insecure"
        ? "http link · won't open"
        : reading.kind === "scheme"
        ? "not a web link"
        : "link removed";
    return (
      <>
        {words}{" "}
        <span style={MONO_META} data-untrusted-link-reason={reading.kind}>
          ({reason})
        </span>
      </>
    );
  }
  const name = inlineText(node.children).trim() || reading.domain;
  return (
    <button
      type="button"
      className="bk-ut-link"
      aria-haspopup="dialog"
      aria-label={`${name}, outside link to ${reading.domain}, asks first`}
      data-untrusted-link=""
      onClick={(event) => open(reading, event.currentTarget)}
    >
      <span className="bk-ut-link-words">{words}</span>{" "}
      <span
        style={{ font: `500 0.86em/1 ${font.mono}`, color: accent.purple.ink }}
      >
        {reading.domain}
        <span aria-hidden="true"> ↗</span>
      </span>
    </button>
  );
}

function Blocks({ blocks, open }: { blocks: Block[]; open: Open }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "paragraph":
            return (
              <p key={i} className="bk-ut-p">
                <Inlines nodes={block.children} open={open} />
              </p>
            );
          case "heading":
            return (
              <p key={i} className="bk-ut-p" style={{ fontWeight: 650 }}>
                <Inlines nodes={block.children} open={open} />
              </p>
            );
          case "code":
          case "html":
            return (
              // A scroll container takes focus so its overflow is reachable by keyboard.
              <pre
                key={i}
                className="bk-ut-pre"
                tabIndex={0}
                data-untrusted-html={block.type === "html" ? "" : undefined}
              >
                <bdi>{block.text}</bdi>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={i} className="bk-ut-quote">
                <Blocks blocks={block.children} open={open} />
              </blockquote>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            const tasks = block.items.every((item) => item.task !== null);
            return (
              <List
                key={i}
                className="bk-ut-list"
                data-tasks={tasks ? "" : undefined}
              >
                {block.items.map((item, j) => (
                  <li key={j} style={{ marginInlineStart: item.depth * 16 }}>
                    {item.task !== null ? (
                      <>
                        <span aria-hidden="true">{item.task ? "☑" : "☐"} </span>
                        <span className="bk-sr-only">
                          {item.task ? "Done: " : "Not done: "}
                        </span>
                      </>
                    ) : null}
                    <Inlines nodes={item.children} open={open} />
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </>
  );
}

/** The full-URL interstitial: nothing navigates until its Open action. */
function LinkGate(p: {
  link: Extract<LinkReading, { kind: "asks" }> | null;
  source: string;
  author?: string | null;
  returnTo: () => HTMLElement | null;
  sourcePhrase: string;
  onClose: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const message = useId();
  const link = p.link;
  return (
    <Overlay
      open={link !== null}
      variant="dialog"
      size="md"
      title={`Open a link from ${p.source}?`}
      describedBy={message}
      initialFocus={stay}
      returnFocus={p.returnTo}
      onClose={p.onClose}
      data-untrusted-gate=""
    >
      {link ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            font: `400 12.5px/1.5 ${font.body}`,
            color: color.ink,
          }}
        >
          <p id={message} style={{ margin: 0, color: color.inkDim }}>
            {p.author ? (
              <>
                <bdi>{p.author}</bdi> wrote this link {p.sourcePhrase}.
              </>
            ) : (
              <>This link was written {p.sourcePhrase}.</>
            )}{" "}
            Brain hasn't checked where it goes.
          </p>
          <div>
            <div className="bk-ut-gate-label">Site</div>
            <div
              data-untrusted-gate-domain=""
              style={{
                font: `600 20px/1.3 ${font.mono}`,
                color: color.ink,
                overflowWrap: "anywhere",
              }}
            >
              <bdi dir="ltr">{link.domain}</bdi>
            </div>
          </div>
          <div>
            <div className="bk-ut-gate-label">Full address</div>
            <FullAddress
              href={link.href}
              host={link.host}
              domain={link.domain}
            />
          </div>
          <p style={{ margin: 0, color: color.inkMute, fontSize: 11.5 }}>
            Opens in a new tab. Brain doesn't send anything with it.
          </p>
          <div className="bk-ut-gate-actions">
            <button
              ref={stay}
              type="button"
              className="bk-control bk-ut-gate-btn"
              onClick={p.onClose}
            >
              Stay here
            </button>
            <a
              className="bk-control bk-ut-gate-btn"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              referrerPolicy="no-referrer"
              data-untrusted-open=""
              onClick={p.onClose}
            >
              Open {link.domain}
              <span aria-hidden="true"> ↗</span>
            </a>
          </div>
        </div>
      ) : null}
    </Overlay>
  );
}

/** The parsed address, never truncated: subdomains dim, the registrable domain bold and underlined. */
function FullAddress({
  href,
  host,
  domain,
}: {
  href: string;
  host: string;
  domain: string;
}) {
  const start = href.indexOf("//") + 2;
  const hostname = host.replace(/:\d+$/, "");
  const parsed =
    href.slice(start, start + hostname.length) === hostname &&
    hostname.endsWith(domain);
  const box: CSSProperties = {
    margin: 0,
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${color.line}`,
    background: color.raised,
    font: `400 12px/1.6 ${font.mono}`,
    color: color.ink,
    overflowWrap: "anywhere",
    wordBreak: "break-all",
  };
  if (!parsed) {
    return (
      <p style={box} data-untrusted-gate-address="">
        <bdi dir="ltr">{href}</bdi>
      </p>
    );
  }
  const sub = hostname.slice(0, hostname.length - domain.length);
  return (
    <p style={box} data-untrusted-gate-address="">
      <bdi dir="ltr">
        <span style={{ color: color.inkMute }}>
          {href.slice(0, start)}
          {sub}
        </span>
        <strong
          data-untrusted-gate-emphasis=""
          style={{
            fontWeight: 700,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          {domain}
        </strong>
        <span style={{ color: color.inkDim }}>
          {href.slice(start + hostname.length)}
        </span>
      </bdi>
    </p>
  );
}

export function UntrustedText(p: UntrustedTextProps) {
  const frame = p.frame ?? "box";
  const max = p.maxChars ?? Number.POSITIVE_INFINITY;
  const chars = Array.from(p.text);
  const cut = chars.length > max;
  const shown = cut ? chars.slice(0, max).join("") : p.text;
  const blocks = parseUntrusted(shown);

  const [active, setActive] = useState<Extract<
    LinkReading,
    { kind: "asks" }
  > | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const open: Open = (link, button) => {
    opener.current = button;
    setActive(link);
  };

  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const clamped = p.lines !== undefined && !expanded;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !clamped) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [clamped, shown]);

  const caption =
    p.caption === false || frame === "none"
      ? null
      : p.caption ??
        `Written on ${p.source} by ${
          p.author ?? "an unknown author"
        } · not checked`;
  const outer: CSSProperties =
    frame === "box"
      ? {
          border: `1px solid ${token("provenance-border")}`,
          borderRadius: 10,
          padding: "10px 12px",
          background: color.surface,
        }
      : frame === "rule"
      ? {
          borderInlineStart: `2px solid ${token("provenance-border")}`,
          paddingInlineStart: 10,
        }
      : {};

  return (
    <div
      style={{
        ...outer,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      data-untrusted-text=""
    >
      {caption ? (
        <div
          style={{
            font: `500 9.5px/1.4 ${font.mono}`,
            color: accent.purple.ink,
          }}
        >
          <bdi>{caption}</bdi>
        </div>
      ) : null}
      <div
        ref={body}
        dir="auto"
        className={clamped ? "bk-ut bk-ut-clamp" : "bk-ut"}
        style={{
          ...(clamped
            ? ({
                "--ut-lines": p.lines,
                "--ut-lines-narrow": p.linesNarrow ?? p.lines,
              } as CSSProperties)
            : null),
          font: `400 12.5px/1.7 ${font.body}`,
          color: color.ink,
        }}
      >
        <Blocks blocks={blocks} open={open} />
      </div>
      {clamped && overflows ? (
        <button
          type="button"
          className="bk-text-btn"
          data-tone="inherit"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          style={{
            alignSelf: "flex-start",
            font: `500 12px/20px ${font.body}`,
            color: color.inkDim,
            textDecoration: "none",
          }}
        >
          {p.expandLabel ?? "Show more"}
        </button>
      ) : null}
      {cut || p.truncated ? (
        <div
          style={{ font: `400 10.5px/1.5 ${font.mono}`, color: color.inkMute }}
        >
          {p.truncatedNote ?? "Truncated"}
        </div>
      ) : null}
      <LinkGate
        link={active}
        source={p.source}
        author={p.author}
        returnTo={() => opener.current}
        sourcePhrase={p.sourcePhrase ?? `on ${p.source}`}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
