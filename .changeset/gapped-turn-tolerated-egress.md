---
"@schlessera/brain-ui-server": patch
---

A turn that began with a permanent safety recording gap no longer refuses its ordinary network traffic, or stops, when the writer tolerates a lost record (#4351). On such a turn the occurrence writer returns `{id:0, recorded:false}` by design, because the gap already shows the loss. An untrusted proxy connection now proceeds under the restricted recipient policy it already passed, without source trust, instead of refusing with 503 `egress_unavailable`. A lost terminal exposure no longer stops the turn. Source-trusted connections still need a durable occurrence and refuse with 503 without one, and every other lost write, including a lost connection audit or any loss on a turn without a permanent gap, keeps its existing containment.
