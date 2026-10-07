"""Fixture-only native CLI hook. Commands and paths are data, never shell code here."""
import json, os, pathlib, shlex, sys

def contained(path, root):
    try:
        pathlib.Path(path).resolve().relative_to(pathlib.Path(root).resolve())
        return True
    except (ValueError, OSError):
        return False

def verdict(event, root, source):
    if event.get('hook_event_name') != 'PreToolUse':
        return True
    name = event.get('tool_name'); data = event.get('tool_input') or {}
    if name in ['Read', 'Glob', 'Grep']:
        path = data.get('file_path') or data.get('path') or root
        pattern = data.get('pattern') if name == 'Glob' else None
        if pattern and (pathlib.Path(pattern).is_absolute() or '..' in pathlib.Path(pattern).parts):
            return False
        # Runtime source is mounted for the CLI, but tool reads must not expose
        # authored benchmark goldens or measurement code to the baseline.
        return contained(path, root)
    if name in ['Write', 'Edit']:
        path = data.get('file_path') or ''
        try:
            relative = pathlib.Path(path).resolve().relative_to(pathlib.Path(root).resolve())
        except (ValueError, OSError):
            return False
        return relative.suffix == '.md' and not any(p.startswith('.') for p in relative.parts) and relative.name not in ['AGENTS.md', 'CLAUDE.md']
    if name == 'Bash':
        try:
            lexer = shlex.shlex(data.get('command') or '', posix=True, punctuation_chars=';&|<>\n')
            lexer.whitespace_split = True
            lexer.whitespace = ' \t\r'
            words = list(lexer)
        except ValueError:
            return False
        if any(w and all(c in ';&|<>\n' for c in w) for w in words):
            return False
        # shlex cannot retain whether command substitutions were quoted. Refuse
        # their syntax conservatively even in quoted capture content.
        command = data.get('command') or ''
        if '$' in command or '`' in command:
            return False
        return len(words) >= 2 and words[0] == 'brain' and words[1] in ['add', 'search', 'index', 'schema', 'types', 'list', 'read', '--help']
    return name in ['Skill', 'TodoWrite']

if __name__ == '__main__':
    event = json.load(sys.stdin)
    if not verdict(event, os.environ['BRAIN_ROOT'], os.environ['BRAIN_SMART_SOURCE']):
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Measurement permits only contained fixture documents and the brain CLI; quoted capture content is not command authority.'}}))
    else:
        print('{}')
