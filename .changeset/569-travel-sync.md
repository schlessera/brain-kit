---
"@schlessera/brain-module-travel": minor
---

Add `brain travel sync [--check]`, which regenerates `trips/_index.md` (Done, Proposed and Dismissed day trips) and `places/_index.md` (countries visited, every place and the places reached each year) from the canonical journey, trip and place records. Only the `travel-trips` and `travel-places` generated regions change; prose around them, including the trips index's choosing rules, keeps its bytes, and an unchanged brain writes nothing. A visit linked from several places counts once, and unknown dates and coordinates stay `unknown`. Any invalid record or malformed region refuses the run and writes neither registry. New `trip-log` and `places` skills propose, record and dismiss trips and record visited places through the photo, route and sync commands; `plan-travel` now records a completed journey's visit.
