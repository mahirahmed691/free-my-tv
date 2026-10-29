#!/usr/bin/env python3
"""Types into the text field open on the LG TV, from the laptop (the remote's on-screen keyboard is slow).

    python3 scripts/tv_type.py 192.168.0.4 "https://example.com/apps.json"          # make type TEXT="..."
    python3 scripts/tv_type.py 192.168.0.4 "Wirral" --enter                          # then press Enter

Open the field on the TV first, with OK, so its on-screen keyboard shows: the TV accepts the text either way, but it
only lands while that keyboard is up. It uses the TV's remote control API (port 3000, as
webos/apps.py and LG's phone app do) with only the typing permission: the TV asks once to allow it, and the key it
gives back is kept in ~/.ssh/freemytv_ssap_type_<IP>.
"""
import json
import os
import re
import socket
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'webos'))
from apps import Socket  # noqa: E402

MANIFEST = {'manifestVersion': 1, 'appVersion': '1.0', 'permissions': ['CONTROL_INPUT_TEXT']}


def key_path(ip):
    return os.path.join(os.path.expanduser('~'), '.ssh', 'freemytv_ssap_type_' + ip.replace('.', '_'))


def request(ws, uri, payload, rid):
    ws.send({'type': 'request', 'id': rid, 'uri': uri, 'payload': payload})
    while True:
        m = ws.receive(timeout=15)
        if m.get('id') != rid:
            continue
        if m.get('type') == 'error' or not (m.get('payload') or {}).get('returnValue', True):
            sys.exit('The TV said: %s (is a text field open, with its keyboard showing?)' % (m.get('error') or json.dumps(m.get('payload'))))
        return m


def main():
    args = [a for a in sys.argv[1:] if a != '--enter']
    if len(args) != 2 or not re.match(r'^\d{1,3}(\.\d{1,3}){3}$', args[0]):
        sys.exit(__doc__)
    ip, text = args
    path = key_path(ip)
    key = open(path).read().strip() if os.path.exists(path) else None
    ws = Socket(ip)
    try:
        payload = {'forcePairing': False, 'pairingType': 'PROMPT', 'manifest': MANIFEST}
        if key:
            payload['client-key'] = key
        ws.send({'type': 'register', 'id': 'register', 'payload': payload})
        if not key:
            print('On the TV, choose Allow (once) ...')
        while True:
            m = ws.receive(timeout=90)
            if m.get('type') == 'error':
                sys.exit('The TV said: %s' % (m.get('error') or json.dumps(m)))
            if m.get('type') == 'registered':
                with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
                    f.write(m['payload']['client-key'])
                break
        request(ws, 'ssap://com.webos.service.ime/insertText', {'text': text, 'replace': 0}, 'type')
        if '--enter' in sys.argv:
            request(ws, 'ssap://com.webos.service.ime/sendEnterKey', {}, 'enter')
        print('Typed %d characters on the TV%s.' % (len(text), ' and pressed Enter' if '--enter' in sys.argv else ''))
        # The TV says yes even when no field is listening: the text only lands while its on-screen keyboard is up.
        print('Nothing there? Select the field with OK so the TV\'s keyboard shows, then run it again.')
    except socket.timeout:
        sys.exit('No answer from the TV: was the Allow prompt on the TV missed?')
    finally:
        ws.close()


if __name__ == '__main__':
    main()
