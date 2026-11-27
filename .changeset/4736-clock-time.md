---
"@schlessera/brain-ui-react": patch
---

Every clock time is 24-hour `HH:MM` in the reader's time zone, built from one helper (#4736). For a reader on a 12-hour locale three surfaces change: message stamps (`9:41 PM` → `21:41`), the voice-permission receipt (`heard "brain, stop" · 9:41 PM` → `· 21:41`) and the location card's stamp. The draft indicator, the compare dialog, answer delivery, trackers and the recordings tray already printed this form and are unchanged.
