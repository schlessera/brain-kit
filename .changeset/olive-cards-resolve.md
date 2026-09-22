---
"@schlessera/brain-module-jobs": patch
---

`brain jobs scrape dice` stores an openable link. Dice is the only board whose
result card carries a relative `href`, and the adapter handed it on unchanged,
so every stored row's `url` and `source_url` was `/job-detail/<guid>` — a link
nothing in the review queue, an opportunity doc or the CLI could follow. The
card link is now resolved against `https://www.dice.com`, the way every other
adapter already prefixes its origin.

The company comes off the card's `/company-profile/` link instead of being
guessed at by scanning the card's text lines, which had left one row in ten
stored as the literal `Unknown`.

`source_id` is unchanged — still the relative path — so the next scrape updates
the rows already stored rather than inserting a second copy of each.
