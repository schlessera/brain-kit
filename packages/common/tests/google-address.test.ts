import { describe, expect, test } from "bun:test";
import {
  matchesAllowList, matchGoogleAllowList, normalizeGoogleDomain, parseGoogleAllowListEntry, parseGoogleMailbox, parseGoogleMailboxList,
} from "@schlessera/brain-common/internal/google-operations";

/** A mailbox's matched address, or its refusal reason. */
const address = (text: string): string => {
  const parsed = parseGoogleMailbox(text);
  return parsed.ok ? parsed.mailbox.address : `refused: ${parsed.reason}`;
};

describe("parseGoogleMailbox", () => {
  const rows: [name: string, input: string, expected: string][] = [
    ["a bare address", "penelope@example.com", "penelope@example.com"],
    ["a display name and angle brackets", "Penelope <penelope@example.com>", "penelope@example.com"],
    ["a quoted display name", "\"Penelope, Queen of Ithaca\" <penelope@example.com>", "penelope@example.com"],
    ["an obs-phrase display name with a dot", "Odysseus L. Laertiades <odysseus@example.com>", "odysseus@example.com"],
    ["display-name spoofing: the quoted name is ignored", "\"penelope@example.com\" <x@example.invalid>", "x@example.invalid"],
    ["display-name spoofing without quotes is refused", "penelope@example.com <x@example.invalid>", "refused: invalid_display_name"],
    ["group syntax", "Ithaca: penelope@example.com, telemachus@example.com;", "refused: group_syntax"],
    ["an empty group", "undisclosed-recipients:;", "refused: group_syntax"],
    ["a trailing comment", "penelope@example.com (Queen of Ithaca)", "refused: comment"],
    ["a comment inside the address", "pene(lope)@example.com", "refused: comment"],
    ["a quoted local part", "\"penelope\"@example.com", "refused: quoted_local_part"],
    ["a quoted local part with a space", "\"pene lope\"@example.com", "refused: quoted_local_part"],
    ["a quoted local part in angle brackets", "Penelope <\"pene lope\"@example.com>", "refused: quoted_local_part"],
    ["a domain literal", "penelope@[192.0.2.1]", "refused: domain_literal"],
    ["an IDN domain becomes punycode", "penelope@b\u00FCcher.example", "penelope@xn--bcher-kva.example"],
    ["a punycode domain stays punycode", "penelope@xn--bcher-kva.example", "penelope@xn--bcher-kva.example"],
    ["an upper-case domain is lowered, the local part kept", "PENELOPE@EXAMPLE.COM", "PENELOPE@example.com"],
    ["a homograph domain is its own punycode", "penelope@ex\u0430mple.com", "penelope@xn--exmple-4nf.com"],
    ["no domain", "penelope", "refused: malformed"],
    ["no local part", "@example.com", "refused: malformed"],
    ["an empty domain", "penelope@", "refused: malformed"],
    ["a single-label domain", "penelope@example", "refused: invalid_domain"],
    ["a double at sign", "penelope@@example.com", "refused: invalid_local_part"],
    ["a space in the local part", "pene lope@example.com", "refused: malformed"],
    ["a space in the domain", "penelope@exa mple.com", "refused: malformed"],
    ["an empty domain label", "penelope@example..com", "refused: invalid_domain"],
    ["a domain label starting with a hyphen", "penelope@-example.com", "refused: invalid_domain"],
    ["an IP address as domain", "penelope@192.0.2.1", "refused: invalid_domain"],
    ["a zero-width space in the domain", "penelope@exa\u200Bmple.com", "refused: invalid_domain"],
    ["a full-width dot in the domain", "penelope@example\uFF0Ecom", "refused: invalid_domain"],
    ["a non-ASCII local part", "p\u00E9n\u00E9lope@example.com", "refused: invalid_local_part"],
    ["a header injection", "penelope@example.com\r\nBcc: suitor@example.invalid", "refused: control_character"],
    ["two mailboxes", "penelope@example.com, telemachus@example.com", "refused: malformed"],
    ["an unclosed angle bracket", "Penelope <penelope@example.com", "refused: malformed"],
    ["text after the angle brackets", "<penelope@example.com> Penelope", "refused: malformed"],
    ["an empty string", "", "refused: empty"],
    ["an over-long input", `${"a".repeat(600)}@example.com`, "refused: too_long"],
  ];
  for (const [name, input, expected] of rows) {
    test(name, () => expect(address(input)).toBe(expected));
  }

  test("the display name is parsed and kept for display, with encoded words decoded", () => {
    const parsed = parseGoogleMailbox("=?utf-8?Q?Odysseus_=E2=9A=93?= <odysseus@example.com>");
    expect(parsed.ok ? parsed.mailbox : parsed).toEqual({ address: "odysseus@example.com", local: "odysseus", domain: "example.com", display_name: "Odysseus \u2693" });
  });
});

describe("parseGoogleMailboxList", () => {
  const addresses = (text: string): string[] | string => {
    const parsed = parseGoogleMailboxList(text);
    return parsed.ok ? parsed.mailboxes.map(mailbox => mailbox.address) : `refused: ${parsed.reason} at ${parsed.index}`;
  };

  test("commas inside quoted display names do not split mailboxes", () => {
    expect(addresses("\"Odysseus, King of Ithaca\" <odysseus@example.com>, telemachus@example.com"))
      .toEqual(["odysseus@example.com", "telemachus@example.com"]);
  });

  test("an encoded word in a display name cannot add a recipient", () => {
    // The display name decodes to `suitor@example.invalid,`, but only after the list's structure is fixed.
    expect(addresses("=?utf-8?Q?suitor=40example.invalid=2C?= <penelope@example.com>")).toEqual(["penelope@example.com"]);
  });

  test("group syntax in a list is refused", () => {
    expect(addresses("eumaeus@example.com, Ithaca: penelope@example.com;")).toBe("refused: group_syntax at 0");
  });

  test("an empty element is refused", () => {
    expect(addresses("penelope@example.com, , telemachus@example.com")).toBe("refused: empty at 1");
  });

  test("one bad mailbox refuses the list and names it", () => {
    expect(addresses("penelope@example.com, \"eumaeus\"@example.com")).toBe("refused: quoted_local_part at 1");
  });

  test("an empty value is an empty list", () => {
    expect(addresses("  ")).toEqual([]);
  });
});

describe("allow-list entries", () => {
  const entry = (text: string) => {
    const parsed = parseGoogleAllowListEntry(text);
    return parsed.ok ? parsed.entry : `refused: ${parsed.reason}`;
  };

  test("self, a domain wildcard and a full address parse", () => {
    expect([entry("self"), entry("*@example.com"), entry("*@b\u00FCcher.example"), entry("penelope@EXAMPLE.com")]).toEqual([
      { kind: "self" },
      { kind: "domain", domain: "example.com" },
      { kind: "domain", domain: "xn--bcher-kva.example" },
      { kind: "address", address: "penelope@example.com" },
    ]);
  });

  test("subdomain wildcards, bare wildcards, display names and comments are refused", () => {
    expect(["*@*.example.com", "*", "*@", "pen*@example.com", "Penelope <penelope@example.com>", "penelope@example.com (queen)", "Self"].map(entry))
      .toEqual(["refused: invalid_domain", "refused: invalid_local_part", "refused: invalid_domain", "refused: invalid_local_part", "refused: malformed", "refused: comment", "refused: malformed"]);
  });

  test("a domain is normalised once, the same way for entries and addresses", () => {
    expect([normalizeGoogleDomain("B\u00DCCHER.example"), normalizeGoogleDomain("0x7f.1")]).toEqual([
      { ok: true, domain: "xn--bcher-kva.example" },
      { ok: false, reason: "invalid_domain" },
    ]);
  });
});

describe("matchesAllowList", () => {
  const SELF = ["odysseus@example.com", "Odysseus <king@ithaca.example>"];

  test("an exact address entry matches that address", () => {
    expect(matchesAllowList(["Penelope <penelope@example.com>"], ["penelope@example.com"], [])).toBe(true);
  });

  test("display-name spoofing does not match the address in the display name", () => {
    expect(matchesAllowList(["\"penelope@example.com\" <x@example.invalid>"], ["penelope@example.com"], [])).toBe(false);
    expect(matchesAllowList(["\"penelope@example.com\" <x@example.invalid>"], ["*@example.invalid"], [])).toBe(true);
  });

  test("a domain wildcard matches exactly that domain", () => {
    expect(matchesAllowList(["telemachus@example.com", "eumaeus@example.com"], ["*@example.com"], [])).toBe(true);
  });

  test("a domain wildcard matches no subdomain and no lookalike", () => {
    expect(["eumaeus@farm.example.com", "eumaeus@example.com.invalid", "eumaeus@notexample.com", "eumaeus@ex\u0430mple.com"]
      .map(input => matchesAllowList([input], ["*@example.com"], []))).toEqual([false, false, false, false]);
  });

  test("IDN and punycode forms match each other", () => {
    expect([
      matchesAllowList(["penelope@b\u00FCcher.example"], ["*@xn--bcher-kva.example"], []),
      matchesAllowList(["penelope@xn--bcher-kva.example"], ["penelope@b\u00FCcher.example"], []),
      matchesAllowList(["penelope@B\u00DCCHER.example"], ["*@b\u00FCcher.example"], []),
    ]).toEqual([true, true, true]);
  });

  test("the local part is compared exactly", () => {
    expect(matchesAllowList(["Penelope@example.com"], ["penelope@example.com"], [])).toBe(false);
  });

  test("self matches only the host-supplied addresses", () => {
    expect([
      matchesAllowList(["odysseus@example.com"], ["self"], SELF),
      matchesAllowList(["Laertiades <king@ithaca.example>"], ["self"], SELF),
      matchesAllowList(["telemachus@example.com"], ["self"], SELF),
      matchesAllowList(["odysseus@example.com"], ["self"], []),
    ]).toEqual([true, true, false, false]);
  });

  test("an empty allow-list matches nothing", () => {
    expect(matchesAllowList(["penelope@example.com"], [], SELF)).toBe(false);
  });

  test("an empty address list matches nothing", () => {
    expect(matchesAllowList([], ["*@example.com", "self"], SELF)).toBe(false);
  });

  test("an unparseable address matches nothing, even beside a matching one", () => {
    expect(matchesAllowList(["penelope@example.com", "Ithaca: telemachus@example.com;"], ["*@example.com"], [])).toBe(false);
  });

  test("a malformed entry matches nothing", () => {
    expect(matchesAllowList(["eumaeus@farm.example.com"], ["*@*.example.com"], [])).toBe(false);
  });

  test("each verdict names the entry it matched as written", () => {
    expect(matchGoogleAllowList(["odysseus@example.com", "eumaeus@example.com", "suitor@example.invalid"], ["self", "*@example.com"], SELF)
      .map(match => [match.mailbox?.address ?? null, match.entry])).toEqual([
      ["odysseus@example.com", "self"],
      ["eumaeus@example.com", "*@example.com"],
      ["suitor@example.invalid", null],
    ]);
  });
});
