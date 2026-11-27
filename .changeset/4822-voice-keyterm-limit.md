---
"@schlessera/brain-ui-server": patch
---

A `VOICE_KEYTERM_LIMIT` that is not a number (for example `5OO`) now applies its documented default of 500 (#4822). It used to become `NaN`, which the keyterm builder read as "no terms" and cached as an empty vocabulary until the next forced rebuild. Unset or empty still means 500, and `0` still means no terms. Every other numeric setting keeps its current handling of an invalid value.
