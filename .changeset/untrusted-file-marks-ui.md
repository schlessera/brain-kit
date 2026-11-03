---
"@schlessera/brain-ui-react": minor
---
Files can mark a file untrusted (#2673). The viewer toolbar gains `Mark untrusted` between Copy path and Share. The owner sees a pressed `Untrusted: clear mark` control, and every reader sees a purple `untrusted` cue on the file and its tree row. A `Marked untrusted` list replaces the disabled `Untrusted only` filter: the owner's list shows retained marks on moved or deleted files, and readers see only present files they can open, with no marker identity. Every change waits for the host's reply. Races, refusals and uncertain replies use the approved copy, and focus follows the approved table.
