---
"@schlessera/brain-common": patch
"@schlessera/brain-ui-sdk": patch
---

The inference relay and the provider relay now strip one shared list of request headers a worker may not choose (credentials, routing and hop-by-hop) and one shared list of response headers, instead of each declaring its own copy; the provider relay adds its three routing headers on top. No header name is added or removed. `@schlessera/brain-common/internal/provider-relay` exports `CREDENTIAL_HEADERS`, the six credential header names the relayed CLI client already removed; internal entries carry no compatibility promise.
