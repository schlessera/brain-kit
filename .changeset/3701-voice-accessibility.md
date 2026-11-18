---
"@schlessera/brain-ui-react": patch
---

Voice is announced and keeps keyboard focus in the assembled app (#3701).

- **Announcements.** The dictation and live field's state label is a polite live region. A blocked microphone (D7), a dictation that stops (D8) and a stopped live conversation (L9) are announced assertively, and so is what to tap when an approval is pending (L6). A change to the Start card's notice is announced politely, without moving focus.
- **Focus.** Ending a live conversation, by End, Close or Escape on the Start card, returns focus to the composer's mic instead of the text field. A live control that is disabled or removed while focused (Interrupt once the reply stops, Mute while voice gets ready, Send now after sending) passes focus to Mute, or to the first control still usable, instead of dropping it to the page.
