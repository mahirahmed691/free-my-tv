/* Ramadan and the Eids on the home screen (CONFIG.islam.festive): lanterns, a crescent and a star hanging from the top,
 * gold accents, from the Hijri date, so a moon sighting's shift (hijri_adjust) moves them too. */
var Festive = (function () {
  'use strict';

  var GOLD = '<linearGradient id="fg{n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE7A3"/><stop offset="1" stop-color="#C98B2B"/></linearGradient>';
  var GLASS = '<linearGradient id="gl{n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF0B8"/><stop offset="1" stop-color="#FF9A2E"/></linearGradient>';

  function art(width, height, inside) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">'
      + '<defs>' + GOLD + GLASS + '</defs>' + inside + '</svg>';
  }

  var LANTERN = art(70, 130, '<circle cx="35" cy="7" r="5" fill="none" stroke="url(#fg{n})" stroke-width="3"/>'
    + '<path d="M24 30 L35 12 L46 30 Z" fill="url(#fg{n})"/><rect x="20" y="30" width="30" height="5" rx="2" fill="url(#fg{n})"/>'
    + '<path d="M16 35 H54 L60 62 L50 96 H20 L10 62 Z" fill="url(#gl{n})" stroke="url(#fg{n})" stroke-width="3"/>'
    + '<path d="M28 35 L24 62 L29 96 M42 35 L46 62 L41 96 M10 62 H60" fill="none" stroke="#B9791F" stroke-width="2"/>'
    + '<path d="M20 96 H50 L44 106 H26 Z" fill="url(#fg{n})"/><path d="M35 106 V122" stroke="#D9A441" stroke-width="2"/>'
    + '<circle cx="35" cy="124" r="3" fill="url(#fg{n})"/>');
  var CRESCENT = art(62, 64, '<path d="M42 4 A28 28 0 1 0 42 60 A40 40 0 0 1 42 4 Z" fill="url(#fg{n})"/>');
  var STAR = art(40, 40, '<path d="M20 2 L25 15 L38 20 L25 25 L20 38 L15 25 L2 20 L15 15 Z" fill="url(#fg{n})"/>');

  // Each hangs on its thread: what, how far along, the thread's length, and how long it takes to sway.
  var HANGING = [[LANTERN, 1336, 22, 5.2], [CRESCENT, 1404, 54, 6.4], [LANTERN, 1468, 8, 4.6], [STAR, 1536, 40, 5.8]];

  /** 'ramadan', 'eid' or '': the season on this day. */
  function season(day) {
    var h = Islam.hijri(day);
    if (h.month === 9) return 'ramadan';
    return (h.month === 10 && h.day <= 3) || (h.month === 12 && h.day >= 10 && h.day <= 13) ? 'eid' : '';
  }

  var box = null, shown = '';

  function build(parent) {
    box = document.createElement('div');
    box.id = 'festive';
    var html = '';
    for (var i = 0; i < HANGING.length; i++) {
      var h = HANGING[i];
      html += '<div class="hang" style="left:' + h[1] + 'px;-webkit-animation-duration:' + h[3] + 's;animation-duration:' + h[3] + 's">'
        + '<div class="thread" style="height:' + h[2] + 'px"></div><div class="glow"></div>' + h[0].replace(/\{n\}/g, i) + '</div>';
    }
    box.innerHTML = html;
    parent.insertBefore(box, parent.firstChild);
  }

  /** Shows `kind` ('ramadan', 'eid' or ''); only a change touches the page. */
  function show(kind, top, body) {
    if (kind === shown) return;
    if (shown) body.className = body.className.replace(new RegExp('\\b' + shown + '\\b', 'g'), '').replace(/\s+/g, ' ');
    shown = kind;
    if (kind && !box) build(top);
    if (kind) body.className += ' festive ' + kind;
    else body.className = body.className.replace(/\bfestive\b/g, '').replace(/\s+/g, ' ');
  }

  return {season: season, show: show, crescent: CRESCENT.replace(/\{n\}/g, 'm')};
})();
