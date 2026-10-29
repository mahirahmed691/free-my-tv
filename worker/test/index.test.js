import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { pickMatches, watchSites, watchList, parseSalah, localDay } from '../src/index.js';

function kv() {
  const m = new Map();
  const store = {
    m,
    writes: 0,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.writes++; m.set(k, v); },
    async delete(k) { store.writes++; m.delete(k); },
  };
  return store;
}

let env, calls, ukhoDown;
const EVENTS = [
  { EventType: 'LowWater', DateTime: '2099-01-01T06:00:00', Height: 1.234 },
  { EventType: 'HighWater', DateTime: '2099-01-01T11:22:00', Height: 9.61 },
  { EventType: 'HighWater', DateTime: '2000-01-01T00:00:00', Height: 9 },   // past: left out
];

beforeEach(() => {
  env = { TV_TOKEN: 'secret-token', UKHO_KEY: 'ukho', STATIONS: '0451:Mersey,0461:Dee', ALLOWED_IPS: '', CACHE: kv() };
  calls = [];
  ukhoDown = false;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: init.headers['Ocp-Apim-Subscription-Key'] });
    if (ukhoDown) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(EVENTS), { status: 200 });
  };
  console.error = () => {};
});

const get = (path, headers = {}) => worker.fetch(new Request('https://w.example' + path, { headers }), env);
const authed = (path, extra = {}) => get(path, { Authorization: 'Bearer secret-token', ...extra });

test('refuses without the right token', async () => {
  assert.equal((await get('/v1/tides')).status, 401);
  assert.equal((await get('/v1/tides', { Authorization: 'Bearer secret-tokeN' })).status, 401);
  assert.equal((await get('/v1/tides', { Authorization: 'Bearer secret-token-longer' })).status, 401);
  assert.equal(calls.length, 0);
});

test('tides for both stations, UTC times, upcoming only, rounded heights', async () => {
  const r = await authed('/v1/tides');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await r.json();
  assert.deepEqual(body.stations.map((s) => s.name), ['Mersey', 'Dee']);
  assert.deepEqual(body.stations[0].events, [
    { type: 'low', at: '2099-01-01T06:00:00Z', height: 1.2 },
    { type: 'high', at: '2099-01-01T11:22:00Z', height: 9.6 },
  ]);
  assert.equal(calls[0].key, 'ukho');
  assert.match(calls[0].url, /Stations\/0451\/TidalEvents/);
});

test('UKHO is asked every time and nothing of its data is stored (Discovery forbids caching)', async () => {
  await authed('/v1/tides');
  await authed('/v1/tides');
  assert.equal(calls.length, 4);   // twice per station
  for (const [k, v] of env.CACHE.m) {
    assert.match(k, /^health:/);
    assert.doesNotMatch(v, /HighWater|LowWater|"high"|"low"|9\.6/);
  }
});

test('UKHO down: no tides, the error; health keeps the last success too', async () => {
  await authed('/v1/tides');
  ukhoDown = true;
  const s = (await (await authed('/v1/tides')).json()).stations[0];
  assert.equal(s.stale, true);
  assert.match(s.error, /HTTP 503/);
  assert.equal(s.events.length, 0);
  const h = await (await get('/health')).json();
  assert.match(h.sources['tides:0451'].error, /HTTP 503/);
  assert.ok(h.sources['tides:0451'].okAt);
});

test('UKHO down with nothing cached: that station empty, the other still answers', async () => {
  globalThis.fetch = async (url) => (String(url).includes('0451') ? new Response('', { status: 500 }) : new Response(JSON.stringify(EVENTS)));
  const body = await (await authed('/v1/tides')).json();
  assert.equal(body.stations[0].events.length, 0);
  assert.equal(body.stations[0].stale, true);
  assert.equal(body.stations[1].events.length, 2);
});

test('IP allowlist: an IPv4 address and an IPv6 /64', async () => {
  env.ALLOWED_IPS = '203.0.113.7, 2001:db8:2e84:f100::/64';
  const from = async (ip) => (await authed('/v1/tides', { 'CF-Connecting-IP': ip })).status;
  assert.equal(await from('203.0.113.7'), 200);
  assert.equal(await from('203.0.113.8'), 403);
  assert.equal(await from('2001:db8:2e84:f100:d126:ba23:ffbc:ac4b'), 200);   // another device at home
  assert.equal(await from('2001:db8:2e84:f100::1'), 200);
  assert.equal(await from('2001:db8:2e84:f101::1'), 403);                    // the next /64: not home
  assert.equal(await from('2001:db8::1'), 403);
  assert.equal(await from('not-an-ip'), 403);
  assert.equal(await from(''), 403);
  assert.equal((await get('/health', { 'CF-Connecting-IP': '198.51.100.1' })).status, 403);
});

test('preflight and health need no token, and health holds no secrets', async () => {
  const pre = await worker.fetch(new Request('https://w.example/v1/tides', { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const h = await get('/health');
  assert.equal(h.status, 200);
  assert.doesNotMatch(await h.text(), /secret-token|ukho"/);
});

function fakeGitHub(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    assert.equal(init.headers.Authorization, 'Bearer gh-token');
    if (overrides.down) return new Response('', { status: 502 });
    if (u.includes('/user/repos')) {
      return new Response(JSON.stringify([
        { full_name: 'me/a', name: 'a', private: true, default_branch: 'main', archived: false },
        { full_name: 'me/old', name: 'old', default_branch: 'main', archived: true },
        { full_name: 'me/b', name: 'b', default_branch: 'trunk', archived: false },
        { full_name: 'me/c', name: 'c', default_branch: 'main', archived: false },
      ]));
    }
    if (u.includes('/actions/runs')) {
      const run = u.includes('me/a') ? { status: 'completed', conclusion: 'success', name: 'CI', updated_at: '2026-10-28T09:00:00Z' }
        : u.includes('me/b') ? { status: 'completed', conclusion: 'failure', name: 'Deploy', updated_at: '2026-10-28T10:00:00Z' } : null;
      return new Response(JSON.stringify({ workflow_runs: run ? [run] : [] }));
    }
    if (u.includes('/dependabot/alerts')) {
      if (!u.includes('me/a')) return new Response('', { status: 403 });
      // Two pages: 100, then 49 (a repo past one page, as GitHub sends it).
      if (u.includes('after=p2')) return new Response(JSON.stringify(Array(49).fill({ security_advisory: { severity: 'high' } })));
      return new Response(JSON.stringify([{ security_advisory: { severity: 'critical' } }, ...Array(99).fill({ security_advisory: { severity: 'medium' } })]),
        { headers: { Link: '<https://api.github.com/repos/me/a/dependabot/alerts?state=open&per_page=100&after=p2>; rel="next"' } });
    }
    if (u.includes('/search/issues')) {
      const q = decodeURIComponent(u.split('q=')[1]);
      const item = (repo, number, title) => ({ repository_url: 'https://api.github.com/repos/me/' + repo, number, title,
        html_url: `https://github.com/me/${repo}/pull/${number}` });
      if (q.includes('review-requested')) return new Response(JSON.stringify({ total_count: 3, items: [item('a', 7, 'Fix login')] }));
      if (q.includes('status:failure')) return new Response(JSON.stringify({ total_count: 1, items: [item('b', 9, 'Bump deps')] }));
      return new Response(JSON.stringify({ total_count: 2, items: [item('b', 9, 'Bump deps'), item('a', 8, 'Docs')] }));
    }
    return new Response('', { status: 404 });
  };
  return calls;
}

test('dashboard: counts across recent unarchived repos, no names, cached 3 min', async () => {
  env.GITHUB_TOKEN = 'gh-token';
  env.GITHUB_RECENT = '3';
  const calls = fakeGitHub();
  const r = await authed('/v1/dashboard');
  assert.equal(r.status, 200);
  const text = await r.text();
  const d = JSON.parse(text);
  assert.equal(d.repos, 3);
  assert.deepEqual(d.builds, { passing: 1, failing: 1, running: 0 });   // me/c has no Actions: neither
  assert.equal(d.alerts, 149);                                          // both pages; me/b's 403 counts as none
  assert.equal(d.reviews, 3);
  assert.deepEqual(d.pullRequests, { open: 2, failing: 1 });
  assert.doesNotMatch(text, /me\/|"a"|old|Fix login|Bump|Docs|CI|Deploy/);
  assert.ok(calls.some((u) => u.includes('me/b/actions/runs') && u.includes('branch=trunk')));
  assert.ok(!calls.some((u) => u.includes('me/old')));
  const n = calls.length;
  await authed('/v1/dashboard');
  assert.equal(calls.length, n);
});

test('dashboard: without GITHUB_TOKEN 503; GitHub down serves the last counts, stale', async () => {
  assert.equal((await authed('/v1/dashboard')).status, 503);
  env.GITHUB_TOKEN = 'gh-token';
  fakeGitHub();
  await authed('/v1/dashboard');
  for (const [k, v] of env.CACHE.m) if (k === 'github') env.CACHE.m.set(k, JSON.stringify({ ...JSON.parse(v), fetchedAt: 1 }));
  fakeGitHub({ down: true });
  const d = await (await authed('/v1/dashboard')).json();
  assert.equal(d.stale, true);
  assert.match(d.error, /HTTP 502/);
  assert.equal(d.reviews, 3);
  assert.equal(d.alerts, 149);
  assert.match((await (await get('/health')).json()).sources.github.error, /HTTP 502/);
});

test('details: names, builds, PRs with their checks, alerts by severity; one GitHub fetch for both endpoints', async () => {
  env.GITHUB_TOKEN = 'gh-token';
  env.GITHUB_RECENT = '3';
  const calls = fakeGitHub();
  const d = await (await authed('/v1/dashboard/details')).json();
  assert.deepEqual(d.repos.map((r) => [r.name, r.build.state]), [['a', 'passing'], ['b', 'failing'], ['c', 'none']]);
  assert.deepEqual(d.repos[0].alerts, { critical: 1, high: 49, medium: 99, low: 0 });
  assert.equal(d.repos[1].build.workflow, 'Deploy');
  assert.deepEqual(d.reviews, { total: 3, items: [{ repo: 'a', number: 7, title: 'Fix login', url: 'https://github.com/me/a/pull/7' }] });
  assert.deepEqual(d.mine.items.map((p) => [p.repo, p.number, p.failing]), [['b', 9, true], ['a', 8, false]]);
  const n = calls.length;
  const c = await (await authed('/v1/dashboard')).json();
  assert.equal(calls.length, n);   // the counts come from the same cached details
  assert.equal(c.alerts, 149);
});

// ---- trains, notes, sites, and staying inside KV's free writes

const req = (path, { method = 'GET', token = 'secret-token', body, ip } = {}) => worker.fetch(new Request('https://w.example' + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
}), env);

test('trains: Huxley2 departures, cancellations flagged, messages without HTML', async () => {
  env.TRAINS_CRS = 'bkq';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), cf: init.cf });
    return new Response(JSON.stringify({
      locationName: 'Hamilton Square',
      nrccMessages: [{ value: '<p>Disruption between <b>A</b> &amp; B</p>' }],
      trainServices: [
        { std: '08:10', etd: 'On time', platform: '1', destination: [{ locationName: 'Liverpool Central' }] },
        { std: '08:14', etd: 'Cancelled', isCancelled: true, destination: [{ locationName: 'West Kirby' }] },
      ],
    }));
  };
  const t = await (await req('/v1/trains')).json();
  assert.match(seen[0].url, /departures\/BKQ\/8$/);
  assert.equal(seen[0].cf.cacheTtl, 60);
  assert.equal(t.station, 'Hamilton Square');
  assert.deepEqual(t.services.map((x) => [x.std, x.destination, x.cancelled]), [['08:10', 'Liverpool Central', false], ['08:14', 'West Kirby', true]]);
  assert.deepEqual(t.messages, ['Disruption between A & B']);
});

test('trains: Huxley2 down is a 502 with the reason, not a crash', async () => {
  globalThis.fetch = async () => new Response('', { status: 503 });
  const r = await req('/v1/trains');
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /HTTP 503/);
});

test('notes: the TV reads; only ADMIN_TOKEN writes or clears; length and emptiness checked', async () => {
  env.ADMIN_TOKEN = 'admin-token';
  assert.deepEqual(await (await req('/v1/notes')).json(), { text: '', at: 0 });
  assert.equal((await req('/v1/notes', { method: 'POST', body: { text: 'Bins out' } })).status, 401);        // TV token
  assert.equal((await req('/v1/notes', { method: 'POST', token: null, body: { text: 'x' } })).status, 401);
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'admin-token', body: { text: '   ' } })).status, 400);
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'admin-token', body: { text: 'x'.repeat(141) } })).status, 400);
  const w = await req('/v1/notes', { method: 'POST', token: 'admin-token', body: { text: '  Bins out\n tonight ' } });
  assert.equal((await w.json()).text, 'Bins out tonight');
  assert.equal((await (await req('/v1/notes')).json()).text, 'Bins out tonight');
  assert.equal((await req('/v1/notes', { method: 'DELETE', token: 'admin-token' })).status, 200);
  assert.equal((await (await req('/v1/notes')).json()).text, '');
  assert.equal((await req('/v1/tides', { method: 'POST', token: 'admin-token' })).status, 405);           // only notes take writes
});

test('notes: ALLOWED_IPS applies to writes too', async () => {
  env.ADMIN_TOKEN = 'admin-token';
  env.ALLOWED_IPS = '203.0.113.7';
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'admin-token', body: { text: 'x' }, ip: '198.51.100.1' })).status, 403);
});

test('sites: the monitors\' last results, counts on the card, names only in details', async () => {
  env.GITHUB_TOKEN = 'gh-token';
  env.GITHUB_RECENT = '3';
  env.SITES = 'Shop:SITE_A,Coach:SITE_B,Missing:SITE_C';
  env.SITE_A = kv();
  env.SITE_B = kv();
  await env.SITE_B.put('last', JSON.stringify({ sig: '/hub content|/login status', at: 123 }));
  fakeGitHub();
  const card = await (await authed('/v1/dashboard')).json();
  assert.deepEqual(card.sites, { up: 1, total: 3 });
  const d = await (await authed('/v1/dashboard/details')).json();
  assert.deepEqual(d.sites, [
    { name: 'Shop', ok: true, at: 0, failing: [] },
    { name: 'Coach', ok: false, at: 123, failing: ['/hub content', '/login status'] },
    { name: 'Missing', ok: null, at: 0, failing: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(card), /Shop|Coach/);
});

test('KV free tier: an hour of healthy tide requests writes health once', async () => {
  for (let i = 0; i < 30; i++) await authed('/v1/tides');
  const healthWrites = env.CACHE.writes;
  assert.ok(healthWrites <= 2, `${healthWrites} writes (one per station at most)`);
});

test('KV free tier: with Cloudflare\'s cache, the dashboard writes its KV copy at most every 30 minutes', async () => {
  const store = new Map();
  globalThis.caches = { default: {
    async match(u) { const e = store.get(u); return e && e.until > Date.now() ? new Response(e.body) : undefined; },
    async put(u, r) { const age = Number(/max-age=(\d+)/.exec(r.headers.get('Cache-Control'))[1]); store.set(u, { body: await r.text(), until: Date.now() + age * 1000 }); },
  } };
  try {
    env.GITHUB_TOKEN = 'gh-token';
    env.GITHUB_RECENT = '3';
    const calls = fakeGitHub();
    await authed('/v1/dashboard');
    const after1 = calls.length;
    await authed('/v1/dashboard');
    assert.equal(calls.length, after1);                         // served from Cloudflare's cache
    const kvWrites = env.CACHE.writes;
    store.clear();                                               // the 3 minutes are up
    await authed('/v1/dashboard');
    assert.ok(calls.length > after1);                            // asked GitHub again...
    assert.equal(env.CACHE.writes, kvWrites);                    // ...but the KV copy is under 30 min old: no write
  } finally {
    delete globalThis.caches;
  }
});

// ---- football

const m = (date, status, home, away, score = [null, null]) => ({
  utcDate: date, status, competition: { name: 'Premier League' },
  homeTeam: { id: home[0], shortName: home[1] }, awayTeam: { id: away[0], shortName: away[1] },
  score: { fullTime: { home: score[0], away: score[1] } },
});
const MUN = [66, 'Man United'], CHE = [61, 'Chelsea'], BOU = [1044, 'Bournemouth'], ROM = [100, 'Roma'];

test('football: the last result, the next fixture, home or away, as the TV needs them', () => {
  const now = Date.parse('2026-10-29T02:00:00Z');
  const p = pickMatches([
    m('2026-11-03T20:00:00Z', 'TIMED', MUN, ROM),
    m('2026-10-25T14:00:00Z', 'FINISHED', MUN, BOU, [0, 3]),
    m('2026-10-31T12:30:00Z', 'TIMED', CHE, MUN),
  ], 66, now);
  assert.equal(p.team, 'Man United');
  assert.equal(p.live, null);
  assert.deepEqual([p.next.home, p.next.away, p.next.opponent, p.next.atHome], ['Chelsea', 'Man United', 'Chelsea', false]);
  assert.deepEqual([p.last.opponent, p.last.atHome, p.last.score], ['Bournemouth', true, { home: 0, away: 3 }]);
});

test('football: a match in play is live (and not also next)', () => {
  const now = Date.parse('2026-10-31T13:00:00Z');
  const p = pickMatches([m('2026-10-31T12:30:00Z', 'IN_PLAY', CHE, MUN, [1, 1]), m('2026-11-03T20:00:00Z', 'TIMED', MUN, ROM)], 66, now);
  assert.deepEqual([p.live.home, p.live.away, p.live.score], ['Chelsea', 'Man United', { home: 1, away: 1 }]);
  assert.equal(p.next.opponent, 'Roma');
});

test('football: through the Worker with the key in the header; no key is a 503', async () => {
  assert.equal((await authed('/v1/football')).status, 503);
  env.FOOTBALL_KEY = 'fd-key';
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), key: init.headers['X-Auth-Token'] };
    return new Response(JSON.stringify({ matches: [m('2099-01-01T15:00:00Z', 'TIMED', MUN, CHE)] }));
  };
  const d = await (await authed('/v1/football')).json();
  assert.equal(seen.key, 'fd-key');
  assert.match(seen.url, /teams\/66\/matches\?dateFrom=\d{4}-\d\d-\d\d&dateTo=\d{4}-\d\d-\d\d$/);
  assert.equal(d.next.opponent, 'Chelsea');
  assert.doesNotMatch(JSON.stringify(d), /fd-key/);
});

// ---- calendar

test('calendar: today from the secret feed; no feed is a 503; an HTML page (wrong link) is an error, not events', async () => {
  assert.equal((await authed('/v1/calendar')).status, 503);
  env.CALENDAR_ICS = 'https://calendar.example/secret/basic.ics';
  const now = new Date();
  const stamp = (h) => `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}T${h}0000Z`;
  let seen;
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', `DTSTART:${stamp('12')}`, `DTEND:${stamp('13')}`, 'SUMMARY:Lunch', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  };
  const d = await (await authed('/v1/calendar')).json();
  assert.equal(seen, 'https://calendar.example/secret/basic.ics');
  assert.equal(d.tz, 'Europe/London');
  assert.deepEqual(d.events.map((e) => e.title), ['Lunch']);
  assert.doesNotMatch(JSON.stringify(d), /secret\/basic/);   // the feed's address never reaches the TV
  for (const [k] of env.CACHE.m) if (k === 'calendar') env.CACHE.m.delete(k);
  globalThis.fetch = async () => new Response('<html>Sign in</html>');
  const bad = await authed('/v1/calendar');
  assert.equal(bad.status, 502);
});

test('notes: ADMIN_TOKEN can list one token per device; each works, and dropping one revokes only it', async () => {
  env.ADMIN_TOKEN = 'mac-token, phone-token';
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'mac-token', body: { text: 'from the Mac' } })).status, 200);
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'phone-token', body: { text: 'from the phone' } })).status, 200);
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'phone', body: { text: 'x' } })).status, 401);
  env.ADMIN_TOKEN = 'mac-token';
  assert.equal((await req('/v1/notes', { method: 'POST', token: 'phone-token', body: { text: 'x' } })).status, 401);
  assert.equal((await req('/v1/notes', { method: 'DELETE', token: 'mac-token' })).status, 200);
});

// ---- watched sites (the cron)

test('watched sites: up, down by status, down by no answer; on the card with the monitors; KV written only on change', async () => {
  env.WATCH_SITES = 'Link=https://link.example|Blog=https://blog.example|Shop=https://shop.example| broken entry ';
  assert.deepEqual(watchList(env).map((x) => x.name), ['Link', 'Blog', 'Shop']);
  globalThis.fetch = async (url) => {
    if (String(url).includes('blog')) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND blog.example');
    return new Response('', { status: String(url).includes('shop') ? 503 : 200 });
  };
  const r = await watchSites(env, 1000);
  assert.deepEqual(r.map((x) => [x.name, x.ok]), [['Link', true], ['Blog', false], ['Shop', false]]);
  assert.match(r[1].detail, /ENOTFOUND/);
  assert.equal(r[2].detail, 'HTTP 503');
  const writes = env.CACHE.writes;
  await watchSites(env, 1000 + 60000);                 // same results a minute later: no write
  assert.equal(env.CACHE.writes, writes);
  await watchSites(env, 1000 + 3600000);               // an hour on: one write
  assert.equal(env.CACHE.writes, writes + 1);

  env.GITHUB_TOKEN = 'gh-token';
  env.GITHUB_RECENT = '3';
  env.SITES = 'Coach:SITE_B';
  env.SITE_B = kv();
  fakeGitHub();
  const card = await (await authed('/v1/dashboard')).json();
  assert.deepEqual(card.sites, { up: 2, total: 4 });   // Coach (never failed) + Link up; Blog, Shop down
  const d = await (await authed('/v1/dashboard/details')).json();
  assert.deepEqual(d.sites.map((s) => [s.name, s.ok]), [['Coach', true], ['Link', true], ['Blog', false], ['Shop', false]]);
  assert.equal(d.sites[3].failing[0], 'HTTP 503');
});

test('watched sites not checked yet show as not yet, not as down', async () => {
  env.WATCH_SITES = 'Link=https://link.example';
  env.GITHUB_TOKEN = 'gh-token';
  env.GITHUB_RECENT = '3';
  fakeGitHub();
  const d = await (await authed('/v1/dashboard/details')).json();
  assert.deepEqual(d.sites.map((s) => [s.name, s.ok]), [['Link', null]]);
});

// ---- the private Homebrew Channel repository

test('homebrew repository: home only, no token, never without ALLOWED_IPS; 404 until published', async () => {
  const get2 = (path, ip) => worker.fetch(new Request('https://w.example' + path, { headers: ip ? { 'CF-Connecting-IP': ip } : {} }), env);
  assert.equal((await get2('/webos/apps.json')).status, 403);                     // ALLOWED_IPS unset: refused
  env.ALLOWED_IPS = '203.0.113.7';
  assert.equal((await get2('/webos/apps.json', '198.51.100.1')).status, 403);     // not home
  assert.equal((await get2('/webos/apps.json', '203.0.113.7')).status, 404);      // home, nothing published
  await env.CACHE.put('webos:apps.json', '{"packages":[]}');
  env.CACHE.get = ((orig) => async (k, type) => (k === 'webos:ipk' && type === 'arrayBuffer' ? new Uint8Array([1, 2, 3]).buffer : orig(k, type)))(env.CACHE.get);
  const repo = await get2('/webos/apps.json', '203.0.113.7');
  assert.equal(repo.status, 200);
  assert.equal(await repo.text(), '{"packages":[]}');
  const ipk = await get2('/webos/FreeMyTV.ipk', '203.0.113.7');
  assert.equal(ipk.status, 200);
  assert.equal(ipk.headers.get('Content-Length'), '3');
  assert.ok(JSON.stringify([...ipk.headers]).length < 2000);                       // the Channel's Node takes 8 KB of headers at most
});

// A page shaped like the mosque's ConnectMazjid widget (made up: the real one carries its token).
const item = (name, adhan, iqamah, off = false) =>
  `{\\"name\\":\\"${name}\\",\\"icon\\":[\\"$\\",\\"svg\\",null,{}],\\"azanTime\\":\\"x\\",\\"iqamaTime\\":\\"y\\",\\"rawAzanTime\\":${adhan},\\"rawIqamaTime\\":${iqamah},\\"isNotOffered\\":${off}}`;
const SALAH_PAGE = `<script>self.__next_f.push([1,"17:[{\\"prayerTimes\\":[${[
  item('Fajr', 1793253600, 1793254500), item('Sunrise', 1793257500, 0), item('Dhuhr', 1793278800, 1793279700),
  item('Asar', 1793286000, 1793286900), item('Maghrib', 1793292480, 1793292780), item('Isha', 1793299500, 1793300400),
].join(',')}],\\"hijriDate\\":\\"18 Jumada al-Ula, 1448\\",\\"timezone\\":\\"Europe/London\\",\\"specialTimings\\":[{\\"name\\":\\"Jummah\\",\\"khutbahTime\\":\\"01:30 PM\\",\\"prayerTime\\":\\"01:45 PM\\"}],\\"masjidName\\":\\"Wallasey Mosque\\"}]"])</script>`;

test('parseSalah reads adhan and jamaat, the Hijri date and Jumu\'ah', () => {
  const s = parseSalah(SALAH_PAGE);
  assert.equal(s.masjid, 'Wallasey Mosque');
  assert.equal(s.day, '2026-10-29');
  assert.equal(s.hijri, '18 Jumada al-Ula, 1448');
  assert.deepEqual(s.times.asr, { adhan: 1793286000000, iqamah: 1793286900000 });
  assert.deepEqual(s.times.sunrise, { adhan: 1793257500000 });
  assert.equal(s.jumuah, '13:45');
  assert.equal(parseSalah(SALAH_PAGE, '13:00').jumuah, '13:00');
  assert.throws(() => parseSalah('<html>nothing</html>'), /no fajr/);
});

test('localDay is the day in the mosque\'s time zone', () => {
  assert.equal(localDay(Date.parse('2026-06-21T23:30:00Z'), 'Europe/London'), '2026-06-22');
  assert.equal(localDay(Date.parse('2026-12-21T23:30:00Z'), 'Europe/London'), '2026-12-21');
});

test('/v1/salah needs the token and says when the page is not today\'s', async () => {
  env.SALAH_WIDGET = 'https://widgets.example/prayer-timing?token=t';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).startsWith('https://widgets.example') ? new Response(SALAH_PAGE) : realFetch(url));
  try {
    const no = await worker.fetch(new Request('https://w/v1/salah'), env);
    assert.equal(no.status, 401);
    const r = await worker.fetch(new Request('https://w/v1/salah', { headers: { Authorization: 'Bearer secret-token' } }), env);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.times.isha.iqamah, 1793300400000);
    assert.equal(body.today, localDay(Date.now(), 'Europe/London') === '2026-10-29');
    assert.equal(body.stale, !body.today);
  } finally {
    globalThis.fetch = realFetch;
  }
});
