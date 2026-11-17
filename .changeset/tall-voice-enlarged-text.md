---
"@schlessera/brain-ui-kit": patch
---

The tall `VoiceField` holds its body under enlarged text (#3773). It is still 136px at 1× text; when doubled text and a body need more room, it grows to fit, upward, with its controls pinned to its bottom edge, so no control paints below the field. The tall label wraps instead of ellipsising its meta. Live draft words (`VoiceText` with `text` or `partial`) keep their newest two whole lines at any text size, and a message (`VoiceText` with `children` alone: the refusal line, a notice) is never clamped in the tall field. To keep a rich draft clamped, pass its plain words as `text` alongside `children`.
