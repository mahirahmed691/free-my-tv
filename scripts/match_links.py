#!/usr/bin/env python3
"""Film match's links, one per person, each with a fresh key that can only vote.

    python3 scripts/match_links.py Mahir Mariam [--dry-run]    # make match-links [NAMES="Mahir Mariam"]

Every run replaces all the keys, so an old link stops working. The keys go to the Worker's MATCH_KEYS and to
config.properties (worker_match_token_<name>), and each link to out/match-links/<Name>.txt, to send to that phone.
The key is never printed.
"""
import os
import re
import secrets
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone_key  # noqa: E402
import publish_repo  # noqa: E402
import tvconfig  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINKS = os.path.join(ROOT, 'out', 'match-links')


def main():
    dry = '--dry-run' in sys.argv
    names = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(names) < 2 or len(set(n.lower() for n in names)) < len(names) or not all(re.match(r'^[A-Za-z]{1,20}$', n) for n in names):
        sys.exit('Two names at least, letters only: ' + __doc__)
    url = tvconfig.settings().get('worker_url', '').strip().rstrip('/')
    if not url.startswith('https://'):
        sys.exit('No worker_url in tv.properties.')
    keys = {name: secrets.token_urlsafe(32) for name in names}
    print('Worker MATCH_KEYS → %d keys: %s' % (len(keys), ', '.join(names)))
    if dry:
        print('(dry run: nothing changes)')
        return
    env = dict(os.environ, WRANGLER_SEND_METRICS='false', PATH=publish_repo.node_path())
    result = subprocess.run(['npx', '--yes', 'wrangler@4.150.0', 'secret', 'put', 'MATCH_KEYS'], cwd=os.path.join(ROOT, 'worker'),
                            input=','.join('%s=%s' % kv for kv in keys.items()), capture_output=True, text=True, env=env)
    if result.returncode != 0 or 'Success' not in result.stdout + result.stderr:
        sys.exit('wrangler failed (needs the Cloudflare login): %s' % (result.stderr or result.stdout).strip()[-300:])
    with open(phone_key.CONFIG, encoding='utf-8') as f:
        text = re.sub(r'(?m)^worker_match_token_\w+=.*\n?', '', f.read())
    text = text.rstrip('\n') + '\n' + ''.join('worker_match_token_%s=%s\n' % (n.lower(), k) for n, k in keys.items())
    phone_key.write_config(text, False)
    os.makedirs(LINKS, mode=0o700, exist_ok=True)
    for name, key in keys.items():
        fd = os.open(os.path.join(LINKS, name + '.txt'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write('%s/match#%s\n' % (url, key))
    print('Done: the links are in out/match-links/. Send each to its phone; they work on the home Wi-Fi.')


if __name__ == '__main__':
    main()
