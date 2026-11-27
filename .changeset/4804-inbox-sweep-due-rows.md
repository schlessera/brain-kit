---
"@schlessera/brain-ui-server": patch
---

The one-minute inbox lifecycle sweep reads only the items that can need work instead of loading and parsing every inbox item three times inside the write transaction (#4804). One indexed query picks expired or snoozed Actions, work past its retention or schedule, failed work out of attempts, and finished work in a thread whose staging cleanup is not queued yet; each is re-read just before it is acted on, in the same order as before. Staging cleanup is enqueued once per thread instead of once per finished item on every tick, and the Actions cap reads only open decisions. Every transition, notice, suppression, dead letter and cleanup item the sweep produces is unchanged.
