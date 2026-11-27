---
"@schlessera/brain-ui-react": patch
---

The tracker-seen hook keeps one MutationObserver and one pair of scroll and visibility listeners for as long as what they depend on holds, instead of rebuilding them on every Chat render, and an answer still being written no longer costs a document query for an open modal (#4743). A transcript that appears after the empty state still gets its scroll listener, and the same turns are marked seen.
