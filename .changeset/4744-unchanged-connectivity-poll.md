---
"@schlessera/brain-ui-react": patch
---

An unchanged connectivity poll no longer writes the connection store or notifies its subscribers, and the recording store rescans its partitions only when the account, the socket status or the probe result changed (#4744). Work the last transcription sync left behind (a status still being read, a tombstone whose `DELETE` failed) keeps the poll's 15-second pace in the recording store itself, with or without the recordings tray. Listing a partition now reads all acceptance receipts in one read instead of one read per recording.
