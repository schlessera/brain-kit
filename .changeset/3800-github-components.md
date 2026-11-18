---
"@schlessera/brain-ui-kit": minor
---

New GitHub components: `GitHubPullRequest`, `GitHubIssue`, `GitHubThread`, `GitHubComment`, `GitHubReview`, `GitHubCommitRow`, `GitHubMergeEvent`, `GitHubResultList`, `GitHubDetailSection`, `GitHubStateChip`, `GitHubRef`, `GitHubIdentity`, `GitHubParticipants` and `GitHubWriteNotice`. They take props and callbacks only and never fetch or build a URL. A direct `GitHub ↗` link renders only in its slot, only for an `https://github.com` URL, and opens in a new tab with no opener and no referrer. An avatar loads only from the page's own origin. Absent checks and unknown review states read "— None reported" and "— Not reported", never as passing.

New `UntrustedText`, for text written outside Brain. It renders a safe markdown subset: no HTML, no images and no autolinks, with bidi isolated per run. An `https:` link is a button that opens a full-address interstitial naming the link's registrable domain, and only the interstitial's Open action navigates. Other links stay text, with the reason they won't open. The kit now depends on `tldts` for the public-suffix list behind the registrable domain.

`Icon` gains `pr-open`, `pr-merged`, `pr-closed`, `issue-open`, `issue-closed`, `not-planned`, `draft`, `commit`, `changes-requested` and `review-pending`. `Overlay` gains `describedBy`.
