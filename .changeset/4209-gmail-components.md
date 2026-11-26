---
"@schlessera/brain-ui-kit": minor
---

New Gmail components: `GmailResultList`, `GmailThread`, `GmailMessage` and `GmailLabels`. They take props and callbacks only and never fetch. `GmailResultList`, `GmailThread` and `GmailMessage` each take a `view`. In the structured view, a row carries no slot for a sender, a subject or anything else a stranger wrote, and the header says once: "Structured view · dates, labels and counts only. Brain didn't read these messages." In the content view, every sender, subject, snippet, address, file name and body is shown as untrusted text, and a link in a body opens only through the full-address interstitial. Labels show as neutral chips with system labels as words, three of them and then "+N", which expands in place. A thread shows its newest message open and folds all but the last two of four or more earlier messages. Quoted history at the end of a body folds behind "Show quoted text". A body the payload cut says how much Brain read, and the rest loads on demand in the same states GitHub's detail section uses.

New `revealInvisibles` and `invisibleSegments`. They show bidi controls, zero-width characters, tag characters and other hidden code points as `‹U+XXXX›` markers, and leave spelling that needs them, such as emoji sequences and Persian or Indic joiners, as written. `UntrustedText` is unchanged.

`GitHubDetailSection` is now a wrapper over a shared detail section. Its API, copy and markup are unchanged. `Icon` gains `star`.
