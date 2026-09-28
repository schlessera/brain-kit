---
"@schlessera/brain-ui-sdk": minor
---

- **ui-sdk**: `showBlockInputSchema(form)` builds `show_block`'s input schema in a measured form, and `SHIPPED_SHOW_BLOCK_SCHEMA_FORM` names the one that ships (#336). A form can share `tone`, `valueTone` and `icon` through `definitions`, drop the field descriptions that restate the tool description, or both. Every form accepts exactly the input `SHOW_BLOCK_INPUT_SCHEMA` accepts, and the shipped schema is unchanged byte for byte.
