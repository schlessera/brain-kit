---
"@schlessera/brain-ui-server": patch
---

The trust settings and owner safety review routes share one exact-Origin check (#4759): an `Origin` header must be present, the expected scheme must be `http` or `https`, and the two origins must be equal. The expected origin takes its host from the `Host` header (the request URL's host only when the header is absent) and its scheme from the first trusted `X-Forwarded-Proto` value. The safety review route now reads the host from the `Host` header instead of the request URL, which under Bun name the same host. Two requests are now refused that one route accepted before: a trusted forwarded scheme other than `http` or `https` (such as `foo`) at the safety review route, and an Origin of `ws://…` with a trusted forwarded `ws` at the trust settings route. Both routes keep their refusal bodies.
