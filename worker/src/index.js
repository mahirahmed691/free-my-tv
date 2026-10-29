import { eventsBetween, dayBounds } from './ics.js';

/**
 * The TV's backend: holds the API keys (Wrangler secrets), calls the sources, and gives the TV small JSON. The TV
 * holds only TV_TOKEN, read-only and rotatable. KV keeps each source's last success and failure (/health), and the
 * answers of sources whose terms allow it (cached); never UKHO's.
 *
 *   GET /v1/tides       the next week of high and low water at STATIONS (UKHO's Admiralty API, asked every time)
 *   GET /v1/dashboard   counts for GitHub: the latest builds, reviews waiting, your PRs, Dependabot alerts (3 min cache)
 *   GET /v1/dashboard/details   the same with repo names and PR titles, for the sheet the TV opens on purpose
 *   GET /v1/trains      the next departures from TRAINS_CRS (Huxley2's National Rail feed; Cloudflare caches 60 s)
 *   GET /v1/notes       the note shown on the TV; POST {"text"} or DELETE it with ADMIN_TOKEN (make note)
 *   GET /v1/football    FOOTBALL_TEAM's live match, next fixture and last result (football-data.org, 5 min cache)
 *   GET /v1/calendar    today's events from CALENDAR_ICS (a calendar's secret iCal address; 10 min cache)
 *   GET /v1/salah       today's adhan and jamaat at your mosque, as it publishes them (SALAH_WIDGET, its ConnectMazjid
 *                       widget, as Sakinah's hall display reads it; 30 min cache, never past midnight)
 *   GET /webos/apps.json, /webos/FreeMyTV.ipk   a private Homebrew Channel repository (make release uploads both to KV):
 *                       no token (the Channel can't send one), so only from ALLOWED_IPS, and never without it
 *   GET /health     each source's last fetch, for the TV's About screen and a monitor (no token: nothing private)
 *
 * Every 15 minutes (cron) it also checks WATCH_SITES ("Name=https://url|..."), and the GitHub card counts them with the
 * monitoring Workers' sites.
 *
 * Secrets: TV_TOKEN, ADMIN_TOKEN (writes the note, one per device, comma separated; never on the TV), UKHO_KEY, GITHUB_TOKEN (fine-grained, read-only),
 * FOOTBALL_KEY (football-data.org), SALAH_WIDGET (the mosque's widget address, with its token), CALENDAR_ICS (the calendar's secret iCal address: anyone with it reads the calendar). Vars: STATIONS ("0451:Mersey,0461:Dee"), ALLOWED_IPS (addresses or CIDR ranges, comma
 * separated; empty = any), GITHUB_RECENT (how many recently pushed repos, 6).
 * /v1/dashboard holds counts only, never repo names or titles: the TV's card is on a shared screen.
 */

const DAY = 86400000;
const KEEP = 3 * DAY;   // how long KV keeps a cached answer (to serve stale when its source is down) and health

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

/** Compares in constant time, so the token can't be guessed from how long a refusal takes. */
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** An IPv4 or IPv6 address as 32 or 128 bits (a BigInt), or null. */
function bits(ip) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    return parts.some((n) => n > 255) ? null : { v: 4, n: parts.reduce((a, n) => (a << 8n) | BigInt(n), 0n) };
  }
  if (!/^[0-9a-f:]+$/i.test(ip) || (ip.match(/::/g) || []).length > 1) return null;
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = tail === null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

/** Whether ip is in range: an address, or a CIDR range (your home's IPv6 /64: each device has its own address). */
function inRange(ip, range) {
  const [base, len] = range.split('/');
  const a = bits(ip), b = bits(base);
  if (!a || !b || a.v !== b.v) return false;
  const size = a.v === 4 ? 32 : 128, prefix = len === undefined ? size : Number(len);
  if (!(prefix >= 0 && prefix <= size)) return false;
  const shift = BigInt(size - prefix);
  return a.n >> shift === b.n >> shift;
}

function allowedIp(request, env) {
  const list = (env.ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  return !list.length || list.some((range) => inRange(ip, range));
}

function stations(env) {
  return (env.STATIONS || '0451:Mersey,0461:Dee').split(',').map((s) => {
    const [id, name] = s.split(':');
    return { id: id.trim(), name: (name || id).trim() };
  });
}

const HOUR = 3600000;
const KV_FALLBACK_EVERY = 30 * 60000;   // KV's free tier allows 1,000 writes a day: the stale copy is refreshed this often

/**
 * Notes a source's success or failure for /health (no data: some sources' terms forbid storing it). Writes KV only
 * when the state changes, or hourly while it holds, to stay inside KV's free writes.
 */
async function noteHealth(env, key, error) {
  const health = (await env.CACHE.get('health:' + key, 'json')) || {};
  const now = Date.now();
  const failing = (health.failedAt || 0) > (health.okAt || 0);
  if (!error && !failing && health.okAt && now - health.okAt < HOUR) return;
  if (error && failing && health.error === error && now - health.failedAt < HOUR) return;
  const next = error ? { ...health, failedAt: now, error } : { ...health, okAt: now };
  await env.CACHE.put('health:' + key, JSON.stringify(next), { expirationTtl: KEEP / 1000 });
}

/** Cloudflare's cache (free, no write limit) for fresh answers; absent in tests, where KV alone serves. */
const edgeCache = () => (typeof caches !== 'undefined' && caches.default) || null;
const cacheUrl = (key) => `https://freemytv-bff.cache/${encodeURIComponent(key)}`;

/** Fetches every time, for sources that may not be stored (UKHO's free Discovery tier forbids caching). */
async function live(env, key, load) {
  try {
    const data = await load();
    await noteHealth(env, key);
    return data;
  } catch (e) {
    console.error(JSON.stringify({ source: key, error: String(e.message || e) }));
    await noteHealth(env, key, String(e.message || e));
    throw e;
  }
}

/**
 * The cached answer for key, fetched again when older than fresh (only for sources whose terms allow caching). When the source fails, the last answer is served
 * with stale: true and the error, so the TV can say "stale since"; the failure is logged for Workers Logs.
 */
async function cached(env, key, fresh, load) {
  const cache = edgeCache();
  if (cache) {
    const hit = await cache.match(cacheUrl(key));
    if (hit) return { ...(await hit.json()), stale: false };
  }
  const old = await env.CACHE.get(key, 'json');
  if (!cache && old && Date.now() - old.fetchedAt < fresh) return { ...old, stale: false };
  try {
    const data = await load();
    const entry = { fetchedAt: Date.now(), data };
    if (cache) {
      await cache.put(cacheUrl(key), new Response(JSON.stringify(entry), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.round(fresh / 1000)}` },
      }));
    }
    if (!old || Date.now() - old.fetchedAt >= (cache ? KV_FALLBACK_EVERY : 0)) {
      await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: KEEP / 1000 });
    }
    await noteHealth(env, key);
    return { ...entry, stale: false };
  } catch (e) {
    console.error(JSON.stringify({ source: key, error: String(e.message || e) }));
    await noteHealth(env, key, String(e.message || e));
    if (old) return { ...old, stale: true, error: String(e.message || e) };
    throw e;
  }
}

async function ukhoEvents(env, id) {
  const url = `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/${encodeURIComponent(id)}/TidalEvents?duration=7`;
  const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': env.UKHO_KEY } });
  if (!r.ok) {
    // UKHO's gateway says why (an invalid key, a missing subscription): its message, never the key.
    const why = (await r.text().catch(() => '')).match(/"message"\s*:\s*"([^"]{0,160})/);
    throw new Error(`UKHO ${id}: HTTP ${r.status}` + (why ? ` (${why[1]})` : ''));
  }
  const list = await r.json();
  // UKHO's times are UTC without a zone: say so, so the TV shows them in its own time zone.
  return list
    .filter((e) => e.EventType === 'HighWater' || e.EventType === 'LowWater')
    .map((e) => ({
      type: e.EventType === 'HighWater' ? 'high' : 'low',
      at: /Z|[+-]\d\d:?\d\d$/.test(e.DateTime) ? e.DateTime : e.DateTime + 'Z',
      height: typeof e.Height === 'number' ? Math.round(e.Height * 10) / 10 : null,
    }));
}

async function tides(env) {
  const now = Date.now();
  const out = [];
  for (const s of stations(env)) {
    try {
      const events = await live(env, 'tides:' + s.id, () => ukhoEvents(env, s.id));
      out.push({ ...s, fetchedAt: Date.now(), stale: false, events: events.filter((e) => Date.parse(e.at) > now - 3600000) });
    } catch (e) {
      out.push({ ...s, fetchedAt: 0, stale: true, error: String(e.message || e), events: [] });
    }
  }
  return { stations: out };
}

// MARK: GitHub

const DASHBOARD_FRESH = 3 * 60000;

async function githubPage(env, url) {
  const r = await fetch(url.startsWith('https://') ? url : 'https://api.github.com' + url, {
    headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'freemytv-bff' },
  });
  if (!r.ok) {
    const e = new Error(`GitHub ${url.replace('https://api.github.com', '').split('?')[0]}: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const next = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
  return { body: await r.json(), next: next && next[1] };
}

const github = async (env, path) => (await githubPage(env, path)).body;

/** Every page of a list, following GitHub's Link: rel="next" (up to 10 pages: 1,000 alerts a repo). */
async function githubAll(env, path) {
  let all = [], url = path;
  for (let i = 0; url && i < 10; i++) {
    const page = await githubPage(env, url);
    all = all.concat(page.body);
    url = page.next;
  }
  return all;
}

const search = (env, q, n) => github(env, `/search/issues?per_page=${n}&q=` + encodeURIComponent(q));
const repoName = (item) => item.repository_url.split('/').pop();
const pr = (item) => ({ repo: repoName(item), number: item.number, title: item.title, url: item.html_url });

/**
 * Your most recently pushed repos and what needs you, with names: only /v1/dashboard/details sends them (the TV shows
 * them in a sheet opened on purpose); /v1/dashboard sends counts(). A repo without Actions or Dependabot counts as neither.
 */
async function details(env) {
  const n = Math.min(Math.max(parseInt(env.GITHUB_RECENT || '6', 10) || 6, 1), 20);
  const list = (await github(env, `/user/repos?sort=pushed&affiliation=owner&per_page=${n + 10}`))
    .filter((r) => !r.archived).slice(0, n);
  const repos = await Promise.all(list.map(async (r) => {
    const runs = await github(env, `/repos/${r.full_name}/actions/runs?per_page=1&branch=${encodeURIComponent(r.default_branch)}`)
      .catch(() => ({ workflow_runs: [] }));
    const run = runs.workflow_runs[0];
    const state = !run ? 'none' : run.status !== 'completed' ? 'running'
      : ['success', 'skipped', 'neutral'].includes(run.conclusion) ? 'passing' : 'failing';
    // Off, or the token can't see them: 403/404, counted as none.
    const open = await githubAll(env, `/repos/${r.full_name}/dependabot/alerts?state=open&per_page=100`).catch(() => []);
    const alerts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of Array.isArray(open) ? open : []) {
      const sev = ((a.security_advisory || {}).severity || (a.security_vulnerability || {}).severity || 'low').toLowerCase();
      alerts[sev in alerts ? sev : 'low']++;
    }
    return { name: r.name, private: !!r.private, build: { state, workflow: run ? run.name : '', at: run ? run.updated_at : '' }, alerts };
  }));
  const [reviews, mine, failing] = await Promise.all([
    search(env, 'is:pr is:open archived:false review-requested:@me', 20),
    search(env, 'is:pr is:open archived:false author:@me', 20),
    search(env, 'is:pr is:open archived:false author:@me status:failure', 100),
  ]);
  const failed = new Set(failing.items.map((i) => i.html_url));
  return {
    repos,
    reviews: { total: reviews.total_count, items: reviews.items.map(pr) },
    mine: { total: mine.total_count, failing: failing.total_count, items: mine.items.map((i) => ({ ...pr(i), failing: failed.has(i.html_url) })) },
  };
}

/** The card's counts: never a name. */
/** The card's counts: never a name. */
function siteCounts(list) {
  return { up: list.filter((x) => x.ok === true).length, total: list.length };
}

function counts(d) {
  const builds = { passing: 0, failing: 0, running: 0 };
  let alerts = 0;
  for (const r of d.repos) {
    if (r.build.state in builds) builds[r.build.state]++;
    alerts += r.alerts.critical + r.alerts.high + r.alerts.medium + r.alerts.low;
  }
  return { repos: d.repos.length, builds, reviews: d.reviews.total, pullRequests: { open: d.mine.total, failing: d.mine.failing }, alerts };
}

// MARK: Trains

const decode = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function trains(env) {
  const crs = (env.TRAINS_CRS || 'BKQ').toUpperCase();
  const r = await fetch(`https://huxley2.azurewebsites.net/departures/${encodeURIComponent(crs)}/8`, {
    headers: { 'User-Agent': 'freemytv-bff' }, cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Huxley2 ${crs}: HTTP ${r.status}`);
  const d = await r.json();
  return {
    station: d.locationName || crs,
    crs,
    services: (d.trainServices || []).map((t) => ({
      std: t.std,
      etd: t.etd,
      destination: (t.destination || []).map((x) => x.locationName).join(' & '),
      platform: t.platform || null,
      cancelled: Boolean(t.isCancelled) || t.etd === 'Cancelled',
    })),
    messages: (d.nrccMessages || []).map((m) => decode(m.value)).filter(Boolean),
  };
}

/** Milliseconds until the next midnight in tz (at least a minute). */
function msToMidnight(t, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t));
  const get = (type) => +parts.find((p) => p.type === type).value;
  return Math.max(60000, ((24 - get('hour')) * 3600 - get('minute') * 60 - get('second')) * 1000);
}

// MARK: Salah (the mosque's ConnectMazjid widget: a Next.js page whose data carries each prayer's times)

const SALAH_FRESH = 30 * 60000;
const SALAH_KEYS = { Fajr: 'fajr', Sunrise: 'sunrise', Dhuhr: 'dhuhr', Asar: 'asr', Asr: 'asr', Maghrib: 'maghrib', Isha: 'isha' };

/** The day in tz as YYYY-MM-DD. */
export function localDay(t, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** "01:30 PM" as "13:30" ('' when it isn't a clock). */
function clock24(value) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(value || '').trim());
  if (!m || +m[1] < 1 || +m[1] > 12) return '';
  const h = (+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** {masjid, day, hijri, times: {fajr: {adhan, iqamah}, sunrise: {adhan}, ...} (ms), jumuah: "13:00"} from the page. */
export function parseSalah(html, jumuahOverride = '') {
  const text = html.replace(/\\"/g, '"');
  const times = {};
  const item = /\{"name":"(\w+)","icon"[\s\S]{0,1600}?"rawAzanTime":(\d+),"rawIqamaTime":(\d+),"isNotOffered":(true|false)/g;
  for (const m of text.matchAll(item)) {
    const key = SALAH_KEYS[m[1]];
    if (!key || times[key] || m[4] === 'true') continue;
    times[key] = { adhan: +m[2] * 1000 };
    if (+m[3] > 0) times[key].iqamah = +m[3] * 1000;
  }
  for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) if (!times[k]) throw new Error(`no ${k} on the mosque's page`);
  const field = (name) => (new RegExp(`"${name}":"([^"]{1,80})"`).exec(text) || [])[1] || '';
  const jumuah = /"name":"Jum(?:m|u'?)ah"[\s\S]{0,240}?"prayerTime":"([^"]+)"/.exec(text);
  const tz = field('timezone') || 'Europe/London';
  return {
    masjid: field('masjidName'), timezone: tz, day: localDay(times.dhuhr.adhan, tz), hijri: field('hijriDate'),
    times, jumuah: jumuahOverride || (jumuah ? clock24(jumuah[1]) : ''),
  };
}

async function salah(env) {
  const r = await fetch(env.SALAH_WIDGET, { headers: { 'User-Agent': 'freemytv-bff' } });
  if (!r.ok) throw new Error(`mosque widget: HTTP ${r.status}`);
  return parseSalah(await r.text(), env.JUMUAH || '');
}

// MARK: Football (football-data.org: one request, 7 days back to 14 ahead)

const FOOTBALL_FRESH = 5 * 60000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

/** {team, live, next, last}: each {home, away, opponent, atHome, utcDate, competition, status, score: {home, away}}. */
export function pickMatches(matches, teamId, now = Date.now()) {
  const shape = (m) => {
    const atHome = m.homeTeam.id === teamId;
    return {
      home: m.homeTeam.shortName || m.homeTeam.name, away: m.awayTeam.shortName || m.awayTeam.name,
      opponent: atHome ? m.awayTeam.shortName || m.awayTeam.name : m.homeTeam.shortName || m.homeTeam.name,
      atHome, utcDate: m.utcDate, competition: (m.competition || {}).name || '', status: m.status,
      score: { home: m.score && m.score.fullTime ? m.score.fullTime.home : null, away: m.score && m.score.fullTime ? m.score.fullTime.away : null },
    };
  };
  const sorted = [...matches].sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
  const live = sorted.find((m) => m.status === 'IN_PLAY' || m.status === 'PAUSED');
  const next = sorted.find((m) => (m.status === 'SCHEDULED' || m.status === 'TIMED') && Date.parse(m.utcDate) > now);
  const last = [...sorted].reverse().find((m) => m.status === 'FINISHED');
  const team = sorted[0] ? (sorted[0].homeTeam.id === teamId ? sorted[0].homeTeam : sorted[0].awayTeam) : null;
  return { team: team ? team.shortName || team.name : '', live: live ? shape(live) : null, next: next ? shape(next) : null, last: last ? shape(last) : null };
}

async function football(env) {
  const team = parseInt(env.FOOTBALL_TEAM || '66', 10);
  const now = Date.now();
  const url = `https://api.football-data.org/v4/teams/${team}/matches?dateFrom=${ymd(now - 7 * DAY)}&dateTo=${ymd(now + 14 * DAY)}`;
  const r = await fetch(url, { headers: { 'X-Auth-Token': env.FOOTBALL_KEY } });
  if (!r.ok) throw new Error(`football-data: HTTP ${r.status}`);
  return pickMatches((await r.json()).matches || [], team, now);
}

// MARK: Calendar (today in CALENDAR_TZ, from the secret iCal address)

const CALENDAR_FRESH = 10 * 60000;

async function calendar(env) {
  const r = await fetch(env.CALENDAR_ICS, { headers: { 'User-Agent': 'freemytv-bff' } });
  if (!r.ok) throw new Error(`calendar feed: HTTP ${r.status}`);
  const text = await r.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('calendar feed: not iCal');
  const tz = env.CALENDAR_TZ || 'Europe/London';
  const [from, to] = dayBounds(Date.now(), tz);
  // feedEvents: how many VEVENTs the feed holds, so "nothing today" can be told from "couldn't read the feed".
  return { tz, from, to, events: eventsBetween(text, from, to, tz), feedEvents: (text.match(/^BEGIN:VEVENT/gm) || []).length };
}

// MARK: Notes (make note MSG="..." writes; the TV reads)

const NOTE_MAX = 140;

async function notes(request, env) {
  if (request.method === 'GET') return json((await env.CACHE.get('note', 'json')) || { text: '', at: 0 });
  // ADMIN_TOKEN may list several, comma separated: one per device (the Mac, a phone's Shortcut), so one can be revoked.
  const admin = request.headers.get('Authorization') || '';
  const tokens = (env.ADMIN_TOKEN || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!tokens.some((t) => sameSecret(admin, 'Bearer ' + t))) return json({ error: 'admin token' }, 401);
  if (request.method === 'DELETE') {
    await env.CACHE.delete('note');
    return json({ text: '', at: 0 });
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON body {"text": "..."}' }, 400); }
  const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
  if (!text) return json({ error: 'empty note' }, 400);
  if (text.length > NOTE_MAX) return json({ error: `at most ${NOTE_MAX} characters` }, 400);
  const note = { text, at: Date.now() };
  await env.CACHE.put('note', JSON.stringify(note));
  return json(note);
}

// MARK: Sites (the monitoring Workers' last results, from their KV)

/** [{name, ok, at, failing}] from SITES ("Name:BINDING,..."): each binding is a monitor's STATE KV ({sig, at} in "last"). */
async function sites(env) {
  const list = (env.SITES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const watched = ((await env.CACHE.get('watch:last', 'json')) || {}).results || [];
  const fromWatch = watchList(env).map((w) => {
    const r = watched.find((x) => x.name === w.name);
    return r ? { name: w.name, ok: r.ok, at: 0, failing: r.ok ? [] : [r.detail] } : { name: w.name, ok: null, at: 0, failing: [] };
  });
  return (await Promise.all(list.map(async (item) => {
    const [name, binding] = item.split(':').map((x) => x.trim());
    const kv = env[binding];
    if (!kv) return { name, ok: null, at: 0, failing: [] };
    const last = await kv.get('last', 'json');
    if (!last) return { name, ok: true, at: 0, failing: [] };   // never failed yet: monitors only write news
    return { name, ok: !last.sig, at: last.at || 0, failing: last.sig ? last.sig.split('|') : [] };
  }))).concat(fromWatch);
}

// MARK: Homebrew Channel repository (the build holds keys and photos: home only, never public)

async function homebrew(path, env) {
  if (!(env.ALLOWED_IPS || '').trim()) return json({ error: 'the repository needs ALLOWED_IPS' }, 403);
  if (path === '/webos/apps.json') {
    const repo = await env.CACHE.get('webos:apps.json');
    return repo ? new Response(repo, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
      : json({ error: 'nothing published yet (make release)' }, 404);
  }
  const ipk = await env.CACHE.get('webos:ipk', 'arrayBuffer');
  if (!ipk) return json({ error: 'nothing published yet (make release)' }, 404);
  return new Response(ipk, { headers: { 'Content-Type': 'application/vnd.debian.binary-package', 'Content-Length': String(ipk.byteLength),
    'Cache-Control': 'no-store' } });
}

// MARK: Watched sites (the cron): your other sites, checked every 15 minutes

const WATCH_TIMEOUT = 15000;

export function watchList(env) {
  return (env.WATCH_SITES || '').split('|').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return { name: x.slice(0, i).trim(), url: x.slice(i + 1).trim() };
  }).filter((x) => x.name && /^https?:\/\//.test(x.url));
}

async function probeSite(site) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCH_TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(site.url, { redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; freemytv-sitewatch)' } });
    return { name: site.name, url: site.url, ok: r.status < 400, detail: `HTTP ${r.status}`, ms: Date.now() - t0 };
  } catch (e) {
    const why = e.name === 'AbortError' ? 'no answer in 15 s' : String(e.message || e).replace(/^.*?: /, '').slice(0, 80);
    return { name: site.name, url: site.url, ok: false, detail: why, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks them all; writes KV only when the result changes or hourly (KV's free writes). */
export async function watchSites(env, now = Date.now()) {
  const results = await Promise.all(watchList(env).map(probeSite));
  const sig = results.map((r) => `${r.name}:${r.ok ? 'up' : r.detail}`).join('|');
  const last = (await env.CACHE.get('watch:last', 'json')) || {};
  if (last.sig !== sig || now - (last.at || 0) >= HOUR) {
    await env.CACHE.put('watch:last', JSON.stringify({ sig, at: now, results }));
  }
  console.log(JSON.stringify({ watched: results.length, down: results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`) }));
  return results;
}

async function health(env) {
  const sources = {};
  for (const s of stations(env)) sources['tides:' + s.id] = (await env.CACHE.get('health:tides:' + s.id, 'json')) || {};
  if (env.GITHUB_TOKEN) sources.github = (await env.CACHE.get('health:github', 'json')) || {};
  return { ok: true, now: Date.now(), sources };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(watchSites(env));
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const writesNote = path === '/v1/notes' && (request.method === 'POST' || request.method === 'DELETE');
    if (request.method !== 'GET' && !writesNote) return json({ error: 'GET only' }, 405);
    if (!allowedIp(request, env)) return json({ error: 'not from an allowed address' }, 403);
    if (path === '/health') return json(await health(env));
    if (path === '/webos/apps.json' || path === '/webos/FreeMyTV.ipk') return homebrew(path, env);

    if (writesNote) return notes(request, env);
    const auth = request.headers.get('Authorization') || '';
    if (!env.TV_TOKEN || !sameSecret(auth, 'Bearer ' + env.TV_TOKEN)) return json({ error: 'token' }, 401);
    try {
      if (path === '/v1/notes') return notes(request, env);
      if (path === '/v1/football') {
        if (!env.FOOTBALL_KEY) return json({ error: 'no FOOTBALL_KEY' }, 503);
        const c = await cached(env, 'football', FOOTBALL_FRESH, () => football(env));
        return json({ ...c.data, fetchedAt: c.fetchedAt, stale: c.stale, error: c.error });
      }
      if (path === '/v1/calendar') {
        if (!env.CALENDAR_ICS) return json({ error: 'no CALENDAR_ICS' }, 503);
        const c = await cached(env, 'calendar', CALENDAR_FRESH, () => calendar(env));
        return json({ ...c.data, fetchedAt: c.fetchedAt, stale: c.stale, error: c.error });
      }
      if (path === '/v1/salah') {
        if (!env.SALAH_WIDGET) return json({ error: 'no SALAH_WIDGET' }, 503);
        // Never kept past the mosque's midnight: tomorrow's times are another page.
        const tz = env.CALENDAR_TZ || 'Europe/London', now = Date.now();
        const c = await cached(env, 'salah', Math.min(SALAH_FRESH, msToMidnight(now, tz)), () => salah(env));
        const today = c.data.day === localDay(now, tz);
        return json({ ...c.data, today, fetchedAt: c.fetchedAt, stale: c.stale || !today, error: c.error });
      }
      if (path === '/v1/trains') {
        const t = await live(env, 'trains', () => trains(env)).catch((e) => ({ error: String(e.message || e) }));
        return json(t, t.error ? 502 : 200);
      }
      if (path === '/v1/tides') return json(await tides(env));
      if (path === '/v1/dashboard' || path === '/v1/dashboard/details') {
        if (!env.GITHUB_TOKEN) return json({ error: 'no GITHUB_TOKEN' }, 503);
        const c = await cached(env, 'github', DASHBOARD_FRESH, () => details(env));
        const siteList = await sites(env);
        const data = path === '/v1/dashboard' ? { ...counts(c.data), sites: siteCounts(siteList) } : { ...c.data, sites: siteList };
        return json({ ...data, fetchedAt: c.fetchedAt, stale: c.stale, error: c.error });
      }
    } catch (e) {
      console.error(JSON.stringify({ path, error: String(e.message || e) }));
      return json({ error: 'upstream' }, 502);
    }
    return json({ error: 'not found' }, 404);
  },
};
