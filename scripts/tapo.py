#!/usr/bin/env python3
"""Your Tapo lights for the LG TV: finds them on your Wi-Fi and keeps what the TV needs in config.properties.

    make tapo-login      # asks your TP-Link login once (the password isn't shown, kept or printed)
    make tapo-list       # the lights it found, and whether each answers

The TV talks to the lights itself, on your Wi-Fi (webos/service: TP-Link's KLAP, which the Tapo app's Me > Third-Party
Services > Third-Party Compatibility turns on). It needs only tapo_auth, the hash the lights check (SHA-256 of the
SHA-1s of your email and password), never the password; and tapo_lights, "Name@IP" for each light it found.
Give the lights fixed addresses in your router (DHCP reservation), or run make tapo-login again when one moves.
"""
import base64
import getpass
import hashlib
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvconfig  # noqa: E402

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    Cipher = None


def auth_hash(email, password):
    sha1 = lambda s: hashlib.sha1(s.encode()).digest()  # noqa: E731
    return hashlib.sha256(sha1(email) + sha1(password)).digest()


def pad(data):
    n = 16 - len(data) % 16
    return data + bytes([n]) * n


class Klap:
    """One session with a light: handshake1 and 2, then signed AES-128-CBC requests (as python-kasa's klaptransport)."""

    def __init__(self, ip, auth):
        self.ip, self.auth, self.cookie = ip, auth, ''
        local = os.urandom(16)
        r = self._post('handshake1', local)
        remote, server = r[:16], r[16:48]
        if server != hashlib.sha256(local + remote + auth).digest():
            raise PermissionError('the light refused this login (is Third-Party Compatibility on?)')
        self._post('handshake2', hashlib.sha256(remote + local + auth).digest())
        seed = local + remote + auth
        self.key = hashlib.sha256(b'lsk' + seed).digest()[:16]
        iv = hashlib.sha256(b'iv' + seed).digest()
        self.iv, self.seq = iv[:12], struct.unpack('>i', iv[-4:])[0]
        self.sig = hashlib.sha256(b'ldk' + seed).digest()[:28]

    def _post(self, path, body):
        req = urllib.request.Request('http://%s/app/%s' % (self.ip, path), data=body, method='POST',
                                     headers={'Cookie': self.cookie} if self.cookie else {})
        with urllib.request.urlopen(req, timeout=5) as r:
            m = re.search(r'TP_SESSIONID=([^;]+)', r.headers.get('Set-Cookie', ''))
            if m:
                self.cookie = 'TP_SESSIONID=' + m.group(1)
            return r.read()

    def request(self, method, params=None):
        self.seq += 1
        seq = struct.pack('>i', self.seq)
        cipher = Cipher(algorithms.AES(self.key), modes.CBC(self.iv + seq))
        enc = cipher.encryptor()
        body = json.dumps({'method': method, 'params': params or {}, 'request_time_milis': int(time.time() * 1000)}).encode()
        data = enc.update(pad(body)) + enc.finalize()
        out = self._post('request?seq=%d' % self.seq, hashlib.sha256(self.sig + seq + data).digest() + data)
        dec = cipher.decryptor()
        plain = dec.update(out[32:]) + dec.finalize()
        answer = json.loads(plain[:-plain[-1]])
        if answer.get('error_code'):
            raise RuntimeError('%s: error %s' % (method, answer['error_code']))
        return answer.get('result', {})


def nickname(info):
    try:
        return base64.b64decode(info.get('nickname', '')).decode('utf-8') or info.get('model', 'Light')
    except ValueError:
        return info.get('model', 'Light')


def subnet():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.0.2.1', 9))   # no packet is sent: only picks the interface toward the router
        return s.getsockname()[0].rsplit('.', 1)[0]
    finally:
        s.close()


def probe(ip, auth):
    try:
        with socket.create_connection((ip, 80), timeout=0.6):
            pass
        info = Klap(ip, auth).request('get_device_info')
        if str(info.get('type', '')).startswith('SMART.TAPO') and info.get('model', '').startswith(('L', 'P')):
            return {'ip': ip, 'name': nickname(info), 'model': info.get('model', ''), 'on': info.get('device_on')}
    except Exception:
        return None


def find(auth):
    base = subnet()
    with ThreadPoolExecutor(64) as pool:
        found = [x for x in pool.map(lambda i: probe('%s.%d' % (base, i), auth), range(1, 255)) if x]
    return sorted(found, key=lambda x: x['name'].lower())


def write(values):
    path = tvconfig.SECRETS
    lines = open(path, encoding='utf-8').read().splitlines() if os.path.exists(path) else []
    lines = [line for line in lines if line.split('=', 1)[0].strip() not in values]
    lines += ['%s=%s' % kv for kv in values.items()]
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def lights_line(found):
    return ','.join('%s@%s' % (x['name'].replace(',', ' ').replace('@', ' '), x['ip']) for x in found)


def main():
    if Cipher is None:
        sys.exit('Needs the cryptography package: python3 -m pip install --user cryptography')
    if sys.argv[1:] == ['login']:
        email = input('TP-Link (Tapo) email: ').strip()
        auth = auth_hash(email, getpass.getpass('Password (not shown, not kept): '))
        print('Looking for your Tapo lights ...')
        found = find(auth)
        if not found:
            sys.exit('No light answered that login. Check Third-Party Compatibility (Tapo app: Me > Third-Party Services) and the password.')
        write({'tapo_auth': auth.hex(), 'tapo_lights': lights_line(found)})
        for x in found:
            print('  %-20s %-16s %s' % (x['name'], x['ip'], x['model']))
        print('Saved in config.properties (the hash only). make release puts the Lights on the TV.')
    elif sys.argv[1:] == ['list']:
        s = tvconfig.settings()
        if not s.get('tapo_auth'):
            sys.exit('Run make tapo-login first.')
        auth = bytes.fromhex(s['tapo_auth'])
        for item in s.get('tapo_lights', '').split(','):
            name, _, ip = item.rpartition('@')
            try:
                info = Klap(ip, auth).request('get_device_info')
                state = 'on, %d%%' % info.get('brightness', 0) if info.get('device_on') else 'off'
            except Exception as e:
                state = 'no answer (%s)' % e
            print('  %-20s %-16s %s' % (name, ip, state))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
