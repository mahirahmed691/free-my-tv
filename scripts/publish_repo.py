#!/usr/bin/env python3
"""Publishes the build to the Worker's private Homebrew Channel repository (make release runs it after the install).

    python3 scripts/publish_repo.py 1.2.2630205    # the version FREEMYTV_VERSION gave this build

Writes the repository (upstream's format, tools/homebrew_repo.py) with ipkUrl on the Worker, and puts it and
FreeMyTV-webos.ipk in the Worker's KV (webos:apps.json, webos:ipk). The Worker serves both only to ALLOWED_IPS: the
build holds the TMDB key, the TV's Worker token and your photos, so it never goes anywhere public.
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvconfig  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IPK = os.path.join(ROOT, 'FreeMyTV-webos.ipk')
ICON = 'https://freemytv.io/assets/icon-512.png'
KV_MAX = 25 * 1024 * 1024


def node_path():
    """PATH with a Node 22+ first: wrangler needs it, and the shell's own node may be an older nvm one."""
    path = os.environ.get('PATH', '')
    try:
        if int(subprocess.run(['node', '-v'], capture_output=True, text=True).stdout.strip().lstrip('v').split('.')[0]) >= 22:
            return path
    except (OSError, ValueError):
        pass
    found = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v2[2-9].*/bin')), key=lambda d: [int(x) for x in re.findall(r'\d+', d)])
    return found[-1] + os.pathsep + path if found else path


def kv_put(key, path):
    env = dict(os.environ, WRANGLER_SEND_METRICS='false', PATH=node_path())
    r = subprocess.run(['npx', '--yes', 'wrangler@4.150.0', 'kv', 'key', 'put', key, '--binding', 'CACHE', '--remote', '--path', path],
                       cwd=os.path.join(ROOT, 'worker'), capture_output=True, text=True, env=env)
    if r.returncode != 0:
        sys.exit('Couldn\'t upload %s: %s' % (key, (r.stderr or r.stdout).strip()[-300:]))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    version = sys.argv[1]
    url = tvconfig.settings().get('worker_url', '').rstrip('/')
    if not url:
        sys.exit('No worker_url in tv.properties.')
    data = open(IPK, 'rb').read()
    if len(data) > KV_MAX:
        sys.exit('FreeMyTV-webos.ipk is %d MB: the repository holds 25 MB at most (fewer photos).' % (len(data) // 1048576))
    app = json.load(open(os.path.join(ROOT, 'webos', 'appinfo.json'), encoding='utf-8'))
    description = 'A fast, ad-free home screen: your apps on a glass shelf, the weather and prices, day and night.'
    manifest = {'id': app['id'], 'version': version, 'type': 'web', 'title': app['title'], 'appDescription': description,
                'iconUri': ICON, 'sourceUrl': 'https://github.com/mahirahmed691/free-my-tv', 'rootRequired': False,
                'ipkUrl': url + '/webos/FreeMyTV.ipk', 'ipkHash': {'sha256': hashlib.sha256(data).hexdigest()}, 'ipkSize': len(data)}
    repo = {'paging': {'page': 1, 'count': 1, 'maxPage': 1, 'itemsTotal': 1, 'prevUrl': None, 'nextUrl': None},
            'packages': [{'id': app['id'], 'title': app['title'], 'iconUri': ICON, 'shortDescription': description, 'pool': 'main',
                          'fullDescriptionUrl': 'https://freemytv.io/webos/full_description.html', 'manifest': manifest}]}
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(repo, f, indent=2)
        listing = f.name
    try:
        kv_put('webos:ipk', IPK)            # the package first: the listing never points at one not there yet
        kv_put('webos:apps.json', listing)
    finally:
        os.unlink(listing)
    print('Published %s %s (%d KB) to %s/webos/apps.json (home only)' % (app['id'], version, len(data) // 1024, url))


if __name__ == '__main__':
    main()
