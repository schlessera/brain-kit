// Odysseus's Gmail approval cards (#4215): what the send, draft, delete,
// trash and modify cards render in Storybook, in the visual baselines and in
// the kit's unit tests. Ogygia, the week before the pinned morning
// (REFERENCE_DATE, 2026-07-12). Every address is on example.com or a reserved
// `.example` domain; every Gmail id has the shape Gmail mints; every hidden
// character is spelled as an escape.

import type {
  GmailLabel, GoogleMailbox, GoogleMailMessage, GoogleMailTarget, GoogleMailThread, GoogleRecipientMatch,
} from "../src/index.js";
import { L, mailDate } from "./gmail.js";

// ---------------------------------------------------------------- mailboxes

const box = (address: string, displayName: string | null = null): GoogleMailbox => ({ address, displayName });

export const ODYSSEUS = box("odysseus@example.com", "Odysseus");
export const PENELOPE = box("penelope@example.com", "Penelope");
export const TELEMACHUS = box("telemachus@example.com", "Telemachus");
export const EUMAEUS = box("eumaeus@example.com");
export const EURYCLEIA = box("eurycleia@example.com", "Eurycleia");
export const MENTOR = box("mentor@ithaca.example", "Mentor");
/** A Reply-To that is not From: replies would go to the steward, not to Odysseus. */
export const STEWARD = box("steward@ithaca-steward.example", "Odysseus");

/** The crew a long send goes to: twelve To, six Cc, three Bcc. */
const CREW = ["eurylochus", "polites", "elpenor", "perimedes", "antiphus", "lycaon", "baius", "misenus", "echion", "thrasymedes", "phemius", "medon"];
export const CREW_TO = CREW.map((name) => box(`${name}@example.com`, name[0]!.toUpperCase() + name.slice(1)));
export const CREW_CC = ["halitherses", "aegyptius", "peisenor", "noemon", "mentes", "dolius"].map((name) => box(`${name}@ithaca.example`));
export const CREW_BCC = [EUMAEUS, box("philoetius@example.com"), box("eurycleia@example.com", "Eurycleia")];

/** Each recipient's send-list match, as the host's card names it: the policy entry as written. */
export function matchesFor(message: GoogleMailMessage): GoogleRecipientMatch[] {
  const entry = (address: string) => (address === ODYSSEUS.address ? "self" : `*@${address.slice(address.indexOf("@") + 1)}`);
  return (["to", "cc", "bcc"] as const).flatMap((field) => message[field].map((m) => ({ field, address: m.address, entry: entry(m.address) })));
}

// ---------------------------------------------------------------- bodies

export const SHORT_BODY = ["Keep unpicking it at night.", "", "I've left Ogygia; the raft sails at seven, if the wind holds east.", "", "O."].join("\n");

const QUOTED = [
  "On Sat, 11 Jul 2026 at 18:02, Penelope <penelope@example.com> wrote:",
  "> The loom is still not finished, and they have started counting the nights.",
  "> Antinous says the shroud is a story. Eurymachus says it is a delay.",
  "> Both of them are right, and both of them drink the wine.",
  ">",
  "> Telemachus wants to sail for Pylos. I said no. He went to Mentor instead.",
  "> If you are coming, come before the last of the wool.",
];

/** A reply long enough to scroll: forty-two lines, the quoted history in full (nothing is summarised away on a send). */
export const LONG_BODY = [
  "Penelope,",
  "",
  "Keep unpicking it at night. I've left Ogygia; the raft sails at seven.",
  "",
  ...Array.from({ length: 17 }, (_, i) => `Day ${i + 1}: keep the Great Bear on the left hand, as Calypso said, and do not sleep.`),
  "",
  "If the raft breaks, I will swim. If I reach the Phaeacians, I will ask for a ship.",
  "Tell Telemachus that Mentor is the right man to sail with, and that I said so.",
  "Tell Eumaeus to keep the pigs fat and say nothing to anyone in the hall.",
  "",
  "Do not answer the suitors. Do not count the wine. Count the days instead.",
  "",
  "Seventeen of them, then the Phaeacians, then home.",
  "",
  "O.",
  "",
  ...QUOTED,
  "",
  "-- ",
  "Sent from the raft",
].join("\n");

/** Hidden characters in the body: a right-to-left override, a zero-width space and a run of three of them. */
export const HIDDEN_BODY = [
  "The ship's name is in the attachment: Argo\u{202E}gro.",
  "Meet at the harbour\u{200B}master's house\u{200B}\u{200B}\u{200B} at dusk.",
].join("\n");

/** A body with a link: it opens only through the interstitial, with its full address. */
export const LINK_BODY = [
  "The tide table for the strait is here: [tides at Ogygia](https://tides.ithaca.example/ogygia/july).",
  "",
  "Read it before you agree to anything Calypso says about the wind.",
].join("\n");

// ---------------------------------------------------------------- messages

const message = (rest: Partial<GoogleMailMessage>): GoogleMailMessage => ({
  from: ODYSSEUS,
  to: [PENELOPE],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "The raft sails at seven",
  inReplyTo: [],
  body: SHORT_BODY,
  ...rest,
});

/** To only: no Cc, no Bcc, no Reply-To. */
export const minimalMessage = message({});

/** Cc, Bcc and a Reply-To that differs from From, replying in the loom thread. */
export const fullMessage = message({
  to: [PENELOPE],
  cc: [TELEMACHUS],
  bcc: [EUMAEUS],
  replyTo: [STEWARD],
  subject: "Re: The loom, again",
  inReplyTo: ["<CAOgygia.loom.5@mail.example.com>"],
});

export const longMessage = message({ subject: "Re: The loom, again", body: LONG_BODY, inReplyTo: ["<CAOgygia.loom.5@mail.example.com>"] });

/** Hidden characters in the subject, an address's display name and the body. */
export const hiddenMessage = message({
  to: [box("penelope@example.com", "Penel\u{202E}epo"), EURYCLEIA],
  subject: "Invoice\u{200B} for the \u{202E}tfar",
  body: HIDDEN_BODY,
});

export const linkMessage = message({ subject: "The tide table", body: LINK_BODY });

export const manyMessage = message({ to: CREW_TO, cc: CREW_CC, bcc: CREW_BCC, subject: "Muster at the ships, first light" });

/** The thread a reply answers, as the host shows it. */
export const loomThread: GoogleMailThread = { subject: "Re: The loom, again", date: mailDate("2026-07-11T18:02") };

export const replyMessage = message({
  subject: "Re: The loom, again",
  inReplyTo: ["<CAOgygia.loom.5@mail.example.com>"],
  body: [SHORT_BODY, "", ...QUOTED].join("\n"),
});

/** A draft update: the body it replaces and the new one. */
export const PREVIOUS_BODY = ["Keep unpicking it at night.", "", "I'm still on Ogygia; Calypso won't hear of a raft.", "", "O."].join("\n");
export const updatedMessage = message({ body: SHORT_BODY });

// ---------------------------------------------------------------- targets

const PROMOTIONS: readonly GmailLabel[] = [L.inbox, L.promotions];
const DAYS = ["2026-07-11T09:14", "2026-07-10T17:40", "2026-07-09T08:05", "2026-07-09T07:31", "2026-07-07T19:22", "2026-07-06T12:00", "2026-07-05T06:45", "2026-07-04T21:10", "2026-07-03T10:30", "2026-07-02T15:55", "2026-07-01T08:20", "2026-06-30T13:05"];

/** Twelve promotions in the inbox: what an archive reads, by date and labels. */
export const promotionTargets: GoogleMailTarget[] = DAYS.map((day, i) => ({
  messageId: `19a1b2c3d4e5f6${(10 + i).toString(16).padStart(2, "0")}`,
  date: mailDate(day, { time: false }),
  labels: PROMOTIONS,
}));

/** Three messages from the suitors, with what a stranger wrote about them. */
export const suitorTargets: GoogleMailTarget[] = [
  { messageId: "19a1c0de0f2b4a01", date: mailDate("2026-07-11T22:40", { time: false }), labels: [L.inbox, L.suitors], from: "Antinous <antinous@ithaca.example>", subject: "Choose one of us before the wine runs out" },
  { messageId: "19a1c0de0f2b4a02", date: mailDate("2026-07-10T23:15", { time: false }), labels: [L.inbox, L.suitors], from: "Eurymachus <eurymachus@ithaca.example>", subject: "Re: Choose one of us" },
  { messageId: "19a1c0de0f2b4a03", date: mailDate("2026-07-09T21:02", { time: false }), labels: [L.inbox, L.suitors], from: "Amphinomus <amphinomus@ithaca.example>", subject: "An apology, of sorts" },
];

/** What today's card payload carries for each message: its Gmail id and nothing else. */
export const idOnlyTargets: GoogleMailTarget[] = ["19a1d00000000a01", "19a1d00000000a02", "19a1d00000000a03", "19a1d00000000a04"].map((messageId) => ({ messageId }));

export const DRAFT_ID = "r-5823190347761234567";
