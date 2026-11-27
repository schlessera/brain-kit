---
"@schlessera/brain-scrape": minor
"@schlessera/brain-module-jobs": patch
---

`FetchOptions` gains an optional `maxBytes` (#4768). When it is set, `ScrapeClient.getJson`, `getPage` and `getText` read at most that many bytes of a response body, the body of a non-2xx response included: a longer body is refused as it streams in, its stream is cancelled, and that request fails. Unset, behaviour is unchanged, and `get` always returns its `Response` unread. The robots.txt fetcher uses the same bounded reader with its existing limit.

module-jobs now bounds what one board response may carry: 32 MiB for a listing page or API response and 8 MiB for a detail page. A response past its bound fails that page, counted like any other failed fetch; the rest of the run continues.
