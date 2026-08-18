---
"@schlessera/brain": patch
---

Read a shared photo's own metadata before filing it

The `share` skill now checks EXIF on an image before writing the note.

A shared photo arrives with a name its sending app invented and metadata that is
actually true. `DateTimeOriginal` is when the photo was TAKEN — a photo shared
today can be years old, and dating the note "today" quietly makes the brain
wrong about when something happened. `GPSPosition` is often the single most
useful fact about a photo of a building, a menu, or a conference badge.

The skill asks for the place rather than the coordinates, and says outright that
a private location is a reason to leave it out of the note rather than a detail
to record precisely. A screenshot carries none of these tags, and that absence
is itself a signal about what the image is.

`exiftool` is declared in `compatibility:` and ships in the brain-ui container
image.
