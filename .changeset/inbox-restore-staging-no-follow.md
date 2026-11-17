---
"@schlessera/brain-ui-server": patch
---
Restoring an inbox snapshot no longer follows links in the staging directory. The restore checked `.brain-ui/inbox` and each arrival directory once, then created directories, reaped leftover temporaries and published files by pathname, so a link swapped in after that check was followed. Those changes now go through directory descriptors opened without following links from the brain's canonical root, as intake already does. A staging or arrival directory that is, or becomes, a link refuses the restore with the existing `inbox_staging_symlink` code, and nothing is written to or removed from whatever the link names.
