---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

Render retained Activity run intervals through LaneChart on one recorded time
axis. Only explicit approval boundaries hatch; only recorded active work has
an open tail, and missing terminal timing is disclosed without inference.
Preserve outcome words and complete readable timing in both themes and on phones.

Expose LaneChart's existing HATCH_GLYPH constant from the public kit barrel so
hosts can supply the documented waiting legend. Long lane names and legends wrap.
