/**
 * `classifyLink` — what a model-chosen address may do, decided once (#43).
 *
 * A link the model authors carries a destination, a title and a description,
 * and the model may have read untrusted content before choosing any of them.
 * The card that draws it states the destination as a fact Brain derived and
 * the words as the model's. This module derives the fact: it parses the
 * address once, and every string the card shows or navigates to comes out of
 * that one parse, so the host on screen and the anchor's `href` cannot
 * disagree.
 *
 * It lives in the kit, behind the React-free `@schlessera/brain-ui-kit/links`
 * export, because the kit is the one place every consumer of the card goes
 * through: `LinkPreviewCard` calls it on its own `url` prop, and ui-sdk's
 * `show_block` handler calls the same function to reject a refused link
 * before echoing it (the ruling on #43 records why there is one copy).
 *
 * Pure: no I/O, no DNS, no fetch, no `window`. `URL` is the WHATWG parser,
 * which is also what the browser will use to navigate, so a host derived here
 * is the host the browser resolves.
 *
 * Order of checks, first failure wins: the raw string (length, invisible and
 * control characters), then the parse, the scheme, credentials, and last the
 * scripts of each hostname label. The raw checks run BEFORE parsing because
 * the parser silently drops tabs and newlines, and what a reader inspects
 * should be what the model sent.
 */

/** Why a link is withheld. The card turns each into one sentence. */
export type LinkRefusalReason =
  | "too-long"
  | "hidden-characters"
  | "relative"
  | "unparseable"
  | "scheme"
  | "credentials"
  | "mixed-script";

export type LinkVerdict =
  | {
      ok: true;
      /** The anchor's `href`, and also the string the Full address disclosure shows. */
      href: string;
      /** ASCII (`xn--`) form, with a non-default port. What the browser resolves. */
      host: string;
      /** The decoded form, only when `host` has `xn--` labels. */
      hostUnicode?: string;
      /** Pathname, search and hash; `""` for a bare `/`. */
      path: string;
      /** An IPv4 or bracketed IPv6 literal, not a name. */
      ip: boolean;
      /** `http:` rather than `https:`. */
      insecure: boolean;
    }
  | {
      ok: false;
      reason: LinkRefusalReason;
      /** The refused scheme (`javascript:`), when `reason` is `scheme`. */
      scheme?: string;
      /** What was sent, redacted for display: never a link, at most 120 characters. */
      shown: string;
    };

/** A refused verdict, the same shape for a web link and a mail link. */
export type LinkRefusal = Extract<LinkVerdict, { ok: false }>;

/** The longest address accepted, matching the `link` block's schema. */
export const LINK_URL_MAX = 2048;

/** How much of a refused address the withheld card reveals. */
const SHOWN_MAX = 120;

/**
 * C0 and C1 controls, DEL, and every default-ignorable code point. The last
 * class covers the zero-width characters (U+200B-U+200D, U+FEFF), the soft
 * hyphen, and the bidi controls (U+061C, U+200E-U+200F, U+202A-U+202E,
 * U+2066-U+2069), which is what can make an address read differently from
 * what it is.
 */
const HIDDEN = /[\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
const HIDDEN_ALL = /[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/** A scheme per RFC 3986, followed by its colon. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Every hidden code point spelled out, so the reader sees that it was there. */
function spell(raw: string): string {
  return raw.replace(HIDDEN_ALL, (ch) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/** Userinfo (`user:pass@`) replaced by `•••@`, whether or not it parses. */
function redactUserinfo(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1•••@");
}

function shown(raw: string): string {
  const text = spell(redactUserinfo(raw));
  const chars = Array.from(text);
  return chars.length > SHOWN_MAX ? `${chars.slice(0, SHOWN_MAX - 1).join("")}…` : text;
}

function refuse(raw: string, reason: LinkRefusalReason, scheme?: string): LinkRefusal {
  return scheme ? { ok: false, reason, scheme, shown: shown(raw) } : { ok: false, reason, shown: shown(raw) };
}

// ---------------------------------------------------------------------------
// Punycode (RFC 3492), decode only
// ---------------------------------------------------------------------------

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 → 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z → 0-25
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z → 0-25
  return BASE;
}

/** Decodes one label's punycode (without its `xn--` prefix), or `null` when it is invalid. */
export function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const cut = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(cut, 0); j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let index = cut > 0 ? cut + 1 : 0; index < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const d = digit(input.charCodeAt(index++));
      if (d >= BASE) return null;
      i += d * w;
      if (!Number.isSafeInteger(i)) return null;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    if (n > 0x10ffff) return null;
    i %= length;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

// ---------------------------------------------------------------------------
// Scripts (UTS #39, Highly Restrictive)
// ---------------------------------------------------------------------------

/**
 * The Unicode scripts, as the four-letter codes ECMAScript's `\p{scx=…}`
 * accepts. A code the running engine does not know is skipped rather than
 * thrown on; a letter that matches no known script then counts as a script of
 * its own, so mixing it with any other script still refuses.
 */
const SCRIPT_CODES = (
  "Adlm Aghb Ahom Arab Armi Armn Avst Bali Bamu Bass Batk Beng Bhks Bopo Brah Brai Bugi Buhd " +
  "Cakm Cans Cari Cham Cher Chrs Copt Cpmn Cprt Cyrl Deva Diak Dogr Dsrt Dupl Egyp Elba Elym " +
  "Ethi Geor Glag Gong Gonm Goth Gran Grek Gujr Guru Hang Hani Hano Hatr Hebr Hira Hluw Hmng " +
  "Hmnp Hung Ital Java Kali Kana Kawi Khar Khmr Khoj Kits Knda Kthi Lana Laoo Latn Lepc Limb " +
  "Lina Linb Lisu Lyci Lydi Mahj Maka Mand Mani Marc Medf Mend Merc Mero Mlym Modi Mong Mroo " +
  "Mtei Mult Mymr Nagm Nand Narb Nbat Newa Nkoo Nshu Ogam Olck Orkh Orya Osge Osma Ougr Palm " +
  "Pauc Perm Phag Phli Phlp Phnx Plrd Prti Rjng Rohg Runr Samr Sarb Saur Sgnw Shaw Shrd Sidd " +
  "Sind Sinh Sogd Sogo Sora Soyo Sund Sylo Syrc Tagb Takr Tale Talu Taml Tang Tavt Telu Tfng " +
  "Tglg Thaa Thai Tibt Tirh Tnsa Toto Ugar Vaii Vith Wara Wcho Xpeo Xsux Yezi Yiii Zanb"
).split(" ");

let scriptTests: [string, RegExp][] | undefined;

function scripts(): [string, RegExp][] {
  if (scriptTests) return scriptTests;
  scriptTests = [];
  for (const code of SCRIPT_CODES) {
    try {
      scriptTests.push([code, new RegExp(`^\\p{scx=${code}}$`, "u")]);
    } catch {
      // Not in this engine's Unicode version; see SCRIPT_CODES.
    }
  }
  return scriptTests;
}

/** Common and Inherited: digits, `-`, combining marks. They join any script. */
const COMMON = /^[\p{scx=Zyyy}\p{scx=Zinh}]$/u;

/**
 * The combinations UTS #39 "Highly Restrictive" allows beside a single
 * script: Japanese, Chinese with Bopomofo, and Korean, each with Latin.
 */
const ALLOWED_MIXES: ReadonlySet<string>[] = [
  new Set(["Latn", "Hani", "Hira", "Kana"]),
  new Set(["Latn", "Hani", "Bopo"]),
  new Set(["Latn", "Hani", "Hang"]),
];

/** Each non-common character's Script_Extensions set. */
function scriptSets(label: string): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const ch of label) {
    if (COMMON.test(ch)) continue;
    const set = new Set<string>();
    for (const [code, re] of scripts()) if (re.test(ch)) set.add(code);
    // A character in no script this engine knows is its own script.
    sets.push(set.size ? set : new Set([`?${ch}`]));
  }
  return sets;
}

/** True when the label passes UTS #39's Highly Restrictive level. */
export function highlyRestrictive(label: string): boolean {
  const sets = scriptSets(label);
  if (sets.length === 0) return true;
  // One script covers every character: the resolved script set is non-empty.
  let resolved = new Set(sets[0]);
  for (const set of sets.slice(1)) resolved = new Set([...resolved].filter((code) => set.has(code)));
  if (resolved.size > 0) return true;
  return ALLOWED_MIXES.some((mix) => sets.every((set) => [...set].some((code) => mix.has(code))));
}

// ---------------------------------------------------------------------------
// classifyLink
// ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Classify one model-supplied address. See the module comment for the order. */
export function classifyLink(raw: string): LinkVerdict {
  if (raw.length > LINK_URL_MAX) return refuse(raw, "too-long");
  if (HIDDEN.test(raw)) return refuse(raw, "hidden-characters");
  // Leading or trailing spaces are dropped by the parser like tabs are.
  if (raw !== raw.trim()) return refuse(raw, "hidden-characters");

  // No colon before the first `/`, `?` or `#`: there is no scheme, so it is
  // relative (`/tides`, `tides.html`, `//host.example/x`). A colon that
  // follows something a scheme cannot be (`ht!tp:/x`) is not relative; it is
  // unreadable.
  const firstDelimiter = raw.search(/[/?#]/);
  const colon = raw.indexOf(":");
  if (colon === -1 || (firstDelimiter !== -1 && firstDelimiter < colon)) return refuse(raw, "relative");
  const scheme = SCHEME.exec(raw);
  if (!scheme) return refuse(raw, "unparseable");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(raw, "unparseable");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse(raw, "scheme", url.protocol);
  }
  if (url.username !== "" || url.password !== "" || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)) {
    return refuse(raw, "credentials");
  }
  if (url.hostname === "") return refuse(raw, "unparseable");

  const ip = IPV4.test(url.hostname) || url.hostname.startsWith("[");
  let hostUnicode: string | undefined;
  if (!ip && /(^|\.)xn--/i.test(url.hostname)) {
    const labels: string[] = [];
    for (const label of url.hostname.split(".")) {
      if (!/^xn--/i.test(label)) {
        labels.push(label);
        continue;
      }
      const decoded = decodePunycode(label.slice(4));
      if (decoded === null) return refuse(raw, "unparseable");
      if (HIDDEN.test(decoded)) return refuse(raw, "hidden-characters");
      if (!highlyRestrictive(decoded)) return refuse(raw, "mixed-script");
      labels.push(decoded);
    }
    hostUnicode = labels.join(".") + (url.port ? `:${url.port}` : "");
  }

  const rest = url.pathname + url.search + url.hash;
  return {
    ok: true,
    href: url.href,
    host: url.host,
    ...(hostUnicode === undefined ? {} : { hostUnicode }),
    path: rest === "/" ? "" : rest,
    ip,
    insecure: url.protocol === "http:",
  };
}

/** The reader-facing sentence for each refusal (spec §5 on #43). */
export function refusalSentence(verdict: { reason: LinkRefusalReason; scheme?: string }): string {
  switch (verdict.reason) {
    case "unparseable":
      return "the address could not be read";
    case "relative":
      return "the address has no site (it is relative)";
    case "scheme":
      return `only web addresses open from here · this one is ${verdict.scheme ?? "another kind"}`;
    case "credentials":
      return "the address carries a sign-in name or password";
    case "mixed-script":
      return "the site name mixes alphabets in one part";
    case "hidden-characters":
      return "the address contains invisible or direction-changing characters";
    case "too-long":
      return `the address is longer than ${LINK_URL_MAX.toLocaleString("en")} characters`;
  }
}

// ---------------------------------------------------------------------------
// classifyMailto
// ---------------------------------------------------------------------------

export type MailVerdict =
  | {
      ok: true;
      /** `mailto:` and the addresses, and nothing else: every query parameter is dropped. */
      href: string;
      /** The addresses as shown beside the link text, comma-joined, domains in ASCII. */
      display: string;
      addresses: string[];
    }
  | LinkRefusal;

/** The most addresses one `mailto:` may carry before it reads as a mailing. */
export const MAILTO_ADDRESSES_MAX = 10;

/** RFC 5322 `dot-atom` characters for the local part. ASCII only. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

/** Characters that would let a domain smuggle a path, a port, credentials or a second host. */
const DOMAIN_FORBIDDEN = /[\s/?#@:[\]\\%,;<>()"]/;

/**
 * Classify a `mailto:` address in prose (#551, D49 §5).
 *
 * This is the one scheme `classifyLink` refuses that prose keeps live, and it
 * is a check beside `classifyLink`, not a loosening of it: the `link` block
 * still refuses `mailto:`. The raw-string checks are `classifyLink`'s, run
 * first for the same reason. Each address's domain goes through
 * `classifyLink` itself, as the host of an `https:` address, so a mail domain
 * meets exactly the web host's rules (mixed script refused, shown in ASCII).
 *
 * Every query parameter is dropped from the href rather than shown or
 * refused: `cc`, `bcc` and `to` add recipients the shown address would not
 * name, and a `body` is a message the model writes for the reader to send.
 */
export function classifyMailto(raw: string): MailVerdict {
  if (raw.length > LINK_URL_MAX) return refuse(raw, "too-long");
  if (HIDDEN.test(raw) || raw !== raw.trim()) return refuse(raw, "hidden-characters");
  const scheme = SCHEME.exec(raw);
  if (!scheme) return refuse(raw, colonless(raw) ? "relative" : "unparseable");
  if (scheme[1]!.toLowerCase() !== "mailto") return refuse(raw, "scheme", `${scheme[1]!.toLowerCase()}:`);

  const rest = raw.slice(scheme[0].length);
  const query = rest.indexOf("?");
  let decoded: string;
  try {
    decoded = decodeURIComponent(query === -1 ? rest : rest.slice(0, query));
  } catch {
    return refuse(raw, "unparseable");
  }
  // Percent-encoding is how a bidi control would get past the raw check.
  if (HIDDEN.test(decoded)) return refuse(raw, "hidden-characters");

  const parts = decoded.split(",");
  if (parts.length > MAILTO_ADDRESSES_MAX) return refuse(raw, "too-long");
  const addresses: string[] = [];
  for (const part of parts) {
    const at = part.lastIndexOf("@");
    const local = part.slice(0, at);
    const domain = part.slice(at + 1);
    if (at <= 0 || !LOCAL_PART.test(local) || domain === "" || DOMAIN_FORBIDDEN.test(domain)) {
      return refuse(raw, "unparseable");
    }
    const host = classifyLink(`https://${domain}/`);
    if (!host.ok) return refuse(raw, host.reason === "credentials" ? "unparseable" : host.reason);
    addresses.push(`${local}@${host.host}`);
  }
  const encoded = addresses.map((address) => address.replace(/[%?#&]/g, (ch) => encodeURIComponent(ch)));
  return { ok: true, href: `mailto:${encoded.join(",")}`, display: addresses.join(","), addresses };
}

/** No colon before the first `/`, `?` or `#`, as `classifyLink` reads "relative". */
function colonless(raw: string): boolean {
  const firstDelimiter = raw.search(/[/?#]/);
  const colon = raw.indexOf(":");
  return colon === -1 || (firstDelimiter !== -1 && firstDelimiter < colon);
}
