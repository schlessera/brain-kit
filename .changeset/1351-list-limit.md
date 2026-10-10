---
"@schlessera/brain": minor
---

**Breaking (#1351):** `brain list --limit` and `brain_list`'s `limit` now share one rule: a whole number from 1 to 100, defaulting to 20. A value outside it is refused, never clamped or partially read.

- **CLI, before:** `--limit` went through `parseInt`, so `10abc` listed 10, `1.5` listed 1, `abc` passed `NaN` to the query, and any value above 100 was honoured. **After:** the whole argument must be an integer literal in 1–100. `abc`, `10abc`, `1.5`, `0`, `-1`, `101` and a `--limit` with no value are usage errors (exit 1, message on stderr, nothing on stdout) in human and JSON modes, and no query runs. Omitting `--limit` still lists 20.
- **MCP, before:** `limit` was a plain `number` that the server clamped into 1–100, so `0` listed 1 and `500` listed 100. **After:** the input schema is `{ "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }`, and a fraction, `0`, a negative or a value over 100 is rejected as invalid input (a tool result with `isError: true`, as for any schema violation).

Successful results keep their shapes. A caller that asked for more than 100 now gets an error instead of the larger list; pass at most 100 and narrow with filters.
