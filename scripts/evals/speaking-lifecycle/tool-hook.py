"""Fixture boundary only; permitted tools return {} and retain native auto policy."""
import json, os, pathlib, shlex, sys

def contained(path, root):
    try:
        value = pathlib.Path(path)
        if not value.is_absolute(): value = pathlib.Path(root) / value
        value.resolve().relative_to(pathlib.Path(root).resolve())
        value = pathlib.Path(os.path.abspath(value))
        current = pathlib.Path(root).resolve()
        for part in value.relative_to(current).parts:
            current = current / part
            if current.is_symlink(): return False
        return True
    except (ValueError, OSError): return False

def verdict(event, root):
    if event.get('hook_event_name') != 'PreToolUse': return True
    name = event.get('tool_name'); data = event.get('tool_input') or {}
    allowed = set(json.loads(os.environ.get('BRAIN_SPEAKING_ALLOWED_WRITES', '[]')))
    if name in ['Read', 'Glob', 'Grep']:
        path = data.get('file_path') or data.get('path') or root
        pattern = data.get('pattern') if name == 'Glob' else None
        return contained(path, root) and not (pattern and (pathlib.Path(pattern).is_absolute() or '..' in pathlib.Path(pattern).parts))
    if name in ['Write', 'Edit']:
        path = data.get('file_path')
        if not isinstance(path, str) or not contained(path, root): return False
        return str(pathlib.Path(path).resolve().relative_to(pathlib.Path(root).resolve())) in allowed
    if name == 'Bash':
        command = data.get('command') or ''
        if '$' in command or '`' in command: return False
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|<>\n'); lexer.whitespace_split = True; lexer.whitespace = ' \t\r'
            words = list(lexer)
        except ValueError: return False
        if any(w and all(c in ';&|<>\n' for c in w) for w in words): return False
        if len(words) < 2 or words[0] != 'brain': return False
        if words[1] == 'config': return words[2:] in [['check'], ['check', '--json']]
        if any(word == '--root' or word.startswith('--root=') or word == '--config' or word.startswith('--config=') or word == '--output' or word.startswith('--output=') for word in words): return False
        if words[1] == 'read': return len(words) in [3,4] and contained(words[2], root) and (len(words)==3 or words[3]=='--json')
        if words[1] == 'archive': return len(words) in [3,4] and words[2] in allowed and contained(words[2], root) and (len(words)==3 or words[3]=='--json')
        return words[1] in ['search', 'schema', 'types', 'list', 'read'] and not any(w in ['--smart','--fix'] for w in words)
    if name == 'Skill': return data.get('skill') in ['submission-outcome','conference-aftermath']
    return name == 'TodoWrite'

if __name__ == '__main__':
    if verdict(json.load(sys.stdin), os.environ['BRAIN_ROOT']): print('{}')
    else: print(json.dumps({'hookSpecificOutput': {'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':'Only contained source reads and explicitly owned speaking task writes are allowed; native permission mode is unchanged.'}}))
