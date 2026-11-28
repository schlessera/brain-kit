---
"@schlessera/brain-ui-react": patch
---

The recordings tray and the associate-recordings dialog no longer import each other (#4819). Their two label helpers live in a leaf module both import; nothing either renders changes.
