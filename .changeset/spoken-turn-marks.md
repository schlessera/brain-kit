---
"@schlessera/brain-ui-react": minor
---

Spoken turns in the chat now use the voice kit's marks (#3700). Recognized speech is your spoken turn, with the amber mic. A voice reply is brain's, with the teal speaker. A dictated or reviewed voice message also carries the mic inline, in place of the header badge. Typed and legacy turns stay plain.

- While live recognition is still updating, your turn shows the outlined bubble and cursor. Restored text never does.
- A fragment is dotted as uncertain only when the service reported a calibrated confidence below the client's 0.9 review threshold. That evidence is retained, so a reloaded chat shows the same marks.
- No reply text is dimmed as unplayed, because the client does not know which words the played audio carried.
- When a live conversation ends, the chat shows the end divider with its locally observed duration, in place of "Voice ended".
- The "Recognized speech" and "Voice reply" headers and the "Original discussion position unknown" line are gone. That evidence stays in the transcript details.
