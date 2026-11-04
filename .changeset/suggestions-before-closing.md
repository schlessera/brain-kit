---
"@schlessera/brain-ui-sdk": patch
---
`show_block` now asks the model to call `suggestions` before the answer's final sentence instead of last. An answer that ended on that call returned no text. The Claude CLI then nudged for visible output, and the model wrote the whole answer a second time, so the chat showed it twice. The suggestions row still appears under the finished answer.
