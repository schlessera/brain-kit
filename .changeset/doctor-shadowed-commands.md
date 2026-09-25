---
"@schlessera/brain": minor
---

`brain doctor` has a new `shadowed-commands` check. It warns when a `.claude/commands/<name>.md` file has the same name as a skill. Claude Code runs the skill in that case, so the command file is dead but still looks like the one in charge. The check names each file and suggests deleting or renaming it. It passes when there is no `.claude/commands` directory or nothing clashes. A command in a subdirectory is invoked as `/<dir>:<name>`, so a skill shadows it only when the skill has that full name.
