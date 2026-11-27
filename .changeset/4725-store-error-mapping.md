---
"@schlessera/brain-ui-react": patch
---

The file and graph stores, the What's up briefing and the three `/api/vpn-check` readers now share the API client's one failure mapping (#4725): a failed request is an `ApiRequestError` with its HTTP status and parsed body, and its message is the host's `error`, then `reason`, then `code`, then `HTTP <status>`. Three visible texts change: a file or graph failure whose body has `reason` or `code` and no `error` reads as that text instead of `HTTP <status>`; a graph failure whose body is not JSON reads as the status text; and the What's up modal's fallback is `HTTP <status>` without the status text. Routes, request headers and the public `BrainApi` type are unchanged.
