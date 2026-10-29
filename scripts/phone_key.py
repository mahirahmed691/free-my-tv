#!/usr/bin/env python3
"""The phones' keys for the TV's note (the iPhone Shortcuts), each separate from the Mac's so it can be revoked alone.

    python3 scripts/phone_key.py new [NAME] [--dry-run]      # make new-phone-key [NAME=Mariam]: a fresh key, Shortcuts built
    python3 scripts/phone_key.py revoke [NAME] [--dry-run]   # make revoke-phone [NAME=Mariam]: that phone's key stops working

The Worker's ADMIN_TOKEN is the list of keys that may write the note, each "Name=key" so the note says who wrote it:
the Mac's worker_admin_token and the first phone's worker_phone_token (note_name in tv.properties: you), and each
other person's worker_phone_token_<name> (config.properties). No key is ever printed.
"""
import os
import re
import secrets
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvconfig  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, 'config.properties')
SHORTCUTS = os.path.join(ROOT, 'out', 'shortcuts')


def read_key(text, name):
    m = re.search(r'(?m)^%s=(.+)$' % name, text)
    return m.group(1).strip() if m else ''


def admin_list(text, owner):
    """[(label, "Name=key")] from config.properties: the Mac, the first phone, and every named phone."""
    out = []
    for key, value in re.findall(r'(?m)^(worker_admin_token|worker_phone_token(?:_\w+)?)=(.+)$', text):
        who = owner if key in ('worker_admin_token', 'worker_phone_token') else key.split('_', 3)[3].capitalize()
        label = 'the Mac' if key == 'worker_admin_token' else who + "'s phone"
        out.append((label, '%s=%s' % (who, value.strip()) if who else value.strip()))
    return out


def set_admin_tokens(entries, dry):
    """ADMIN_TOKEN on the Worker, through wrangler's stdin (never an argument or the screen)."""
    tokens = [e for _, e in entries]
    print('Worker ADMIN_TOKEN → %d key(s): %s' % (len(tokens), ', '.join(label for label, _ in entries)))
    if dry:
        return
    env = dict(os.environ, WRANGLER_SEND_METRICS='false')
    result = subprocess.run(['npx', '--yes', 'wrangler@4.150.0', 'secret', 'put', 'ADMIN_TOKEN'], cwd=os.path.join(ROOT, 'worker'),
                            input=','.join(tokens), capture_output=True, text=True, env=env)
    if result.returncode != 0 or 'Success' not in result.stdout + result.stderr:
        sys.exit('wrangler failed (needs Node 22 and the Cloudflare login): %s' % (result.stderr or result.stdout).strip()[-300:])


def write_config(text, dry):
    if dry:
        return
    fd = os.open(CONFIG, os.O_WRONLY | os.O_TRUNC)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    args = sys.argv[1:]
    dry = '--dry-run' in args
    words = [a for a in args if not a.startswith('--')]
    command, who = (words + ['', ''])[:2]
    if command not in ('revoke', 'new') or (who and not re.match(r'^[A-Za-z]{1,20}$', who)):
        sys.exit(__doc__)
    with open(CONFIG, encoding='utf-8') as f:
        text = f.read()
    if not read_key(text, 'worker_admin_token'):
        sys.exit('No worker_admin_token in config.properties: the Mac\'s key is needed either way.')
    owner = tvconfig.settings().get('note_name', '').strip()
    key = 'worker_phone_token' + ('_' + who.lower() if who else '')
    shortcuts = os.path.join(SHORTCUTS, who.capitalize()) if who else SHORTCUTS
    text = re.sub(r'(?m)^%s=.*\n?' % key, '', text)
    if dry:
        print('(dry run: nothing changes)')

    if command == 'revoke':
        set_admin_tokens(admin_list(text, owner), dry)
        write_config(text, dry)
        print('config.properties: %s removed' % key)
        if os.path.isdir(shortcuts):
            print('%s: deleted' % os.path.relpath(shortcuts, ROOT))
            if not dry:
                shutil.rmtree(shortcuts)
        print(('Would be done: that phone\'s Shortcuts would' if dry else 'Done: that phone\'s Shortcuts now')
              + ' get {"error":"admin token"}; the others still work.')
        return

    text = text.rstrip('\n') + '\n%s=%s\n' % (key, secrets.token_urlsafe(32))
    set_admin_tokens(admin_list(text, owner), dry)
    write_config(text, dry)
    print('config.properties: new %s' % key)
    if dry:
        print('Would build the Shortcuts (scripts/make_shortcuts.py).')
        return
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'make_shortcuts.py')] + ([who.capitalize()] if who else []), check=True)


if __name__ == '__main__':
    main()
