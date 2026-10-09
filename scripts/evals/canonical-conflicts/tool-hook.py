"""Read-only Phase 2 fixture tools. Untrusted document text is not authority."""
import json, os, pathlib, shlex, sys

def contained(path, root):
    try:
        pathlib.Path(path).resolve().relative_to(pathlib.Path(root).resolve())
        return True
    except (ValueError, OSError):
        return False

def verdict(event, root):
    if event.get('hook_event_name') != 'PreToolUse':
        return True
    name = event.get('tool_name'); data = event.get('tool_input') or {}
    if name in ['Read', 'Glob', 'Grep']:
        path = data.get('file_path') or data.get('path') or root
        pattern = data.get('pattern') if name == 'Glob' else None
        return contained(path, root) and not (pattern and (pathlib.Path(pattern).is_absolute() or '..' in pathlib.Path(pattern).parts))
    if name == 'Bash':
        command = data.get('command') or ''
        if '$' in command or '`' in command:
            return False
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|<>\n'); lexer.whitespace_split = True; lexer.whitespace = ' \t\r'
            words = list(lexer)
        except ValueError:
            return False
        if any(w and all(c in ';&|<>\n' for c in w) for w in words):
            return False
        if len(words) < 2 or words[0] != 'brain':
            return False
        if words[1] == 'config':
            return words[2:] in [['check'], ['check', '--json']]
        return words[1] in ['search', 'schema', 'types', 'list', 'read'] and not any(w in ['--smart', '--fix'] for w in words)
    return name in ['Skill', 'TodoWrite']

if __name__ == '__main__':
    if verdict(json.load(sys.stdin), os.environ['BRAIN_ROOT']):
        print('{}')
    else:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Report-only Phase 2 permits contained reads and the bounded read-only brain CLI, with no content, log or replacement write.'}}))
