---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits the session catalog on its SQLite write worker at `synchronous=FULL`, in submission order, instead of on the event loop (#2850): the session row, accepted work and turn boundaries, message sources, turn failures, the state room, Claude usage accounting, handoff links, labels and session costs, and the worker-profile and policy-proposal binds a new session makes. Reads on the turn path see a write from its submission; the session list, history replays and retry reads wait for the writes submitted before them.
