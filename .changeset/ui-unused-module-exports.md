---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---
Removed: the `export` keyword from 478 module-level names that no other file imported and no entry point reaches. Names that were also unused in their own file were deleted. No entry point's exports changed.
