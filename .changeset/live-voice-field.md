---
"@schlessera/brain-ui-react": minor
---

Live conversation now draws its state in the tall voice field from `@schlessera/brain-ui-kit` (#3699). The field's colour, meter, icon and one word say who has the floor (Connecting, Listening, Thinking, Working, Speaking, Needs your tap, Muted, Reconnecting), with the service and the connected time beside it, and Mute, Interrupt and End sit on its raised controls. Interrupt is enabled only while a reply plays. A failure that withdraws capture shows "Live conversation stopped" with the client's reason, and Start again reopens the disclosure. The two diagnostic status lines ("● Listening · mic on", "Connected · chat: ok"), the provider-code details button and the Mute mic, Stop reply and Leave voice buttons are gone. The conversation client exposes its capture intent (`capture`: `idle`, `listening`, `muted` or `stopped`) and display-only meter readings (`levels()`); neither changes capture, recovery or permission behaviour.
