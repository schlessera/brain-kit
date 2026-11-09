---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

The cut-off tag and the live-conversation end divider now survive a reload (#3729). `DialogueEvidence` gains two additive kinds: `voice_interruption`, retained when the voice service reports that it stopped a reply (with the reply's `outputId` when the service names one), and `voice_end`, retained when you end a conversation, with its start and end time. ui-server writes both on its existing dialogue path. Neither enters the voice service's history.

The chat now draws both marks only from that retained evidence, so a live chat and the same chat reloaded look the same:

- A reply shows the "cut off" tag only when a retained interruption names it. A reply with no recorded interruption never shows it.
- The end divider shows the retained duration. Pausing, a lost connection or a voice service that closes does not end a conversation and draws no divider.

A client from an earlier release refuses a dialogue page that carries the new kinds. Update the client together with the host.
