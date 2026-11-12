---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Pi's host web executor now reaches the network only through a mandatory egress route. It runs under bubblewrap in its own network namespace, so a direct socket, a spawned `curl` or a `NO_PROXY` setting reaches nothing. Its one route is a host egress proxy opened for each conversation, which resolves every destination itself and checks every redirect hop. The proxy refuses loopback, private, link-local, shared, multicast and reserved addresses unless the host's `ssrf.allowRanges` in `web-search.json` names them. Cloud metadata addresses are always refused, ports other than 80 and 443 are refused, and each conversation's executor may move at most 64 MiB. A guard inside the executor stops provider keys from following a redirect to another origin. Refused connections are logged. A host without bubblewrap now has no web executor, so the web tools are refused. The egress proxy gains an optional destination policy (`EgressDestinationPolicy`) and the `egressBootstrapEntry` helper, both internal.
