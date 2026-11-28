---
"@schlessera/brain-ui-react": patch
---

The voice Start card and the live conversation field select only the conversation fields they draw (#4893). A recognition fragment, unassigned speech or a dialogue page no longer re-renders the Start card or the field; what either draws is unchanged.
