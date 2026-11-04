#!/usr/bin/env python3
"""Put an earlier release back on the TV: builds that tag in a throwaway checkout, with today's secrets.

    python3 scripts/rollback.py                    # the releases, newest first
    python3 scripts/rollback.py <tag> <ip>         # build that tag and install it
    python3 scripts/rollback.py <tag> --build-only # build it, stop before the TV

It reuses the tag's version, so About this TV reads as it did. The Worker and the Homebrew Channel repository stay as they
are: a Channel that lists a newer version will offer it again.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Not in git, and the build needs them: the secrets, and the app list webos/apps.py wrote for this TV.
LOCAL = ('config.properties', 'webos-apps.local.json', 'webos-icons.local')


def git(*args):
    return subprocess.run(['git'] + list(args), cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def releases():
    return git('tag', '-l', 'tv-*', '--sort=-creatordate', '--format=%(refname:short)  %(creatordate:short)  %(subject)')


def field(notes, name):
    found = re.search(r'^%s: *(\S+)' % name, notes, re.M)
    return found.group(1) if found else ''


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    build_only = '--build-only' in sys.argv
    if not args:
        print(releases() or 'No releases yet.')
        return
    tag = args[0]
    if not re.match(r'^tv-[0-9-]+$', tag) or tag not in git('tag', '-l', 'tv-*').split():
        sys.exit('No release called %s. These are:\n%s' % (tag, releases()))
    if not build_only and len(args) < 2:
        sys.exit('Usage: rollback.py <tag> <ip>, or <tag> --build-only.')
    notes = git('tag', '-l', tag, '--format=%(contents)')
    version, wanted = field(notes, 'version'), field(notes, 'config-sha256')

    tree = os.path.join(ROOT, 'out', 'rollback', tag)
    git('worktree', 'prune')
    git('worktree', 'add', '--detach', '--force', tree, tag)
    try:
        for name in LOCAL:
            source = os.path.join(ROOT, name)
            if os.path.isdir(source):
                shutil.copytree(source, os.path.join(tree, name))
            elif os.path.exists(source):
                shutil.copy2(source, os.path.join(tree, name))
        make = ['make', '-C', tree, 'BUILD_TAG=' + tag, 'FREEMYTV_VERSION=' + version]
        # The settings' hash leaves the secrets out, so it only differs when the build wouldn't be the tag's.
        now = subprocess.run(['python3', 'scripts/tvconfig.py', 'hash'], cwd=tree, capture_output=True, text=True).stdout.strip()
        if wanted and now != wanted:
            sys.exit("%s's settings hash to %s, the tag says %s: stopping." % (tag, now[:12], wanted[:12]))
        if build_only:
            subprocess.run(make + ['build'], check=True)
            shutil.copy2(os.path.join(tree, 'FreeMyTV-webos.ipk'), os.path.join(ROOT, 'out', 'rollback', tag + '.ipk'))
            print('Built %s (version %s): out/rollback/%s.ipk. The TV was not touched.' % (tag, version or 'as tagged', tag))
        else:
            subprocess.run(make + ['install', 'TV=' + args[1]], check=True)
            print('%s (version %s) is on the TV.' % (tag, version or 'as tagged'))
    finally:
        git('worktree', 'remove', '--force', tree)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit('Stopped: %s failed.%s' % (' '.join(e.cmd[:3]), ' ' + e.stderr.strip() if e.stderr else ''))
