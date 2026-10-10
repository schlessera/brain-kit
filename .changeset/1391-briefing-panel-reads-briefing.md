---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
---

The Daily briefing panel now shows the keyless `brain briefing` output from `GET /api/brain/briefing`, the selected root's existing briefing route, with loading, empty, failure and Retry states. The internal `POST /api/brain/whatsup` route is gone, and with it the repo-local script lookup at `private/whatsup.ts` and `scripts/whatsup.ts` and its forced `--gemini` flag: opening the briefing runs no script and no agent turn. Because the briefing cannot spend, the rail, palette, More sheet and welcome chip no longer print `spends` beside it.
