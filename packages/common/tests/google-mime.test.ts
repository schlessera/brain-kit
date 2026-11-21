import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseGmailRawDraft, type GmailRawDraft, type GmailRawDraftProblem } from "@schlessera/brain-common/internal/google-operations";

/** A message from lines joined with CRLF, as Gmail stores it. */
const message = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join("\r\n"));
/** Bytes from a string whose code units are bytes (for non-UTF-8 fixtures). */
const latin = (text: string): Uint8Array => Uint8Array.from(text, char => char.charCodeAt(0));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const flags = (draft: GmailRawDraft) => ({ html_part: draft.html_part, attachment: draft.attachment, unreadable_headers: draft.unreadable_headers, unreadable_body: draft.unreadable_body, problems: draft.problems });
const CLEAN = { html_part: false, attachment: false, unreadable_headers: false, unreadable_body: false, problems: [] };
const addresses = (list: readonly { address: string }[]) => list.map(mailbox => mailbox.address);

const HEADERS = [
  "From: Penelope <penelope@example.com>",
  "To: Telemachus <telemachus@example.com>, eumaeus@example.com",
  "Cc: \"Eurycleia, Nurse\" <eurycleia@example.com>",
  "Bcc: odysseus@example.com",
  "Reply-To: penelope@example.com",
  "Subject: The loom",
  "In-Reply-To: <loom.1@example.com>",
  "References: <shroud.0@example.com> <loom.1@example.com>",
  "Date: Sun, 12 Jul 2026 09:30:00 +0000",
  "Message-ID: <reply.2@example.com>",
  "MIME-Version: 1.0",
];

describe("parseGmailRawDraft: plain text", () => {
  test("reads every shown header and the text body of a plain-text draft", async () => {
    const draft = await parseGmailRawDraft(message(...HEADERS, "Content-Type: text/plain; charset=\"UTF-8\"", "", "Weave by day,", "unweave by night.", ""));
    expect({
      from: draft.from?.address, to: addresses(draft.to), cc: addresses(draft.cc), bcc: addresses(draft.bcc), reply_to: addresses(draft.reply_to),
      subject: draft.subject, in_reply_to: draft.in_reply_to, references: draft.references, body_text: draft.body_text,
      display: [draft.from?.display_name, draft.cc[0]?.display_name],
    }).toEqual({
      from: "penelope@example.com",
      to: ["telemachus@example.com", "eumaeus@example.com"],
      cc: ["eurycleia@example.com"],
      bcc: ["odysseus@example.com"],
      reply_to: ["penelope@example.com"],
      subject: "The loom",
      in_reply_to: ["<loom.1@example.com>"],
      references: ["<shroud.0@example.com>", "<loom.1@example.com>"],
      body_text: "Weave by day,\nunweave by night.\n",
      display: ["Penelope", "Eurycleia, Nurse"],
    });
    expect(flags(draft)).toEqual(CLEAN);
  });

  test("a message with no Content-Type is US-ASCII text", async () => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Subject: Home", "", "Soon."));
    expect([draft.body_text, flags(draft)]).toEqual(["Soon.", CLEAN]);
  });

  test("a quoted-printable UTF-8 body is decoded, soft breaks removed", async () => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
      "The shroud is w=C3=B6ven and unw=", "=C3=B6ven.=3D"));
    expect([draft.body_text, flags(draft)]).toEqual(["The shroud is w\u00F6ven and unw\u00F6ven.=", CLEAN]);
  });

  test("a base64 UTF-8 body is decoded", async () => {
    const body = btoa(String.fromCharCode(...new TextEncoder().encode("\u00C0 Ithaque, enfin.")));
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body.slice(0, 8), body.slice(8)));
    expect([draft.body_text, flags(draft)]).toEqual(["\u00C0 Ithaque, enfin.", CLEAN]);
  });

  test("an 8-bit ISO-8859-1 body is decoded byte for byte", async () => {
    const draft = await parseGmailRawDraft(latin("To: penelope@example.com\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nPr\xeatre de Zeus"));
    expect([draft.body_text, flags(draft)]).toEqual(["Pr\u00EAtre de Zeus", CLEAN]);
  });
});

describe("parseGmailRawDraft: multipart", () => {
  test("multipart/alternative: the text part is the body and the HTML part is flagged", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Subject: The loom", "MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=\"000000000000a1b2c3\"", "",
      "--000000000000a1b2c3", "Content-Type: text/plain; charset=\"UTF-8\"", "", "Weave by day.", "",
      "--000000000000a1b2c3", "Content-Type: text/html; charset=\"UTF-8\"", "", "<div>Weave by day.</div>", "",
      "--000000000000a1b2c3--", ""));
    expect([draft.body_text, flags(draft)]).toEqual(["Weave by day.\n", { ...CLEAN, html_part: true }]);
  });

  test("an attachment is flagged and its bytes never become the body", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/mixed; boundary=b1", "",
      "--b1", "Content-Type: text/plain; charset=us-ascii", "", "The map is attached.",
      "--b1", "Content-Type: application/pdf; name=\"ithaca.pdf\"", "Content-Disposition: attachment; filename=\"ithaca.pdf\"", "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK",
      "--b1--"));
    expect([draft.body_text, flags(draft)]).toEqual(["The map is attached.", { ...CLEAN, attachment: true }]);
  });

  test("a text part marked as an attachment is an attachment, not the body", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/mixed; boundary=b1", "",
      "--b1", "Content-Type: text/plain", "Content-Disposition: attachment; filename*=utf-8''suitors.txt", "", "Antinous, Eurymachus",
      "--b1--"));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, attachment: true }]);
  });

  test("a second text part is flagged as an attachment", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/mixed; boundary=b1", "",
      "--b1", "", "First.", "--b1", "", "Second.", "--b1--"));
    expect([draft.body_text, flags(draft)]).toEqual(["First.", { ...CLEAN, attachment: true }]);
  });

  test("an HTML-only draft has no text body and is flagged", async () => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: text/html; charset=utf-8", "", "<p>Hi</p>"));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, html_part: true }]);
  });

  test("nested multipart/related inside multipart/mixed is walked", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/mixed; boundary=outer", "",
      "--outer", "Content-Type: multipart/alternative; boundary=inner", "",
      "--inner", "Content-Type: text/plain", "", "Plain.", "--inner", "Content-Type: text/html", "", "<p>Plain.</p>", "--inner--",
      "--outer", "Content-Type: image/png", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--outer--"));
    expect([draft.body_text, flags(draft)]).toEqual(["Plain.", { ...CLEAN, html_part: true, attachment: true }]);
  });

  test("a multipart body without its closing delimiter is unreadable", async () => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: multipart/mixed; boundary=b1", "", "--b1", "", "Text."));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["multipart_structure"] }]);
  });

  test("a multipart type without a boundary is unreadable", async () => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: multipart/mixed", "", "Text."));
    expect(flags(draft)).toEqual({ ...CLEAN, unreadable_body: true, problems: ["multipart_structure"] });
  });
});

describe("parseGmailRawDraft: encoded words and folding", () => {
  test("a Q-encoded UTF-8 subject is decoded", async () => {
    const draft = await parseGmailRawDraft(message("Subject: =?UTF-8?Q?Home_to_Ithaca_=E2=9A=93?=", "", ""));
    expect([draft.subject, flags(draft)]).toEqual(["Home to Ithaca \u2693", CLEAN]);
  });

  test("a B-encoded subject is decoded and whitespace between adjacent encoded words is dropped", async () => {
    const draft = await parseGmailRawDraft(message("Subject: =?utf-8?B?VGhlIGxvb20=?= =?iso-8859-1?Q?_r=EAve?= done", "", ""));
    expect([draft.subject, flags(draft)]).toEqual(["The loom r\u00EAve done", CLEAN]);
  });

  test("a folded subject is unfolded", async () => {
    const draft = await parseGmailRawDraft(message("Subject: Weave by day,", "\tunweave by night,", " and wait.", "", ""));
    expect([draft.subject, flags(draft)]).toEqual(["Weave by day,\tunweave by night, and wait.", CLEAN]);
  });

  test("a folded encoded subject is unfolded and decoded", async () => {
    const draft = await parseGmailRawDraft(message("Subject: =?utf-8?Q?The_shroud_is_w=C3=B6ven?=", " =?utf-8?Q?_tonight?=", "", ""));
    expect(draft.subject).toBe("The shroud is w\u00F6ven tonight");
  });

  test("a folded address list is unfolded before it is parsed", async () => {
    const draft = await parseGmailRawDraft(message("To: Telemachus <telemachus@example.com>,", "  eumaeus@example.com,", "\tpenelope@example.com", "", ""));
    expect([addresses(draft.to), flags(draft)]).toEqual([["telemachus@example.com", "eumaeus@example.com", "penelope@example.com"], CLEAN]);
  });

  test("an encoded display name is decoded but cannot add a recipient", async () => {
    const draft = await parseGmailRawDraft(message("To: =?utf-8?Q?suitor=40example.invalid=2C?= <penelope@example.com>", "", ""));
    expect([addresses(draft.to), draft.to[0]?.display_name, flags(draft)]).toEqual([["penelope@example.com"], "suitor@example.invalid,", CLEAN]);
  });

  test("an encoded word in an unknown charset is unreadable, not guessed", async () => {
    const draft = await parseGmailRawDraft(message("Subject: =?koi8-r?B?8NLJ18XU?=", "", ""));
    expect([draft.subject, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_headers: true, problems: ["encoded_word"] }]);
  });

  test("an encoded word that decodes to a line break is unreadable", async () => {
    const draft = await parseGmailRawDraft(message("Subject: =?utf-8?Q?Hi=0D=0ABcc:_suitor@example.invalid?=", "", ""));
    expect([draft.subject, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_headers: true, problems: ["encoded_word"] }]);
  });

  test("a raw UTF-8 header (RFC 6532) is read", async () => {
    const draft = await parseGmailRawDraft(message("Subject: \u00C0 Ithaque", "", ""));
    expect([draft.subject, flags(draft)]).toEqual(["\u00C0 Ithaque", CLEAN]);
  });
});

describe("parseGmailRawDraft: unreadable headers", () => {
  const unreadable = async (...lines: string[]) => flags(await parseGmailRawDraft(message(...lines)));

  test("a header line without a colon is a malformed header", async () => {
    expect(await unreadable("To: penelope@example.com", "Subject without a colon", "", "Body.")).toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["header_syntax"] });
  });

  test("a continuation line before any header is malformed", async () => {
    expect(await unreadable(" To: penelope@example.com", "", "Body.")).toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["header_syntax"] });
  });

  test("a bare carriage return in the headers is unreadable", async () => {
    expect(await unreadable("To: penelope@example.com\rBcc: suitor@example.invalid", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["bare_cr"] });
  });

  test("a NUL in a header is unreadable", async () => {
    expect(await unreadable("Subject: Loom\u0000", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["header_control_character"] });
  });

  test("a repeated To header is unreadable", async () => {
    expect(await unreadable("To: penelope@example.com", "To: suitor@example.invalid", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, problems: ["duplicate_header"] });
  });

  test("a recipient header the card does not show is unreadable", async () => {
    expect(await unreadable("To: penelope@example.com", "Resent-To: suitor@example.invalid", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, problems: ["unshown_address_header"] });
  });

  test("group syntax in To is unreadable", async () => {
    expect(await unreadable("To: Ithaca: penelope@example.com;", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, problems: ["address_syntax"] });
  });

  test("a From naming two mailboxes is unreadable", async () => {
    expect(await unreadable("From: penelope@example.com, odysseus@example.com", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, problems: ["from_not_single"] });
  });

  test("a malformed message id is unreadable", async () => {
    expect(await unreadable("In-Reply-To: loom.1@example.com", "", "")).toEqual({ ...CLEAN, unreadable_headers: true, problems: ["message_id_syntax"] });
  });

  test("header bytes that are not UTF-8 are unreadable", async () => {
    expect(flags(await parseGmailRawDraft(latin("Subject: Pr\xeatre\r\n\r\n")))).toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["header_encoding"] });
  });
});

describe("parseGmailRawDraft: unreadable bodies", () => {
  const body = async (...lines: string[]) => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", ...lines));
    return [draft.body_text, flags(draft)];
  };

  test("an unknown charset is unreadable", async () => {
    expect(await body("Content-Type: text/plain; charset=koi8-r", "", "text")).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["charset"] }]);
  });

  test("an 8-bit byte in a US-ASCII body is unreadable", async () => {
    const draft = await parseGmailRawDraft(latin("To: penelope@example.com\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nPr\xeatre"));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["charset"] }]);
  });

  test("invalid UTF-8 in a UTF-8 body is unreadable", async () => {
    const draft = await parseGmailRawDraft(latin("To: penelope@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n\xff\xfe"));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["charset"] }]);
  });

  test("an unknown transfer encoding is unreadable", async () => {
    expect(await body("Content-Transfer-Encoding: x-uuencode", "", "begin 644 loom")).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["transfer_encoding"] }]);
  });

  test("invalid base64 is unreadable", async () => {
    expect(await body("Content-Transfer-Encoding: base64", "", "not base64!")).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["transfer_encoding"] }]);
  });

  test("a broken quoted-printable escape is unreadable", async () => {
    expect(await body("Content-Transfer-Encoding: quoted-printable", "", "loom =ZZ")).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["transfer_encoding"] }]);
  });

  test("a Content-Type with a comment is unreadable", async () => {
    expect(await body("Content-Type: text/plain (the loom); charset=us-ascii", "", "x")).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["content_type"] }]);
  });
});

describe("parseGmailRawDraft: digest", () => {
  test("the digest is sha256 over the exact input bytes", async () => {
    const bytes = message(...HEADERS, "", "Weave by day.");
    expect((await parseGmailRawDraft(bytes)).digest).toBe(sha256(bytes));
  });

  test("line endings that read the same still change the digest", async () => {
    const crlf = message("To: penelope@example.com", "Subject: Home", "", "Soon.");
    const lf = new TextEncoder().encode("To: penelope@example.com\nSubject: Home\n\nSoon.");
    const [a, b] = await Promise.all([parseGmailRawDraft(crlf), parseGmailRawDraft(lf)]);
    expect([a.subject, a.body_text, b.subject, b.body_text]).toEqual(["Home", "Soon.", "Home", "Soon."]);
    expect([a.digest, b.digest]).toEqual([sha256(crlf), sha256(lf)]);
    expect(a.digest).not.toBe(b.digest);
  });

  test("a view into a larger buffer is hashed over the view only", async () => {
    const whole = message("PREFIX", "To: penelope@example.com", "", "Soon.");
    const view = whole.subarray("PREFIX\r\n".length);
    expect((await parseGmailRawDraft(view)).digest).toBe(sha256(Uint8Array.from(view)));
  });

  test("an unreadable draft still carries the digest of its bytes", async () => {
    const bytes = message("Subject without a colon", "", "");
    const draft = await parseGmailRawDraft(bytes);
    expect([draft.unreadable_headers, draft.digest, draft.bytes]).toEqual([true, sha256(bytes), bytes.length]);
  });
});

describe("parseGmailRawDraft: multipart subtypes the card can represent", () => {
  test("a multipart/digest is unreadable, not read as a text body", async () => {
    // A digest child without Content-Type is message/rfc822 (RFC 2046 5.1.5): here a whole HTML message.
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/digest; boundary=d1", "",
      "--d1", "", "From: antinous@example.invalid", "Subject: Suitors", "Content-Type: text/html", "", "<p>Marry me</p>",
      "--d1--"));
    expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["multipart_subtype"] }]);
  });

  for (const subtype of ["parallel", "signed", "report", "x-loom"]) {
    test(`multipart/${subtype} is unreadable`, async () => {
      const draft = await parseGmailRawDraft(message("To: penelope@example.com", `Content-Type: multipart/${subtype}; boundary=b1`, "", "--b1", "", "Text.", "--b1--"));
      expect([draft.body_text, flags(draft)]).toEqual([null, { ...CLEAN, unreadable_body: true, problems: ["multipart_subtype"] }]);
    });
  }

  test("multipart/related is walked like mixed", async () => {
    const draft = await parseGmailRawDraft(message(
      "To: penelope@example.com", "Content-Type: multipart/related; boundary=r1", "",
      "--r1", "Content-Type: text/plain", "", "The map.", "--r1", "Content-Type: image/png", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--r1--"));
    expect([draft.body_text, flags(draft)]).toEqual(["The map.", { ...CLEAN, attachment: true }]);
  });

  test("a message/* part is an attachment", async () => {
    for (const type of ["message/rfc822", "message/global"]) {
      const draft = await parseGmailRawDraft(message(
        "To: penelope@example.com", "Content-Type: multipart/mixed; boundary=b1", "",
        "--b1", "", "Forwarded below.", "--b1", `Content-Type: ${type}`, "", "From: antinous@example.invalid", "", "Marry me.", "--b1--"));
      expect([type, draft.body_text, flags(draft)]).toEqual([type, "Forwarded below.", { ...CLEAN, attachment: true }]);
    }
  });
});

describe("parseGmailRawDraft: parameters the parser relies on", () => {
  const body = async (contentType: string, text: string) => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", contentType, "", text));
    return [draft.body_text, flags(draft)];
  };
  const EXTENDED = { ...CLEAN, unreadable_body: true, problems: ["extended_parameter"] as GmailRawDraftProblem[] };

  test("an RFC 2231 extended charset is unreadable", async () => {
    expect(await body("Content-Type: text/plain; charset*=utf-8''utf-7", "+AKM-")).toEqual([null, EXTENDED]);
  });

  test("a continued charset is unreadable", async () => {
    expect(await body("Content-Type: text/plain; charset*0=\"utf-\"; charset*1=\"7\"", "+AKM-")).toEqual([null, EXTENDED]);
  });

  test("an extended charset beside a literal one is unreadable", async () => {
    expect(await body("Content-Type: text/plain; charset=us-ascii; charset*=utf-8''utf-7", "+AKM-")).toEqual([null, EXTENDED]);
  });

  test("an extended boundary beside a literal one is unreadable", async () => {
    expect(await body("Content-Type: multipart/mixed; boundary=b1; boundary*0=b2", "--b1\r\n\r\nText.\r\n--b1--")).toEqual([null, EXTENDED]);
  });

  test("an extended name still marks an attachment", async () => {
    expect(await body("Content-Type: text/plain; name*0=\"suitors\"; name*1=\".txt\"", "Antinous")).toEqual([null, { ...CLEAN, attachment: true }]);
  });
});

describe("parseGmailRawDraft: dispositions", () => {
  const body = async (disposition: string) => {
    const draft = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: text/plain", `Content-Disposition: ${disposition}`, "", "The loom."));
    return [draft.body_text, flags(draft)];
  };

  for (const token of ["x-attachment", "form-data", "signal"]) {
    test(`a ${token} disposition makes a text part an attachment`, async () => {
      expect(await body(token)).toEqual([null, { ...CLEAN, attachment: true }]);
    });
  }

  test("an inline disposition, in any case, is the body", async () => {
    expect([await body("inline"), await body("INLINE")]).toEqual([["The loom.", CLEAN], ["The loom.", CLEAN]]);
  });
});

describe("parseGmailRawDraft: controls after decoding", () => {
  const CONTROL = { ...CLEAN, unreadable_body: true, problems: ["body_control_character"] as GmailRawDraftProblem[] };
  const draft = (encoding: string, body: string) =>
    parseGmailRawDraft(latin(`To: penelope@example.com\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}`));
  const rows: [name: string, encoding: string, body: string][] = [
    ["a raw NUL", "8bit", "loom\x00shroud"],
    ["a quoted-printable NUL", "quoted-printable", "loom=00shroud"],
    ["a base64 NUL", "base64", btoa("loom\x00shroud")],
    ["a raw bare carriage return", "8bit", "loom\rshroud"],
    ["a quoted-printable bare carriage return", "quoted-printable", "loom=0Dshroud"],
    ["a base64 bare carriage return", "base64", btoa("loom\rshroud")],
    ["an escape", "8bit", "loom\x1b[2Jshroud"],
    ["a form feed", "8bit", "loom\x0cshroud"],
    ["DEL", "8bit", "loom\x7fshroud"],
    ["a C1 control", "8bit", "loom\xc2\x85shroud"],
    ["a right-to-left override", "8bit", "loom\xe2\x80\xaeshroud"],
    ["a left-to-right embedding", "quoted-printable", "loom=E2=80=AAshroud"],
    ["a right-to-left isolate", "base64", btoa("loom\xe2\x81\xa7shroud")],
    ["a pop directional isolate", "8bit", "loom\xe2\x81\xa9shroud"],
  ];
  for (const [name, encoding, body] of rows) {
    test(`${name} in the decoded body is unreadable`, async () => {
      const parsed = await draft(encoding, body);
      expect([parsed.body_text, flags(parsed)]).toEqual([null, CONTROL]);
    });
  }

  test("tabs, CRLF line breaks and ZWJ emoji stay displayable", async () => {
    const text = "Weave\tby day,\r\nunweave by night \u{1F468}\u200D\u{1F469}\u200D\u{1F466}.";
    const parsed = await parseGmailRawDraft(message("To: penelope@example.com", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
      btoa(String.fromCharCode(...new TextEncoder().encode(text)))));
    expect([parsed.body_text, flags(parsed)]).toEqual(["Weave\tby day,\nunweave by night \u{1F468}\u200D\u{1F469}\u200D\u{1F466}.", CLEAN]);
  });

  test("a bidirectional override in a raw subject is unreadable", async () => {
    expect(flags(await parseGmailRawDraft(message("To: penelope@example.com", "Subject: Invoice \u202Efdp.exe", "", ""))))
      .toEqual({ ...CLEAN, unreadable_headers: true, unreadable_body: true, problems: ["header_control_character"] });
  });

  test("a bidirectional override in an encoded subject is unreadable", async () => {
    const parsed = await parseGmailRawDraft(message("To: penelope@example.com", "Subject: =?utf-8?Q?Invoice_=E2=80=AEfdp.exe?=", "", ""));
    expect([parsed.subject, flags(parsed)]).toEqual([null, { ...CLEAN, unreadable_headers: true, problems: ["encoded_word"] }]);
  });

  test("a bidirectional isolate in an encoded display name is unreadable", async () => {
    const parsed = await parseGmailRawDraft(message("To: =?utf-8?Q?=E2=81=A7Penelope?= <penelope@example.com>", "", ""));
    expect([addresses(parsed.to), flags(parsed)]).toEqual([[], { ...CLEAN, unreadable_headers: true, problems: ["address_syntax"] }]);
  });

  test("a ZWJ emoji in a subject stays displayable", async () => {
    const parsed = await parseGmailRawDraft(message("Subject: =?utf-8?Q?Home_=F0=9F=91=A8=E2=80=8D=F0=9F=91=A6?=", "", ""));
    expect([parsed.subject, flags(parsed)]).toEqual(["Home \u{1F468}\u200D\u{1F466}", CLEAN]);
  });
});
