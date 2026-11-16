import { useState, type CSSProperties, type ReactNode } from "react";
import { color, font } from "../tokens.js";
import { Field, initials, type GitHubPerson } from "./shared.js";

/**
 * `GitHubIdentity` — a person named on GitHub (#3800, design #3795 revision 2 §4′).
 *
 * The `@login` and its tags are the identity; the avatar is decoration
 * (`alt=""`). The only image input is `avatarSrc`, and only a URL on the
 * page's own origin (the brain's avatar proxy, #3796) may load. Anything else
 * keeps the initials and makes no request.
 *
 * The initials badge shows at once and the image replaces it when it loads,
 * with no fade and no shimmer. Loading, failed and absent avatars look the
 * same on purpose: avatar state is not information.
 *
 * - A bot: a rounded square and the word `bot`.
 * - A deleted account (`login: null`): a dashed empty circle and `@ghost`.
 */
export interface GitHubIdentityProps extends GitHubPerson {
  /** 22px wherever a person is named; 20px in the participant stack. */
  size?: 22 | 20;
  /** Trailing words after the tags: "opened 3 d ago", a review state, a time. */
  meta?: ReactNode;
}

/** The avatar's address when it is on this page's origin, else `null`. */
export function brainOriginAvatar(src: string | null | undefined): string | null {
  if (typeof src !== "string" || src === "" || typeof document === "undefined") return null;
  try {
    const base = new URL(document.baseURI);
    const url = new URL(src, base);
    if (url.origin !== base.origin || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function GitHubAvatar({ person, size = 22 }: { person: GitHubPerson; size?: number }) {
  const src = person.login === null ? null : brainOriginAvatar(person.avatarSrc);
  const [loaded, setLoaded] = useState<string | null>(null);
  const radius = person.bot ? 6 : 999;
  const box: CSSProperties = {
    position: "relative",
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    boxSizing: "border-box",
    borderRadius: radius,
    overflow: "hidden",
    border: person.login === null ? `1px dashed ${color.inkMute}` : `1px solid ${color.edge}`,
    background: person.login === null ? "transparent" : color.raised,
    font: `600 ${size >= 22 ? 8.5 : 8}px/1 ${font.mono}`,
    color: color.inkDim,
  };
  return (
    <span style={box} aria-hidden="true" data-avatar-state={person.login === null ? "ghost" : loaded === src && src ? "loaded" : src ? "pending" : "initials"}>
      {person.login === null ? null : initials(person.login)}
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          decoding="async"
          onLoad={() => setLoaded(src)}
          onError={() => setLoaded(null)}
          // Hidden until it has loaded: the initials stay until then, and stay after a failure.
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", visibility: loaded === src ? "visible" : "hidden" }}
        />
      ) : null}
    </span>
  );
}

const TAG: CSSProperties = {
  flex: "none",
  padding: "0 4px",
  borderRadius: 4,
  border: `1px solid ${color.edge}`,
  font: `500 9px/14px ${font.mono}`,
  color: color.inkMute,
};

export function GitHubIdentity(p: GitHubIdentityProps) {
  const ghost = p.login === null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", minWidth: 0 }} data-github-identity="">
      <GitHubAvatar person={p} size={p.size ?? 22} />
      <span style={{ font: `600 11.5px/1.4 ${font.mono}`, color: color.ink, minWidth: 0 }}>
        @<Field>{ghost ? "ghost" : p.login}</Field>
      </span>
      {ghost ? <span style={{ font: `400 11px/1.4 ${font.body}`, color: color.inkMute }}>account deleted</span> : null}
      {!ghost && p.association ? <span style={TAG}>{p.association}</span> : null}
      {!ghost && p.bot ? <span style={TAG}>bot</span> : null}
      {p.meta !== undefined && p.meta !== null ? <span style={{ font: `400 11px/1.4 ${font.body}`, color: color.inkMute }}>{p.meta}</span> : null}
    </span>
  );
}

/**
 * `GitHubParticipants` — up to four overlapping 20px faces, then `+n`, then
 * the count in words. The stack is decoration; "4 people" carries the count.
 */
export interface GitHubParticipantsProps {
  people: GitHubPerson[];
  /** Everyone taking part, which may exceed the people the payload names. */
  count: number;
}

export function GitHubParticipants(p: GitHubParticipantsProps) {
  const faces = p.people.slice(0, 4);
  const rest = p.count - faces.length;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} data-github-participants="">
      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center" }}>
        {faces.map((person, i) => (
          <span key={i} style={{ marginInlineStart: i === 0 ? 0 : -5, display: "inline-flex", borderRadius: 999, boxShadow: `0 0 0 2px ${color.surface}` }}>
            <GitHubAvatar person={person} size={20} />
          </span>
        ))}
        {rest > 0 ? (
          <span style={{ marginInlineStart: -5, minWidth: 20, height: 20, padding: "0 4px", boxSizing: "border-box", borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", background: color.raised, boxShadow: `0 0 0 2px ${color.surface}`, font: `600 8.5px/1 ${font.mono}`, color: color.inkDim }}>
            +{rest}
          </span>
        ) : null}
      </span>
      <span style={{ font: `400 11px/1.4 ${font.body}`, color: color.inkMute }}>
        {p.count} {p.count === 1 ? "person" : "people"}
      </span>
    </span>
  );
}
