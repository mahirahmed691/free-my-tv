/** Quran together's page for the phones, on the same links as Film match: the key stays in the address's #fragment. */
export function quranPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B1330">
<meta name="referrer" content="no-referrer">
<title>Quran together</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; --ink: #F5F5F7; --dim: rgba(245, 245, 247, 0.62); --gold: #F6DB9B; --line: rgba(255, 255, 255, 0.12); }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { min-height: 100dvh; margin: 0; padding: max(20px, env(safe-area-inset-top)) 18px max(20px, env(safe-area-inset-bottom)); display: flex; flex-direction: column;
    color: var(--ink); background: linear-gradient(#0B1330, #2A2358 70%, #4A3560); font: 17px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { margin: 0 0 22px; font-size: 30px; font-weight: 700; letter-spacing: -0.01em; color: var(--gold); }
  .person { padding: 18px 0; border-top: 1px solid var(--line); }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .name { font-size: 21px; font-weight: 600; }
  .count { font-size: 21px; font-variant-numeric: tabular-nums; }
  .khatam { margin-top: 2px; font-size: 14px; color: var(--gold); min-height: 19px; }
  .bar { display: grid; grid-template-columns: repeat(30, 1fr); gap: 3px; margin-top: 10px; }
  .bar i { height: 16px; border-radius: 3px; background: rgba(255, 255, 255, 0.12); }
  .bar i.on { background: var(--gold); }
  #actions { margin-top: auto; padding-top: 24px; }
  button { width: 100%; min-height: 62px; border: 0; border-radius: 18px; font: inherit; font-weight: 700; color: #2A1E05; background: var(--gold); }
  button:active { opacity: 0.75; }
  button:disabled { opacity: 0.4; }
  .quiet { display: flex; gap: 12px; margin-top: 10px; }
  .quiet button { min-height: 48px; font-weight: 500; color: var(--ink); background: rgba(255, 255, 255, 0.1); }
  #note { margin-top: 16px; text-align: center; color: var(--dim); min-height: 24px; }
  a { display: block; margin-top: 14px; text-align: center; color: var(--dim); }
</style>
</head>
<body>
<h1>Quran together</h1>
<div id="people"></div>
<div id="actions">
  <button id="done" disabled>I finished a juz</button>
  <div class="quiet"><button id="undo" disabled>Undo</button><button id="again" disabled>Start again</button></div>
  <div id="note" role="status"></div>
  <a id="films">Film match</a>
</div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var key = location.hash.slice(1), buttons = ['done', 'undo', 'again'].map(function (id) { return document.getElementById(id); });
  var note = document.getElementById('note'), people = document.getElementById('people');
  document.getElementById('films').href = '/match#' + key;

  function make(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    parent.appendChild(n);
    return n;
  }

  function call(method, body) {
    var headers = { Authorization: 'Bearer ' + key };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('/v1/quran', { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 401 ? 'key' : r.status === 403 ? 'place' : 'server');
      return r.json();
    });
  }

  function failed(e) {
    note.textContent = e.message === 'key' ? 'This link has stopped working. Ask for a new one.'
      : e.message === 'place' ? 'Join the home Wi-Fi: this works at home only.' : 'No connection. Nothing was saved.';
  }

  function show(d) {
    people.textContent = '';
    d.people.forEach(function (p) {
      var box = make('div', 'person', people), top = make('div', 'top', box);
      make('div', 'name', top, p.name);
      make('div', 'count', top, p.juz + ' of 30');
      make('div', 'khatam', box, p.khatam ? 'Khatam × ' + p.khatam : '');
      var bar = make('div', 'bar', box);
      for (var i = 0; i < 30; i++) make('i', i < p.juz ? 'on' : '', bar);
    });
    buttons.forEach(function (b) { b.disabled = false; });
    note.textContent = '';
  }

  function act(body, said) {
    buttons.forEach(function (b) { b.disabled = true; });
    call('POST', body).then(function (d) { show(d); note.textContent = d.finished ? 'Khatam! Mabrook.' : said; })
      .catch(function (e) { buttons.forEach(function (b) { b.disabled = false; }); failed(e); });
  }

  buttons[0].addEventListener('click', function () { act({ step: 1 }, 'Saved.'); });
  buttons[1].addEventListener('click', function () { act({ step: -1 }, 'Undone.'); });
  buttons[2].addEventListener('click', function () {
    if (window.confirm('Start your count again from zero? Your finished Qurans stay.')) act({ reset: true }, 'Back to the start.');
  });
  if (key) call('GET').then(show).catch(failed); else failed(new Error('key'));
})();
</script>
</body>
</html>
`;
}
