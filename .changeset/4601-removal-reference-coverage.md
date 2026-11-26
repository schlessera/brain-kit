---
"@schlessera/brain-ui-react": patch
---

The Storage removal dialogs no longer read an incomplete reference check as a clean result (#4601). When the inspection did not check every reference, or refused a file as `consequences_incomplete`, the inspect sheet and the removal review say the links are unknown instead of "No references found", by the same rule the Find large files rows use for `? links unknown`. Links that were found are still listed, with a note that others may exist. A complete check with no references keeps its "none found" wording.
