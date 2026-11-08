---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Choose the dictation service in Settings › Voice (#3709). The new Voice pane, between Models and Accounts, lists every dictation service the host registered and saves the brain-wide choice the moment one is picked, with **Clean up as I speak** (on by default) for services that support it. It shows a single service without a choice, says when dictation isn't set up, marks a saved service the host no longer has as unavailable, reverts a failed save with **Try again**, reloads a choice changed on another device, and is read-only for non-owners. Opening or saving Settings never opens the microphone, requests a session or calls a provider.

The mic is named for the service the next take goes to ("Dictate · Deepgram"). The first take to a service on a device shows where its audio goes, with **Cancel** and **Start dictation**, before any session request or microphone access; the acknowledgement is stored on the device. A take is bound to the service it disclosed: a default saved meanwhile applies to the next take, and a session for any other service is refused. With nowhere to send audio, the sheet says so and offers **Open Settings**, without falling back to another service. The listening sheet reads "To <service>".

Saved recordings are confirmed for the effective service when it can transcribe them; otherwise the tray offers an unsaved choice among the services that can. The upload names the confirmed service. `RecordingStore.transcribe` accepts that provider id as an optional fifth argument; a retry refused for naming another service keeps the recording and says why. The kit `Composer` adds `micTip` to show the mic's name as its pointer tooltip, and `micUnavailable`, which draws the mic disabled (`aria-disabled`) with the reason as its description and tooltip; the composer uses it when the host registers no dictation service.
