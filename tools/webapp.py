"""What the LG (webos/build.py) and Samsung (tizen/build.py) packages share: the settings and the web app's files.

The settings come from config.properties, the same file as the Android build. --generic leaves it out (the GitHub
release is built that way): no TMDB key, and the TV's time zone picks the city, the currency and the region.
"""
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import translate  # noqa: E402  (the catalogues and the keys the web app uses)

GENERIC = {'tmdbKey': '', 'tmdbRegion': '', 'latitude': '', 'longitude': '', 'city': '', 'language': 'auto',
           'currency': '', 'temperature': 'auto', 'theme': 'auto', 'showCrypto': True, 'hideAnimation': False, 'hideApps': [],
           'shelfApps': [], 'drawerFirst': False}


def config_from_args(args):
    """The settings for these command-line arguments (--generic, --config PATH or config.properties)."""
    if '--generic' in args:
        return dict(GENERIC)
    path = os.path.join(ROOT, 'config.properties')
    if '--config' in args:
        path = os.path.abspath(args[args.index('--config') + 1])
    return read_config(path)


def read_config(path):
    if not os.path.exists(path):
        shutil.copy(os.path.join(ROOT, 'config.example.properties'), path)
        print('Created config.properties: add your TMDB key and your city there (optional), then build again.')
    values = {}
    try:
        with open(path, encoding='utf-8-sig') as f:
            lines = f.readlines()
    except UnicodeDecodeError:   # Notepad's "Unicode" is UTF-16
        sys.exit('config.properties is saved as UTF-16 (Notepad\'s "Unicode"). Save it as UTF-8 and build again.')
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"')

    def number(key, default):
        v = values.get(key, '') or default
        if not re.match(r'^-?\d+(\.\d+)?$', v):
            sys.exit('config.properties: %s must be a number (got "%s")' % (key, v))
        return v

    return {
        'tmdbKey': values.get('tmdb_key', ''),
        'tmdbRegion': values.get('tmdb_region', 'US') or 'US',
        'latitude': number('latitude', '40.7128'),
        'longitude': number('longitude', '-74.0060'),
        'city': values.get('city', ''),
        'language': values.get('language', 'auto') or 'auto',
        'currency': values.get('currency', 'USD') or 'USD',
        'temperature': values.get('temperature', 'auto') or 'auto',
        'theme': values.get('theme', 'auto') or 'auto',
        # The home screen's font (Home Settings can change it on the TV): inter, manrope, outfit, jakarta, lexend or lora.
        'font': values.get('font', 'inter') or 'inter',
        'showCrypto': values.get('show_crypto', 'true').lower() != 'false',
        'hideAnimation': values.get('hide_animation', 'false').lower() == 'true',
        'hideApps': [s.strip() for s in values.get('hide_apps', '').split(',') if s.strip()],
        'shelfApps': [s.strip() for s in values.get('shelf_apps', '').split(',') if s.strip()],
        'drawerFirst': values.get('drawer_first', 'false').lower() == 'true',
        # The Worker (worker/): its address and the TV's read-only token; tides=true shows UKHO's on the weather card.
        'worker': {'url': values.get('worker_url', ''), 'token': values.get('worker_token', ''),
                   'tides': values.get('tides', 'false').lower() == 'true',
                   'dashboard': values.get('dashboard', 'false').lower() == 'true', 'workHours': values.get('work_hours', ''),
                   'trains': values.get('trains', 'false').lower() == 'true', 'notes': values.get('notes', 'false').lower() == 'true',
                   'football': values.get('football', 'false').lower() == 'true',
                   'calendar': values.get('calendar', 'false').lower() == 'true',
                   'mosque': values.get('mosque', 'false').lower() == 'true',
                   'shopping': values.get('shopping', 'false').lower() == 'true',
                   # The cats' mealtimes (a phone's "Fed the cats") and the Met Office's warnings for the region.
                   'fed': values.get('fed', 'false').lower() == 'true',
                   'warnings': values.get('weather_warnings', 'false').lower() == 'true'},
        # The morning briefing: the first time the home screen shows each morning, one card with the day.
        'briefing': values.get('briefing', 'false').lower() == 'true',
        # Shows you follow: "New episode today" from TMDB (comma separated names).
        'followShows': [x.strip() for x in values.get('follow_shows', '').split(',') if x.strip()],
        # Your own dates to count down to, "2026-12-25 Christmas, 2027-03-01 Holiday"; Eids, Ramadan and your
        # anniversary come by themselves.
        'countdowns': [{'date': x.strip()[:10], 'name': x.strip()[10:].strip()}
                       for x in values.get('countdowns', '').split(',') if re.match(r'^\s*\d{4}-\d\d-\d\d\s+\S', x)],
        # The adhan out loud at these prayers (fajr, dhuhr, asr, maghrib, isha), from adhan_file packed in the app.
        'adhan': {'prayers': [x.strip().lower() for x in values.get('adhan', '').split(',') if x.strip()],
                  'volume': int(values.get('adhan_volume', '60') or 60),
                  'path': adhan_file(values),
                  'src': 'adhan' + os.path.splitext(values.get('adhan_file', ''))[1].lower() if adhan_file(values) else ''},
        # "Good evening, <greeting>" in place of "For You" (empty: "For You").
        'greeting': values.get('greeting', ''),
        # Prayer times and the Hijri date (web/islam.js): the method, Asr's shadow and a day's shift for a moon sighting.
        'islam': {'prayer': values.get('prayer', 'false').lower() == 'true', 'method': values.get('prayer_method', 'MWL') or 'MWL',
                  'asr': values.get('asr', 'standard') or 'standard', 'hijriAdjust': int(values.get('hijri_adjust', '0') or 0),
                  # Your wedding day (YYYY-MM-DD; config.properties keeps it out of git): the Married chip and anniversaries.
                  'married': values.get('married', ''),
                  # Maghrib's warm light: the Tapo lights that are on turn warm and soft at Maghrib (the TV has to be on).
                  'prayerLights': values.get('prayer_lights', 'false').lower() == 'true',
                  # At each adhan: a banner (the TV's toast over other apps) and the lights that are on dip.
                  'prayerAlert': values.get('prayer_alert', 'false').lower() == 'true',
                  # Minutes to the mosque: "Leave by" on the Jumu'ah chip, and a reminder when it's time (0: neither).
                  'travel': int(values.get('mosque_travel', '0') or 0)},
        # Your Tapo lights (scripts/tapo.py writes both to config.properties): the login's hash and "Name@IP" each.
        'tapo': {'auth': values.get('tapo_auth', ''),
                 'lights': [{'name': x.rpartition('@')[0], 'ip': x.rpartition('@')[2]}
                            for x in values.get('tapo_lights', '').split(',') if '@' in x],
                 # The lights that take the picture's colours (empty: the ones named Lounge or Living, else all).
                 'ambient': [x.strip() for x in values.get('ambient_lights', '').split(',') if x.strip()],
                 # The lights the TV set (movie mode, ambient) go off when the TV does.
                 'offWithTv': values.get('lights_off_with_tv', 'true').lower() == 'true'},
        # Bin day, as a rule (Wirral has no lookup): "2026-11-02 Grey, Green" is a collection that day and every 7 days
        # after, the bins taking turns in that order. The chip shows from 4 pm the day before until 10 am on the day.
        'bins': bins(values.get('bins', '')),
        # Your photos on the screensaver (scripts/tv_photos.py puts them in out/photos): half, mostly or mine.
        'photosDir': values.get('photos_dir', ''), 'photosMix': values.get('photos_mix', 'half') or 'half',
        # What was built, for About this TV (written by scripts/tvconfig.py; empty otherwise).
        'build': {'commit': values.get('build_commit', ''), 'tag': values.get('build_tag', ''),
                  'settings': values.get('settings_hash', ''), 'devModeUntil': int(values.get('devmode_until', '0') or 0)},
    }


def adhan_file(values):
    """The adhan recording to pack (adhan_file: an MP3 or M4A on this computer), or ''."""
    path = os.path.expanduser(values.get('adhan_file', '').strip())
    return path if path and os.path.isfile(path) and path.lower().endswith(('.mp3', '.m4a', '.aac', '.ogg')) else ''


def bins(text):
    m = re.match(r'^(\d{4}-\d\d-\d\d)\s+(.+)$', text.strip())
    if not text.strip():
        return None
    if not m:
        sys.exit('config: bins must look like "2026-11-02 Grey, Green" (got "%s")' % text)
    return {'start': m.group(1), 'cycle': [x.strip() for x in m.group(2).split(',') if x.strip()]}


def coins():
    """The coins' logos from the Android app's vector drawables, as SVG paths (BTC, ETH, SOL, USDT)."""
    out = []
    for name in ('btc', 'eth', 'sol', 'usdt'):
        with open(os.path.join(ROOT, 'app', 'res', 'drawable', 'coin_%s.xml' % name), encoding='utf-8') as f:
            out.append(re.findall(r'android:pathData="([^"]+)"', f.read()))
    return out


def catalogues():
    """Each language's catalogue (app/assets/i18n), with only the keys the web app uses: {lang: {key: text}}."""
    keys = translate.web_keys()
    return {lang: {k: v for k, v in sorted(translate.load(lang).items()) if k in keys} for lang in translate.languages()}


def files(config, made_by):
    """The web app's files, {path inside the app: bytes}: web/, the settings, the catalogues, the app's symbols and font."""
    out = {}
    web = os.path.join(ROOT, 'web')
    for name in sorted(os.listdir(web)):
        if os.path.isdir(os.path.join(web, name)):
            continue
        with open(os.path.join(web, name), 'rb') as f:
            out[name] = f.read()
    icons = os.path.join(web, 'icons')
    for name in sorted(os.listdir(icons)):
        with open(os.path.join(icons, name), 'rb') as f:
            out['icons/' + name] = f.read()
    # Your own photos, only when this build asked for them (never in a generic build or a release).
    photos, pets, days, photo_dir = [], [], {}, os.path.join(ROOT, 'out', 'photos')
    if config.get('photosDir') and os.path.isdir(photo_dir):
        for name in sorted(os.listdir(photo_dir)):
            if name.endswith('.jpg'):
                with open(os.path.join(photo_dir, name), 'rb') as f:
                    out['photos/' + name] = f.read()
                photos.append('photos/' + name)
        # The day each was taken (its EXIF date), for "on this day" on the screensaver.
        days_list = os.path.join(photo_dir, 'days.json')
        if os.path.exists(days_list):
            with open(days_list, encoding='utf-8') as f:
                days = {'photos/' + k: v for k, v in json.load(f).items()}
        # Your pets (scripts/tv_photos.py: a folder each): their photos and the squares around their faces.
        pets_list = os.path.join(photo_dir, 'pets.json')
        if os.path.exists(pets_list):
            with open(pets_list, encoding='utf-8') as f:
                pets = json.load(f)
            for name in sorted(os.listdir(os.path.join(photo_dir, 'pets'))):
                with open(os.path.join(photo_dir, 'pets', name), 'rb') as f:
                    out['photos/pets/' + name] = f.read()
    config = dict(config, photos=photos, pets=pets, photoDays=days)
    adhan = dict(config.get('adhan') or {})
    path = adhan.pop('path', '')
    if path:   # your own recording: packed by this build only
        with open(path, 'rb') as f:
            out[adhan['src']] = f.read()
    config['adhan'] = adhan
    out['config.js'] = ('/* Generated by %s. */\nwindow.CONFIG = %s;\n'
                        % (made_by, json.dumps(config, ensure_ascii=False))).encode('utf-8')
    out['coins.js'] = ('window.COINS = %s;\n' % json.dumps(coins())).encode('utf-8')
    out['i18n.js'] = ('/* Generated by %s from app/assets/i18n. */\nwindow.I18N_CATALOGUES = %s;\n'
                      % (made_by, json.dumps(catalogues(), ensure_ascii=False, separators=(',', ':')))).encode('utf-8')
    symbols = os.path.join(ROOT, 'app', 'assets', 'symbols')
    for name in sorted(os.listdir(symbols)):
        if name.endswith('.png') or name.startswith('LICENSE'):
            with open(os.path.join(symbols, name), 'rb') as f:
                out['symbols/' + name] = f.read()
    for name in ('InterVariable.ttf', 'OFL.txt'):
        with open(os.path.join(ROOT, 'app', 'assets', 'fonts', name), 'rb') as f:
            out['fonts/' + name] = f.read()
    fonts = os.path.join(web, 'fonts')
    for name in sorted(os.listdir(fonts)):
        if name.endswith('.ttf') or name.startswith('OFL-'):
            with open(os.path.join(fonts, name), 'rb') as f:
                out['fonts/' + name] = f.read()
    return out


def preview(app, out_dir):
    """Leaves the app's files in out_dir, to open index.html in a browser."""
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    for path, content in app.items():
        target = os.path.join(out_dir, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(content)
