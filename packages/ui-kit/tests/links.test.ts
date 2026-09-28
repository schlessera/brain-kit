/**
 * `classifyLink`, the policy a model-chosen address passes before the card
 * draws it or the `show_block` handler echoes it (#43). The numbered tests are
 * the spec's acceptance tests 1-10 on the issue; test 11 (the "mentions
 * another site" note) was dropped by the ruling.
 */
import { describe, expect, test } from "bun:test";

import {
  classifyLink,
  classifyMailto,
  decodePunycode,
  highlyRestrictive,
  refusalSentence,
  type LinkVerdict,
  type MailVerdict,
} from "../src/links.js";

function refused(url: string): Extract<LinkVerdict, { ok: false }> {
  const verdict = classifyLink(url);
  if (verdict.ok) throw new Error(`expected ${JSON.stringify(url)} to be refused, got ${JSON.stringify(verdict)}`);
  return verdict;
}

function accepted(url: string): Extract<LinkVerdict, { ok: true }> {
  const verdict = classifyLink(url);
  if (!verdict.ok) throw new Error(`expected ${JSON.stringify(url)} to be accepted, got ${JSON.stringify(verdict)}`);
  return verdict;
}

describe("classifyLink", () => {
  test("1. an absolute https address: host from the parse, href is the full address", () => {
    const v = accepted("https://ithaca-harbour.example/tides");
    expect(v.host).toBe("ithaca-harbour.example");
    expect(v.href).toBe("https://ithaca-harbour.example/tides");
    expect(v.path).toBe("/tides");
    expect(v.ip).toBe(false);
    expect(v.insecure).toBe(false);
    expect(v.hostUnicode).toBeUndefined();
  });

  test("2. relative addresses are relative; a broken scheme is unparseable", () => {
    expect(refused("/tides").reason).toBe("relative");
    expect(refused("tides.html").reason).toBe("relative");
    expect(refused("//ithaca-harbour.example/tides").reason).toBe("relative");
    expect(refused("ht!tp:/x").reason).toBe("unparseable");
    expect(refused("https://").reason).toBe("unparseable");
  });

  test("3. every scheme but http(s) is refused, and the sentence names it", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<b>hi</b>",
      "file:///etc/passwd",
      "ftp://x.example",
      "mailto:a@b.example",
    ]) {
      expect(refused(url).reason).toBe("scheme");
    }
    expect(refusalSentence(refused("javascript:alert(1)"))).toBe(
      "only web addresses open from here · this one is javascript:"
    );
  });

  test("4. credentials are refused, and what is shown redacts them", () => {
    for (const url of ["https://odysseus:nobody@x.example/", "https://odysseus@x.example/", "https://@x.example/"]) {
      const v = refused(url);
      expect(v.reason).toBe("credentials");
      expect(v.shown).toContain("•••@x.example");
      expect(v.shown).not.toContain("odysseus");
      expect(v.shown).not.toContain("nobody");
    }
  });

  test("5. invisible and control characters are refused before the parser can strip them", () => {
    for (const ch of ["\t", "\n", "\u202E", "\u200B", "\uFEFF", "\u2066", "\u00AD"]) {
      const v = refused(`https://ithaca-harbour.example/ti${ch}des`);
      expect(v.reason).toBe("hidden-characters");
      // Spelled out, so the reader sees the character that was there.
      expect(v.shown).toContain(`⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
    }
    expect(refused(" https://ithaca-harbour.example/").reason).toBe("hidden-characters");
  });

  test("6. a label mixing Latin and Cyrillic is refused", () => {
    // U+0430 CYRILLIC SMALL LETTER A, then Latin "pple".
    expect(refused("https://аpple.example/").reason).toBe("mixed-script");
    // Latin + Greek omicron.
    expect(refused("https://gοogle.example/").reason).toBe("mixed-script");
  });

  test("7. an internationalised name: the ASCII form is the host, the decoded form rides beside it", () => {
    const v = accepted("https://bücher.example/odyssey");
    expect(v.host).toBe("xn--bcher-kva.example");
    expect(v.hostUnicode).toBe("bücher.example");
    expect(v.href).toBe("https://xn--bcher-kva.example/odyssey");
  });

  test("7b. an all-Cyrillic lookalike is accepted, and its headline is the xn-- form", () => {
    // Every letter Cyrillic: no mixed script, so not refused. The ASCII
    // headline is the defence: it does not read as the brand it imitates.
    const v = accepted("https://аррӏе.example/");
    expect(v.host.startsWith("xn--")).toBe(true);
    expect(v.hostUnicode).toBe("аррӏе.example");
  });

  test("8. Japanese mixing Han, Hiragana and Katakana is one allowed mix", () => {
    const v = accepted("https://日本語ひらがなカタカナ.example/");
    expect(v.hostUnicode).toBe("日本語ひらがなカタカナ.example");
    expect(highlyRestrictive("sony-ソニー")).toBe(true);
  });

  test("9. IP literals are accepted and marked; http is marked insecure", () => {
    const v4 = accepted("http://10.0.0.1:8080/");
    expect(v4).toMatchObject({ host: "10.0.0.1:8080", ip: true, insecure: true, path: "" });
    expect(accepted("https://[::1]/").ip).toBe(true);
    expect(accepted("https://ithaca-harbour.example:8443/").host).toBe("ithaca-harbour.example:8443");
  });

  test("10. 2,048 characters are accepted, 2,049 refused", () => {
    const base = "https://ithaca-harbour.example/";
    expect(accepted(base + "a".repeat(2048 - base.length)).ok).toBe(true);
    expect(refused(base + "a".repeat(2049 - base.length)).reason).toBe("too-long");
  });

  test("what a refused card shows is cut at 120 characters", () => {
    const v = refused(`javascript:${"x".repeat(500)}`);
    expect(Array.from(v.shown)).toHaveLength(120);
    expect(v.shown.endsWith("…")).toBe(true);
  });
});

describe("decodePunycode", () => {
  test("decodes RFC 3492's own samples and refuses garbage", () => {
    expect(decodePunycode("bcher-kva")).toBe("bücher");
    // RFC 3492 7.1 (B), Chinese (simplified).
    expect(decodePunycode("ihqwcrb4cv8a8dqg056pqjye")).toBe("他们为什么不说中文");
    expect(decodePunycode("!!")).toBeNull();
  });
});

/**
 * `classifyMailto`, the one scheme prose keeps live (#551, D49 §5). Criteria
 * 2 and 3 of the design comment on #551.
 */
describe("classifyMailto", () => {
  function mail(raw: string): Extract<MailVerdict, { ok: true }> {
    const verdict = classifyMailto(raw);
    if (!verdict.ok) throw new Error(`expected ${JSON.stringify(raw)} to be accepted, got ${JSON.stringify(verdict)}`);
    return verdict;
  }
  function refusedMail(raw: string): Extract<MailVerdict, { ok: false }> {
    const verdict = classifyMailto(raw);
    if (verdict.ok) throw new Error(`expected ${JSON.stringify(raw)} to be refused, got ${JSON.stringify(verdict)}`);
    return verdict;
  }

  test("one address: the href is mailto: and the address, and the address is what is shown", () => {
    expect(mail("mailto:penelope@ithaca.example")).toEqual({
      ok: true,
      href: "mailto:penelope@ithaca.example",
      display: "penelope@ithaca.example",
      addresses: ["penelope@ithaca.example"],
    });
    expect(mail("MAILTO:penelope@ithaca.example").href).toBe("mailto:penelope@ithaca.example");
  });

  test("every query parameter is dropped from the href, recipients included", () => {
    const v = mail("mailto:penelope@ithaca.example?subject=Supplies&bcc=x@y.example&cc=z@y.example&body=Send%20it");
    expect(v.href).toBe("mailto:penelope@ithaca.example");
    expect(v.display).toBe("penelope@ithaca.example");
  });

  test("several addresses are all shown, up to ten", () => {
    const v = mail("mailto:penelope@ithaca.example,telemachus@ithaca.example");
    expect(v.display).toBe("penelope@ithaca.example,telemachus@ithaca.example");
    expect(v.href).toBe("mailto:penelope@ithaca.example,telemachus@ithaca.example");
    const ten = Array.from({ length: 10 }, (_, i) => `crew${i}@ithaca.example`).join(",");
    expect(mail(`mailto:${ten}`).addresses).toHaveLength(10);
    expect(refusedMail(`mailto:${ten},crew10@ithaca.example`).reason).toBe("too-long");
  });

  test("a percent-encoded address is decoded before it is checked and shown", () => {
    expect(mail("mailto:penelope%40ithaca.example").display).toBe("penelope@ithaca.example");
    // A `?` in the local part is legal and must not end the address in the href.
    expect(mail("mailto:who%3F@ithaca.example").href).toBe("mailto:who%3F@ithaca.example");
  });

  test("the domain meets the web host's rules: ASCII shown, mixed script refused", () => {
    expect(mail("mailto:odysseus@bücher.example").display).toBe("odysseus@xn--bcher-kva.example");
    expect(refusedMail("mailto:odysseus@аpple.example").reason).toBe("mixed-script");
  });

  test("hidden and bidi characters are refused, raw or percent-encoded", () => {
    expect(refusedMail("mailto:penelope@ithaca.example\u202E").reason).toBe("hidden-characters");
    expect(refusedMail("mailto:pene\u200Blope@ithaca.example").reason).toBe("hidden-characters");
    expect(refusedMail("mailto:penelope%E2%80%AE@ithaca.example").reason).toBe("hidden-characters");
    expect(refusedMail(" mailto:penelope@ithaca.example").reason).toBe("hidden-characters");
  });

  test("no address, or a malformed one, is unparseable", () => {
    for (const raw of [
      "mailto:",
      "mailto:?subject=hi",
      "mailto:penelope",
      "mailto:@ithaca.example",
      "mailto:penelope@",
      "mailto:penelope@ithaca.example/inbox",
      "mailto:penelope@ithaca.example:25",
      "mailto:a b@ithaca.example",
      "mailto:penelope@ithaca.example,",
      "mailto:%E0%A4%A",
    ]) {
      expect(refusedMail(raw).reason).toBe("unparseable");
    }
  });

  test("the raw checks run first, as classifyLink's do", () => {
    expect(refusedMail(`mailto:${"a".repeat(2050)}@ithaca.example`).reason).toBe("too-long");
  });

  test("it classifies mailto: only; the link block still refuses mailto:", () => {
    expect(refusedMail("https://ithaca.example/")).toMatchObject({ reason: "scheme", scheme: "https:" });
    expect(classifyLink("mailto:penelope@ithaca.example")).toMatchObject({ ok: false, reason: "scheme" });
  });
});
