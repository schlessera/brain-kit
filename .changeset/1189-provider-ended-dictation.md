---
"@schlessera/brain-ui-react": patch
---

Keep what was dictated when the speech provider ends a dictation on its own. When the Deepgram socket closed (end of stream, an idle timeout, a dropped connection or an expired grant) or the browser's speech recognition ended without a stop, the dictation sheet closed and the words heard so far were lost. They now go to the review card as Done hands them, in the same update that ends the dictation, so a pending app update still waits for them. A dictation whose composer unmounts mid-capture keeps its words the same way, and a replaced recognizer ending late no longer ends the dictation that replaced it.
