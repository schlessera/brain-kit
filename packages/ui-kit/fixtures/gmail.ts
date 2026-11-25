// Odysseus's mail (#4209): what the Gmail components render in Storybook and
// the visual baselines. Ogygia, the week before the pinned morning
// (REFERENCE_DATE, 2026-07-12, 06:40 at UTC+2). Every address is on
// example.com or a reserved `.example` domain; every date is a literal the
// host would format from a Gmail timestamp, built here with arithmetic and
// no clock; every hidden character is spelled as an escape.

import type {
  GmailContentMessage, GmailContentThread, GmailDate, GmailLabel, GmailStructuredMessage, GmailStructuredThread,
} from "../src/index.js";
import { OGYGIA_UTC_OFFSET } from "./time.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A Gmail timestamp as the host would show it on Ogygia: `mailDate("2026-07-11T18:02")`
 * is "Sat 11 Jul 18:02" and "Saturday 11 July 2026, 18:02". `time: false`
 * drops the time from the short form, as a content row does.
 */
export function mailDate(local: string, opts: { time?: boolean } = {}): GmailDate {
  const iso = `${local}:00${OGYGIA_UTC_OFFSET}`;
  const [date, clock] = local.split("T") as [string, string];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const day = DAYS[weekday]!;
  const month = MONTHS[m - 1]!;
  const short = `${day.slice(0, 3)} ${d} ${month.slice(0, 3)}${opts.time === false ? "" : ` ${clock}`}`;
  return { short, full: `${day} ${d} ${month} ${y}, ${clock}`, iso };
}

// ------------------------------------------------------------------ labels

export const L = {
  inbox: { id: "INBOX", name: "INBOX" },
  unread: { id: "UNREAD", name: "UNREAD" },
  starred: { id: "STARRED", name: "STARRED" },
  important: { id: "IMPORTANT", name: "IMPORTANT" },
  sent: { id: "SENT", name: "SENT" },
  primary: { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL" },
  promotions: { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS" },
  updates: { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES" },
  yellowStar: { id: "YELLOW_STAR", name: "YELLOW_STAR" },
  family: { id: "Label_1", name: "Family" },
  ithaca: { id: "Label_2", name: "Ithaca" },
  voyage: { id: "Label_3", name: "Voyage" },
  suitors: { id: "Label_4", name: "Suitors" },
  raft: { id: "Label_5", name: "Raft" },
  estate: { id: "Label_6", name: "Estate · herds and orchards" },
  /** As the host escapes it (ruling 5 of #4207): an RLO in the name arrives as the visible text `\u{202E}`. */
  escaped: { id: "Label_7", name: "Suitors \\u{202E}gol" },
  /** A name the host withheld (longer than Gmail allows): only the id. */
  withheld: { id: "Label_8", name: null },
} satisfies Record<string, GmailLabel>;

// ---------------------------------------------------------------- mailboxes

export const ODYSSEUS = "Odysseus <odysseus@example.com>";
export const PENELOPE = "Penelope <penelope@example.com>";
export const TELEMACHUS = "Telemachus <telemachus@example.com>";
export const EUMAEUS = "Eumaeus <eumaeus@example.com>";
export const EURYCLEIA = "Eurycleia <eurycleia@example.com>";
export const LAERTES_LONG = '"Laertes, son of Arcesius, keeper of the orchard above the town" <laertes.son-of-arcesius.keeper-of-the-orchard@example.com>';

// --------------------------------------------------------- search: content

export const contentThreads: GmailContentThread[] = [
  {
    threadId: "19a1c0de0f2b4a01",
    date: mailDate("2026-07-11T18:02", { time: false }),
    messageCount: 5,
    labels: [L.inbox, L.unread, L.family, L.ithaca, L.voyage],
    sizeBucket: "under_1mb",
    unread: true,
    starred: false,
    hasAttachment: true,
    untrusted: {
      from: PENELOPE,
      to: ODYSSEUS,
      cc: EURYCLEIA,
      subject: "The loom, again",
      snippet: "The suitors have noticed the shroud never grows. Antinous counted the threads last night and said nothing, which is worse.",
    },
  },
  {
    threadId: "19a1b97e44c0aa12",
    date: mailDate("2026-07-09T21:40", { time: false }),
    messageCount: 2,
    labels: [L.inbox, L.estate],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    untrusted: {
      from: EUMAEUS,
      to: ODYSSEUS,
      cc: null,
      subject: "Pigs, and a stranger at the hut",
      snippet: "Three hundred and sixty boars, master, and the suitors take the best one every day. A beggar slept by the fire last night.",
    },
  },
  {
    threadId: "19a1a4410d5ce803",
    date: mailDate("2026-07-08T07:15", { time: false }),
    messageCount: 1,
    labels: [L.inbox, L.starred, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: true,
    hasAttachment: false,
    untrusted: {
      from: TELEMACHUS,
      to: ODYSSEUS,
      cc: null,
      subject: "Leaving for Sparta",
      snippet: "Nestor sent me on with a chariot and his son. Menelaus has news of you, they say. I will write from Sparta.",
    },
  },
  {
    threadId: "19a19f03b7e21c44",
    date: mailDate("2026-07-06T09:30", { time: false }),
    messageCount: 3,
    labels: [L.inbox, L.important, L.raft],
    sizeBucket: "under_100kb",
    unread: false,
    starred: false,
    hasAttachment: true,
    untrusted: {
      from: "Calypso <calypso@example.com>",
      to: ODYSSEUS,
      cc: null,
      subject: null,
      snippet: "The bronze axe is by the cave mouth and the poplars on the point are dry. Hermes says I am to let you go. I have not said I will.",
    },
  },
];

/** A sender with a long display name and address, and a long subject, for the 320px row. */
export const longSenderThread: GmailContentThread = {
  threadId: "19a18a20c3d4e905",
  date: mailDate("2026-07-05T16:48", { time: false }),
  messageCount: 12,
  labels: [L.inbox, L.family, L.estate, L.ithaca, L.voyage],
  sizeBucket: "under_100kb",
  unread: true,
  starred: true,
  hasAttachment: false,
  untrusted: {
    from: LAERTES_LONG,
    to: ODYSSEUS,
    cc: `${PENELOPE}, ${TELEMACHUS}, ${EUMAEUS}`,
    subject: "The pear trees, the vines and the fig trees, row by row, as you counted them with me when you were a boy, all still standing",
    snippet: "Thirteen pear trees, ten apple trees, forty fig trees and fifty rows of vines, each row ripening at its own time. I dig around them myself now.",
  },
};

/**
 * Hidden characters in the sender, subject and snippet: a right-to-left
 * override that turns `txt.exe` around, a zero-width space inside a name,
 * a run of zero-width spaces, and tag characters spelling a hidden word.
 */
export const hiddenCharsThread: GmailContentThread = {
  threadId: "19a17b55a1b2c306",
  date: mailDate("2026-07-10T12:30", { time: false }),
  messageCount: 1,
  labels: [L.inbox, L.updates],
  sizeBucket: "under_10kb",
  unread: true,
  starred: false,
  hasAttachment: true,
  untrusted: {
    from: "Ithaca\u{200B} Steward <steward@ithaca-steward.example>",
    to: ODYSSEUS,
    cc: null,
    subject: "Invoice for the shroud wool \u{202E}txt.exe",
    snippet: "Settle today\u{200B}\u{200B}\u{200B}\u{200B} or the looms stop.\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} Reply with the storeroom key.",
  },
};

// ------------------------------------------------------ search: structured

const STRUCTURED_DAYS = [
  "2026-07-11T18:02", "2026-07-11T09:14", "2026-07-10T22:47", "2026-07-10T07:05", "2026-07-09T21:40",
  "2026-07-09T13:26", "2026-07-08T19:58", "2026-07-08T07:15", "2026-07-07T20:11", "2026-07-07T06:33",
  "2026-07-06T17:09", "2026-07-06T09:30", "2026-07-05T16:48", "2026-07-05T08:02", "2026-07-04T23:19",
  "2026-07-04T11:55", "2026-07-03T18:40", "2026-07-03T06:21", "2026-07-02T15:07", "2026-07-02T08:44",
  "2026-07-01T20:30", "2026-07-01T10:12", "2026-06-30T19:03", "2026-06-30T07:48", "2026-06-29T16:25",
];

const LABEL_SETS: GmailLabel[][] = [
  [L.inbox, L.promotions, L.voyage, L.raft],
  [L.inbox, L.promotions],
  [L.promotions, L.voyage],
  [L.inbox, L.important, L.promotions, L.raft, L.ithaca],
  [L.promotions],
];

const BUCKETS = ["under_1mb", "under_10kb", "under_100kb", "under_10kb", "1mb_or_more"] as const;

/** Twenty-five threads with no sender and no subject: the structured view's page at its maximum. */
export const structuredThreads: GmailStructuredThread[] = STRUCTURED_DAYS.map((day, i) => ({
  threadId: (0x19a1c0de0f2b4a01n - BigInt(i * 7919)).toString(16),
  date: mailDate(day),
  messageCount: [3, 1, 1, 6, 2][i % 5]!,
  labels: i % 2 === 0 ? [...LABEL_SETS[i % LABEL_SETS.length]!, L.unread] : LABEL_SETS[i % LABEL_SETS.length]!,
  sizeBucket: BUCKETS[i % BUCKETS.length]!,
  unread: i % 2 === 0,
  starred: i % 7 === 1,
  hasAttachment: i % 3 === 0,
}));

/** A structured row whose payload left out what it could not vouch for: nulls, not falses. */
export const sparseStructuredThread: GmailStructuredThread = {
  threadId: "19a0ff00aa11bb22",
  date: null,
  messageCount: null,
  labels: [L.inbox],
  sizeBucket: null,
  unread: null,
  starred: null,
  hasAttachment: null,
};

// ------------------------------------------------------------ thread: loom

const loomQuote = (when: string, who: string, lines: string[]) => [`On ${when}, ${who} wrote:`, ...lines.map((line) => (line === "" ? ">" : `> ${line}`))].join("\n");

const m1Body = "I have told them I will choose when the shroud for Laertes is finished. I weave by day. You know what I do by night.";
const m2Body = "Keep unweaving. Seventeen days of open water, if Calypso lets the raft go. Tell no one but Eurycleia.";
const m3Body = "Eurycleia knows. So does Melantho, and Melantho talks to Eurymachus.";
const m4Body = "Tell them it's for Laertes. It is, after all.";
const m5Body = [
  "The suitors have noticed the shroud never grows. Antinous counted the threads last night and said nothing, which is worse.",
  "",
  "I have sent the pattern so you can see how far it has not come. The border is done twice over; the field has been undone eleven hundred times. Amphinomus is the only one of them who looks ashamed.",
  "",
  "Come home before the last of the wool.",
].join("\n");

export const loomMessages: GmailContentMessage[] = [
  {
    messageId: "19a1a01f10000001",
    date: mailDate("2026-07-07T20:11"),
    labels: [L.inbox, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: { from: PENELOPE, to: ODYSSEUS, cc: null, subject: "The loom, again", snippet: m1Body, body: m1Body, bodyTruncated: false, bodyLength: m1Body.length, attachments: [] },
  },
  {
    messageId: "19a1a01f10000002",
    date: mailDate("2026-07-08T06:52"),
    labels: [L.sent, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: {
      from: ODYSSEUS, to: PENELOPE, cc: null, subject: "Re: The loom, again", snippet: m2Body,
      body: `${m2Body}\n\n${loomQuote("Tue, 7 Jul 2026 at 20:11", "Penelope <penelope@example.com>", [m1Body])}`,
      bodyTruncated: false, bodyLength: null, attachments: [],
    },
  },
  {
    messageId: "19a1a01f10000003",
    date: mailDate("2026-07-09T22:30"),
    labels: [L.inbox, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: { from: PENELOPE, to: ODYSSEUS, cc: EURYCLEIA, subject: "Re: The loom, again", snippet: m3Body, body: m3Body, bodyTruncated: false, bodyLength: m3Body.length, attachments: [] },
  },
  {
    messageId: "19a1a01f10000004",
    date: mailDate("2026-07-10T07:05"),
    labels: [L.sent, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: {
      from: ODYSSEUS, to: PENELOPE, cc: null, subject: "Re: The loom, again", snippet: m4Body,
      body: `${m4Body}\n\n${loomQuote("Thu, 9 Jul 2026 at 22:30", "Penelope <penelope@example.com>", [m3Body])}`,
      bodyTruncated: false, bodyLength: null, attachments: [],
    },
  },
  {
    messageId: "19a1a01f10000005",
    date: mailDate("2026-07-11T18:02"),
    labels: [L.inbox, L.unread, L.family, L.ithaca],
    sizeBucket: "under_1mb",
    unread: true,
    starred: true,
    hasAttachment: true,
    attachmentCount: 1,
    untrusted: {
      from: PENELOPE, to: ODYSSEUS, cc: EURYCLEIA, subject: "Re: The loom, again", snippet: m5Body.split("\n")[0]!,
      body: `${m5Body}\n\n${loomQuote("Fri, 10 Jul 2026 at 07:05", "Odysseus <odysseus@example.com>", [m4Body, "", "On Thu, 9 Jul 2026 at 22:30, Penelope <penelope@example.com> wrote:", `> ${m3Body}`])}`,
      bodyTruncated: false, bodyLength: null,
      attachments: [{ filename: "shroud-pattern.pdf", mimeType: "application/pdf", size: 122_880 }],
    },
  },
];

/** Two messages: Telemachus writes, Odysseus answers. */
export const spartaMessages: GmailContentMessage[] = [
  {
    messageId: "19a1a4410d5ce803",
    date: mailDate("2026-07-08T07:15"),
    labels: [L.inbox, L.starred, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: true,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: {
      from: TELEMACHUS, to: ODYSSEUS, cc: PENELOPE, subject: "Leaving for Sparta",
      snippet: "Nestor sent me on with a chariot and his son.",
      body: "Nestor sent me on with a chariot and his son, Peisistratus. Menelaus has news of you, they say: that you are held on an island by a goddess, and have no ship.\n\nI will write from Sparta.",
      bodyTruncated: false, bodyLength: null, attachments: [],
    },
  },
  {
    messageId: "19a1a4410d5ce804",
    date: mailDate("2026-07-09T06:10"),
    labels: [L.sent, L.family],
    sizeBucket: "under_10kb",
    unread: false,
    starred: false,
    hasAttachment: false,
    attachmentCount: 0,
    untrusted: {
      from: ODYSSEUS, to: TELEMACHUS, cc: null, subject: "Re: Leaving for Sparta",
      snippet: "The island part is true. The no ship part will not be for long.",
      body: "The island part is true. The no ship part will not be for long.\n\nWhen you come home, come by the swineherd's hut first, not the harbour.",
      bodyTruncated: false, bodyLength: null, attachments: [],
    },
  },
];

/** A quote in the middle of what the sender wrote: it stays where it is. */
export const midQuoteMessage: GmailContentMessage = {
  ...loomMessages[2]!,
  messageId: "19a1a01f10000013",
  untrusted: {
    ...loomMessages[2]!.untrusted,
    body: "> Keep unweaving.\n\nI am. Every night, by torchlight, with Eurycleia at the door.\n\nThe maids sleep early now; I have seen to that.",
  },
};

// ----------------------------------------------------- message: the herds

const HERD_LINE = "Twelve sties of fifty sows, the boars kept outside them, three hundred and sixty in all, and the suitors take the best fattened one each day.";

/** `n` characters of the swineherd's tally, line by line. */
function tally(n: number, from = 0): string {
  let out = "";
  let i = from;
  while (out.length < n) {
    out += `Day ${i + 1}: ${HERD_LINE}\n`;
    i++;
  }
  return out.slice(0, n);
}

/** Eumaeus's account of the herds: 49,152 characters, of which the payload carried the first 32,768. */
export const herdsBody = tally(32_768);
export const herdsRest = tally(49_152).slice(32_768);

export const herdsMessage: GmailContentMessage = {
  messageId: "19a1b97e44c0aa13",
  date: mailDate("2026-07-09T21:40"),
  labels: [L.inbox, L.estate],
  sizeBucket: "under_100kb",
  unread: false,
  starred: false,
  hasAttachment: false,
  attachmentCount: 0,
  untrusted: {
    from: EUMAEUS, to: ODYSSEUS, cc: null, subject: "The count of the herds, every day since you sailed", snippet: HERD_LINE,
    body: herdsBody, bodyTruncated: true, bodyLength: 49_152, attachments: [],
  },
};

/** A later message in a thread whose 128 KiB reading budget was already spent: Brain read none of it. */
export const unreadBudgetMessage: GmailContentMessage = {
  ...herdsMessage,
  messageId: "19a1b97e44c0aa14",
  untrusted: { ...herdsMessage.untrusted, subject: "Re: The count of the herds", body: "", bodyLength: 6_240 },
};

/** A short message with a link, which opens only through the interstitial. */
export const linkMessage: GmailContentMessage = {
  ...spartaMessages[0]!,
  messageId: "19a1a4410d5ce805",
  untrusted: {
    ...spartaMessages[0]!.untrusted,
    subject: "The route Menelaus drew",
    body: "Menelaus drew the route from Pharos on a hide. I copied it: [the route from Pharos](https://charts.pharos.example/route?from=pharos&to=ithaca).\n\nHe says the Old Man of the Sea gave it to him.",
  },
};

/** A message that hides text: an override in the body, zero-width spaces, tag characters, and an emoji whose joiner is spelling. */
export const hiddenCharsMessage: GmailContentMessage = {
  messageId: "19a17b55a1b2c307",
  date: mailDate("2026-07-10T12:30"),
  labels: [L.inbox, L.updates],
  sizeBucket: "under_10kb",
  unread: true,
  starred: false,
  hasAttachment: true,
  attachmentCount: 1,
  untrusted: {
    from: hiddenCharsThread.untrusted.from,
    to: ODYSSEUS,
    cc: null,
    subject: hiddenCharsThread.untrusted.subject,
    snippet: hiddenCharsThread.untrusted.snippet,
    body: [
      "The invoice is attached as invoice-\u{202E}fdp.exe and must be settled today.",
      "",
      "Pay\u{200B}\u{200B}\u{200B}\u{200B}\u{200B}ment to the steward only.\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} The swineherd \u{1F9D1}\u{200D}\u{1F33E} is waiting.",
    ].join("\n"),
    bodyTruncated: false,
    bodyLength: null,
    attachments: [{ filename: "invoice-\u{202E}fdp.exe", mimeType: "application/octet-stream", size: 48_213 }],
  },
};

/** A message with no text body (an HTML-only message that converted to nothing). */
export const noBodyMessage: GmailContentMessage = {
  ...spartaMessages[1]!,
  messageId: "19a1a4410d5ce806",
  untrusted: { ...spartaMessages[1]!.untrusted, subject: "A picture of the harbour", snippet: null, body: null, bodyLength: null, attachments: [{ filename: "harbour.jpg", mimeType: "image/jpeg", size: 2_516_582 }] },
  hasAttachment: true,
  attachmentCount: 1,
};

/** A long body, clamped to six lines (four on a phone). */
export const clampedMessage: GmailContentMessage = {
  ...spartaMessages[0]!,
  messageId: "19a1a4410d5ce807",
  untrusted: {
    ...spartaMessages[0]!.untrusted,
    subject: "What Menelaus said",
    body: [
      "Menelaus says that on Pharos, becalmed twenty days, he caught the Old Man of the Sea, who changed into a lion, a serpent, a leopard, a boar, running water and a tree before he would answer.",
      "",
      "He answered three questions. The second was about the others who sailed from Troy. Ajax drowned. Agamemnon reached home and was killed at his own table.",
      "",
      "The third was about you. The Old Man said you are on an island, in the house of the nymph Calypso, weeping, with no ship and no crew to row one.",
      "",
      "Menelaus gave me horses. I said Ithaca is no country for horses and asked for a cup instead. He laughed and gave me the cup.",
    ].join("\n"),
  },
};

/** Structured views of a thread and a message: dates, labels, counts. */
export const structuredMessages: GmailStructuredMessage[] = loomMessages.map(({ untrusted: _untrusted, detail: _detail, ...structured }) => structured);
