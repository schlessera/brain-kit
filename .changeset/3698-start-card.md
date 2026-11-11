---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": patch
---

Live conversation opens on the Start card (#3698) instead of the pre-Start disclosure sheet.

- **Card.** The kit `StartCard` names the service Start would open, lists the full former disclosure behind "What's shared", and holds the Service row and the persona list. Change appears only when two or more services are usable, applies to this conversation only and is never saved; an unavailable saved service needs an explicit Choose. Picking a persona also saves it as the default.
- **Recovery.** A persona with no voice on the service names the default voice; a saved voice the service no longer offers blocks Start until "Use the default voice this time"; instructions over the service's byte cap block Start; an unusable persona file offers "Use Standard this time". The one-time choices go into the Start's `personaRef` and are not saved.
- **Client.** `choosePersona(ref | null)` records the persona this entry's Start sends, and `personaChoice` is in the client state. A refused first Start lets the card pick a service or persona again.
- **Kit.** The Service row's key and Change/Choose link no longer break mid-word at 320px.
