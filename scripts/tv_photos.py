#!/usr/bin/env python3
"""Your photos for the TV's screensaver: from photos_dir (tv.properties) into out/photos, ready to pack in the app.

    python3 scripts/tv_photos.py    # run by make build

Each photo (JPEG, HEIC, PNG...) is turned upright by its EXIF orientation, shrunk to fit inside 1920x1080 (never
enlarged) and written as a JPEG with no metadata copied: no orientation tag for a newer TV browser to apply twice, and no GPS
or camera details inside the app. Uses Apple's ImageIO (scripts/tv_photo.swift, compiled once); results are cached by each file's size and time, so only new or
changed photos are converted. The originals are never touched. At most MAX photos (by name), MAX_MB in all.

Each folder inside photos_dir is a pet, named by the folder (~/Pictures/TV/Maya): its photos join the screensaver with
its name, and scripts/tv_pet.swift cuts a square around its face (Apple's Vision) for the round photo by the greeting.
out/photos/pets.json lists them.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvconfig  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'photos')
CACHE = os.path.join(ROOT, 'out', 'photos-cache')
EXTENSIONS = ('.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.webp')
MAX, MAX_MB = 80, 20   # 20 MB keeps the package inside the Worker repository's 25 MB


def tool(name='tv_photo'):
    """scripts/<name>.swift compiled into out/bin (again when the source changes)."""
    src = os.path.join(ROOT, 'scripts', name + '.swift')
    digest = hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12]
    binary = os.path.join(ROOT, 'out', 'bin', name + '-' + digest)
    if not os.path.exists(binary):
        os.makedirs(os.path.dirname(binary), exist_ok=True)
        r = subprocess.run(['swiftc', '-O', src, '-o', binary], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError('swiftc: ' + (r.stderr or r.stdout).strip()[-300:])
    return binary


def convert(src, dest, name='tv_photo'):
    r = subprocess.run([tool(name), src, dest], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(dest):
        raise RuntimeError((r.stderr or r.stdout).strip()[-200:] or 'exit %d' % r.returncode)


def main():
    folder = tvconfig.settings().get('photos_dir', '').strip()
    shutil.rmtree(OUT, ignore_errors=True)
    if not folder:
        return
    folder = os.path.expanduser(folder)
    if not os.path.isdir(folder):
        print('photos: %s not found, no photos packed' % folder)
        return
    if not shutil.which('swiftc'):
        print('photos: needs macOS with the Xcode command line tools (swiftc), no photos packed')
        return
    names = sorted(n for n in os.listdir(folder) if n.lower().endswith(EXTENSIONS) and not n.startswith('.'))
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    total, packed, failed = 0, 0, []
    for name in names:
        if packed >= MAX:
            print('photos: only the first %d are packed (of %d)' % (MAX, len(names)))
            break
        src = os.path.join(folder, name)
        st = os.stat(src)
        key = hashlib.sha256(('%s|%d|%d' % (name, st.st_size, int(st.st_mtime))).encode()).hexdigest()[:20]
        cached = os.path.join(CACHE, key + '.jpg')
        if not os.path.exists(cached):
            try:
                convert(src, cached)
            except RuntimeError as e:
                failed.append('%s (%s)' % (name, e))
                continue
        size = os.path.getsize(cached)
        if total + size > MAX_MB * 1024 * 1024:
            print('photos: stopped at %d MB (%d packed)' % (MAX_MB, packed))
            break
        packed += 1
        total += size
        shutil.copyfile(cached, os.path.join(OUT, '%03d.jpg' % packed))
    pets, count = [], 0
    for pet in sorted(n for n in os.listdir(folder) if os.path.isdir(os.path.join(folder, n)) and not n.startswith('.')):
        sub = os.path.join(folder, pet)
        entry = {'name': pet, 'photos': [], 'faces': []}
        for name in sorted(n for n in os.listdir(sub) if n.lower().endswith(EXTENSIONS) and not n.startswith('.')):
            if packed + count >= MAX:
                break
            src = os.path.join(sub, name)
            st = os.stat(src)
            key = hashlib.sha256(('%s/%s|%d|%d' % (pet, name, st.st_size, int(st.st_mtime))).encode()).hexdigest()[:20]
            cached, face = os.path.join(CACHE, key + '.jpg'), os.path.join(CACHE, key + '-face.jpg')
            try:
                if not os.path.exists(cached):
                    convert(src, cached)
                if not os.path.exists(face):
                    convert(cached, face, 'tv_pet')
            except RuntimeError as e:
                failed.append('%s/%s (%s)' % (pet, name, e))
                continue
            size = os.path.getsize(cached) + os.path.getsize(face)
            if total + size > MAX_MB * 1024 * 1024:
                break
            total += size
            count += 1
            os.makedirs(os.path.join(OUT, 'pets'), exist_ok=True)
            for path, suffix in ((cached, ''), (face, '-face')):
                shutil.copyfile(path, os.path.join(OUT, 'pets', '%03d%s.jpg' % (count, suffix)))
            entry['photos'].append('photos/pets/%03d.jpg' % count)
            entry['faces'].append('photos/pets/%03d-face.jpg' % count)
        if entry['photos']:
            pets.append(entry)
    if pets:
        with open(os.path.join(OUT, 'pets.json'), 'w', encoding='utf-8') as f:
            json.dump(pets, f, ensure_ascii=False)
    for f in failed:
        print('photos: skipped', f)
    print('photos: %d packed from %s (%.1f MB)%s' % (packed, folder, total / 1048576,
          ''.join(', %s %d' % (p['name'], len(p['photos'])) for p in pets)))


if __name__ == '__main__':
    main()
