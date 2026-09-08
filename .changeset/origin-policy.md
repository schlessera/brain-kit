---
"@schlessera/brain-ui-server": minor
---

One origin policy guards every non-GET request under `/api/*` and the WebSocket upgrade in every auth mode: accepted on `Sec-Fetch-Site: same-origin`/`none`, on a matching `Origin` (host and port; scheme too from `X-Forwarded-Proto` under `TRUST_PROXY`), or when both headers are absent; `Origin: null` is refused; `ALLOWED_ORIGINS` is consulted after both, and `WEBAUTHN_ORIGINS` only for the passkey ceremony routes. JSON routes require `Content-Type: application/json` (415 otherwise), which closes the `text/plain` form CSRF on JSON POSTs in tailscale, proxy and none modes. `isAllowedWsOrigin` is gone; the upgrade uses the same policy.
