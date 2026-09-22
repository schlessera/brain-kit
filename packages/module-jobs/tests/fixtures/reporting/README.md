# Reporting fixtures

Bodies for the one thing `boards/` cannot hold: what a **healthy** board serves
on a day it has nothing to offer.

`boards/` is captured markup — a verbatim slice of what a real site answered on
2026-09-22, which is what makes it evidence. These are not captured, and saying
so is the point. You cannot go and record a day on which Remotive had no jobs
in a category, and waiting for one is not a test strategy. So each file here is
**constructed**: the board's own envelope, carrying no records.

That is exactly the case #37 has to keep separable from a parser that has
stopped working, and it is the only case in this directory. Nothing here stands
in for real markup, and no claim about how a site behaves rests on these files.

| File | What it is |
| --- | --- |
| `interstitial.html` | A challenge page. Not any board's markup — the body every adapter is fed to prove it reports rather than shrugs. |
| `remoteok-empty.json` | The RemoteOK feed: its legal notice and no postings behind it. |
| `remoteok-drifted.json` | The same feed with postings whose `position`/`company` have been renamed. |
| `remotive-empty.json` | A Remotive category answering with `"jobs": []`. |
| `remotive-drifted.json` | The same envelope with records whose `title`/`company_name` have been renamed. |
| `workingnomads-empty.json` | The Working Nomads endpoint answering with a bare `[]`. |
| `workingnomads-drifted.json` | The same array with records whose `title`/`company_name` have been renamed. |
| `weworkremotely-empty.rss` | A valid feed document with a channel and no `<item>`s. |
| `jobgether-empty.json` | The `/api/v1/jobs` envelope with an empty `jobs` array. |
| `remoteok-maintenance.json` | Valid JSON that is not the RemoteOK feed. Produces no entries, exactly as an empty feed does. |
| `weworkremotely-attributed-items.rss` | A **populated** feed whose `<item>` tags carry an attribute, which `parseRssItems` matches by bare tag and therefore skips. |

The `-empty` and `-drifted` pairs are the same envelope and produce the same row
count — zero. An adapter that decides on the count alone cannot tell them apart,
which is why it does not: see `PageLedger.read` in
`src/adapters/base.ts`.

The last two files are the near misses, and they are here because a review
found them rather than because they were predicted. Both produce zero rows off
a 200 that is not an empty listing, and both would have been reported as one by
an empty check that asked a slightly easier question — "is this JSON?" instead
of "is this the feed's envelope?", "is there a channel?" instead of "is there a
channel and no item markup at all?".

The placeholder employers (`Example Corp`, `Example Labs`) are fictional and
carry no relationship to the real postings in `boards/`.

## Boards with no file here

`simplyhired`, `remotelyde`, `remoteineurope` and the three browser boards have
no empty-state fixture, because none of them has a captured no-results marker to
build one from. Their adapters therefore claim no empty state at all, and report
a served page they read nothing off as drift. That is the safe direction, and
each adapter says so at the call site.
