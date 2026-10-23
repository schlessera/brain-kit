---
"@schlessera/brain-ui-server": minor
---

Enforce provider `types` selectors and `folder/**/*` paths in hosted turns when they map exactly onto whole folders: the turn masks those folders and builds its private index without them. A type maps when its taxonomy folders are literal, hold no other type's folder, it is not the inbox type, and no Markdown document outside them declares it. Every other selector still refuses admission, now naming why.
