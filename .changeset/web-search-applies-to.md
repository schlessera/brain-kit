---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
---

fix: the web-search card says which models its providers reach

The card is shown whenever the pi backend is configured, but a deployment
running both backends puts Claude models in the same picker — and those use the
Agent SDK's Anthropic-hosted `WebSearch`, which takes no provider setting and
ignores `web-search.json` entirely. The toggles looked global and silently were
not.

`GET /api/web-search` now returns `appliesTo`, the labels of the pi profiles,
and the card renders "Applies to <models>. Claude models search through
Anthropic instead, which has no provider setting."
