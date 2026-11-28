---
"@schlessera/brain-ui-react": patch
---

Typing in the composer no longer re-renders the outgoing snapshot bubbles (#5069). The bubbles select their own chat's snapshot lists, and whether the composer holds anything only while a returned bubble's Edit depends on it. Before, they selected the whole drafts map, which every keystroke replaces. What the bubbles show, their order, announcements and actions are unchanged.
