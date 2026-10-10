---
"@schlessera/brain-ui-react": patch
---

Enter runs a slash command instead of sending it. Typing `/stats` and pressing Enter shows the statistics, as clicking its row in the command palette does; nothing goes to the agent. While the palette is open, Enter runs its highlighted row, the first by default, and the up and down arrows move the highlight, which is marked with `aria-current` and announced. A command typed in full still runs after Escape closes the palette, and a draft that starts with `/` but names no command, such as `/etc/hosts?`, is sent as before.
