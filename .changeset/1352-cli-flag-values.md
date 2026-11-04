---
"@schlessera/brain": minor
---

**Breaking (#1352):** core CLI commands now read flag values through one typed accessor, so a malformed value is a usage error (exit 1, message on stderr, nothing on stdout) in human and JSON modes, refused before any query runs. Valid values keep their meaning, a repeated flag still keeps its last value, and no new upper bound is introduced.

- **`brain search --limit`**, before: read with `parseInt`, so `10abc` searched with 10, `1.5` with 1, `abc` came back empty with an `FTS search failed: datatype mismatch` warning, and `0` or `-5` was passed on to the query. **After:** a whole number of 1 or more; `abc`, `0`, `-5`, `1.5`, `10abc` and an empty value are refused.
- **`brain search --mode`**, before: an unknown mode ran neither lane and returned nothing without a warning. **After:** `fts`, `vector` or `hybrid`; anything else, including an empty value, is refused (`--mode must be one of fts, vector, hybrid, got "bogus"`).
- **`brain context --max-tokens`** and **`brain briefing --limit`**, before: `parseInt`, so `abc` reached the assembler as `NaN` and briefing silently fell back to 15. **After:** a whole number of 1 or more; `abc`, `0`, `1.5`, `10abc` and an empty value are refused.
- **A value flag with no value** (`brain search q --type`, `brain list --tag --status active`, `brain add "…" --tags`), before: flowed on as `true`, or for `add --tags` failed with exit 2. **After:** `--<flag> needs a value`.

`brain search --sort` and the date filters keep their existing usage errors.
