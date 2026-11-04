/**
 * Film match's page for the phones. Everything from the TV is set as text, never as HTML. The key is in the address's
 * #fragment, which browsers don't send, so it stays out of request logs; the page sends it as a Bearer token.
 */
export function matchPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#111113">
<meta name="referrer" content="no-referrer">
<title>Film match</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; --ink: #F5F5F7; --dim: rgba(245, 245, 247, 0.62); --card: #1C1C1E; --line: rgba(255, 255, 255, 0.1); --love: #FF375F; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; min-height: 100dvh; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    overflow: hidden; color: var(--ink); background: #111113; font: 17px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.01em; }
  #left { color: var(--dim); font-size: 15px; font-variant-numeric: tabular-nums; }
  #stage { position: relative; flex: 1; min-height: 0; margin: 14px 0; }
  .film { position: absolute; inset: 0; overflow: hidden; border-radius: 28px; background: var(--card); touch-action: none; user-select: none; -webkit-user-select: none;
    transition: transform 0.22s ease-out, opacity 0.22s; will-change: transform; }
  .film.drag { transition: none; }
  .film.next { transform: scale(0.96); }
  .film img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  .film .shade { position: absolute; inset: 40% 0 0; background: linear-gradient(transparent, rgba(0, 0, 0, 0.88)); }
  .film .text { position: absolute; left: 20px; right: 20px; bottom: 18px; }
  .film .name { font-size: 27px; font-weight: 700; line-height: 1.15; }
  .film .meta { margin-top: 5px; color: rgba(255, 255, 255, 0.76); font-size: 15px; }
  .stamp { position: absolute; top: 22px; padding: 4px 12px; border: 3px solid; border-radius: 10px; font-size: 24px; font-weight: 800; opacity: 0; }
  .stamp.yes { left: 20px; color: #30D158; transform: rotate(-10deg); }
  .stamp.no { right: 20px; color: #FF453A; transform: rotate(10deg); }
  #buttons { display: flex; gap: 12px; }
  button { flex: 1; min-height: 58px; border: 0; border-radius: 18px; color: var(--ink); background: var(--card); font: inherit; font-weight: 600; }
  button:active { opacity: 0.7; }
  button:disabled { opacity: 0.35; }
  #yes { color: #fff; background: var(--love); }
  #note { position: absolute; inset: 0; display: none; flex-direction: column; justify-content: center; padding: 24px; text-align: center; color: var(--dim); }
  #note.on { display: flex; }
  #note b { display: block; margin-bottom: 8px; font-size: 22px; color: var(--ink); }
  #note button { flex: none; margin-top: 20px; }
  #matches { margin-top: 12px; color: var(--dim); font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #matches b { color: var(--love); }
  #quran { display: block; margin-top: 10px; text-align: center; font-size: 15px; color: var(--dim); }
  #banner { position: fixed; left: 16px; right: 16px; top: max(16px, env(safe-area-inset-top)); z-index: 2; padding: 14px 18px; border-radius: 18px; text-align: center;
    font-weight: 600; color: #fff; background: var(--love); transform: translateY(-160%); transition: transform 0.25s; }
  #banner.on { transform: none; }
</style>
</head>
<body>
<header><h1>Film match</h1><div id="left"></div></header>
<div id="stage"><div id="note"></div></div>
<div id="buttons"><button id="no" disabled>Not for me</button><button id="yes" disabled>Yes please</button></div>
<div id="matches"></div>
<a id="quran">Quran together</a>
<div id="banner" role="status"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var key = location.hash.slice(1), stage = document.getElementById('stage'), note = document.getElementById('note');
  var yes = document.getElementById('yes'), no = document.getElementById('no'), left = document.getElementById('left');
  document.getElementById('quran').href = '/quran#' + key;
  var films = [], known = null, busy = false, card = null, bannerTimer = 0;

  function make(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function call(method, body) {
    var headers = { Authorization: 'Bearer ' + key };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('/v1/match', { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 401 ? 'key' : r.status === 403 ? 'place' : 'server');
      return r.json();
    });
  }

  function say(title, text, action, run) {
    note.textContent = '';
    make('b', '', note, title);
    make('span', '', note, text);
    if (action) make('button', '', note, action).addEventListener('click', run);
    note.className = 'on';
    yes.disabled = no.disabled = true;
  }

  function failed(e) {
    if (e.message === 'key') say('This link has stopped working', 'Ask for a new one.');
    else if (e.message === 'place') say('Join the home Wi-Fi', 'Film match works at home only.', 'Try again', load);
    else say('No connection', 'The vote may not have been counted.', 'Try again', load);
  }

  function banner(text) {
    var b = document.getElementById('banner');
    b.textContent = text;
    b.className = 'on';
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { b.className = ''; }, 3500);
  }

  function showMatches(list) {
    var m = document.getElementById('matches');
    m.textContent = '';
    if (list.length) {
      make('b', '', m, 'You both want: ');
      m.appendChild(document.createTextNode(list.map(function (f) { return f.title; }).join(' · ')));
    }
    if (known) list.forEach(function (f) { if (known.indexOf(f.id) < 0) banner("It's a match: " + f.title); });
    known = list.map(function (f) { return f.id; });
  }

  function cardFor(f, cls) {
    var c = make('div', 'film ' + cls);
    if (f.image) {
      var i = make('img', '', c);
      i.alt = '';
      i.src = 'https://image.tmdb.org/t/p/w780' + f.image;
    }
    make('div', 'shade', c);
    var t = make('div', 'text', c);
    make('div', 'name', t, f.title);
    make('div', 'meta', t, (f.rating ? '★ ' + f.rating + '  ·  ' : '') + (f.meta || ''));
    make('div', 'stamp yes', c, 'YES');
    make('div', 'stamp no', c, 'NOPE');
    return c;
  }

  function render() {
    Array.prototype.slice.call(stage.querySelectorAll('.film')).forEach(function (c) { c.remove(); });
    left.textContent = films.length ? films.length + ' to go' : '';
    card = null;
    if (!films.length) {
      say('All done', known && known.length ? 'Your matches are in Movie night on the TV.' : "Nothing new. When there are more films, they'll be here.", 'Start again', restart);
      return;
    }
    note.className = '';
    yes.disabled = no.disabled = false;
    if (films[1]) stage.insertBefore(cardFor(films[1], 'next'), note);
    card = cardFor(films[0], '');
    stage.insertBefore(card, note);
    drag(card);
  }

  function vote(like) {
    if (busy || !films.length) return;
    busy = true;
    var f = films.shift(), gone = card;
    if (gone) {
      gone.style.transform = 'translateX(' + (like ? 140 : -140) + '%) rotate(' + (like ? 14 : -14) + 'deg)';
      gone.style.opacity = '0';
    }
    setTimeout(function () { busy = false; render(); }, 180);
    call('POST', { id: f.id, like: like }).then(function (d) { showMatches(d.matches); }).catch(failed);
  }

  function drag(c) {
    var startX = 0, dx = 0, on = false;
    c.addEventListener('pointerdown', function (e) { on = true; startX = e.clientX; dx = 0; c.setPointerCapture(e.pointerId); c.classList.add('drag'); });
    c.addEventListener('pointermove', function (e) {
      if (!on) return;
      dx = e.clientX - startX;
      c.style.transform = 'translateX(' + dx + 'px) rotate(' + dx / 22 + 'deg)';
      c.querySelector('.stamp.yes').style.opacity = Math.max(0, dx / 90);
      c.querySelector('.stamp.no').style.opacity = Math.max(0, -dx / 90);
    });
    function end() {
      if (!on) return;
      on = false;
      c.classList.remove('drag');
      if (Math.abs(dx) > 90) { vote(dx > 0); return; }
      c.style.transform = '';
      c.querySelector('.stamp.yes').style.opacity = c.querySelector('.stamp.no').style.opacity = 0;
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  }

  function load() {
    if (!key) { say('This link has no key', 'Ask for a new one.'); return; }
    call('GET').then(function (d) {
      if (!d.total) { showMatches(d.matches); say('No films yet', 'They come from the TV: turn it on and try again in a few minutes.', 'Try again', load); return; }
      films = shuffle(d.left);
      showMatches(d.matches);
      render();
    }).catch(failed);
  }

  function restart() { call('DELETE').then(load).catch(failed); }

  yes.addEventListener('click', function () { vote(true); });
  no.addEventListener('click', function () { vote(false); });
  load();
})();
</script>
</body>
</html>
`;
}
