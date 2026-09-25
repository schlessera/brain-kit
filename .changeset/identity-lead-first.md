---
"@schlessera/brain": minor
---

`brain context` reads the identity and current-focus documents lead first when they do not fit whole. The lead is the document's `summary` plus its text before the first `#`/`##` heading. After the lead come its sections whole, in order, while they fit, followed by the `(truncated — brain read <path>)` pointer. A lead that does not fit on its own is still cut at a block boundary. `/brain-init` asks for a short facts card (roles, location, languages, how to reach you; each optional) and for current priorities and dated items. It seeds them as the leads of `me/identity.md` and the current-focus document. The shipped `CONTRACT.md` states the convention, so agents keep the leads current.
