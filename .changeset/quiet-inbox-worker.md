---
"@schlessera/brain-ui-server": patch
---

Move hosted inbox lifecycle commits off the event loop at FULL durability. Correct the public declaration drift by marking `WsHost.inboxTools` and `WsHostOptions.inboxTools` internal under the #1053 narrowing ruling; these concrete inbox helpers are supplied by `createApp`.
